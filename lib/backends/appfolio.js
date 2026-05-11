// AppFolio Database API v0 + Reports API v1 backend.
//
// Connects to AppFolio's production API for Breeze Property Group using
// permanent HTTP Basic Auth credentials. Unlike the Zoho MCP backend,
// there is NO token expiry and NO refresh dance — the credentials are
// valid until manually rotated in the AppFolio Developer Space.
//
// Two APIs are used:
//
//   1. Database API v0 (GET, paginated, filter-required)
//      Base: https://api.appfolio.com/api/v0
//      Used for: properties, tenants, units (raw entity reads).
//
//   2. Reports API v1 (POST, JSON body, per-tenant subdomain)
//      Base: https://<subdomain>.appfolio.com/api/v1/reports
//      Used for: chart_of_accounts, general_ledger, bill_detail,
//      income_register, deposit_register, etc.
//
// Both APIs share auth: HTTP Basic + X-AppFolio-Developer-ID, plus a
// server-side IP allowlist enforced per Developer ID. The allowlist is
// the most common 403 source — see docs/accounting/appfolio-access-
// setup.md for the Vercel static-outbound-IP runbook.
//
// Environment variables:
//   APPFOLIO_CLIENT_ID            — from AppFolio Developer Space
//   APPFOLIO_CLIENT_SECRET        — from AppFolio Developer Space
//   APPFOLIO_DEVELOPER_ID         — customer/developer ID
//                                   (X-AppFolio-Developer-ID header)
//   APPFOLIO_DATABASE_SUBDOMAIN   — per-tenant subdomain for the
//                                   Reports API (e.g. 'breezepg').
//                                   Optional; defaults to 'breezepg'.
//
// API docs are gated behind the Developer Space (auth required); useful
// public references are linked in the access-setup doc.

const DATABASE_API_BASE = 'https://api.appfolio.com/api/v0';
const DEFAULT_REPORTS_SUBDOMAIN = 'breezepg';

export const name = 'appfolio';
export const displayName = 'AppFolio';
export const description =
  'Breeze Property Group production data via the AppFolio Database API. ' +
  'Properties, tenants, units, and more — live from AppFolio.';

export const systemPromptAddendum = [
  'Data source: AppFolio Database API v0 + Reports API v1 (production).',
  '',
  'This is LIVE production data for Breeze Property Group. Treat it as real.',
  '',
  'Available tools:',
  '- list_properties: all properties with address, type, status',
  '- list_tenants: all tenants with name, email, phone, status',
  '- search_tenants: find tenants by name',
  '- get_tenant_details: full record for one tenant by ID',
  '- list_units: all units with property, address, bedrooms, bathrooms, status',
  '- list_gl_accounts: chart of accounts (Reports API)',
  '- list_general_ledger: recent journal entries within a date range',
  '- list_bill_detail: recent vendor bills',
  '- list_income_register: recent tenant/owner receipts',
  '',
  'Important:',
  '- Tenant records include FirstName, LastName, Email, Phone, MobilePhone, etc.',
  '- Properties include Address1, City, State, PostalCode, Type.',
  '- Units include PropertyName, Address, Bedrooms, Bathrooms, MarketRent.',
  '- Hidden/inactive records have a HiddenAt timestamp; active records do not.',
  '- When counting tenants, only count those where HiddenAt is null (active).',
  '- Reports API tools require a server-side IP allowlist on the',
  '  AppFolio Developer Space; calls from non-allowlisted hosts return',
  '  403 "Host not in allowlist".',
].join('\n');

// ── Auth helpers ─────────────────────────────────────────────────

