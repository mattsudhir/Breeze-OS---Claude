// GET /api/admin/debug-appfolio-auth?secret=<TOKEN>
//
// Diagnoses why AppFolio is returning 401 without leaking secrets.
// Returns:
//   - whether each env var is set
//   - length + sha256 hash prefix of each (so we can spot whitespace
//     diffs vs. what's in our records, without exposing values)
//   - whitespace flags (leading/trailing space, contains newline)
//   - the BASE_URL we'll call
//   - the result of one /properties?page[size]=1 probe with status,
//     body snippet, and resolved Authorization header length
//
// Token never echoed. Read-only.

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

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'GET only' });
  }

  const inspections = {
    APPFOLIO_CLIENT_ID: inspect('APPFOLIO_CLIENT_ID'),
    APPFOLIO_CLIENT_SECRET: inspect('APPFOLIO_CLIENT_SECRET'),
    APPFOLIO_DEVELOPER_ID: inspect('APPFOLIO_DEVELOPER_ID'),
    APPFOLIO_DATABASE_API_URL: inspect('APPFOLIO_DATABASE_API_URL'),
  };

  const clientId = (process.env.APPFOLIO_CLIENT_ID || '').trim();
  const clientSecret = (process.env.APPFOLIO_CLIENT_SECRET || '').trim();
  const developerId = (process.env.APPFOLIO_DEVELOPER_ID || '').trim();
  const baseUrl =
    (process.env.APPFOLIO_DATABASE_API_URL || '').trim() ||
    'https://api.appfolio.com/api/v0';

  if (!clientId || !clientSecret || !developerId) {
    return res.status(200).json({
      ok: false,
      stage: 'env_missing',
      inspections,
      base_url: baseUrl,
      hint: 'One or more of APPFOLIO_CLIENT_ID / APPFOLIO_CLIENT_SECRET / APPFOLIO_DEVELOPER_ID is not set in this environment.',
    });
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  let probeStatus = null;
  let probeBodySnippet = null;
  let probeUrl = `${baseUrl}/properties?page%5Bsize%5D=1`;
  let probeError = null;
  try {
    const r = await fetch(probeUrl, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'X-AppFolio-Developer-ID': developerId,
      },
    });
    probeStatus = r.status;
    const text = await r.text();
    probeBodySnippet = text.slice(0, 400);
  } catch (err) {
    probeError = err.message || String(err);
  }

  return res.status(200).json({
    ok: probeStatus === 200,
    stage: probeStatus === 200 ? 'auth_ok' : 'auth_failed',
    inspections,
    base_url: baseUrl,
    auth_header_length: `Basic ${auth}`.length,
    probe_url: probeUrl,
    probe_status: probeStatus,
    probe_body_snippet: probeBodySnippet,
    probe_error: probeError,
    hints: [
      probeStatus === 401
        ? 'AppFolio rejected the credentials. Either the client_id/client_secret were rotated on their side, or whitespace got into the env values (check has_leading/trailing_whitespace flags above).'
        : null,
      probeStatus === 403
        ? 'Credentials were accepted but the developer-id may be wrong for this customer.'
        : null,
      probeStatus === 404
        ? `404 — the BASE_URL is probably wrong. We called ${probeUrl}. If your AppFolio subdomain is custom (e.g. https://<customer>.appfolio.com/api/v0), set APPFOLIO_DATABASE_API_URL in Vercel.`
        : null,
    ].filter(Boolean),
  });
});
