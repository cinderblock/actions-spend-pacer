import type { GitHub } from "./github.ts";
import type { OwnerType, Workflow } from "./types.ts";

interface ApiRepo {
  name: string;
  private: boolean;
  visibility?: string;
  archived: boolean;
  owner: { login: string };
}

/**
 * Repos to govern. `all-private` means every non-public, non-archived repo of the owner
 * that the token can see. A fine-grained PAT only sees the repos it was granted, so the
 * token's repository selection is the real scope.
 */
export async function governedRepos(
  gh: GitHub,
  ownerType: OwnerType,
  owner: string,
  repos: "all-private" | string[],
): Promise<string[]> {
  if (repos !== "all-private") return [...new Set(repos.map((r) => r.replace(/^[^/]+\//, "")))];
  const path =
    ownerType === "org"
      ? `/orgs/${owner}/repos?type=all&per_page=100`
      : `/user/repos?affiliation=owner&visibility=private&per_page=100`;
  const all = await gh.paginate<ApiRepo>(path, (p) => p);
  return all
    .filter((r) => r.owner.login.toLowerCase() === owner.toLowerCase())
    .filter((r) => (r.visibility ? r.visibility !== "public" : r.private) && !r.archived)
    .map((r) => r.name)
    .sort((a, b) => a.localeCompare(b));
}

export interface Inventory {
  workflows: Workflow[];
  /** Repo → error message, for repos whose workflow list could not be read. */
  failedRepos: Map<string, string>;
}

export async function listWorkflows(gh: GitHub, owner: string, repo: string): Promise<Workflow[]> {
  const raw = await gh.paginate<{ id: number; path: string; name: string; state: string }>(
    `/repos/${owner}/${repo}/actions/workflows?per_page=100`,
    (p) => p.workflows ?? [],
  );
  return raw.map((w) => ({ repo, id: w.id, path: w.path, name: w.name, state: w.state }));
}

export async function inventory(gh: GitHub, owner: string, repos: string[], concurrency = 8): Promise<Inventory> {
  const workflows: Workflow[] = [];
  const failedRepos = new Map<string, string>();
  const queue = [...repos];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let repo = queue.shift(); repo !== undefined; repo = queue.shift()) {
        try {
          workflows.push(...(await listWorkflows(gh, owner, repo)));
        } catch (e) {
          failedRepos.set(repo, (e as Error).message);
        }
      }
    }),
  );
  workflows.sort((a, b) => a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path));
  return { workflows, failedRepos };
}

export async function setEnabled(gh: GitHub, owner: string, repo: string, id: number, enabled: boolean) {
  await gh.request("PUT", `/repos/${owner}/${repo}/actions/workflows/${id}/${enabled ? "enable" : "disable"}`);
}