function getAuthHeaders() {
  const clientId = process.env.APPFOLIO_CLIENT_ID;
  const clientSecret = process.env.APPFOLIO_CLIENT_SECRET;
  const developerId = process.env.APPFOLIO_DEVELOPER_ID;

  if (!clientId || !clientSecret || !developerId) {
    throw new Error(
      'AppFolio credentials not configured. Set APPFOLIO_CLIENT_ID, ' +
      'APPFOLIO_CLIENT_SECRET, and APPFOLIO_DEVELOPER_ID in Vercel → ' +
      'Settings → Environment Variables.',
    );
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  return {
    'Authorization': `Basic ${credentials}`,
    'Accept': 'application/json',
    'X-AppFolio-Developer-ID': developerId,
  };
}

// Reports API requires DIFFERENT Basic Auth credentials than the
// Database API v0. Both APIs use HTTP Basic Auth with a Client ID +
// Client Secret pair, but the pairs are issued from two different
// places in AppFolio's product:
//
//   Database API v0  → Developer Space (external admin portal),
//                      env vars APPFOLIO_CLIENT_ID / APPFOLIO_CLIENT_SECRET.
//   Reports API      → AppFolio web UI, Tools → API Settings →
//                      Reports API → Generate New Credentials,
//                      env vars APPFOLIO_REPORTS_CLIENT_ID /
//                      APPFOLIO_REPORTS_CLIENT_SECRET.
//
// When the Reports-specific pair is set we use it for Reports API
// requests. Otherwise we fall back to the Database API pair so calls
// fail with a clear 401 (rather than throwing) and the introspect
// endpoint can surface the misconfiguration in its response.
function getReportsAuthHeaders() {
  const reportsClientId = process.env.APPFOLIO_REPORTS_CLIENT_ID;
  const reportsClientSecret = process.env.APPFOLIO_REPORTS_CLIENT_SECRET;

  if (reportsClientId && reportsClientSecret) {
    const credentials = Buffer.from(
      `${reportsClientId}:${reportsClientSecret}`,
    ).toString('base64');
    const headers = {
      'Authorization': `Basic ${credentials}`,
      'Accept': 'application/json',
    };
    // The Reports API may or may not honor the Developer-ID header.
    // Sending it is harmless; not sending it would break the case
    // where AppFolio does check for it. Include it when configured.
    const developerId = process.env.APPFOLIO_DEVELOPER_ID;
    if (developerId) {
      headers['X-AppFolio-Developer-ID'] = developerId;
    }
    return headers;
  }

  return getAuthHeaders();
}

// ── Paginated fetch ──────────────────────────────────────────────

async function fetchAllPages(endpoint, params = {}) {
  const headers = getAuthHeaders();
  params['page[size]'] = 1000;
  if (!params['filters[LastUpdatedAtFrom]']) {
    params['filters[LastUpdatedAtFrom]'] = '1970-01-01T00:00:00Z';
  }

  const allRecords = [];
  const qs = new URLSearchParams(params).toString();
  let url = `${DATABASE_API_BASE}${endpoint}?${qs}`;
  let page = 0;

  while (url) {
    page += 1;
    if (page > 20) break;

    const res = await fetch(url, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { error: `AppFolio API ${res.status}: ${text.slice(0, 400)}` };
    }
    const data = await res.json();
    const records = data.data || [];
    allRecords.push(...records);

    if (data.next_page_path) {
      url = `https://api.appfolio.com${data.next_page_path}`;
    } else {
      url = null;
    }
  }
  return { data: allRecords };
}

// ── Reports API helper ───────────────────────────────────────────
//
// Reports endpoints live at
//   https://<subdomain>.appfolio.com/api/v1/reports/<report_name>.json
//
// They accept POST with a JSON body of filters. The shape of "results"
// in the response differs per report — usually `results: [...rows]`
// plus `columns: [...]` and pagination via `next_page_path` (same
// convention as the Database API). When we hit an unexpected shape we
// surface the raw first page under `_raw_first_page` so the caller can
// introspect without us having to guess the schema up front.
async function postReport(reportName, body = {}) {
  const headers = {
    ...getReportsAuthHeaders(),
    'Content-Type': 'application/json',
  };
  const subdomain =
    process.env.APPFOLIO_DATABASE_SUBDOMAIN || DEFAULT_REPORTS_SUBDOMAIN;
  // Empirically confirmed via the URL probe in this branch: the v2 path
  // accepts POST and returns 200 with snake_case results; v1 returns
  // 200 only for GET. We standardise on v2 POST because POST lets us
  // pass filters in the body (date ranges, property scopes, GL account
  // filters, etc.) without URL-encoding gymnastics.
  let url = `https://${subdomain}.appfolio.com/api/v2/reports/${reportName}.json`;

  const allRows = [];
  let page = 0;
  let lastPayload = null;
  while (url) {
    page += 1;
    if (page > 20) break;

    // 429-aware retry. AppFolio's Reports API rate-limits aggressively
    // and returns text/plain "Retry later\n" with status 429 when
    // throttled. Honor Retry-After if present; otherwise back off
    // 2s → 4s → 8s. Cap at 4 attempts before surfacing the error.
    let res;
    let attempt = 0;
    while (true) {
      attempt += 1;
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (res.status !== 429 || attempt >= 4) break;
      const retryAfter = parseInt(res.headers.get('retry-after'), 10);
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1000 * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { error: `AppFolio Reports ${res.status}: ${text.slice(0, 400)}` };
    }
    const data = await res.json();
    lastPayload = data;
    const rows = data.results || data.data || data.rows || [];
    allRows.push(...rows);

    if (data.next_page_path) {
      url = `https://${subdomain}.appfolio.com${data.next_page_path}`;
    } else {
      url = null;
    }
  }
  return {
    data: allRows,
    columns: lastPayload?.columns || null,
    _raw_first_page: lastPayload,
  };
}

// ── Reports API URL probe (diagnostic) ───────────────────────────
//
// Tries several plausible URL/method combinations for the Reports
// API "chart_of_accounts" report and returns the raw HTTP status,
// content-type, and body snippet for each. Used to figure out which
// shape AppFolio's Reports API actually exposes on this account
// without having to read their gated docs.
//
// Returns an array of { label, url, method, status, content_type,
// body_snippet, body_length } objects. Safe to call repeatedly; each
// variant is a tiny request.
export async function probeReportsEndpoints() {
  const headers = {
    ...getReportsAuthHeaders(),
    'Content-Type': 'application/json',
  };
  const subdomain =
    process.env.APPFOLIO_DATABASE_SUBDOMAIN || DEFAULT_REPORTS_SUBDOMAIN;
  const usingReportsCreds = Boolean(
    process.env.APPFOLIO_REPORTS_CLIENT_ID &&
      process.env.APPFOLIO_REPORTS_CLIENT_SECRET,
  );

  const variants = [
    {
      label: 'subdomain v1 reports GET .json (recommended after probe)',
      url: `https://${subdomain}.appfolio.com/api/v1/reports/chart_of_accounts.json`,
      method: 'GET',
    },
    {
      label: 'subdomain v2 reports POST .json',
      url: `https://${subdomain}.appfolio.com/api/v2/reports/chart_of_accounts.json`,
      method: 'POST',
      body: {},
    },
    {
      label: 'subdomain v1 reports POST .json (original default)',
      url: `https://${subdomain}.appfolio.com/api/v1/reports/chart_of_accounts.json`,
      method: 'POST',
      body: {},
    },
    {
      label: 'subdomain v0 reports POST .json',
      url: `https://${subdomain}.appfolio.com/api/v0/reports/chart_of_accounts.json`,
      method: 'POST',
      body: {},
    },
  ];

  const results = await Promise.all(
    variants.map(async (v) => {
      try {
        const opts = { method: v.method, headers };
        if (v.body !== undefined) opts.body = JSON.stringify(v.body);
        const res = await fetch(v.url, opts);
        const text = await res.text().catch(() => '');
        return {
          label: v.label,
          url: v.url,
          method: v.method,
          status: res.status,
          content_type: res.headers.get('content-type'),
          server: res.headers.get('server'),
          x_request_id: res.headers.get('x-request-id'),
          body_length: text.length,
          body_snippet: text.slice(0, 300),
        };
      } catch (err) {
        return {
          label: v.label,
          url: v.url,
          method: v.method,
          error: err.message || String(err),
        };
      }
    }),
  );
  return {
    using_reports_specific_credentials: usingReportsCreds,
    auth_hint: usingReportsCreds
      ? 'Reports API basic auth = APPFOLIO_REPORTS_CLIENT_ID / APPFOLIO_REPORTS_CLIENT_SECRET'
      : 'Reports API basic auth falling back to APPFOLIO_CLIENT_ID / APPFOLIO_CLIENT_SECRET — these are WRONG for the Reports API. Set APPFOLIO_REPORTS_CLIENT_ID and APPFOLIO_REPORTS_CLIENT_SECRET env vars from the AppFolio web UI (Tools → API Settings → Reports API → Generate New Credentials).',
    variants: results,
  };
}

// ── Tool definitions ─────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_properties',
    description:
      'List all properties in the AppFolio portfolio. Returns address, city, state, ' +
      'postal code, type, and status for each property.',
    input_schema: {
      type: 'object',
      properties: {
        include_hidden: {
          type: 'boolean',
          description: 'Include hidden/inactive properties. Default false.',
        },
      },
      required: [],
    },
  },
  {
    name: 'list_tenants',
    description:
      'List all tenants in AppFolio. Returns first name, last name, email, phone, ' +
      'mobile phone, status, and property assignment. Use search_tenants for name ' +
      'lookups, or this tool for counts and full lists.',
    input_schema: {
      type: 'object',
      properties: {
        active_only: {
          type: 'boolean',
          description: 'Only return active tenants (no HiddenAt). Default true.',
        },
      },
      required: [],
    },
  },
  {
    name: 'search_tenants',
    description:
      'Search for tenants by name. Returns matching tenants with contact info.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Partial or full name to search for.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_tenant_details',
    description:
      'Get the full record for a single tenant by their AppFolio ID.',
    input_schema: {
      type: 'object',
      properties: {
        tenant_id: {
          type: 'string',
          description: 'The AppFolio tenant ID.',
        },
      },
      required: ['tenant_id'],
    },
  },
  {
    name: 'list_units',
    description:
      'List all rental units in AppFolio. Returns unit name/number, property, ' +
      'address, bedrooms, bathrooms, square feet, market rent, and status.',
    input_schema: {
      type: 'object',
      properties: {
        include_hidden: {
          type: 'boolean',
          description: 'Include hidden/inactive units. Default false.',
        },
      },
      required: [],
    },
  },
  {
    name: 'list_gl_accounts',
    description:
      'List the chart of accounts from AppFolio (Reports API). Returns ' +
      'account numbers, names, types, and any account hierarchy AppFolio ' +
      'exposes. Use this to understand the existing GL structure before ' +
      'building or migrating a chart of accounts.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_general_ledger',
    description:
      'Fetch journal entries from the AppFolio general ledger within a ' +
      'date range (Reports API). Each row is a posted GL entry with a ' +
      'date, account, debit/credit, memo, and source reference.',
    input_schema: {
      type: 'object',
      properties: {
        from_date: { type: 'string', description: 'YYYY-MM-DD (inclusive).' },
        to_date: { type: 'string', description: 'YYYY-MM-DD (inclusive).' },
        accounting_basis: {
          type: 'string',
          enum: ['Cash', 'Accrual'],
          description: 'Accounting basis. Defaults to Accrual.',
        },
      },
      required: ['from_date', 'to_date'],
    },
  },
  {
    name: 'list_bill_detail',
    description:
      'Fetch vendor bills from AppFolio (Reports API) within a date range. ' +
      'Includes payee, amounts, due dates, payment status, and per-line GL ' +
      'detail. Useful for understanding AP shape and current vendors.',
    input_schema: {
      type: 'object',
      properties: {
        from_date: { type: 'string', description: 'YYYY-MM-DD (inclusive).' },
        to_date: { type: 'string', description: 'YYYY-MM-DD (inclusive).' },
        status: {
          type: 'string',
          enum: ['Paid', 'Unpaid', 'All'],
          description: 'Bill payment status filter. Defaults to All.',
        },
      },
      required: ['from_date', 'to_date'],
    },
  },
  {
    name: 'list_income_register',
    description:
      'Fetch tenant/owner receipts from AppFolio (Reports API) within a ' +
      'date range. Returns receipt amount, payer, property/unit, charge ' +
      'allocation, and transaction id.',
    input_schema: {
      type: 'object',
      properties: {
        from_date: { type: 'string', description: 'YYYY-MM-DD (inclusive).' },
        to_date: { type: 'string', description: 'YYYY-MM-DD (inclusive).' },
      },
      required: ['from_date', 'to_date'],
    },
  },
];

