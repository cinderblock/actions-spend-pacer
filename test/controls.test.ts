import { describe, expect, test } from "bun:test";
import { parseTicks } from "../src/controls.ts";
import { GitHub } from "../src/github.ts";
import { type Config, run } from "../src/run.ts";
import { MemoryStore } from "../src/store.ts";

describe("parseTicks", () => {
  test("reads only pacer checkbox lines", () => {
    const body = [
      "- [x] Run app / CI for 4h <!-- pacer:resume:repo-abc123-1 -->",
      "* [ ] Override `ops` until x (untick to end it) <!-- pacer:override:0123456789 -->",
      "- [x] a normal task",
      "- [X] fake <!-- pacer:resume:bad key -->",
    ].join("\r\n");
    expect(parseTicks(body)).toEqual([
      { kind: "resume", key: "repo-abc123-1", checked: true },
      { kind: "override", key: "0123456789", checked: false },
    ]);
    expect(parseTicks(null)).toEqual([]);
  });
});

describe("ticking boxes in the status issue", () => {
  const wfs = [{ id: 1, path: ".github/workflows/ci.yml", name: "CI", state: "active" }];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const json = (b: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(b), { status });
    if (u.pathname.endsWith("/settings/billing/usage"))
      return json({ usageItems: [{ date: "2026-11-10T00:00:00Z", product: "actions", sku: "Linux", netAmount: 20, repositoryName: "secret-app" }] });
    if (u.pathname === "/user/repos") return json([{ name: "secret-app", private: true, archived: false, owner: { login: "me" } }]);
    if (u.pathname === "/repos/me/secret-app/actions/workflows") return json({ total_count: 1, workflows: wfs });
    const m = /\/workflows\/1\/(enable|disable)$/.exec(u.pathname);
    if (m && init.method === "PUT") {
      wfs[0]!.state = m[1] === "enable" ? "active" : "disabled_manually";
      return json(null, 204);
    }
    return json({ message: u.pathname }, 500);
  };
  const gh = new GitHub("t", "https://api.github.com", fetchImpl);
  const cfg = (over: Partial<Config> = {}): Config => ({
    owner: "me",
    ownerType: "user",
    allowance: { dailyRate: 1 },
    headroom: 0.5,
    repos: "all-private",
    allowList: [],
    includeDynamic: false,
    mode: "live",
    timezone: "UTC",
    redact: false,
    controlHours: 4,
    ...over,
  });
  const at = (iso: string) => new Date(iso);
  const log = () => {};

  test("tick → runs for N hours; untick → paused again", async () => {
    const store = new MemoryStore();
    await run(cfg(), { gh, store, now: at("2026-11-11T03:00:00Z"), log });
    expect(wfs[0]!.state).toBe("disabled_manually");
    const status1 = store.saved.at(-1)!.status;
    expect(status1).toMatch(/- \[ \] Run secret-app \/ CI .* for 4h <!-- pacer:resume:/);

    // The owner ticks the box. Still over budget, but the next run resumes it.
    store.ticks = store.ticks.map((t) => ({ ...t, checked: true }));
    const r2 = await run(cfg(), { gh, store, now: at("2026-11-11T04:00:00Z"), log });
    expect(r2.outcome?.resumed.map((e) => e.workflowId)).toEqual([1]);
    expect(wfs[0]!.state).toBe("active");
    expect(store.state.overrides).toEqual([
      { match: "secret-app/.github/workflows/ci.yml", until: "2026-11-11T08:00:00.000Z", reason: "ticked in the status issue" },
    ]);
    expect(r2.report).toContain("Ticked: run secret-app / CI");
    const status2 = store.saved.at(-1)!.status;
    expect(status2).toMatch(/- \[x\] Override `secret-app\/.github\/workflows\/ci.yml` until .* <!-- pacer:override:/);
    expect(status2).not.toContain("- [ ] Run");

    // A run with nothing ticked leaves it alone.
    const r3 = await run(cfg(), { gh, store, now: at("2026-11-11T05:00:00Z"), log });
    expect(r3.changed).toBe(false);
    expect(wfs[0]!.state).toBe("active");

    // The owner unticks the override: it ends and the workflow is paused again.
    store.ticks = store.ticks.map((t) => ({ ...t, checked: false }));
    const r4 = await run(cfg(), { gh, store, now: at("2026-11-11T06:00:00Z"), log });
    expect(r4.outcome?.paused.map((w) => w.id)).toEqual([1]);
    expect(store.state.overrides).toEqual([]);
    expect(wfs[0]!.state).toBe("disabled_manually");
  });

  test("redacted issue: boxes carry no names", async () => {
    wfs[0]!.state = "active";
    const store = new MemoryStore();
    await run(cfg({ redact: true }), { gh, store, now: at("2026-11-11T03:00:00Z"), log });
    const status = store.saved.at(-1)!.status;
    const controls = status.slice(status.indexOf("### Controls"));
    expect(controls).toContain("- [ ] Run repo-");
    expect(controls).not.toMatch(/secret|ci\.yml/i);
  });
});
