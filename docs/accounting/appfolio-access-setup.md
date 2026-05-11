# AppFolio API Access Setup

Status: runbook. Follow when configuring the production environment to
pull from AppFolio reliably (one-shot introspection or ongoing sync).

## Why this exists

AppFolio's APIs (both the Database API v0 and the Reports API v1)
enforce a **server-side IP allowlist** scoped to a Developer ID. Even
with correct HTTP Basic credentials, any call from a non-allowlisted
host returns:

    HTTP 403 Forbidden
    Host not in allowlist

This is enforced before authentication — no exception for "internal"
or "test" calls. Production usage from Vercel requires either:

1. **Stable Vercel egress IPs** (Pro/Enterprise dedicated outbound IP
   feature), allowlisted in AppFolio.
2. **A proxy with a fixed IP** (Fixie, QuotaGuard, your own
   small fixed-IP VPS), routed through, with the proxy's IP
   allowlisted.

Option 1 is the cleanest if you have or are willing to upgrade to a
Vercel plan that supports it. Option 2 is fine and pay-per-use.

## Who can make the change

Everything below is configured by **Breeze** (the AppFolio customer
and the Vercel project owner). AppFolio support does not need to be
involved unless step 4 fails with a "Developer ID not authorised for
Reports API" error, which is a separate scope enablement.

## Step 1 — Pick a fixed-IP strategy

### Option A: Vercel dedicated outbound IPs (recommended for production)

Vercel offers static outbound IPs on **Pro** and **Enterprise** plans
as an add-on feature. The exact path in the dashboard is:

    Project → Settings → Functions → Dedicated IP

Enabling it provisions one or more static IPs that every serverless
function in the project will use as its egress. Cost is a small
monthly add-on. Once enabled, the IPs are listed in the dashboard and
do not change unless you explicitly rotate them.

Document the assigned IPs somewhere durable (a `secrets/` Vercel
project note, a 1Password entry, or this doc with the values redacted
from public diffs).

### Option B: Fixed-IP proxy (Fixie, QuotaGuard, your own VPS)

Sign up for one of:

- **Fixie Socks/Outbound** — usagebilled, gives you a pair of static
  IPs and a SOCKS proxy URL.
- **QuotaGuard Static** — similar, HTTP proxy.
- **Your own fixed-IP VPS** — a $5/mo DigitalOcean/Linode droplet with
  an HTTP proxy (e.g., `tinyproxy`) is enough for our volume.

Whichever you pick, you'll get one or two stable IP addresses to
allowlist and either a proxy URL or credentials to plumb into
`lib/backends/appfolio.js`.

> Code change required for Option B: add a `process.env.HTTP_PROXY`-
> aware fetch wrapper to the AppFolio backend so all requests route
> through the proxy. Not yet implemented — open an issue if you take
> this path.

## Step 2 — Allowlist in the AppFolio Developer Space

1. Sign in at `https://<your-account>.appfolio.com/` as a user with
   developer-portal access.
2. Navigate to **Tools → Developer Space → API Credentials**.
   (Exact path varies by AppFolio plan; if you can't find it,
   AppFolio support's documented term is "Developer Space".)
3. Find the credential row used by Breeze OS — its Client ID should
   match `APPFOLIO_CLIENT_ID` in Vercel env vars.
4. Open the credential's settings. There should be an **"IP
   Allowlist"** or **"Approved IPs"** section.
5. Add the static IP(s) from Step 1. AppFolio typically applies the
   change within minutes.

Keep the existing entries (your office IP, your laptop) — don't remove
them. Multiple allowlisted IPs are fine.

## Step 3 — Configure Vercel env vars

In the Vercel project's **Settings → Environment Variables**, ensure:

| Variable | Required | Notes |
|---|---|---|
| `APPFOLIO_CLIENT_ID` | yes | Database API v0 — from Developer Space. |
| `APPFOLIO_CLIENT_SECRET` | yes | Database API v0 — from Developer Space. **Mark Sensitive.** |
| `APPFOLIO_DEVELOPER_ID` | yes | Customer/Developer UUID — Database API v0. |
| `APPFOLIO_DATABASE_SUBDOMAIN` | optional | Defaults to `breezepg`. Set explicitly if migrating to a different subdomain. |
| `APPFOLIO_REPORTS_USERNAME` | yes for Reports API | Reports API Basic Auth username — configured in the AppFolio web UI (Tools → Database or Tools → API), NOT the Developer Space. Different credential from `APPFOLIO_CLIENT_ID`. |
| `APPFOLIO_REPORTS_PASSWORD` | yes for Reports API | Reports API Basic Auth password — paired with the username above. **Mark Sensitive.** |
| `BREEZE_ADMIN_TOKEN` | yes | Gates `/api/admin/*` including the introspect endpoint. |
| `HTTP_PROXY` | optional | Only if using Option B above. Not yet honored — see note in Step 1. |

**Why two credential pairs?** Empirically (confirmed by probing `/api/v1/reports/*.json` from Vercel), AppFolio gates the **Database API v0** at `api.appfolio.com` with the Developer Space Client ID/Secret + Developer ID header, but gates the **Reports API** at `<subdomain>.appfolio.com` with a separate HTTP Basic Auth username/password pair configured per-customer in the AppFolio web UI. Use both pairs; they are not interchangeable.

Apply to all environments (Production, Preview, Development). Redeploy
the project so the env vars take effect.

## Step 4 — Smoke-test

Once Steps 1–3 are done, hit the introspect endpoint:

    curl 'https://<your-vercel-domain>/api/admin/appfolio-introspect?secret=<BREEZE_ADMIN_TOKEN>&days=30' \
      | jq

Expected: JSON with `chart_of_accounts.ok === true` and a non-zero
`count`. The three transactional sections (`general_ledger`,
`bill_detail`, `income_register`) may be empty if the 30-day window
has no activity — pass a wider window with `&days=365` to confirm.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| All sections `ok: false`, error contains "Host not in allowlist" | Vercel egress IP not on AppFolio allowlist | Re-check Step 2, confirm the IP from Step 1 matches what AppFolio sees. |
| `chart_of_accounts.ok === true` but transactional sections 403 | The Developer ID has scope for the Database API but not the Reports API | Open a ticket with AppFolio support asking to enable Reports API access on the credential. |
| `chart_of_accounts.ok === true`, transactional sections succeed but empty | Date range has no activity | Increase `?days=365`. |
| 500 from Vercel, `credentials not configured` in logs | Env vars not applied to the current deployment | Confirm env vars are set for the deployed environment and that the deployment was redone after setting them. |
| 401 Unauthorized from Vercel | `BREEZE_ADMIN_TOKEN` mismatch | Confirm the `secret` query param matches the env var exactly. |

## Step 5 — When done with one-shot introspection

If you only allowlisted a temporary IP (e.g., a laptop) for the
one-shot pull, remove it from the AppFolio allowlist when finished.
Leaving stale IPs allowlisted is a small but real security exposure
since the credential bypass becomes IP + credential pair, not just the
credential.

## What this enables next

Once the introspect endpoint returns clean data, the next work items
become unblocked:

- Build the **default chart-of-accounts template** for new Breeze OS
  orgs, informed by Breeze's actual AppFolio COA shape.
- Build the **one-way AppFolio sync** for the parallel-run period
  (Breeze OS reads the same source data AppFolio sees, computes
  reports, and we compare side-by-side).
- Build the **per-property cutover tooling** that flips a property
  from AppFolio source-of-truth to Breeze OS source-of-truth without
  data loss.

Each of those is its own work item; this doc only covers the
networking + credentials prerequisites.
