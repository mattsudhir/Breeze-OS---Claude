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
  const qs = 'page%5Bsize%5D=1';
  const probes = await Promise.all([
    probe('shared_v0',     `https://api.appfolio.com/api/v0/properties?${qs}`,            headers),
    probe('subdomain_v0',  `https://${subdomain}.appfolio.com/api/v0/properties?${qs}`,    headers),
    probe('subdomain_v1',  `https://${subdomain}.appfolio.com/api/v1/properties?${qs}`,    headers),
    probe('reports_v2',    `https://${subdomain}.appfolio.com/api/v2/reports/property_directory.json`, {
      ...headers, 'Content-Type': 'application/json',
    }),
  ]);

  const successful = probes.find((p) => p.status === 200);
  const hints = [];
  if (successful) {
    hints.push(`Working endpoint: ${successful.label} → ${successful.url}. If different from the default, set APPFOLIO_DATABASE_API_URL or APPFOLIO_SUBDOMAIN accordingly.`);
  }
  for (const p of probes) {
    if (p.status === 401) hints.push(`${p.label}: 401 — credentials rejected at this host.`);
    if (p.status === 403) hints.push(`${p.label}: 403 — auth accepted but developer-id may be wrong.`);
    if (p.status === 404) hints.push(`${p.label}: 404 — endpoint not at this path.`);
  }

  return res.status(200).json({
    ok: !!successful,
    stage: successful ? 'auth_ok' : 'auth_failed',
    inspections,
    subdomain_in_use: subdomain,
    probes,
    hints,
  });
});