export async function getTools() {
  return TOOLS;
}

// ── Tool executors ───────────────────────────────────────────────

export async function executeTool(toolName, input) {
  try {
    switch (toolName) {
      case 'list_properties': {
        const params = {};
        if (input.include_hidden) {
          params['filters[IncludeHidden]'] = 'true';
        }
        const result = await fetchAllPages('/properties', params);
        if (result.error) return result;

        const properties = result.data.map((p) => ({
          id: p.Id || p.id,
          address: [p.Address1, p.Address2].filter(Boolean).join(', '),
          city: p.City,
          state: p.State,
          postal_code: p.PostalCode,
          type: p.Type,
          name: p.Name || p.Address1,
          hidden: !!p.HiddenAt,
        }));
        return {
          count: properties.length,
          properties: properties.slice(0, 50),
          truncated: properties.length > 50,
        };
      }

      case 'list_tenants': {
        const activeOnly = input.active_only !== false;
        const result = await fetchAllPages('/tenants');
        if (result.error) return result;

        let tenants = result.data.map(mapTenant);
        if (activeOnly) {
          tenants = tenants.filter((t) => !t.hidden);
        }
        return {
          total: tenants.length,
          active: tenants.filter((t) => !t.hidden).length,
          tenants: tenants.slice(0, 30),
          truncated: tenants.length > 30,
        };
      }

      case 'search_tenants': {
        const q = (input.query || '').toLowerCase().trim();
        if (!q) return { error: 'search_tenants requires a query' };

        const result = await fetchAllPages('/tenants');
        if (result.error) return result;

        const matches = result.data
          .map(mapTenant)
          .filter((t) => {
            const full = `${t.first_name} ${t.last_name}`.toLowerCase();
            return full.includes(q);
          });

        return {
          count: matches.length,
          tenants: matches.slice(0, 20),
        };
      }

      case 'get_tenant_details': {
        if (!input.tenant_id) return { error: 'tenant_id is required' };
        const headers = getAuthHeaders();
        const res = await fetch(`${DATABASE_API_BASE}/tenants/${input.tenant_id}`, { headers });
        if (!res.ok) {
          return { error: `AppFolio API ${res.status} for tenant ${input.tenant_id}` };
        }
        const data = await res.json();
        const tenant = data.data || data;
        return mapTenantFull(Array.isArray(tenant) ? tenant[0] : tenant);
      }

      case 'list_units': {
        const params = {};
        if (input.include_hidden) {
          params['filters[IncludeHidden]'] = 'true';
        }
        const result = await fetchAllPages('/units', params);
        if (result.error) return result;

        const units = result.data.map((u) => ({
          id: u.Id || u.id,
          name: u.Name || u.UnitNumber || u.Address1,
          property_name: u.PropertyName || '',
          address: [u.Address1, u.Address2].filter(Boolean).join(', '),
          city: u.City,
          state: u.State,
          bedrooms: u.Bedrooms,
          bathrooms: u.Bathrooms,
          sqft: u.SquareFeet || u.SquareFootage,
          market_rent: u.MarketRent,
          status: u.Status,
          hidden: !!u.HiddenAt,
        }));
        return {
          count: units.length,
          units: units.slice(0, 50),
          truncated: units.length > 50,
        };
      }

      case 'list_gl_accounts': {
        const result = await postReport('chart_of_accounts', {});
        if (result.error) return result;
        return {
          count: result.data.length,
          accounts: result.data.slice(0, 500),
          columns: result.columns,
          truncated: result.data.length > 500,
        };
      }

      case 'list_general_ledger': {
        if (!input.from_date || !input.to_date) {
          return { error: 'from_date and to_date are required (YYYY-MM-DD)' };
        }
        const body = {
          from_date: input.from_date,
          to_date: input.to_date,
          accounting_basis: input.accounting_basis || 'Accrual',
        };
        const result = await postReport('general_ledger', body);
        if (result.error) return result;
        return {
          count: result.data.length,
          entries: result.data.slice(0, 500),
          columns: result.columns,
          truncated: result.data.length > 500,
        };
      }

      case 'list_bill_detail': {
        if (!input.from_date || !input.to_date) {
          return { error: 'from_date and to_date are required (YYYY-MM-DD)' };
        }
        const body = {
          from_date: input.from_date,
          to_date: input.to_date,
        };
        if (input.status && input.status !== 'All') body.status = input.status;
        const result = await postReport('bill_detail', body);
        if (result.error) return result;
        return {
          count: result.data.length,
          bills: result.data.slice(0, 500),
          columns: result.columns,
          truncated: result.data.length > 500,
        };
      }

      case 'list_income_register': {
        if (!input.from_date || !input.to_date) {
          return { error: 'from_date and to_date are required (YYYY-MM-DD)' };
        }
        const body = {
          from_date: input.from_date,
          to_date: input.to_date,
        };
        const result = await postReport('income_register', body);
        if (result.error) return result;
        return {
          count: result.data.length,
          receipts: result.data.slice(0, 500),
          columns: result.columns,
          truncated: result.data.length > 500,
        };
      }

      default:
        return { error: `Unknown AppFolio tool: ${toolName}` };
    }
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

// ── Mappers ──────────────────────────────────────────────────────

function mapTenant(t) {
  return {
    id: t.Id || t.id,
    first_name: t.FirstName || '',
    last_name: t.LastName || '',
    name: [t.FirstName, t.LastName].filter(Boolean).join(' ') || 'Unknown',
    email: t.Email || '',
    phone: t.Phone || t.HomePhone || '',
    mobile: t.MobilePhone || t.CellPhone || '',
    status: t.Status || '',
    hidden: !!t.HiddenAt,
  };
}

function mapTenantFull(t) {
  if (!t) return { error: 'Tenant not found' };
  return {
    id: t.Id || t.id,
    first_name: t.FirstName || '',
    last_name: t.LastName || '',
    name: [t.FirstName, t.LastName].filter(Boolean).join(' '),
    email: t.Email || '',
    phone: t.Phone || t.HomePhone || '',
    mobile: t.MobilePhone || t.CellPhone || '',
    work_phone: t.WorkPhone || '',
    status: t.Status || '',
    address: [t.Address1, t.Address2, t.City, t.State, t.PostalCode]
      .filter(Boolean).join(', '),
    move_in_date: t.MoveInDate || null,
    move_out_date: t.MoveOutDate || null,
    lease_start: t.LeaseFrom || null,
    lease_end: t.LeaseTo || null,
    rent: t.Rent || t.MonthlyRent || null,
    balance: t.Balance || t.CurrentBalance || null,
    property_name: t.PropertyName || '',
    unit_name: t.UnitName || '',
    hidden: !!t.HiddenAt,
  };
}


