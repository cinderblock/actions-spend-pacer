import { readFileSync } from "node:fs";
import * as core from "@actions/core";
import { parseConfig } from "./config.ts";
import { GitHub } from "./github.ts";
import { namer } from "./report.ts";
import { run } from "./run.ts";
import { IssueStore } from "./store.ts";

/** Whether logs/summaries of this run are public. Unknown → assume public (redact). */
function runningRepoIsPublic(): boolean {
  try {
    const ev = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
    if (typeof ev?.repository?.private === "boolean") return !ev.repository.private;
  } catch {}
  return true;
}

/** GitHub auto-disables schedules in public repos after 60 days without activity. */
async function keepalive(token: string): Promise<void> {
  const ref = process.env.GITHUB_WORKFLOW_REF; // owner/repo/.github/workflows/x.yml@refs/...
  const m = ref ? /^([^/]+\/[^/]+)\/(.+?)@/.exec(ref) : null;
  if (!m) return;
  const file = m[2]!.split("/").pop()!;
  try {
    await new GitHub(token).request("PUT", `/repos/${m[1]}/actions/workflows/${file}/enable`);
    core.info(`Keepalive: re-enabled ${m[1]}/${file}.`);
  } catch (e) {
    core.warning(`Keepalive failed (needs actions: write on the workflow token): ${(e as Error).message}`);
  }
}

async function main() {
  const [repoOwner] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
  const cfg = parseConfig((n) => core.getInput(n), { owner: repoOwner, repoIsPublic: runningRepoIsPublic() });
  const scrub = namer(cfg.owner, cfg.redact).scrub;

  const token = core.getInput("token", { required: true });
  core.setSecret(token);
  const workflowToken = core.getInput("github-token");
  const stateRepo = core.getInput("state-repo") || process.env.GITHUB_REPOSITORY!;
  const stateToken = core.getInput("state-token") || workflowToken;
  const trusted = [cfg.owner, repoOwner!, "github-actions[bot]", ...core.getInput("trusted-authors").split(/[\s,]+/)];
  const store = new IssueStore(
    new GitHub(stateToken),
    stateRepo,
    core.getInput("state-issue-title") || "Actions spend pacer",
    trusted.filter(Boolean),
  );

  try {
    const result = await run(cfg, { gh: new GitHub(token), store, now: new Date(), log: (m) => core.info(m) });
    await core.summary.addRaw(result.report).write();
    core.setOutput("status", result.decision.status);
    core.setOutput("spend", result.spend.toFixed(2));
    core.setOutput("allowance", result.allowance.toFixed(2));
    core.setOutput("paused-count", String(result.outcome?.paused.length ?? result.decision.toPause.length));
    core.setOutput("resumed-count", String(result.outcome?.resumed.length ?? result.decision.toResume.length));
    if (result.outcome?.failed.length) core.setFailed(`${result.outcome.failed.length} workflow toggles failed; see summary.`);
  } catch (e) {
    core.setFailed(scrub(e instanceof Error ? e.message : String(e)));
  }

  if (core.getBooleanInput("keepalive") && workflowToken) await keepalive(workflowToken);
}

main().catch((e) => core.setFailed(e instanceof Error ? e.message : String(e)));
