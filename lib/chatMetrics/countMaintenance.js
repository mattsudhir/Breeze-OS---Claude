// count_maintenance — flexible filter over the AppFolio work_order
// mirror. Powers chat questions that combine dimensions the standard
// chat_metrics keys can't express alone, e.g. "urgent HVAC", "stale
// plumbing tickets", "open work orders mentioning mold".
//
// Reads schema.appfolioCache (resourceType='work_order') directly —
// no AppFolio round-trip. Matches the same categorise() rules used by
// maint_by_category so HVAC etc. map consistently across surfaces.
//
// Filter inputs (all optional):
//   status:        'open' | 'completed' | 'all'  (default 'open')
//   min_priority:  'urgent' | 'high' | 'medium' | 'low'
//                  (urgent = Urgent+Emergency; high = High+up; …)
//   category:      'hvac' | 'plumbing' | 'electrical' | 'appliance' |
//                  'pest' | 'exterior' | 'cosmetic' | 'security' |
//                  'general' | 'uncategorized'
//   search:        free-text keyword matched against summary +
//                  description (ILIKE)
//   stale_only:    boolean — only open >30 days
//
// Returns { count, filters_applied } so the chat surface can phrase
// the answer ("3 urgent HVAC work orders") without an extra LLM call.

import { and, eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';

const PRIORITY_BUCKETS = {
  urgent: ['urgent', 'emergency'],
  high: ['urgent', 'emergency', 'high'],
  medium: ['urgent', 'emergency', 'high', 'medium', 'normal'],
  low: ['urgent', 'emergency', 'high', 'medium', 'normal', 'low'],
};

const OPEN_STATUSES = ['new', 'in progress', 'open', 'pending', 'on hold'];

function categoryPattern(cat) {
  switch ((cat || '').toLowerCase()) {
    case 'hvac':
      return /hvac|heat|cool|air condition|furnace|ac\b/i;
    case 'plumbing':
      return /plumb|leak|drain|toilet|sink|faucet|water/i;
    case 'electrical':
      return /electric|wire|outlet|circuit|breaker|light/i;
    case 'appliance':
      return /appliance|fridge|stove|oven|dishwasher|washer|dryer|microwave/i;
    case 'pest':
      return /pest|bug|rodent|mouse|roach|ant\b/i;
    case 'exterior':
      return /roof|gutter|siding|window|door|fence/i;
    case 'cosmetic':
      return /clean|paint|cosmetic|trash/i;
    case 'security':
      return /lock|security|key|alarm/i;
    default:
      return null;
  }
}

export async function countMaintenance({
  orgId,
  status = 'open',
  min_priority = null,
  category = null,
  search = null,
  stale_only = false,
}) {
  const db = getDb();

  const clauses = [
    eq(schema.appfolioCache.organizationId, orgId),
    eq(schema.appfolioCache.resourceType, 'work_order'),
  ];

  // Status filter. Open means anything not Completed/Canceled. The
  // mirror stores status under data->>'status' as free-form text.
  if (status === 'open') {
    clauses.push(
      sql`LOWER(COALESCE(${schema.appfolioCache.data}->>'status', '')) NOT IN ('completed', 'canceled', 'cancelled', 'closed')`,
    );
  } else if (status === 'completed') {
    clauses.push(
      sql`LOWER(COALESCE(${schema.appfolioCache.data}->>'status', '')) IN ('completed', 'closed')`,
    );
  }
  // 'all' adds no status clause.

  // Priority: min_priority='urgent' → urgent+emergency only; 'high' →
  // those + High; etc. Matches maint_by_priority bucketing.
  if (min_priority && PRIORITY_BUCKETS[min_priority]) {
    const allowed = PRIORITY_BUCKETS[min_priority]
      .map((p) => `'${p}'`)
      .join(', ');
    clauses.push(
      sql.raw(
        `LOWER(COALESCE(data->>'priority', '')) IN (${allowed})`,
      ),
    );
  }

  if (stale_only) {
    clauses.push(
      sql`(${schema.appfolioCache.data}->>'createdDate')::timestamptz < (NOW() - INTERVAL '30 days')`,
    );
  }

  // Free-text search across summary + description.
  if (search && search.trim()) {
    const needle = `%${search.trim()}%`;
    clauses.push(
      sql`(
        ${schema.appfolioCache.data}->>'summary' ILIKE ${needle}
        OR ${schema.appfolioCache.data}->>'description' ILIKE ${needle}
      )`,
    );
  }

  // Category is the tricky one — VendorTrade is sparse, so we have to
  // post-filter in JS using the categorise regex against summary +
  // category text. We push a coarse SQL prefilter when possible (just
  // the regex on the concatenation) to avoid loading every row.
  if (category) {
    const pat = categoryPattern(category);
    if (pat) {
      clauses.push(
        sql`(
          ${schema.appfolioCache.data}->>'categoryName' ~* ${pat.source}
          OR ${schema.appfolioCache.data}->>'summary' ~* ${pat.source}
          OR COALESCE(${schema.appfolioCache.data}->>'description', '') ~* ${pat.source}
        )`,
      );
    } else if (category === 'uncategorized') {
      clauses.push(
        sql`COALESCE(${schema.appfolioCache.data}->>'categoryName', '') = ''`,
      );
    }
  }

  const rows = await db
    .select({ n: sql`COUNT(*)::int`.as('n') })
    .from(schema.appfolioCache)
    .where(and(...clauses));

  return {
    count: rows[0]?.n || 0,
    filters_applied: { status, min_priority, category, search, stale_only },
  };
}
