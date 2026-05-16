# Runbook: the admin-ops loop

**What it is:** a ChatOps system that lets anyone with repo write
access drive deployed admin endpoints by posting slash commands in
GitHub issue / PR comments. The response posts back into the same
thread.

**Why it exists:** the alternative is "open a browser, paste the
admin token, hit the endpoint, screenshot the response, paste it
back." We did that for a while; it was a multi-minute round trip
per probe. The slash-command loop turns a 5-minute screenshot
cycle into a 30-second comment.

This runbook is for:
- developers needing to debug or sync data in production
- on-call response to nightly-smoke alerts
- Claude (or any AI/automation) driving the platform on the
  developer's behalf

## Architecture in one paragraph

GitHub workflow `.github/workflows/admin-ops.yml` listens for two
events: `workflow_dispatch` (manual UI trigger) and
`issue_comment` (slash commands). When fired, it curls the
production Vercel URL with `BREEZE_ADMIN_TOKEN`, captures the
JSON response, uploads it as an artifact, and (if the comment
came from an issue or `COMMENT_ISSUE_NUMBER` is set) posts it
back as a reply.

```
You post `/run-smoke`
    ↓ issue_comment event
GitHub Actions runs admin-ops workflow
    ↓ curl with BREEZE_ADMIN_TOKEN
Vercel-hosted /api/admin/smoke-test
    ↓ JSON response
Workflow comments back on the same issue
    ↓ you read it
You decide next step
```

## Setup (one-time, already done for this repo)

| What | Where | Value |
|---|---|---|
| Repo secret `BREEZE_ADMIN_TOKEN` | Settings → Secrets → Actions | matches `BREEZE_ADMIN_TOKEN` in Vercel env |
| Repo secret `VERCEL_PROD_URL` | Settings → Secrets → Actions | e.g. `https://breeze-os-claude.vercel.app` |
| Repo variable `COMMENT_ISSUE_NUMBER` | Settings → Variables → Actions | tracking-issue number (e.g. `84`) |
| Workflow file | `.github/workflows/admin-ops.yml` (must be on `main`) | the file in this repo |
| Tracking issue | any open issue (we use #84 "Ops Console — admin-ops workflow") | gets every workflow_dispatch + scheduled reply |

**Important constraint**: GitHub fires `issue_comment` triggers
only from workflows on the **default branch** (`main`). Adding the
workflow to a feature branch alone isn't enough.

## Commands

Post these as the FIRST LINE of a comment on any issue or PR.
Backticks / bold / italic around the slash are stripped by the
parser — `/run-smoke` and `` `/run-smoke` `` both work.

| Command | What it does |
|---|---|
| `/run-smoke` | Hit `/api/admin/smoke-test`. Read-only health check (db connect, table counts, env vars, integration health, Plaid env). |
| `/run-reimport` | DESTRUCTIVE. Hit `/api/admin/run-reimport` (orchestrator): wipe directory data → import properties → import units → loop sync leases → sync tickets. ~5 min wall clock; ~270s soft budget. Returns `resumable_from` if it can't finish in one go. |
| `/run-reimport-resume <offset>` | Resume the leases sync from the given offset (skips wipe + property + unit imports). Use when a previous `/run-reimport` returned `resumable_from: { step: 'leases', offset: N }`. |
| `/tail-errors [minutes] [limit]` | Hit `/api/admin/recent-errors`. Default lookback 60 min, limit 20. Returns the persisted `admin_error_log` entries with full stack traces. |
| `/run-diag <METHOD> <path> [json-body]` | Generic probe. Hits any admin endpoint. Examples: `/run-diag GET /api/admin/list-integration-health`, `/run-diag GET /api/admin/debug-units-breakdown`, `/run-diag POST /api/admin/wipe-directory-data {"dry_run":true}`. |

## Manual triggers (no slash command)

GitHub → Actions → admin-ops → "Run workflow". Pick the job and
fill the inputs. Same backend; useful when you don't have a comment
context.

## Author-association gate

The workflow ignores comments unless the commenter is `OWNER`,
`MEMBER`, or `COLLABORATOR`. Random PR comments from
non-collaborators are silently no-op'd — no runner is spent.

To grant a new contributor command access: add them as a repo
collaborator (Settings → Collaborators).

## When something goes wrong

### "Workflow ran but the response is `RM auth failed (401)`"
The endpoint isn't in `vercel.json`'s rewrites list, so the
catch-all `/api/(.*) → /api/rentmanager` is intercepting. Add an
identity rewrite for the path:

```json
{ "source": "/api/admin/<your-endpoint>", "destination": "/api/admin/<your-endpoint>" }
```

Push to main, wait for Vercel to redeploy, retry.

### "Workflow returns empty `{}`"
Curl timed out (current limit: 310s) but Vercel may have continued
running the function in the background. Check `/tail-errors`. For
the orchestrator specifically, check whether the work landed via
`/run-smoke` — if table counts changed, the orchestrator finished
even though we didn't get its summary.

### "The comment shows `` `/run-smoke` `` but no workflow ran"
Most likely: the workflow file on `main` is stale or missing.
Re-check by browsing to `.github/workflows/admin-ops.yml` on
`refs/heads/main`. If the parse-comment step has changed but
hasn't been promoted to main, the comment trigger won't see the
update.

### "I posted a slash command and nothing happened"
- Confirm you're a repo collaborator (the author-association
  gate)
- Confirm the comment was on an OPEN issue/PR (closed ones don't
  fire)
- Check Actions tab — if you see a run, it might have been
  skipped at the parse step (look at the log for "Not a
  recognised slash command")

### "Smoke is red — what do I do?"
1. Open the comment the workflow posted; the `checks` array tells
   you which subsystem failed.
2. For `db_connect` failures: check the DB provider (Neon/Vercel
   Postgres) status page.
3. For `plaid_env` failures: check that the env vars in Vercel
   match the deployment ring (sandbox / production).
4. For `integration_health` failures: there's a downstream API
   that probed-poorly. Look at `lastErrorMessage` in the failing
   row.
5. If none of the above: `/tail-errors 30` to see the last 30
   minutes of structured errors.

## Adding a new command

1. Add a new endpoint under `api/admin/` (if it doesn't already
   exist).
2. Add an identity rewrite for the new endpoint to `vercel.json`
   so the catch-all doesn't eat it.
3. Add the slash-command case to `.github/workflows/admin-ops.yml`
   in the `Parse comment trigger` step.
4. Add the matching `curl_admin ...` line in the `Run job` step.
5. Push the workflow change to BOTH the feature branch and `main`
   (GitHub fires `issue_comment` only from main's workflow).
6. Test by posting the new slash command.

## Adding a scheduled probe

`.github/workflows/nightly-smoke.yml` runs `/run-smoke` every day
at 09:00 UTC and posts to the Ops Console on failure. To add a
new schedule, either edit that workflow or create a sibling. Keep
each scheduled workflow narrow — debugging a triggered workflow
that has 8 jobs is harder than 8 workflows with 1 job each.

## Why we ended up here

We started with manual screenshot-and-paste debugging. Tried
sharing the admin token directly (didn't work because Claude's
sandbox blocks outbound HTTP to vercel.app). Built this ChatOps
loop as a workaround that turned out to be the right architecture
anyway. The full story is in commit `33effa0`.
