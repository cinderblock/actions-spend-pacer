# GitHub Actions spend watchdog

## Goal

Keep GitHub Actions spending on a **running allowance** (default $1 × day of month) by
disabling workflows in governed private repos when month-to-date net spend is over the
allowance, and re-enabling **only the workflows it disabled itself** once the allowance
catches up. It sits in front of the account's $20/month "stop usage" budget, which halts
*every* hosted job (ops deploys included) until the month resets.

Built from day one as a **public, reusable** action + reusable workflow that anyone can drop
in; `cinderblock` is the first user.

Background: the ops thread "Boot-check app images before Renovate deploys them"
(`t3-thread://v2/ab3781d7-a1dd-4bbb-b3e9-6331e19b7569/...`), plan
`C:\Users\camer\.t3\worktrees\ops\renovate-app-smoke\plans\renovate-app-smoke-check.md`.

## Environment / context

- Local repo: `C:\Users\camer\.t3\scratch\2026-11-11-build-a-github-actions-spend-f25b2def`
  (`git init`, branch `master`). **Not on GitHub yet**; creating the repo needs a yes.
- Tooling: gh 2.83.2 (logged in as `cinderblock`, classic-style `gho_` token with `repo`,
  `user`, `workflow`), Bun 1.4.2, Node 26.12.1. Windows 11, local zone America/Los_Angeles.
- Billing data is per **UTC** day; the month boundary is UTC midnight.
- Account: 59 non-archived private repos, 43 workflows across 16 of them (all `active` as of
  2026-11-10 6:55 PM PST (02:55Z Nov 11)). Inventory command is in Findings.

## Decisions already made (don't re-ask)

- Running allowance, not a per-day cap: `allowance = rate × UTC day-of-month`
  (or `monthly × day / days_in_month`). Compare against month-to-date **net** Actions spend.
- Over → `PUT .../actions/workflows/{id}/disable` on governed workflows; in-progress runs
  finish. Under again → re-enable only what the watchdog disabled. Never re-enable a
  workflow the user disabled. Optional allow-list of never-pause workflows.
- Lives in a public repo so its standard-runner jobs are free and keep running after the
  hard stop trips (claim to be verified, see Open questions).
- Own fine-grained PAT: user **Plan: read** + repository **Actions: read and write** on the
  governed private repos only. Stored as a secret in the watchdog repo.
- Runs every few hours; soft cap; the $20 hard stop stays as backstop.
- Notifications: job summary + issue/comment in the watchdog repo; optional webhook.
- Every outward step is staged for an explicit yes: repo creation, token, secret, enabling
  the schedule, first live (disabling) run, Marketplace/README/announcement.
- Nothing is disabled on `cinderblock` until a dry run has been shown and approved.
- Don't edit ops or apitorrent workflows; only toggle via the API, only after a yes.
- Bun for dev/test (`bun.lock` committed); the action itself runs on GitHub's Node runtime.

## Proposed design (awaiting yes on name + layout)

### Name

**`cinderblock/actions-spend-pacer`**, Marketplace title "Actions Spend Pacer".
"Pacer" says what it does (keeps spend on a pace line) where "watchdog" suggests a kill
switch. No existing repos use the name. Fallback: `actions-spend-watchdog` (also unused).
`actions-watchdog` is taken in spirit by three unrelated repos and would be confusing.

### Packaging

1. **JS action** (`action.yml`, `runs.using: node24`, bundled `dist/index.js`) holding all
   logic. TypeScript, built with `bun build --target=node`; `dist/` committed (standard for
   JS actions), CI fails if `dist/` is stale.
2. **Reusable workflow** `.github/workflows/pacer.yml` (`on: workflow_call`) wrapping the
   action with `concurrency` and the right `permissions`, for the one-file setup.
3. **CLI entry** (`bunx actions-spend-pacer --dry-run`, same core) so anyone (including us,
   now) can dry-run locally with their own gh token before creating anything. This is how
   milestone 2 runs without any outward step.
4. This repo's own caller workflow `.github/workflows/watchdog.yml` (cron) for `cinderblock`.

### Layout

