import { createHash } from "node:crypto";
import { type Allowance, catchUpDay, grantTotal } from "./allowance.ts";
import type { Spend } from "./billing.ts";
import type { Applied } from "./controls.ts";
import type { Decision } from "./plan.ts";
import type { Mode, PausedEntry, Workflow } from "./types.ts";

export interface Outcome {
  paused: Workflow[];
  resumed: PausedEntry[];
  failed: { what: string; error: string }[];
}

export interface ReportInput {
  now: Date;
  owner: string;
  mode: Mode;
  timezone: string;
  redact: boolean;
  headroom: number;
  allowance: Allowance;
  spend: Spend;
  decision: Decision;
  outcome?: Outcome;
  failedRepos: Map<string, string>;
  governedRepoCount: number;
  workflowCount: number;
  tokenExpiration?: Date;
  stateLocation: string;
  /** Checkbox changes picked up from the status issue this run. */
  ticks?: Applied[];
}

const usd = (x: number) => `$${x.toFixed(2)}`;

/** Stable opaque label for a private repo name, used when output is public. */
export function redactRepo(owner: string, repo: string): string {
  const h = createHash("sha256").update(`${owner.toLowerCase()}/${repo.toLowerCase()}`).digest("hex");
  return `repo-${h.slice(0, 6)}`;
}

export function namer(owner: string, redact: boolean) {
  const repo = (r: string) => (redact ? redactRepo(owner, r) : r);
  const wf = (w: { repo: string; path: string; name: string; id?: number; workflowId?: number }) =>
    redact ? `${repo(w.repo)} workflow ${w.id ?? w.workflowId}` : `${w.repo} / ${w.name} (\`${w.path}\`)`;
  /** Replace repo names inside API paths in error text. */
  const scrub = (text: string) =>
    redact ? text.replace(/\/repos\/([^/\s]+)\/([^/\s]+)/g, (_, o: string, r: string) => `/repos/${o}/${repo(r)}`) : text;
  return { repo, wf, scrub };
}

/** `Nov 10, 2026 6:55 PM PST (02:55Z)`; local first, UTC alongside. */
export function formatTime(d: Date, timeZone: string): string {
  const utc = `${d.toISOString().slice(11, 16)}Z`;
  if (timeZone.toUpperCase() === "UTC") return `${d.toISOString().slice(0, 10)} ${utc}`;
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(d);
  return `${local.replace(/,(?=\s\d{1,2}:)/, "")} (${utc})`;
}

export function headline(r: Pick<ReportInput, "spend" | "allowance" | "decision">): string {
  const { spend, allowance: a, decision } = r;
  const diff = spend.total - decision.effectiveAllowance;
  const granted = grantTotal(decision.grants);
  const line = granted
    ? `**${usd(decision.effectiveAllowance)}** (${usd(a.amount)} for UTC day ${a.day} of ${a.daysInMonth} × ${usd(a.perDay)}/day, + ${usd(granted)} granted)`
    : `**${usd(a.amount)}** (UTC day ${a.day} of ${a.daysInMonth} × ${usd(a.perDay)}/day)`;
  const where =
    decision.status === "over"
      ? `**over by ${usd(diff)}**`
      : decision.status === "under"
        ? `under by ${usd(-diff)}`
        : `within the resume headroom (${usd(-diff)} under)`;
  return `Month-to-date Actions spend **${usd(spend.total)}** vs allowance ${line}: ${where}.`;
}

