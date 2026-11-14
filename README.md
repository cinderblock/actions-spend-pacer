# Actions Spend Pacer

Keep your GitHub Actions bill on a **running allowance** instead of finding out at the end of
the month. Every few hours the pacer compares month-to-date **net** Actions spend (after
included minutes and discounts) with an allowance that grows each day, by default **$1 × the
day of the month**:

- **Over the allowance:** it disables the workflows in your private repos. Runs already in
  progress finish.
- **Back under** (the allowance keeps growing; spend stops): it re-enables **only the
  workflows it disabled itself**. Anything you disabled by hand stays disabled.
- **New month:** spend resets, so everything it paused comes back.

It's a pace limit that sits in front of GitHub's own budget "stop usage" setting, which is a
hard wall: once that trips, every hosted job stops until the month resets.

> **Status:** pre-release. Not yet published to the Marketplace.

## Honest limitations

- **It's a soft cap.** GitHub's billing data lags by hours, and the pacer only checks on
  its schedule. Expect to overshoot by a few hours' worth of spend. Keep a GitHub budget
  with "stop usage" as the hard backstop.
- **Disabling isn't cancelling.** Runs that are in progress (and possibly already queued) when
  a workflow is disabled still finish.
- **It only works at the workflow level.** It can't throttle a single expensive job. It
  pauses whole workflows, and by default every one in every private repo it governs.
- **GitHub-managed `dynamic/` workflows** (Dependabot, Copilot, code scanning) are skipped by
  default. Opt in with `include-dynamic: true`.

## Setup

### 1. A public repo to run it from

Standard GitHub-hosted runners are free in public repositories, so the pacer costs nothing
to run and doesn't eat into the spend it's watching. Create a public repo (e.g.
`you/spend-pacer`).

> [!IMPORTANT]
> In a public repo, logs, job summaries and issues are public. The pacer **redacts private
> repo and workflow names by default** (`redact: auto`) and shows opaque labels like
> `repo-3f9a2c workflow 413747252` instead.

### 2. A fine-grained personal access token