```
action.yml                    # JS action metadata + inputs
src/
  allowance.ts                # pure: allowance(date, rate|monthly), resume threshold
  billing.ts                  # fetch MTD net spend (user or org), per-repo breakdown
  workflows.ts                # list governed repos/workflows, disable/enable
  state.ts                    # state model + (de)serialise from the status issue
  plan.ts                     # pure: decide pause/resume set from spend, state, inventory
  notify.ts                   # job summary, issue comment, optional webhook
  main.ts                     # action entry
  cli.ts                      # local CLI entry (dry run by default)
test/                         # bun test: allowance math, plan/bookkeeping, state parsing
dist/index.js                 # bundled action (committed)
.github/workflows/
  pacer.yml                   # reusable workflow (workflow_call)
  watchdog.yml                # cinderblock's own schedule (starts dry-run, schedule off)
  ci.yml                      # typecheck, test, dist-up-to-date
plans/actions-spend-watchdog.md
README.md  LICENSE  ISSUES.md
```

### Inputs (action and reusable workflow)

| Input | Default | Meaning |
| --- | --- | --- |
| `token` | (required) | Fine-grained PAT (secret) |
| `owner` | repo owner | User or org whose spend is governed |
| `owner-type` | `user` | `user` or `org` (org needs Org Administration: read) |
| `daily-rate` | `1.00` | Allowance per UTC day, USD |
| `monthly-budget` | — | Alternative: prorated monthly amount (mutually exclusive) |
| `resume-headroom` | `0` | Resume only when spend ≤ allowance − headroom |
| `repos` | `all-private` | `all-private` or newline list of repo names |
| `allow-list` | — | `repo` or `repo/workflow-file.yml` never paused |
| `include-dynamic` | `false` | Also govern `dynamic/...` workflows (Copilot agent etc.) |
| `mode` | `dry-run` | `dry-run` or `live`; live must be opted into |
| `state-issue-title` | `Actions spend pacer status` | Status/state issue in the running repo |
| `webhook-url` | — | Optional POST of a JSON event on pause/resume |

### Decision logic (per run)

1. `spend` = Σ `netAmount` of `product == actions` items for the current UTC year/month
   (always pass `year` and `month`).
2. `allowance` = rate × day (or prorated monthly).
3. If `spend > allowance`: pause every governed workflow that is `active`, not allow-listed,
   not dynamic (unless opted in). Record each in state. Workflows already disabled (any
   state) are never recorded, so a manually disabled one is never re-enabled later.
4. If `spend ≤ allowance − headroom` and state has paused workflows: for each, re-enable
   only if it is still `disabled_manually`; if someone already re-enabled it, or it was
   deleted, just drop it from state. Remove from state on success.
5. New month: spend resets, so step 4 resumes everything automatically.
6. Any state parse error or API ambiguity → fail closed: make no changes, report loudly.

### State: a status issue in the watchdog repo (recommended)

One open issue (labelled `spend-pacer`) holds the state as a fenced JSON block inside a
hidden HTML comment in its body, plus a human-readable table of what is paused. Each pause
or resume posts a comment, so the issue is both the durable state **and** the notification
channel (GitHub emails/pushes the repo owner).

Why not the alternatives:
- **Committed JSON file**: needs `contents: write`, adds commit noise every pause/resume,
  can race with pushes, and for adopters means the watchdog writes to their default branch.
- **Repo variables**: `GITHUB_TOKEN` cannot write variables, so the PAT would need an extra
  permission on the watchdog repo (widening it); invisible to the user.
- **Issue**: `GITHUB_TOKEN` with `issues: write` is enough (no PAT widening), visible,
  hand-editable (delete an entry to keep that workflow off), and works the same for
  adopters. Concurrency group on the workflow serialises runs so there is no race.

### Extras worth building in

- **Keepalive.** GitHub auto-disables scheduled workflows in *public* repos after 60 days
  without repo activity. The pacer repo will be quiet, so the action re-enables its own
  workflow via the API (`GITHUB_TOKEN`, `actions: write`) which resets that timer.
- **Token expiry warning.** Read the `github-authentication-token-expiration` response
  header; warn in the summary/issue 14 days ahead.
- **Spend breakdown in the summary**: per repo and per SKU, plus days until the allowance
  catches up at zero further spend.

## Findings / gotchas

- **Billing endpoint permission (verified in docs):** `GET /users/{u}/settings/billing/usage`
  and `/usage/summary` are under *User permissions → Plan: read*. Org equivalents are under
  *Organization permissions → Administration: read* (broader; document it). Source:
  docs.github.com "Permissions required for fine-grained personal access tokens".
- **Workflow toggle permission (verified in docs):** list = Actions: read; disable/enable =
  Actions: write. States: `active`, `deleted`, `disabled_fork`, `disabled_inactivity`,
  `disabled_manually`. Disabling sets `disabled_manually`, so the API can't tell the
  watchdog's disables from the user's; hence the state record.