export function renderReport(r: ReportInput): string {
  const n = namer(r.owner, r.redact);
  const { decision: d, allowance: a } = r;
  const live = r.mode === "live";
  const out: string[] = [];
  out.push(`## Actions spend pacer: \`${r.owner}\`${live ? "" : " (dry run)"}`);
  out.push("");
  out.push(`${formatTime(r.now, r.timezone)}. ${headline(r)}`);
  out.push("");

  const paused = r.outcome?.paused ?? d.toPause;
  const resumed = r.outcome?.resumed ?? d.toResume;
  const verbPause = live ? "Paused" : "Would pause";
  const verbResume = live ? "Resumed" : "Would resume";

  if (paused.length) {
    out.push(`### ${verbPause} ${paused.length} workflow${paused.length === 1 ? "" : "s"}`, "");
    for (const w of paused) out.push(`- ${n.wf(w)}`);
    out.push("");
  }
  if (resumed.length) {
    out.push(`### ${verbResume} ${resumed.length} workflow${resumed.length === 1 ? "" : "s"}`, "");
    for (const e of resumed) out.push(`- ${n.wf(e)}`);
    out.push("");
  }
  if (!paused.length && !resumed.length) {
    out.push(live ? "No changes this run." : "No changes would be made.", "");
  }
  if (r.ticks?.length) {
    out.push("### From the status issue", "");
    for (const t of r.ticks)
      out.push(
        t.kind === "resume"
          ? `- Ticked: run ${n.wf(t.entry)} until ${formatTime(new Date(t.override.until), r.timezone)}`
          : `- Unticked: override ${r.redact ? "(redacted)" : `\`${t.override.match}\``} ended`,
      );
    out.push("");
  }
  if (r.outcome?.failed.length) {
    out.push("### ⚠️ Failures", "");
    for (const f of r.outcome.failed) out.push(`- ${f.what}: ${n.scrub(f.error)}`);
    out.push("");
  }

  const nowPaused = live ? d.stillPaused.length + paused.length : d.stillPaused.length + d.toPause.length;
  if (nowPaused > 0 || d.status !== "under") {
    const day = catchUpDay(a, r.spend.total, r.headroom, grantTotal(d.grants));
    const when =
      day === undefined
        ? "at the start of next month (UTC)"
        : `on ${a.year}-${String(a.month).padStart(2, "0")}-${String(day).padStart(2, "0")} (UTC) if nothing more is spent`;
    if (nowPaused > 0) out.push(`${nowPaused} workflow(s) ${live ? "are" : "would be"} paused. They resume ${when}.`, "");
  }

  if (d.dropped.length) {
    out.push("### Forgotten (no longer managed by the pacer)", "");
    for (const x of d.dropped) out.push(`- ${n.wf(x.entry)}: ${x.reason}`);
    out.push("");
  }
  if (d.grants.length) {
    out.push("### Grants this month", "");
    for (const g of d.grants)
      out.push(
        `- ${usd(g.amount)}${g.until ? ` until ${formatTime(new Date(g.until), r.timezone)}` : " for the rest of the month"}${g.reason && !r.redact ? `: ${g.reason}` : ""}`,
      );
    out.push("");
  }
  if (d.overrides.length) {
    out.push("### Active overrides", "");
    for (const o of d.overrides)
      out.push(
        `- ${r.redact ? "(redacted)" : `\`${o.match}\``} until ${formatTime(new Date(o.until), r.timezone)}${o.reason && !r.redact ? `: ${o.reason}` : ""}`,
      );
    out.push("");
  }
  if (r.failedRepos.size) {
    out.push("### ⚠️ Repos whose workflows could not be listed", "");
    for (const [repo, err] of r.failedRepos) out.push(`- ${n.repo(repo)}: ${n.scrub(err)}`);
    out.push("");
  }
  if (r.tokenExpiration) {
    const days = (r.tokenExpiration.getTime() - r.now.getTime()) / 86_400_000;
    if (days < 14) out.push(`> [!WARNING]\n> The pacer token expires ${formatTime(r.tokenExpiration, r.timezone)} (${days.toFixed(1)} days). Rotate it.`, "");
  }

  out.push("<details><summary>Spend breakdown</summary>", "");
  out.push("| Repository | Net |", "| --- | ---: |");
  for (const [repo, v] of Object.entries(r.spend.byRepo).sort((x, y) => y[1] - x[1]))
    out.push(`| ${repo === "(no repository)" ? repo : n.repo(repo)} | ${usd(v)} |`);
  out.push("", "| SKU | Net |", "| --- | ---: |");
  for (const [sku, v] of Object.entries(r.spend.bySku).sort((x, y) => y[1] - x[1])) out.push(`| ${sku} | ${usd(v)} |`);
  out.push("", "| UTC day | Net that day | Month to date | Allowance |", "| --- | ---: | ---: | ---: |");
  let mtd = 0;
  for (const [day, v] of Object.entries(r.spend.byDay).sort()) {
    mtd += v;
    out.push(`| ${day} | ${usd(v)} | ${usd(mtd)} | ${usd(a.perDay * Number(day.slice(8)))} |`);
  }
  out.push("", "</details>", "");

  const governedOther = d.stillPaused.length;
  out.push("<details><summary>Governed workflows</summary>", "");
  out.push(
    `${r.governedRepoCount} repos, ${r.workflowCount} workflows. ${governedOther} still paused from earlier runs. ${d.skipped.length} skipped:`,
    "",
  );
  for (const s of d.skipped) out.push(`- ${n.wf(s.workflow)}: ${s.reason}${s.reason === "not active" ? ` (${s.workflow.state})` : ""}`);
  for (const e of d.stillPaused) out.push(`- ${n.wf(e)}: paused since ${formatTime(new Date(e.pausedAt), r.timezone)}`);
  out.push("", "</details>", "");
  out.push(`State: ${r.stateLocation}. Billing data lags by hours, so this is a soft cap.`);
  return out.join("\n");
}
