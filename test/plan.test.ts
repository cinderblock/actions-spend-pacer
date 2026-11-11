import { describe, expect, test } from "bun:test";
import { matches, parseDuration } from "../src/match.ts";
import { type DecideInput, decide } from "../src/plan.ts";
import type { PausedEntry, Workflow } from "../src/types.ts";

const now = new Date("2026-11-11T03:00:00Z");
const wf = (repo: string, id: number, file: string, state = "active"): Workflow => ({
  repo,
  id,
  path: file.startsWith("dynamic/") ? file : `.github/workflows/${file}`,
  name: file,
  state,
});
const paused = (w: Workflow): PausedEntry => ({
  repo: w.repo,
  workflowId: w.id,
  path: w.path,
  name: w.name,
  pausedAt: "2026-11-10T00:00:00Z",
});

const base = (over: Partial<DecideInput>): DecideInput => ({
  now,
  owner: "me",
  spend: 0,
  allowance: 11,
  headroom: 0.5,
  workflows: [],
  failedRepos: new Set(),
  state: { version: 1, paused: [], overrides: [] },
  allowList: [],
  includeDynamic: false,
  ...over,
});

describe("decide: pausing", () => {
  const ci = wf("app", 1, "ci.yml");
  const deploy = wf("ops", 2, "deploy.yml");
  const handOff = wf("ops", 3, "old.yml", "disabled_manually");
  const idle = wf("ops", 4, "cron.yml", "disabled_inactivity");
  const dependabot = wf("app", 5, "dynamic/dependabot/dependabot-updates");

  test("over: pauses active, governed, non-exempt workflows only", () => {
    const d = decide(base({ spend: 16.53, workflows: [ci, deploy, handOff, idle, dependabot], allowList: ["ops/deploy.yml"] }));
    expect(d.status).toBe("over");
    expect(d.toPause.map((w) => w.id)).toEqual([1]);
    expect(d.skipped.map((s) => [s.workflow.id, s.reason])).toEqual([
      [2, "allow-list"],
      [3, "not active"],
      [4, "not active"],
      [5, "dynamic"],
    ]);
  });

  test("include-dynamic opts dynamic workflows in", () => {
    const d = decide(base({ spend: 20, workflows: [dependabot], includeDynamic: true }));
    expect(d.toPause).toEqual([dependabot]);
  });

  test("exactly at the allowance is not over", () => {
    expect(decide(base({ spend: 11, workflows: [ci] })).status).toBe("holding");
    expect(decide(base({ spend: 11.0001, workflows: [ci] })).status).toBe("over");
  });

  test("under or holding: never pauses", () => {
    expect(decide(base({ spend: 5, workflows: [ci] })).toPause).toEqual([]);
    expect(decide(base({ spend: 10.8, workflows: [ci] })).toPause).toEqual([]);
  });

  test("an active override protects a workflow, an expired one does not", () => {
    const live = { match: "ops/deploy.yml", until: "2026-11-11T05:00:00Z" };
    const dead = { match: "app", until: "2026-11-11T02:00:00Z" };
    const d = decide(base({ spend: 20, workflows: [ci, deploy], state: { version: 1, paused: [], overrides: [live, dead] } }));
    expect(d.toPause).toEqual([ci]);
    expect(d.overrides).toEqual([live]);
  });

  test("already-paused workflows are not paused twice", () => {
    const pci = { ...ci, state: "disabled_manually" };
    const d = decide(base({ spend: 20, workflows: [pci], state: { version: 1, paused: [paused(ci)], overrides: [] } }));
    expect(d.toPause).toEqual([]);
    expect(d.stillPaused).toHaveLength(1);
  });
});

describe("decide: resuming and bookkeeping", () => {
  const ci = wf("app", 1, "ci.yml", "disabled_manually");
  const mine = wf("app", 9, "manual.yml", "disabled_manually"); // user disabled by hand
  const state = { version: 1 as const, paused: [paused(ci)], overrides: [] };

  test("under (past headroom): resumes only what it paused", () => {
    const d = decide(base({ spend: 10.5, workflows: [ci, mine], state }));
    expect(d.status).toBe("under");
    expect(d.toResume.map((e) => e.workflowId)).toEqual([1]);
    expect(d.toPause).toEqual([]);
  });

  test("holding inside headroom: keeps paused", () => {
    const d = decide(base({ spend: 10.6, workflows: [ci, mine], state }));
    expect(d.status).toBe("holding");
    expect(d.toResume).toEqual([]);
    expect(d.stillPaused).toHaveLength(1);
  });

  test("re-enabled by hand → forgotten, not touched", () => {
    const d = decide(base({ spend: 3, workflows: [{ ...ci, state: "active" }], state }));
    expect(d.toResume).toEqual([]);
    expect(d.dropped).toEqual([{ entry: state.paused[0]!, reason: "workflow is now active" }]);
  });

  test("hand-enabled while over → forgotten now, may be paused again as new", () => {
    const d = decide(base({ spend: 20, workflows: [{ ...ci, state: "active" }], state }));
    expect(d.dropped).toHaveLength(1);
    expect(d.toPause.map((w) => w.id)).toEqual([1]);
  });

  test("workflow deleted → forgotten", () => {
    const d = decide(base({ spend: 3, workflows: [], state }));
    expect(d.dropped[0]!.reason).toMatch(/no longer exists/);
  });

  test("repo listing failed → entry kept, nothing dropped", () => {
    const d = decide(base({ spend: 3, workflows: [], failedRepos: new Set(["app"]), state }));
    expect(d.stillPaused).toHaveLength(1);
    expect(d.dropped).toEqual([]);
    expect(d.toResume).toEqual([]);
  });

  test("override resumes a paused workflow even while over", () => {
    const s = { ...state, overrides: [{ match: "app/ci.yml", until: "2026-11-12T00:00:00Z" }] };
    const d = decide(base({ spend: 20, workflows: [ci], state: s }));
    expect(d.toResume.map((e) => e.workflowId)).toEqual([1]);
  });

  test("allow-listed after being paused → resumed", () => {
    const d = decide(base({ spend: 20, workflows: [ci], state, allowList: ["app"] }));
    expect(d.toResume).toHaveLength(1);
  });
});

describe("matches", () => {
  const w = { repo: "ops", path: ".github/workflows/deploy.yml" };
  test.each([
    ["ops", true],
    ["OPS", true],
    ["ops/deploy.yml", true],
    ["ops/.github/workflows/deploy.yml", true],
    ["me/ops/deploy.yml", true],
    ["ops/other.yml", false],
    ["op", false],
    ["", false],
  ])("%s → %p", (entry, want) => expect(matches(entry, w, "me")).toBe(want));
});

test("parseDuration", () => {
  expect(parseDuration("90m")).toBe(5_400_000);
  expect(parseDuration("4h")).toBe(14_400_000);
  expect(parseDuration("2d")).toBe(172_800_000);
  expect(() => parseDuration("4 hours")).toThrow();
});
