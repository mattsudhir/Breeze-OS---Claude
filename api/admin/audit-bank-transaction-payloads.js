// GET /api/admin/audit-bank-transaction-payloads?secret=<TOKEN>&limit=2000
//
// Scans bank_transactions.raw_payload for anything that looks like
// a full bank account number — defined as a run of 9+ consecutive
// digits that ISN'T already known-safe (transaction id, amount in
// cents, ISO date, etc.).
//
// Plaid is contractually not supposed to return full account numbers
// in the /transactions response; we only ever store `account_last4`
// elsewhere. This audit is a tripwire: if Plaid ever changes its
// payload shape (or we accidentally extend ingestion to a product
// that does return full numbers), this catches it on the next run
// and we can redact at ingest before any real data is exposed.
//
// Surfaces:
//   - count of scanned transactions
//   - count flagged
//   - up to 20 sample flagged rows with the offending payload key path
//
// Read-only. Safe to run anytime; the GitHub Actions schedule could
// run it nightly via /tail-errors if false positives prove rare.

import { eq, isNotNull, and } from 'drizzle-orm';
import { withAdminHandler, getDefaultOrgId } from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

export const config = { maxDuration: 60 };

// 9+ consecutive digits. We then post-filter against known-safe
// patterns (Plaid transaction_id contains digits, ISO dates do too,
// amount strings can too) so we don't fire on every row.
const DIGIT_RUN = /\b\d{9,}\b/g;

// Field paths we don't care about. The full digit-run check ignores
// values found at these keys. Add to this list as needed.
const SAFE_KEY_SUBSTRINGS = [
  'transaction_id',
  'account_id',           // Plaid account id is a UUID-ish string
  'item_id',
  'pending_transaction_id',
  'category_id',          // Plaid uses 7-digit category ids; bump
                          // safe-prefix if needed
  'authorized_date',      // ISO date doesn't have 9+ run, but harmless
  'date',
  'datetime',
  'amount',               // we cast to cents elsewhere; raw amount is float
  'iso_currency_code',
];

function flagDigits(obj, path = '$', findings = []) {
  if (obj == null) return findings;
  if (typeof obj === 'string') {
    // Pre-filter: was this value found at a known-safe key?
    if (SAFE_KEY_SUBSTRINGS.some((s) => path.toLowerCase().includes(s))) {
      return findings;
    }
    const matches = obj.match(DIGIT_RUN);
    if (matches) {
      for (const m of matches) {
        findings.push({ path, value: m, sample: obj.slice(0, 80) });
      }
    }
    return findings;
  }
  if (typeof obj === 'number') {
    // Numeric values: 9+ digit ints are suspicious unless explicitly
    // safe. Cast to string and reuse the path check.
    const s = String(Math.trunc(obj));
    if (s.length >= 9 &&
      !SAFE_KEY_SUBSTRINGS.some((k) => path.toLowerCase().includes(k))
    ) {
      findings.push({ path, value: s, sample: s });
    }
    return findings;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => flagDigits(item, `${path}[${i}]`, findings));
    return findings;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      flagDigits(v, `${path}.${k}`, findings);
    }
  }
  return findings;
}

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'GET or POST only' });
  }

  const limit = Math.min(
    Math.max(Number(req.query?.limit) || 2000, 1),
    50000,
  );

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  // Pull recent transactions with a non-null raw_payload. We only
  // scan rows where we actually have something to scan.
  const rows = await db
    .select({
      id: schema.bankTransactions.id,
      externalId: schema.bankTransactions.externalId,
      rawPayload: schema.bankTransactions.rawPayload,
      postedDate: schema.bankTransactions.postedDate,
    })
    .from(schema.bankTransactions)
    .where(
      and(
        eq(schema.bankTransactions.organizationId, organizationId),
        isNotNull(schema.bankTransactions.rawPayload),
      ),
    )
    .orderBy(schema.bankTransactions.postedDate)
    .limit(limit);

  let scanned = 0;
  let flaggedCount = 0;
  const samples = [];

  for (const r of rows) {
    scanned += 1;
    const findings = flagDigits(r.rawPayload, '$', []);
    if (findings.length > 0) {
      flaggedCount += 1;
      if (samples.length < 20) {
        samples.push({
          bank_transaction_id: r.id,
          external_id: r.externalId,
          posted_date: r.postedDate,
          first_findings: findings.slice(0, 3),
        });
      }
    }
  }

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    scanned,
    flagged_count: flaggedCount,
    flagged_pct: scanned > 0 ? Math.round((flaggedCount / scanned) * 10000) / 100 : 0,
    samples,
    note: flaggedCount === 0
      ? 'No 9+ digit runs found in raw_payload outside known-safe keys. Plaid contract held.'
      : 'Findings present. Review samples and either (a) extend SAFE_KEY_SUBSTRINGS to whitelist a benign key, or (b) add a redaction step in plaid-sync-transactions.js before raw_payload is stored.',
  });
});
