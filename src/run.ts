import { allowanceAt } from "./allowance.ts";
import { fetchSpend } from "./billing.ts";
import { applyTicks, renderControls } from "./controls.ts";
import type { GitHub } from "./github.ts";
import { decide, key, type Decision } from "./plan.ts";
import { type Outcome, namer, renderReport } from "./report.ts";
import type { StateStore } from "./store.ts";
import type { AllowanceConfig, Mode, OwnerType, PausedEntry, State } from "./types.ts";
import { governedRepos, inventory, setEnabled } from "./workflows.ts";

export interface Config {
  owner: string;
  ownerType: OwnerType;
  allowance: AllowanceConfig;
  headroom: number;
  repos: "all-private" | string[];
  allowList: string[];
  includeDynamic: boolean;
  mode: Mode;
  timezone: string;
  redact: boolean;
  /** Redaction for what goes into the state issue. Defaults to `redact`; false when the state repo is private. */
  stateRedact?: boolean;
  /** How long ticking "Run … for Nh" in the status issue lets a workflow run. Default 4. */
  controlHours?: number;
  webhookUrl?: string;
}

export interface RunResult {
  decision: Decision;
  outcome?: Outcome;
  report: string;
  changed: boolean;
  spend: number;
  allowance: number;
}

export interface Deps {
  gh: GitHub;
  store: StateStore;
  now: Date;
  log: (msg: string) => void;
  fetchImpl?: typeof fetch;
}

export async function run(cfg: Config, deps: Deps): Promise<RunResult> {
  const { gh, store, now, log } = deps;
  const a = allowanceAt(now, cfg.allowance);
  const spend = await fetchSpend(gh, cfg.ownerType, cfg.owner, a.year, a.month);
  log(`Spend ${spend.total.toFixed(2)} vs allowance ${a.amount.toFixed(2)}`);

  const loaded = await store.load();
  const { state, applied: ticks } = applyTicks(loaded, store.controls?.() ?? [], cfg.owner, now, cfg.controlHours ?? 4);
  const repos = await governedRepos(gh, cfg.ownerType, cfg.owner, cfg.repos);
  const inv = await inventory(gh, cfg.owner, repos);
  log(`${repos.length} governed repos, ${inv.workflows.length} workflows, ${inv.failedRepos.size} unreadable`);

  const decision = decide({
    now,
    owner: cfg.owner,
    spend: spend.total,
    allowance: a.amount,
    headroom: cfg.headroom,
    workflows: inv.workflows,
    failedRepos: new Set(inv.failedRepos.keys()),
    state,
    allowList: cfg.allowList,
    includeDynamic: cfg.includeDynamic,
  });

  const reportFor = (outcome?: Outcome, redact = cfg.redact) =>
    renderReport({
      now,
      owner: cfg.owner,
      mode: cfg.mode,
      timezone: cfg.timezone,
      redact,
      headroom: cfg.headroom,
      allowance: a,
      spend,
      decision,
      outcome,
      failedRepos: inv.failedRepos,
      governedRepoCount: repos.length,
      workflowCount: inv.workflows.length,
      tokenExpiration: gh.tokenExpiration,
      stateLocation: store.describe(),
      ticks,
    });

  const base = { decision, spend: spend.total, allowance: decision.effectiveAllowance };
  if (cfg.mode !== "live") return { ...base, report: reportFor(), changed: false };

  const outcome = await apply(cfg, deps, loaded, decision, reportFor);
  const report = reportFor(outcome);
  const changed = outcome.paused.length + outcome.resumed.length > 0;
  if (changed || outcome.failed.length) {
    await store.notify(reportFor(outcome, cfg.stateRedact ?? cfg.redact));
    if (cfg.webhookUrl) await postWebhook(cfg, deps, outcome, base).catch((e) => log(`Webhook failed: ${e.message}`));
  }
  return { ...base, outcome, report, changed };
}

/**
 * Apply a decision with crash-safe ordering:
 *   pause:  record intent → persist → disable (a recorded-but-active entry is dropped next run)
 *   resume: enable → forget → persist (a resumed-but-recorded entry is seen active and dropped)
 */
async function apply(
  cfg: Config,
  deps: Deps,
  prev: State,
  d: Decision,
  reportFor: (o?: Outcome, redact?: boolean) => string,
): Promise<Outcome> {
  const { gh, store, now, log } = deps;
  const n = namer(cfg.owner, cfg.redact);
  const stateRedact = cfg.stateRedact ?? cfg.redact;
  const issueReport = (o?: Outcome) =>
    [
      reportFor(o, stateRedact),
      renderControls({
        owner: cfg.owner,
        redact: stateRedact,
        timezone: cfg.timezone,
        hours: cfg.controlHours ?? 4,
        paused: [...paused.values()],
        overrides: d.overrides,
      }),
    ]
      .filter(Boolean)
      .join("\n\n");
  const outcome: Outcome = { paused: [], resumed: [], failed: [] };
  const paused = new Map<string, PausedEntry>();
  for (const e of [...d.stillPaused, ...d.toResume]) paused.set(key(e.repo, e.workflowId), e);
  const intents = d.toPause.map(
    (w): PausedEntry => ({ repo: w.repo, workflowId: w.id, path: w.path, name: w.name, pausedAt: now.toISOString() }),
  );
  for (const e of intents) paused.set(key(e.repo, e.workflowId), e);
  const snapshot = (): State => ({ version: 1, paused: [...paused.values()], overrides: d.overrides, grants: d.grants });

  const stateChanged =
    intents.length > 0 ||
    d.dropped.length > 0 ||
    d.toResume.length > 0 ||
    JSON.stringify(d.overrides) !== JSON.stringify(prev.overrides) ||
    JSON.stringify(d.grants) !== JSON.stringify(prev.grants);
  if (stateChanged) await store.save(snapshot(), issueReport()); // fails → nothing disabled

  for (const w of d.toPause) {
    try {
      await setEnabled(gh, cfg.owner, w.repo, w.id, false);
      outcome.paused.push(w);
      log(`Paused ${n.wf(w)}`);
    } catch (e) {
      paused.delete(key(w.repo, w.id));
      outcome.failed.push({ what: `pause ${n.wf(w)}`, error: (e as Error).message });
    }
  }
  for (const e of d.toResume) {
    try {
      await setEnabled(gh, cfg.owner, e.repo, e.workflowId, true);
      paused.delete(key(e.repo, e.workflowId));
      outcome.resumed.push(e);
      log(`Resumed ${n.wf(e)}`);
    } catch (err) {
      outcome.failed.push({ what: `resume ${n.wf(e)}`, error: (err as Error).message });
    }
  }
  await store.save(snapshot(), issueReport(outcome));
  return outcome;
}

async function postWebhook(cfg: Config, deps: Deps, o: Outcome, base: { spend: number; allowance: number }) {
  const res = await (deps.fetchImpl ?? fetch)(cfg.webhookUrl!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "actions-spend-pacer",
      owner: cfg.owner,
      at: deps.now.toISOString(),
      spend: base.spend,
      allowance: base.allowance,
      paused: o.paused.map((w) => ({ repo: w.repo, workflow: w.path, name: w.name })),
      resumed: o.resumed.map((e) => ({ repo: e.repo, workflow: e.path, name: e.name })),
      failures: o.failed,
      text: `Actions spend pacer (${cfg.owner}): $${base.spend.toFixed(2)} of $${base.allowance.toFixed(2)}; paused ${o.paused.length}, resumed ${o.resumed.length}.`,
    }),
  });
  if (!res.ok) throw new Error(`webhook → ${res.status}`);
}