- **Detailed vs summary endpoint agree.** On 2026-11-10 6:55 PM PST (02:55Z Nov 11): detailed
  items sum to **$16.53** net for Actions; `/usage/summary?product=actions` gives $16.51
  (9.45 Linux + 4.03 macOS + 3.03 Windows; rounding). Use detailed for the per-repo
  breakdown; summary is a cheap cross-check.
- **Month-to-date by repo (net):** apitorrent $9.43, ops $6.77, one other repo $0.34, everything
  else $0. By UTC day: Nov 7 $0.97, Nov 8 $0.08, Nov 9 $2.00, Nov 10 $9.94, Nov 11 $3.54 (so far).
- **Consequence today:** allowance on Nov 11 (UTC) is $11; spend is $16.53, **$5.53 over**.
  A live run now would pause governed workflows until ~Nov 17 (UTC) even with zero further
  spend, which includes ops Server Deploys unless allow-listed. See Open question 2.
- **Dynamic workflows** (`dynamic/dependabot/...`, `dynamic/copilot-*`) show in the list API.
  Dependabot is documented as free; Copilot cloud agent runs consume Actions minutes. Default
  to skipping `dynamic/` paths; whether the API can disable them is untested.
- **Docs are ambiguous on whether a tripped "stop usage" budget blocks free public-repo
  standard runs.** Billing docs say public standard runners are free and "do not reduce
  included usage"; budget docs say an exhausted Actions budget blocks "all GitHub-hosted
  runners". Neither settles it. Must be verified by observation (Open question 1).
- **User endpoint docs** carry stale wording about Copilot-only applicability and the
  "enhanced billing platform"; in practice it returns all products for this account.
- Inventory command (read-only):
  `gh repo list cinderblock --visibility private --limit 300 --json name,isArchived` then
  `gh api repos/cinderblock/<r>/actions/workflows`.

## Plan / steps

1. **← current** Plan doc + proposed name/layout → user yes.
2. Scaffold repo locally (TS, bun test, action.yml), allowance + plan logic with tests.
3. Billing + workflow inventory + CLI dry run against `cinderblock` using the local gh token
   (read-only). Show the output to the user.
4. Stage: create public GitHub repo; create fine-grained PAT (user does this, steps one at a
   time); set secret; caller workflow in dry-run mode, schedule on. Each needs a yes.
5. Observe scheduled dry runs; get yes for `mode: live`.
6. Public polish: README (setup, token steps, lag/soft-cap honesty), license, CI, release tag,
   Marketplace listing, optional blog post. Each publication needs a yes.

## Progress log

- [x] Docs research: billing permissions, workflow API, public-repo billing
- [x] Read-only snapshot of MTD spend and private-repo workflow inventory
- [x] Local repo initialised (`master`)
- [ ] Name + layout approved
- [ ] Core logic + tests
- [ ] Local dry run shown to user
- [ ] GitHub repo created (needs yes)
- [ ] PAT + secret (needs yes)
- [ ] Schedule enabled in dry-run (needs yes)
- [ ] Live mode (needs yes)
- [ ] Public release (needs yes)

## Open questions for the user

1. **Verifying "public repo keeps running after the hard stop".** Recommendation: observe it
   naturally. At the current pace the $20 stop trips within days; keep the pacer's dry-run
   schedule running before then and check its runs continue afterwards. A controlled test
   (a $0 stop-usage budget on a throwaway org with one public repo) is the alternative, but
   it changes account billing settings, so only with your yes.
2. **Ops Server Deploys during a pause.** We're $5.53 over today, so a live pause would last
   about 6 days. Recommendation: allow-list `ops/.github/workflows/deploy.yml` (and maybe
   `credential-expiry.yml`) so deploys stay possible; pause Renovate/Caddy checks/apitorrent.
3. **Governed set**: all private repos (default) or an explicit list? Recommendation: all
   private, with the allow-list above.
4. **Resume headroom**: resume exactly at allowance, or with a buffer (e.g. $1)?
   Recommendation: $0.50 so a resume isn't immediately followed by a re-pause.
5. **License**: MIT? (recommended)
6. **Name**: `actions-spend-pacer` (recommended) vs `actions-spend-watchdog`.

## Things not to do

- Don't call the usage endpoint without `year` and `month` (returns a misleading aggregate).
- Don't infer "watchdog disabled this" from `disabled_manually`; only trust the state record.
- Don't touch ops/apitorrent workflow files; only toggle through the API, after a yes.
- Don't create the repo, token, secret, schedule, or a live run without an explicit yes.
- Don't widen the PAT (no Contents, no Administration on repos) to solve state storage.
