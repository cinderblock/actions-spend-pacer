import { describe, expect, test } from "bun:test";
import { GitHub } from "../src/github.ts";
import { redactRepo } from "../src/report.ts";
import { type Config, run } from "../src/run.ts";
import { MemoryStore } from "../src/store.ts";
import type { State } from "../src/types.ts";

interface FakeWf {
  id: number;
  path: string;
  name: string;
  state: string;
}

/** A tiny fake of the GitHub endpoints the pacer uses. */
function fakeGitHub(opts: { spend: number; repos: Record<string, FakeWf[]>; failToggle?: number[] }) {
  const calls: string[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    calls.push(`${method} ${u.pathname}`);
    const json = (body: unknown, status = 200) =>
      new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === "/users/me/settings/billing/usage")
      return json({ usageItems: [{ date: "2026-11-10T00:00:00Z", product: "actions", sku: "Actions Linux", netAmount: opts.spend, repositoryName: "app" }] });
    if (u.pathname === "/user/repos")
      return json(Object.keys(opts.repos).map((name) => ({ name, private: true, archived: false, owner: { login: "me" } })));
    const m = /^\/repos\/me\/([^/]+)\/actions\/workflows(?:\/(\d+)\/(enable|disable))?$/.exec(u.pathname);
    if (m) {
      const wfs = opts.repos[m[1]!];
      if (!wfs) return json({ message: "Not Found" }, 404);
      if (!m[2]) return json({ total_count: wfs.length, workflows: wfs });
      const w = wfs.find((x) => x.id === Number(m[2]));
      if (!w || opts.failToggle?.includes(w.id)) return json({ message: "nope" }, 403);
      w.state = m[3] === "enable" ? "active" : "disabled_manually";
      return json(null, 204);
    }
    return json({ message: `unexpected ${u.pathname}` }, 500);
  };
  return { gh: new GitHub("t", "https://api.github.com", fetchImpl), calls };
}

const cfg = (over: Partial<Config> = {}): Config => ({
  owner: "me",
  ownerType: "user",
  allowance: { dailyRate: 1 },
  headroom: 0.5,
  repos: "all-private",
  allowList: [],
  includeDynamic: false,
  mode: "live",
  timezone: "America/Los_Angeles",
  redact: false,
  ...over,
});
const now = new Date("2026-11-11T03:00:00Z"); // allowance $11
const log = () => {};

describe("run", () => {
  test("dry run reads only, changes nothing", async () => {
    const repos = { app: [{ id: 1, path: ".github/workflows/ci.yml", name: "CI", state: "active" }] };
    const { gh, calls } = fakeGitHub({ spend: 16.53, repos });
    const store = new MemoryStore();
    const r = await run(cfg({ mode: "dry-run" }), { gh, store, now, log });
    expect(r.decision.toPause).toHaveLength(1);
    expect(calls.every((c) => c.startsWith("GET"))).toBe(true);
    expect(store.saved).toEqual([]);
    expect(r.report).toContain("Would pause 1 workflow");
    expect(r.report).toContain("Nov 10, 2026 7:00 PM PST (03:00Z)");
  });

  test("live: records intent before disabling, then pause → resume cycle", async () => {
    const repos = {
      app: [
        { id: 1, path: ".github/workflows/ci.yml", name: "CI", state: "active" },
        { id: 2, path: ".github/workflows/old.yml", name: "Old", state: "disabled_manually" },
      ],
    };
    const store = new MemoryStore();
    const over = fakeGitHub({ spend: 16.53, repos });
    const save = store.save.bind(store);
    store.save = async (s, md) => {
      over.calls.push(`SAVE ${s.paused.map((e) => e.workflowId).join(",")}`);
      return save(s, md);
    };
    const r1 = await run(cfg(), { gh: over.gh, store, now, log });
    expect(r1.outcome?.paused.map((w) => w.id)).toEqual([1]);
    // The intent was persisted before the disable call.
    const writes = over.calls.filter((c) => !c.startsWith("GET"));
    expect(writes).toEqual(["SAVE 1", "PUT /repos/me/app/actions/workflows/1/disable", "SAVE 1"]);
    expect(store.state.paused.map((e) => e.workflowId)).toEqual([1]);
    expect(store.notes).toHaveLength(1);
    expect(repos.app[1]!.state).toBe("disabled_manually");

    // Spend now well under the allowance: resume only workflow 1, never the hand-disabled 2.
    const under = fakeGitHub({ spend: 5, repos });
    const r2 = await run(cfg(), { gh: under.gh, store, now, log });
    expect(r2.outcome?.resumed.map((e) => e.workflowId)).toEqual([1]);
    expect(under.calls.filter((c) => c.startsWith("PUT"))).toEqual(["PUT /repos/me/app/actions/workflows/1/enable"]);
    expect(store.state.paused).toEqual([]);
    expect(repos.app[0]!.state).toBe("active");
    expect(repos.app[1]!.state).toBe("disabled_manually");
  });

  test("a failed disable is not recorded as paused", async () => {
    const repos = {
      app: [
        { id: 1, path: ".github/workflows/a.yml", name: "A", state: "active" },
        { id: 2, path: ".github/workflows/b.yml", name: "B", state: "active" },
      ],
    };
    const { gh } = fakeGitHub({ spend: 20, repos, failToggle: [2] });
    const store = new MemoryStore();
    const r = await run(cfg(), { gh, store, now, log });
    expect(r.outcome?.paused.map((w) => w.id)).toEqual([1]);
    expect(r.outcome?.failed).toHaveLength(1);
    expect(store.state.paused.map((e) => e.workflowId)).toEqual([1]);
  });

  test("state save failure → nothing disabled", async () => {
    const repos = { app: [{ id: 1, path: ".github/workflows/a.yml", name: "A", state: "active" }] };
    const { gh, calls } = fakeGitHub({ spend: 20, repos });
    const store = new MemoryStore();
    store.save = async () => {
      throw new Error("issue write failed");
    };
    await expect(run(cfg(), { gh, store, now, log })).rejects.toThrow("issue write failed");
    expect(calls.some((c) => c.startsWith("PUT"))).toBe(false);
    expect(repos.app[0]!.state).toBe("active");
  });

  test("redacted report never names private repos or workflows", async () => {
    const repos = {
      "secret-project": [{ id: 7, path: ".github/workflows/launch-codes.yml", name: "Launch codes", state: "active" }],
      broken: [] as FakeWf[],
    };
    const { gh } = fakeGitHub({ spend: 20, repos, failToggle: [7] });
    const state: State = {
      version: 1,
      paused: [],
      overrides: [{ match: "secret-project/x.yml", until: "2026-12-01T00:00:00Z", reason: "secret reason" }],
      grants: [{ amount: 1, month: "2026-11", reason: "secret grant", at: "2026-11-11T00:00:00Z" }],
    };
    const r = await run(cfg({ redact: true }), { gh, store: new MemoryStore(state), now, log });
    expect(r.report).not.toMatch(/secret|launch|Launch/i);
    expect(r.report).toContain(redactRepo("me", "secret-project"));
  });
});
