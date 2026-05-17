// Fast-path response templates for the chat_metrics cache reads.
//
// When the agent's only tool call is get_chat_metric and it returns
// successfully, we can skip the second LLM round-trip (where it would
// otherwise re-narrate the value) and template the reply locally.
// That cuts simple "how many X" questions from two LLM calls (~6-10s)
// to one (~3-5s).
//
// Phrasings match what the system prompt teaches the model to say,
// so the two paths read the same way to the user.

const CURRENCY = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const NUMBER = new Intl.NumberFormat('en-US');

function fmtMoney(cents) {
  if (cents == null) return '$0';
  return CURRENCY.format(Math.round(cents / 100));
}

function fmtNum(n) {
  if (n == null) return '0';
  return NUMBER.format(n);
}

function priorityLabel(key) {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function categoryLabel(key) {
  if (key === 'hvac') return 'HVAC';
  return key.charAt(0).toUpperCase() + key.slice(1);
}

const SHOWME = {
  occupancy: '[SHOWME view=tenants]',
  vacant: '[SHOWME view=properties]',
  tenants: '[SHOWME view=tenants]',
  properties: '[SHOWME view=properties]',
  maintAll: '[SHOWME view=maintenance status=open]',
  maintUrgent: '[SHOWME view=maintenance status=open min_priority=urgent]',
  maintStale: '[SHOWME view=maintenance status=open]',
};

// Returns null when we don't have a clean template for this metric,
// in which case the caller should fall back to the LLM round-trip.
export function formatChatMetricReply(metricKey, value) {
  if (!value || typeof value !== 'object') return null;

  switch (metricKey) {
    case 'occupancy_pct': {
      const { pct, active_tenancies, rentable_units } = value;
      if (active_tenancies == null || rentable_units == null) return null;
      return `We have **${fmtNum(active_tenancies)} tenancies out of ${fmtNum(
        rentable_units,
      )} units (${pct}%)**.\n\n${SHOWME.occupancy}`;
    }

    case 'vacant_unit_count': {
      const { count, occupied_units, rentable_units } = value;
      if (count == null) return null;
      return `We have **${fmtNum(count)} vacant units** (${fmtNum(
        occupied_units,
      )} occupied of ${fmtNum(rentable_units)} rentable).\n\n${SHOWME.vacant}`;
    }

    case 'tenant_count': {
      const { total, active, hidden } = value;
      if (total == null) return null;
      const extra = hidden ? ` (${fmtNum(hidden)} hidden)` : '';
      return `We have **${fmtNum(active)} active tenant records**${extra}.`;
    }

    case 'property_count': {
      const { total, active, hidden } = value;
      if (total == null) return null;
      const extra = hidden ? ` (${fmtNum(hidden)} hidden)` : '';
      return `We have **${fmtNum(active)} active properties**${extra}.\n\n${SHOWME.properties}`;
    }

    case 'unit_count': {
      const { total, active, hidden, by_status, non_revenue } = value;
      if (total == null) return null;
      const status = by_status
        ? Object.entries(by_status)
            .map(([k, v]) => `${v} ${k}`)
            .join(', ')
        : '';
      const nrNote =
        non_revenue > 0 ? ` (${fmtNum(non_revenue)} non-revenue excluded)` : '';
      return `We have **${fmtNum(active)} active units**${nrNote}${
        status ? ` — ${status}` : ''
      }.`;
    }

    case 'open_maint_count': {
      const { count } = value;
      if (count == null) return null;
      return `We have **${fmtNum(count)} open work orders**.\n\n${SHOWME.maintAll}`;
    }

    case 'urgent_maint_count': {
      const { count } = value;
      if (count == null) return null;
      return `There are **${fmtNum(count)} urgent or emergency work orders** open.\n\n${SHOWME.maintUrgent}`;
    }

    case 'stale_maint_count': {
      const { count, threshold_days } = value;
      if (count == null) return null;
      return `There are **${fmtNum(count)} open work orders older than ${threshold_days} days**.\n\n${SHOWME.maintStale}`;
    }

    case 'maint_by_priority': {
      const { by_priority } = value;
      if (!by_priority || !Object.keys(by_priority).length) return null;
      const lines = Object.entries(by_priority)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `- ${priorityLabel(k)}: **${fmtNum(v)}**`);
      return `Open work orders by priority:\n${lines.join('\n')}\n\n${SHOWME.maintAll}`;
    }

    case 'maint_by_category': {
      const { by_category } = value;
      if (!by_category || !Object.keys(by_category).length) return null;
      const lines = Object.entries(by_category)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `- ${categoryLabel(k)}: **${fmtNum(v)}**`);
      return `Open work orders by category:\n${lines.join('\n')}\n\n${SHOWME.maintAll}`;
    }

    case 'delinquent_tenant_count': {
      const { count } = value;
      if (count == null) return null;
      if (count === 0) {
        return 'No tenants currently show a positive balance in our cache. (Tenant balances require the `/balances` pipeline — see ADR 0006 v1.1.)';
      }
      return `**${fmtNum(count)} tenants** currently owe money.`;
    }

    case 'total_delinquency_cents': {
      const { total_cents } = value;
      if (total_cents == null) return null;
      if (total_cents === 0) {
        return 'Total delinquency shows $0 in our cache. (Balances pipeline pending — see ADR 0006 v1.1.)';
      }
      return `Total outstanding tenant balance is **${fmtMoney(total_cents)}**.`;
    }

    // Tenant-scoped metrics need name context the cache doesn't carry —
    // let the LLM phrase those.
    case 'tenant_balance_cents':
    case 'tenant_lease_summary':
      return null;

    default:
      return null;
  }
}
