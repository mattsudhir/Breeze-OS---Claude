// GET /api/admin/debug-appfolio-auth?secret=<TOKEN>
//
// Diagnoses why AppFolio API calls are failing without leaking secrets.
// Probes the Database API at BOTH the shared host (api.appfolio.com)
// and the customer subdomain (<APPFOLIO_SUBDOMAIN>.appfolio.com), so
// we can see which one auths and which one 404s.
//
// Returns env-var presence + length + whitespace flags + sha256 hash
// prefix (never the raw value), and the HTTP status + body snippet
// from each probe.

import crypto from 'crypto';
import { withAdminHandler } from '../../lib/adminHelpers.js';

function inspect(name) {
  const raw = process.env[name];
  if (raw == null) return { name, set: false };
  const trimmed = raw.trim();
  return {
    name,
    set: true,
    length: raw.length,
    trimmed_length: trimmed.length,
    has_leading_whitespace: raw !== raw.trimStart(),
    has_trailing_whitespace: raw !== raw.trimEnd(),
    contains_newline: /\r|\n/.test(raw),
    sha256_prefix: crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, 12),
  };
}

async function probe(label, url, headers) {
  const out = { label, url };
  try {
    const r = await fetch(url, { headers });
    out.status = r.status;
    const text = await r.text();
    out.body_snippet = text.slice(0, 400);
  } catch (err) {
    out.error = err.message || String(err);
  }
  return out;
}

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'GET only' });
  }

  const inspections = {
    APPFOLIO_CLIENT_ID: inspect('APPFOLIO_CLIENT_ID'),
    APPFOLIO_CLIENT_SECRET: inspect('APPFOLIO_CLIENT_SECRET'),
    APPFOLIO_DEVELOPER_ID: inspect('APPFOLIO_DEVELOPER_ID'),
    APPFOLIO_SUBDOMAIN: inspect('APPFOLIO_SUBDOMAIN'),
    APPFOLIO_DATABASE_API_URL: inspect('APPFOLIO_DATABASE_API_URL'),
  };

  const clientId = (process.env.APPFOLIO_CLIENT_ID || '').trim();
  const clientSecret = (process.env.APPFOLIO_CLIENT_SECRET || '').trim();
  const developerId = (process.env.APPFOLIO_DEVELOPER_ID || '').trim();
  const subdomain = (process.env.APPFOLIO_SUBDOMAIN || '').trim() || 'breezepg';

  if (!clientId || !clientSecret || !developerId) {
    return res.status(200).json({
      ok: false,
      stage: 'env_missing',
      inspections,
      hint: 'One or more of APPFOLIO_CLIENT_ID / APPFOLIO_CLIENT_SECRET / APPFOLIO_DEVELOPER_ID is not set in this environment.',
    });
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const headers = {
    Authorization: `Basic ${auth}`,
    Accept: 'application/json',
    'X-AppFolio-Developer-ID': developerId,
  };

  // Probe every endpoint pattern we know about so the user can see
  // which one AppFolio's actually serving for their account.
  // AppFolio's /properties REQUIRES a filter — include
  // LastUpdatedAtFrom so a clean auth pass returns 200, not a 400
  // "must include a filter" that masks the real auth status.
  const qs = 'page%5Bsize%5D=1&filters%5BLastUpdatedAtFrom%5D=1970-01-01T00%3A00%3A00Z';
  const probes = await Promise.all([
    probe('shared_v0',     `https://api.appfolio.com/api/v0/properties?${qs}`,            headers),
    probe('subdomain_v0',  `https://${subdomain}.appfolio.com/api/v0/properties?${qs}`,    headers),
    probe('subdomain_v1',  `https://${subdomain}.appfolio.com/api/v1/properties?${qs}`,    headers),
    probe('reports_v2',    `https://${subdomain}.appfolio.com/api/v2/reports/property_directory.json`, {
      ...headers, 'Content-Type': 'application/json',
    }),
  ]);

  // Intermittency check: same shared_v0 probe, 5 times, sequentially.
  // If the secret is genuinely dead we get 5×401. If it's an IP
  // allowlist or rate-limit problem we get a MIX — that's the
  // smoking gun the user needs to see.
  const repeatProbes = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await probe(`repeat_${i + 1}`, `https://api.appfolio.com/api/v0/properties?${qs}`, headers);
    repeatProbes.push({ attempt: i + 1, status: r.status, error: r.error || null });
  }
  const repeatStatuses = repeatProbes.map((r) => r.status);
  const distinctStatuses = [...new Set(repeatStatuses)];
  const intermittent = distinctStatuses.length > 1;

  const successful = probes.find((p) => p.status === 200) ||
    (repeatStatuses.includes(200) ? { label: 'repeat', url: 'shared_v0' } : null);
  const hints = [];

  if (intermittent) {
    hints.push(
      `INTERMITTENT: 5 identical probes returned mixed statuses ${JSON.stringify(repeatStatuses)}. ` +
      'The secret is VALID — this is not a dead credential. Cause is almost certainly either ' +
      '(a) an IP allowlist on the AppFolio Database API credential (Vercel runs from rotating IPs, ' +
      'so only some invocations land on an allowed IP), or (b) AppFolio rate-limiting. ' +
      'Check AppFolio Developer Space for an "Allowed IPs" / IP restriction setting on the breezepg ' +
      'credential and either remove it or add Vercel\'s IP ranges.',
    );
  } else if (distinctStatuses[0] === 401) {
    hints.push('All 5 probes returned 401 — credential is genuinely rejected. Regenerate the Client Secret and update Vercel.');
  } else if (distinctStatuses[0] === 200) {
    hints.push('All 5 probes returned 200 — auth is healthy right now.');
  } else if (distinctStatuses[0] === 429) {
    hints.push('All 5 probes returned 429 — AppFolio is rate-limiting. Wait for the cooldown and retry.');
  }

  if (successful && !intermittent) {
    hints.push(`Working endpoint: ${successful.label}.`);
  }
  for (const p of probes) {
    if (p.status === 403) hints.push(`${p.label}: 403 — auth accepted but developer-id may be wrong.`);
    if (p.status === 404) hints.push(`${p.label}: 404 — endpoint not at this path.`);
  }

  return res.status(200).json({
    ok: repeatStatuses.includes(200),
    stage: intermittent ? 'intermittent' : (repeatStatuses.includes(200) ? 'auth_ok' : 'auth_failed'),
    intermittent,
    repeat_probe_statuses: repeatStatuses,
    repeat_probes: repeatProbes,
    inspections,
    subdomain_in_use: subdomain,
    probes,
    hints,
  });
});
