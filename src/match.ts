import type { Override, Workflow } from "./types.ts";

/**
 * Allow-list / override entry syntax:
 *   `repo`                          every workflow in that repo
 *   `repo/ci.yml`                   by file name
 *   `repo/.github/workflows/ci.yml` by full path
 * An `owner/` prefix is tolerated and ignored. Repo names compare case-insensitively.
 */
export function matches(entry: string, wf: Pick<Workflow, "repo" | "path">, owner?: string): boolean {
  let e = entry.trim();
  if (!e) return false;
  if (owner && e.toLowerCase().startsWith(owner.toLowerCase() + "/")) {
    const rest = e.slice(owner.length + 1);
    // `owner/repo` vs `repo/ci.yml` is ambiguous when a repo is named like the owner;
    // only strip when what's left still names this repo.
    if (rest.split("/")[0]!.toLowerCase() === wf.repo.toLowerCase()) e = rest;
  }
  const slash = e.indexOf("/");
  const repo = slash < 0 ? e : e.slice(0, slash);
  if (repo.toLowerCase() !== wf.repo.toLowerCase()) return false;
  if (slash < 0) return true;
  const rest = e.slice(slash + 1);
  return rest === wf.path || rest === wf.path.split("/").pop();
}

export function activeOverrides(overrides: Override[], now: Date): Override[] {
  return overrides.filter((o) => Date.parse(o.until) > now.getTime());
}

/** Parse a duration like `90m`, `4h`, `2d`. */
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([mhd])$/i.exec(s.trim());
  if (!m) throw new Error(`Bad duration "${s}"; use e.g. 90m, 4h, 2d.`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]!.toLowerCase() as "m" | "h" | "d"];
  return Number(m[1]) * unit;
}
