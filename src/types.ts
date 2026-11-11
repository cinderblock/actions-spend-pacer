export type OwnerType = "user" | "org";
export type Mode = "dry-run" | "live";

/** A workflow in a governed repo, as reported by the Actions API. */
export interface Workflow {
  repo: string;
  id: number;
  path: string;
  name: string;
  /** active | disabled_manually | disabled_inactivity | disabled_fork | deleted */
  state: string;
}

/** A workflow the pacer itself disabled and may later re-enable. */
export interface PausedEntry {
  repo: string;
  workflowId: number;
  path: string;
  name: string;
  pausedAt: string;
}

/** A time-limited exemption, applied by hand (e.g. "let ops deploys run for 4h"). */
export interface Override {
  /** Same syntax as an allow-list entry: `repo` or `repo/<workflow path or file name>`. */
  match: string;
  /** ISO timestamp; the override is ignored (and pruned) after this. */
  until: string;
  reason?: string;
}

/**
 * Extra allowance granted by hand ("add $5 to this month"). Our own accounting: it raises
 * the pacer's line, not GitHub's budget. Only counts in the UTC billing month it was granted.
 */
export interface Grant {
  /** USD added to the allowance. */
  amount: number;
  /** UTC billing month it applies to, `YYYY-MM`. */
  month: string;
  /** Optional earlier expiry (ISO). Without it the grant lasts until the month ends. */
  until?: string;
  reason?: string;
  /** When it was granted (ISO). */
  at: string;
}

export interface State {
  version: 1;
  paused: PausedEntry[];
  overrides: Override[];
  grants: Grant[];
}

export const emptyState = (): State => ({ version: 1, paused: [], overrides: [], grants: [] });

export interface AllowanceConfig {
  /** USD per UTC day of the month. Mutually exclusive with monthlyBudget. */
  dailyRate?: number;
  /** USD per month, prorated by day. Mutually exclusive with dailyRate. */
  monthlyBudget?: number;
}