[Create a fine-grained token](https://github.com/settings/personal-access-tokens/new):

| Field | Value |
| --- | --- |
| Resource owner | You (or the org) |
| Expiration | Up to you. The pacer warns in its summary 14 days before expiry. |
| Repository access | **All repositories**, or **Only select repositories** with the private repos to govern |
| Repository permissions → **Actions** | **Read and write** |
| Account permissions → **Plan** | **Read-only** (user accounts; this is the billing usage API) |
| Organization permissions → **Administration** | **Read-only** (org owners only, instead of Plan) |

Nothing else. In particular **no Contents** and **no repo Administration**.

Save it as an Actions secret named `PACER_TOKEN` in the pacer repo.

### 3. The workflow

`.github/workflows/spend-pacer.yml` in the pacer repo:

```yaml
name: Spend pacer
on:
  schedule:
    - cron: "17 */3 * * *" # every 3 hours
  workflow_dispatch:
permissions:
  issues: write
  actions: write
jobs:
  pace:
    uses: cinderblock/actions-spend-pacer/.github/workflows/pacer.yml@v1
    with:
      daily-rate: "1.00"   # or monthly-budget: "30"
      mode: dry-run        # switch to live once the dry runs look right
      timezone: America/Los_Angeles
    secrets:
      token: ${{ secrets.PACER_TOKEN }}
```

Run it by hand once (**Actions → Spend pacer → Run workflow**) and read the job summary. It
lists exactly what would be paused. When it looks right, set `mode: live`.

Or use the action directly as a step: `uses: cinderblock/actions-spend-pacer@v1` with the same
inputs (see [action.yml](action.yml)).

## How state is kept

The first live run opens an issue titled **Actions spend pacer** in the pacer repo. Its body
shows the current status and holds, in a hidden JSON block, the list of workflows the pacer
paused. That list is how it knows what it may re-enable. Every pause or resume adds a comment,
so you get a notification.

- Only issues opened by you (or by `github-actions[bot]`, when the issue is in the pacer repo
  itself) are trusted, so a stranger can't plant fake state.
- If the block is ever unreadable, the pacer **fails closed**: it changes nothing and fails the run.
- It records a pause *before* disabling and forgets it *after* re-enabling, so a crash can't
  leave a pause it doesn't know about.
- If you re-enable a paused workflow by hand, the pacer forgets it. Should the account still be
  over the allowance, the next run pauses it again. To keep something running, use an override.

### Keeping the record private

In a public pacer repo, the status issue is redacted like everything else. To see real names
there, keep the issue in a private repo you own instead: set `state-repo: you/some-private-repo`
and pass a `state-token` with **Issues: read and write** on just that repo. The pacer then
writes real names into that issue and its comments, while the public job summary stays
redacted (`state-redact: auto`).

Before choosing a repo, make sure none of its workflows run `on: issues` or `on: issue_comment`,
or every pause and resume will start a (paid) run there.

### Checkboxes in the status issue

The status issue ends with a **Controls** list you can use from your phone:

- `- [ ] Run <workflow> for 4h`, one per paused workflow. Tick it, and the next run turns it
  into a 4-hour override (`control-hours`) and re-enables the workflow.
- `- [x] Override <match> until <time>`, one per active override. Untick it to end the
  override; the next run pauses the workflow again if the account is still over.

Ticks take effect on the next scheduled run, not instantly. If a tick lands while a run is
writing the issue, the run can overwrite it; tick again.

### Overrides

To let one workflow run while the account is over (an urgent deploy, say), add a time-limited
override with the CLI:

```sh
bunx github:cinderblock/actions-spend-pacer override ops/deploy.yml --for 4h --reason "hotfix" \
  --state-repo you/spend-pacer --owner you --now
```

`--now` re-enables it at once. Otherwise the next scheduled run does. When the override
expires, the workflow is governed again.

### Grants: extra allowance for this month

To give the whole account more room for a while (a release week, say), grant extra
allowance. It's the pacer's own accounting: it raises the pacer's line, not your GitHub
budget, so the hard stop still applies.

```sh
bunx github:cinderblock/actions-spend-pacer grant 5 --reason "release week" \
  --state-repo you/spend-pacer --owner you            # add --for 3d to expire sooner
```

A grant counts only in the UTC billing month it was made, and any `--for` expiry ends it
sooner. When it ends, the line drops back, and if spend is then over, the next run pauses
again. Grants are bounded, so unlike an override they keep a runaway in check. To preview
one without recording it, run `run --grant 5` (dry run).

## Inputs

See [action.yml](action.yml). The main ones:

| Input | Default | |
| --- | --- | --- |
| `daily-rate` | `1` | USD per UTC day. Allowance = rate × day of month. |
| `monthly-budget` | | Alternative: prorated monthly amount. |
| `resume-headroom` | `0.50` | Resume only once spend is this far under the allowance. |
| `repos` | `all-private` | Or a list of repo names. |
| `allow-list` | | Never pause: `repo` or `repo/workflow.yml`, one per line. |
| `mode` | `dry-run` | `live` to actually pause and resume. |
| `owner-type` | `user` | `org` for an organization (token needs org Administration: read). |
| `redact` | `auto` | Hide private names when the running repo is public. |
| `state-repo` | this repo | Keep the status issue elsewhere (e.g. a private repo). |
| `control-hours` | `4` | How long a ticked "Run … for 4h" box lets a workflow run. |
| `state-token` | `github-token` | Token for `state-repo` (Issues: read and write on it). |
| `webhook-url` | | JSON POST on pause/resume. Includes real names, so pass it from a secret. |

## Try it locally first

The dry run is read-only and uses your `gh` login:

```sh
git clone https://github.com/cinderblock/actions-spend-pacer && cd actions-spend-pacer
bun install
bun src/cli.ts run --owner you --timezone America/Los_Angeles
```

## Development

```sh
bun install
bun run check   # typecheck, tests, build dist/
```

`dist/` is committed (GitHub runs it directly), and CI fails if it is stale.

## License

[MIT](LICENSE)
