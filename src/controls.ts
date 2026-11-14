/**
 * Checkboxes in the status issue: the owner ticks a box on their phone and the next run acts
 * on it, no CLI needed.
 *
 *   - [ ] Run <workflow> for 4h        tick → a time-limited override, so the next run resumes it
 *   - [x] Override <match> until <t>   untick → the override ends now
 *
 * Each line carries an opaque key in a hidden comment. Keys never contain repo or workflow
 * names, so they are safe in a public issue. Saving the status re-renders the boxes, which
 * consumes the ticks.
 */
import { createHash } from "node:crypto";
import { formatTime, namer, redactRepo } from "./report.ts";
import type { Override, PausedEntry, State } from "./types.ts";

export interface Tick {
  kind: "resume" | "override";
  key: string;
  checked: boolean;
}

export type Applied = { kind: "resume"; entry: PausedEntry; override: Override } | { kind: "end"; override: Override };

const LINE = /^\s*[-*] \[( |x|X)\] .*<!-- pacer:(resume|override):([A-Za-z0-9_-]+) -->\s*$/;

export function parseTicks(body: string | null | undefined): Tick[] {
  const ticks: Tick[] = [];
  for (const line of (body ?? "").split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (m) ticks.push({ kind: m[2] as Tick["kind"], key: m[3]!, checked: m[1] !== " " });
  }
  return ticks;
}

export const resumeKey = (owner: string, e: { repo: string; workflowId: number }) =>
  `${redactRepo(owner, e.repo)}-${e.workflowId}`;

export const overrideKey = (o: Override) =>
  createHash("sha256").update(`${o.match}|${o.until}`).digest("hex").slice(0, 10);

/** Turn ticks into state changes. Returns a new state; the input is not modified. */
export function applyTicks(
  state: State,
  ticks: Tick[],
  owner: string,
  now: Date,
  hours: number,
): { state: State; applied: Applied[] } {
  const applied: Applied[] = [];
  let overrides = [...state.overrides];
  for (const t of ticks) {
    if (t.kind === "resume" && t.checked) {
      const entry = state.paused.find((e) => resumeKey(owner, e) === t.key);
      if (!entry) continue;
      const override: Override = {
        match: `${entry.repo}/${entry.path}`,
        until: new Date(now.getTime() + hours * 3_600_000).toISOString(),
        reason: "ticked in the status issue",
      };
      overrides = [...overrides.filter((o) => o.match !== override.match), override];
      applied.push({ kind: "resume", entry, override });
    } else if (t.kind === "override" && !t.checked) {
      const override = overrides.find((o) => overrideKey(o) === t.key);
      if (!override) continue;
      overrides = overrides.filter((o) => o !== override);
      applied.push({ kind: "end", override });
    }
  }
  return { state: { ...state, overrides }, applied };
}

export interface ControlsInput {
  owner: string;
  redact: boolean;
  timezone: string;
  hours: number;
  /** Workflows the pacer holds paused after this run. */
  paused: PausedEntry[];
  overrides: Override[];
}

/** The checkbox section of the status issue. Empty when there is nothing to control. */
export function renderControls(c: ControlsInput): string {
  if (!c.paused.length && !c.overrides.length) return "";
  const n = namer(c.owner, c.redact);
  const out = ["### Controls", "", "Tick or untick a box; the next run acts on it.", ""];
  for (const e of c.paused)
    out.push(`- [ ] Run ${n.wf(e)} for ${c.hours}h <!-- pacer:resume:${resumeKey(c.owner, e)} -->`);
  for (const o of c.overrides)
    out.push(
      `- [x] Override ${c.redact ? "(redacted)" : `\`${o.match}\``} until ${formatTime(new Date(o.until), c.timezone)} (untick to end it) <!-- pacer:override:${overrideKey(o)} -->`,
    );
  out.push("");
  return out.join("\n");
}
