import { describe, expect, test } from "bun:test";
import { StateError, parseState, stateBlock, withState } from "../src/state.ts";
import type { State } from "../src/types.ts";

const s: State = {
  version: 1,
  paused: [{ repo: "app", workflowId: 1, path: ".github/workflows/ci.yml", name: "CI", pausedAt: "2026-11-11T00:00:00Z" }],
  overrides: [{ match: "ops/deploy.yml", until: "2026-11-12T00:00:00Z", reason: "sneaky --> end" }],
};

describe("state block", () => {
  test("round-trips through an issue body, even with --> in a string", () => {
    const body = withState("## Status\n\nSome table", s);
    expect(body.startsWith("## Status")).toBe(true);
    expect(body.match(/-->/g)).toHaveLength(1);
    expect(parseState(body)).toEqual(s);
  });

  test("replacing keeps the surrounding text and only one block", () => {
    const once = withState("hello", s);
    const twice = withState(once.replace("hello", "updated"), { ...s, paused: [] });
    expect(twice).toContain("updated");
    expect(twice.match(/actions-spend-pacer:state/g)).toHaveLength(1);
    expect(parseState(twice).paused).toEqual([]);
  });

  test("no block → empty state", () => {
    expect(parseState("just an issue")).toEqual({ version: 1, paused: [], overrides: [] });
    expect(parseState(null)).toEqual({ version: 1, paused: [], overrides: [] });
  });

  test("corrupt block fails closed", () => {
    const broken = stateBlock(s).replace('"version": 1', '"version": 1,,');
    expect(() => parseState(broken)).toThrow(StateError);
    expect(() => parseState(stateBlock({ ...s, version: 2 as 1 }))).toThrow(/version/);
    const bad = stateBlock(s).replace('"workflowId": 1', '"workflowId": "1"');
    expect(() => parseState(bad)).toThrow(/paused\[0\]/);
  });
});
