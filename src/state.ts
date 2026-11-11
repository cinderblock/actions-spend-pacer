import type { Override, PausedEntry, State } from "./types.ts";
import { emptyState } from "./types.ts";

export const STATE_MARKER = "actions-spend-pacer:state";
const BLOCK = new RegExp(`<!--\\s*${STATE_MARKER}\\s*\\n([\\s\\S]*?)\\n\\s*-->`);

export class StateError extends Error {}

/**
 * Read state from an issue body. Returns an empty state when the body has no state block
 * (a brand-new issue). Throws StateError when a block exists but is unreadable, so the
 * caller fails closed instead of forgetting what it paused.
 */
export function parseState(body: string | null | undefined): State {
  const m = BLOCK.exec(body ?? "");
  if (!m) return emptyState();
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]!);
  } catch (e) {
    throw new StateError(`State block is not valid JSON: ${(e as Error).message}`);
  }
  return validateState(raw);
}

export function validateState(raw: unknown): State {
  const fail = (why: string): never => {
    throw new StateError(`State block is malformed: ${why}`);
  };
  if (!raw || typeof raw !== "object") fail("not an object");
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) fail(`unsupported version ${JSON.stringify(o.version)}`);
  const paused = o.paused ?? [];
  const overrides = o.overrides ?? [];
  if (!Array.isArray(paused)) fail("paused is not an array");
  if (!Array.isArray(overrides)) fail("overrides is not an array");
  const str = (v: unknown) => typeof v === "string" && v.length > 0;
  (paused as unknown[]).forEach((p, i) => {
    const e = p as Partial<PausedEntry>;
    if (!e || !str(e.repo) || !Number.isInteger(e.workflowId) || typeof e.path !== "string")
      fail(`paused[${i}] needs repo, workflowId and path`);
  });
  (overrides as unknown[]).forEach((p, i) => {
    const e = p as Partial<Override>;
    if (!e || !str(e.match) || !str(e.until) || Number.isNaN(Date.parse(e.until!)))
      fail(`overrides[${i}] needs match and a valid until`);
  });
  return { version: 1, paused: paused as PausedEntry[], overrides: overrides as Override[] };
}

/** Serialise state into a hidden HTML comment. `-->` can never appear inside it. */
export function stateBlock(state: State): string {
  const json = JSON.stringify(state, null, 2).replace(/-->/g, "--\\u003e");
  return `<!-- ${STATE_MARKER}\n${json}\n-->`;
}

/** Replace (or append) the state block in an issue body, keeping everything else. */
export function withState(body: string, state: State): string {
  const block = stateBlock(state);
  return BLOCK.test(body) ? body.replace(BLOCK, () => block) : `${body.trimEnd()}\n\n${block}\n`;
}
