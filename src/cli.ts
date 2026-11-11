#!/usr/bin/env bun
/**
 * Local CLI. Dry run (the default) is read-only:
 *   bun src/cli.ts run --owner you --timezone America/Los_Angeles
 * Manual override (writes the state issue; pacer applies it on its next run, or now with --now):
 *   bun src/cli.ts override ops/deploy.yml --for 4h --reason "hotfix" --state-repo you/pacer --owner you
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { parseConfig } from "./config.ts";
import { GitHub } from "./github.ts";
import { matches, parseDuration } from "./match.ts";
import { run } from "./run.ts";
import { IssueStore, MemoryStore, type StateStore } from "./store.ts";
import { governedRepos, inventory, setEnabled } from "./workflows.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    owner: { type: "string" },
    "owner-type": { type: "string" },
    "daily-rate": { type: "string" },
    "monthly-budget": { type: "string" },
    "resume-headroom": { type: "string" },
    repos: { type: "string" },
    "allow-list": { type: "string", multiple: true },
    "include-dynamic": { type: "boolean" },
    timezone: { type: "string" },
    redact: { type: "boolean" },
    "state-repo": { type: "string" },
    "state-issue-title": { type: "string" },
    live: { type: "boolean" },
    yes: { type: "boolean" },
    json: { type: "boolean" },
    for: { type: "string" },
    reason: { type: "string" },
    now: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const usage = `actions-spend-pacer run [--owner o] [--daily-rate 1 | --monthly-budget 30] [--resume-headroom 0.5]
                        [--repos a,b | all-private] [--allow-list repo/ci.yml ...] [--include-dynamic]
                        [--timezone America/Los_Angeles] [--redact] [--state-repo o/r] [--json]
                        [--live --yes]   (live needs --state-repo)
actions-spend-pacer override <repo[/workflow]> --for 4h [--reason text] [--now] --state-repo o/r --owner o
Token: GITHUB_TOKEN, GH_TOKEN, or \`gh auth token\`.`;

function token(): string {
  const t = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (t) return t;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("No token: set GITHUB_TOKEN or log in with `gh auth login`.");
  }
}

async function main() {
  const [cmd = "run", ...rest] = positionals;
  if (values.help) return console.log(usage);
  const gh = new GitHub(token());
  const owner = values.owner ?? (await gh.request<{ login: string }>("GET", "/user")).login;
  const stateRepo = values["state-repo"];
  const store: StateStore = stateRepo
    ? new IssueStore(gh, stateRepo, values["state-issue-title"] ?? "Actions spend pacer", [owner, "github-actions[bot]"])
    : new MemoryStore();

  if (cmd === "run") {
    if (values.live && (!stateRepo || !values.yes))
      throw new Error("--live needs --state-repo (to remember what it paused) and --yes.");
    const cfg = parseConfig(
      (n) => {
        if (n === "mode") return values.live ? "live" : "dry-run";
        if (n === "owner") return owner;
        if (n === "allow-list") return values["allow-list"]?.join("\n");
        if (n === "redact") return values.redact ? "true" : "false";
        const v = (values as Record<string, unknown>)[n];
        return typeof v === "boolean" ? String(v) : (v as string | undefined);
      },
      { owner },
    );
    const result = await run(cfg, { gh, store, now: new Date(), log: (m) => console.error(`· ${m}`) });
    if (values.json) {
      const { decision: d } = result;
      console.log(
        JSON.stringify(
          { status: d.status, spend: result.spend, allowance: result.allowance, toPause: d.toPause, toResume: d.toResume, stillPaused: d.stillPaused, dropped: d.dropped, skipped: d.skipped, outcome: result.outcome },
          null,
          2,
        ),
      );
    } else console.log(result.report);
    return;
  }

  if (cmd === "override") {
    const match = rest[0];
    if (!match || !values.for || !stateRepo) throw new Error(`override needs <match>, --for and --state-repo.\n${usage}`);
    const until = new Date(Date.now() + parseDuration(values.for)).toISOString();
    const state = await store.load();
    state.overrides = [...state.overrides.filter((o) => o.match !== match), { match, until, reason: values.reason }];
    let resumedNow: string[] = [];
    if (values.now) {
      const hit = state.paused.filter((e) => matches(match, e, owner));
      for (const e of hit) {
        await setEnabled(gh, owner, e.repo, e.workflowId, true);
        resumedNow.push(`${e.repo}/${e.path}`);
      }
      state.paused = state.paused.filter((e) => !hit.includes(e));
    }
    const note = `Override \`${match}\` until ${until}${values.reason ? `: ${values.reason}` : ""}.${resumedNow.length ? ` Re-enabled now: ${resumedNow.length}.` : ""}`;
    await store.save(state, `${note}\n\nThe next scheduled run rewrites this status.`);
    await store.notify(note);
    console.log(`${note}\nState: ${store.describe()}`);
    return;
  }

  // Read-only helper: what does the pacer see?
  if (cmd === "inventory") {
    const repos = await governedRepos(gh, (values["owner-type"] as "user" | "org") ?? "user", owner, "all-private");
    const inv = await inventory(gh, owner, repos);
    for (const w of inv.workflows) console.log(`${w.repo}\t${w.state}\t${w.path}\t${w.name}`);
    for (const [r, e] of inv.failedRepos) console.error(`! ${r}: ${e}`);
    return;
  }
  throw new Error(`Unknown command "${cmd}".\n${usage}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
