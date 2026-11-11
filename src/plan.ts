import { roundCents } from "./allowance.ts";
import { activeOverrides, matches } from "./match.ts";
import type { Override, PausedEntry, State, Workflow } from "./types.ts";

export type Status = "over" | "under" | "holding";

export interface DecideInput {
  now: Date;
  owner: string;
  spend: number;
  allowance: number;
  /** Resume only once spend <= allowance - headroom. */
  headroom: number;
  /** Every workflow in every governed repo whose listing succeeded. */
  workflows: Workflow[];
  /** Repos whose workflow listing failed this run; their state entries are left alone. */
  failedRepos: ReadonlySet<string>;
  state: State;
  allowList: string[];
  includeDynamic: boolean;
}

export interface Dropped {
  entry: PausedEntry;
  reason: string;
}

export interface Skipped {
  workflow: Workflow;
  reason: "allow-list" | "override" | "dynamic" | "not active";
}

export interface Decision {
  /**
   * over: spend > allowance, pause.
   * under: spend <= allowance - headroom, resume.
   * holding: in between (or exactly at the line), change nothing.
   */
  status: Status;
  toPause: Workflow[];
  toResume: PausedEntry[];
  /** Paused entries kept as-is (still paused, waiting for the allowance). */
  stillPaused: PausedEntry[];
  /** State entries forgotten without action, e.g. someone re-enabled the workflow by hand. */
  dropped: Dropped[];
  /** Governed workflows that were left alone this run, and why. */
  skipped: Skipped[];
  /** Overrides still in force after pruning. */
  overrides: Override[];
}

export const key = (repo: string, id: number) => `${repo.toLowerCase()}#${id}`;

export function isDynamic(wf: Pick<Workflow, "path">): boolean {
  return wf.path.startsWith("dynamic/");
}

export function decide(input: DecideInput): Decision {
  const { now, owner, spend, allowance, headroom, workflows, failedRepos, state } = input;
  const overrides = activeOverrides(state.overrides, now);
  const byKey = new Map(workflows.map((w) => [key(w.repo, w.id), w]));

  const allowListed = (w: Workflow) => input.allowList.some((e) => matches(e, w, owner));
  const overridden = (w: Pick<Workflow, "repo" | "path">) => overrides.some((o) => matches(o.match, w, owner));

  const status: Status =
    roundCents(spend) > roundCents(allowance)
      ? "over"
      : roundCents(spend) <= roundCents(allowance - headroom)
        ? "under"
        : "holding";

  const toResume: PausedEntry[] = [];
  const stillPaused: PausedEntry[] = [];
  const dropped: Dropped[] = [];

  for (const entry of state.paused) {
    if (failedRepos.has(entry.repo)) {
      stillPaused.push(entry);
      continue;
    }
    const wf = byKey.get(key(entry.repo, entry.workflowId));
    if (!wf) {
      dropped.push({ entry, reason: "workflow or repo no longer exists or is no longer governed" });
      continue;
    }
    if (wf.state !== "disabled_manually") {
      // Re-enabled by hand, or a pause that was recorded but never applied. Either way,
      // it is not ours to manage any more.
      dropped.push({ entry, reason: `workflow is now ${wf.state}` });
      continue;
    }
    if (status === "under" || overridden(wf) || allowListed(wf)) toResume.push(entry);
    else stillPaused.push(entry);
  }

  const toPause: Workflow[] = [];
  const skipped: Skipped[] = [];
  // Only entries we still track are off-limits. A workflow someone re-enabled by hand while
  // over budget is forgotten above and is paused again like any other; use an override to
  // keep something running.
  const pausedKeys = new Set([...stillPaused, ...toResume].map((e) => key(e.repo, e.workflowId)));

  for (const wf of workflows) {
    if (pausedKeys.has(key(wf.repo, wf.id))) continue;
    if (isDynamic(wf) && !input.includeDynamic) skipped.push({ workflow: wf, reason: "dynamic" });
    else if (allowListed(wf)) skipped.push({ workflow: wf, reason: "allow-list" });
    else if (overridden(wf)) skipped.push({ workflow: wf, reason: "override" });
    else if (wf.state !== "active") skipped.push({ workflow: wf, reason: "not active" });
    else if (status === "over") toPause.push(wf);
  }

  return { status, toPause, toResume, stillPaused, dropped, skipped, overrides };
}
