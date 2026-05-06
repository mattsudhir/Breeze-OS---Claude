// AppFolio Database API v0 backend.
//
// Connects to AppFolio's production API for Breeze Property Group using
// permanent HTTP Basic Auth credentials. Unlike the Zoho MCP backend,
// there is NO token expiry and NO refresh dance — the credentials are
// valid until manually rotated in the AppFolio Developer Space.
//
// Environment variables:
//   APPFOLIO_CLIENT_ID      — from AppFolio Developer Space
//   APPFOLIO_CLIENT_SECRET  — from AppFolio Developer Space
//   APPFOLIO_DEVELOPER_ID   — customer/developer ID (X-AppFolio-Developer-ID header)
//
// API docs: https://api.appfolio.com/api/v0 (Basic Auth, paginated, filter-required)

const BASE_URL = 'https://api.appfolio.com/api/v0';

export const name = 'appfolio';
export const displayName = 'AppFolio';
export const description =
  'Breeze Property Group production data via the AppFolio Database API. ' +
  'Properties, tenants, units, and more — live from AppFolio.';

export const systemPromptAddendum = [
  'Data source: AppFolio Database API v0 (production).',
  '',
  'This is LIVE production data for Breeze Property Group. Treat it as real.',
  '',
  'Tool selection — IMPORTANT for speed:',
  '- For "how many X" / "do we have any X" questions, ALWAYS prefer the',
  '  count_X tool (count_tenants, count_properties, count_units). They',
  '  return just numbers and are much faster than the list_X tools, which',
  '  fetch full record bodies and can time out on large datasets.',
  '- For "show me / list / who lives at" questions, use list_X tools with',
  '  offset and limit. Default page size is 30-50; ask for more (up to',
  '  100-200) only if the user explicitly wants a fuller list.',
  '- For tenant lookup by name, use search_tenants (it stops paging once',
  '  it has enough matches — fast).',
  '- For all details on one tenant (email, phone, lease, balance), call',
  '  get_tenant_details with the AppFolio ID returned by search_tenants.',
  '',
  'Pagination:',
  '- list_properties / list_tenants / list_units accept offset and limit.',
  '- Their response includes total, offset, limit, and has_more — if the',
  '  user wants the next batch, call again with offset = previous offset',
  '  + previous limit.',
  '',
  'Field reference:',
  '- Tenants: FirstName, LastName, Email, Phone, MobilePhone, Status,',
  '  HiddenAt, PropertyName, UnitName, MoveInDate, MoveOutDate,',
  '  LeaseFrom, LeaseTo, Rent, Balance.',
  '- Properties: Address1, City, State, PostalCode, Type, HiddenAt.',
  '- Units: PropertyName, Address1, Bedrooms, Bathrooms, MarketRent,',
  '  Status (vacant/occupied/etc.), HiddenAt.',
  '- Hidden/inactive records have HiddenAt set; active records do not.',
  '  When counting "active" anything, count records where HiddenAt is null.',
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

// ── Paginated fetch ──────────────────────────────────────────────
//
// AppFolio uses cursor-based pagination via `next_page_path` in the
// response body. We can't parallelise — page N+1's URL only exists
// after page N comes back — so cost is roughly (# records / pageSize)
// × per-request latency. With `page[size]=1000` and ~5k tenants this
// is ~5 sequential requests; without a smaller cap or early-exit
// hook, large datasets can blow past the function's maxDuration.
//
// `onPage` lets the caller process records as they arrive AND opt to
// stop paging early (return false to halt). This is what makes count
// and offset/limit list tools survive on large endpoints — they never
// hold the full result set in memory at once and can short-circuit.

async function fetchAllPages(endpoint, params = {}, { onPage, maxPages = 20 } = {}) {
  const headers = getAuthHeaders();
  params['page[size]'] = params['page[size]'] || 1000;
  if (!params['filters[LastUpdatedAtFrom]']) {
    params['filters[LastUpdatedAtFrom]'] = '1970-01-01T00:00:00Z';
  }

  const allRecords = onPage ? null : [];
  const qs = new URLSearchParams(params).toString();
  let url = `${BASE_URL}${endpoint}?${qs}`;
  let page = 0;
  let totalSeen = 0;

  while (url) {
    page += 1;
    if (page > maxPages) break;

    const res = await fetch(url, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { error: `AppFolio API ${res.status}: ${text.slice(0, 400)}` };
    }
    const data = await res.json();
    const records = data.data || [];
    totalSeen += records.length;

    if (onPage) {
      const keepGoing = onPage(records, { page, totalSeen });
      if (keepGoing === false) {
        return { totalSeen, stoppedEarly: true };
      }
    } else {
      allRecords.push(...records);
    }

    if (data.next_page_path) {
      url = `https://api.appfolio.com${data.next_page_path}`;
    } else {
      url = null;
    }
  }
  return onPage ? { totalSeen, stoppedEarly: false } : { data: allRecords };
}

// ── Tool definitions ─────────────────────────────────────────────

const TOOLS = [
  // ── Count tools ──
  // Prefer these for "how many X" / "do we have any X" questions.
  // They iterate AppFolio just like the list tools but never materialise
  // record bodies, so the response to the LLM is tiny (a couple of
  // numbers) — much faster end-to-end than list_X + LLM-side counting.
  {
    name: 'count_tenants',
    description:
      'Return the number of tenants in AppFolio (total, active, and hidden). ' +
      'Use this for "how many tenants" questions instead of list_tenants — ' +
      "it is much faster because it doesn't ship full tenant records to you.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'count_properties',
    description:
      'Return the number of properties in AppFolio (total, active, hidden). ' +
      'Use this for "how many properties" questions instead of list_properties.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'count_units',
    description:
      'Return the number of rental units in AppFolio (total, active, hidden, ' +
      'and a breakdown by status — vacant, occupied, etc. when AppFolio sets ' +
      'a Status field on the unit). Use this for "how many units" or "how many ' +
      'vacant units" questions instead of list_units.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  // ── List tools ──
  // Use when the user actually needs records (names, addresses, IDs).
  // All three accept offset/limit for paging through large result sets.
  {
    name: 'list_properties',
    description:
      'List properties in the AppFolio portfolio with address, city, state, ' +
      'type, and status. Supports pagination via offset/limit.',
    input_schema: {
      type: 'object',
      properties: {
        include_hidden: {
          type: 'boolean',
          description: 'Include hidden/inactive properties. Default false.',
        },
        offset: {
          type: 'integer',
          description: 'Number of records to skip. Default 0.',
        },
        limit: {
          type: 'integer',
          description: 'Max records to return. Default 50, max 200.',
        },
      },
      required: [],
    },
  },
  {
    name: 'list_tenants',
    description:
      'List tenants with first name, last name, email, phone, mobile, and status. ' +
      'Supports pagination via offset/limit. For counts use count_tenants ' +
      '(faster). For name lookups use search_tenants.',
    input_schema: {
      type: 'object',
      properties: {
        active_only: {
          type: 'boolean',
          description: 'Only return active tenants (no HiddenAt). Default true.',
        },
        offset: {
          type: 'integer',
          description: 'Number of records to skip. Default 0.',
        },
        limit: {
          type: 'integer',
          description: 'Max records to return. Default 30, max 100.',
        },
      },
      required: [],
    },
  },
  {
    name: 'search_tenants',
    description:
      'Search for tenants by name. Returns matching tenants with contact info. ' +
      'Stops paging once enough matches are found, so it is fast even on ' +
      'large portfolios.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Partial or full name to search for.',
        },
        limit: {
          type: 'integer',
          description: 'Max matches to return. Default 20, max 100.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_tenant_details',
    description:
      'Get the full record for a single tenant by their AppFolio ID, including ' +
      'lease dates, rent, balance, address, and unit assignment.',
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
      'List rental units with unit name, property, address, bedrooms, bathrooms, ' +
      'sqft, market rent, and status. Supports pagination via offset/limit.',
    input_schema: {
      type: 'object',
      properties: {
        include_hidden: {
          type: 'boolean',
          description: 'Include hidden/inactive units. Default false.',
        },
        offset: {
          type: 'integer',
          description: 'Number of records to skip. Default 0.',
        },
        limit: {
          type: 'integer',
          description: 'Max records to return. Default 50, max 200.',
        },
      },
      required: [],
    },
  },
];

export async function getTools() {
  return TOOLS;
}

// ── Tool executors ───────────────────────────────────────────────

function clampLimit(input, defaultLimit, maxLimit) {
  const requested = Number(input);
  if (!Number.isFinite(requested) || requested <= 0) return defaultLimit;
  return Math.min(Math.floor(requested), maxLimit);
}

function clampOffset(input) {
  const requested = Number(input);
  if (!Number.isFinite(requested) || requested < 0) return 0;
  return Math.floor(requested);
}

export async function executeTool(toolName, input) {
  try {
    switch (toolName) {
      // ── Count tools (fast — never materialise full records) ──
      case 'count_tenants': {
        let total = 0;
        let active = 0;
        const result = await fetchAllPages('/tenants', {}, {
          onPage: (records) => {
            for (const t of records) {
              total += 1;
              if (!t.HiddenAt) active += 1;
            }
            return true;
          },
        });
        if (result.error) return result;
        return { total, active, hidden: total - active };
      }

      case 'count_properties': {
        let total = 0;
        let active = 0;
        const params = { 'filters[IncludeHidden]': 'true' };
        const result = await fetchAllPages('/properties', params, {
          onPage: (records) => {
            for (const p of records) {
              total += 1;
              if (!p.HiddenAt) active += 1;
            }
            return true;
          },
        });
        if (result.error) return result;
        return { total, active, hidden: total - active };
      }

      case 'count_units': {
        let total = 0;
        let active = 0;
        const byStatus = {};
        const params = { 'filters[IncludeHidden]': 'true' };
        const result = await fetchAllPages('/units', params, {
          onPage: (records) => {
            for (const u of records) {
              total += 1;
              if (!u.HiddenAt) active += 1;
              const s = (u.Status || 'unknown').toString().toLowerCase();
              byStatus[s] = (byStatus[s] || 0) + 1;
            }
            return true;
          },
        });
        if (result.error) return result;
        return { total, active, hidden: total - active, by_status: byStatus };
      }

      // ── List tools (paginated, return record bodies) ──
      case 'list_properties': {
        const limit = clampLimit(input.limit, 50, 200);
        const offset = clampOffset(input.offset);
        const params = {};
        if (input.include_hidden) params['filters[IncludeHidden]'] = 'true';

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
        const page = properties.slice(offset, offset + limit);
        return {
          total: properties.length,
          offset,
          limit,
          has_more: offset + limit < properties.length,
          properties: page,
        };
      }

      case 'list_tenants': {
        const activeOnly = input.active_only !== false;
        const limit = clampLimit(input.limit, 30, 100);
        const offset = clampOffset(input.offset);

        const result = await fetchAllPages('/tenants');
        if (result.error) return result;

        let tenants = result.data.map(mapTenant);
        if (activeOnly) tenants = tenants.filter((t) => !t.hidden);

        const page = tenants.slice(offset, offset + limit);
        return {
          total: tenants.length,
          offset,
          limit,
          has_more: offset + limit < tenants.length,
          tenants: page,
        };
      }

      case 'search_tenants': {
        const q = (input.query || '').toLowerCase().trim();
        if (!q) return { error: 'search_tenants requires a query' };
        const limit = clampLimit(input.limit, 20, 100);

        const matches = [];
        const result = await fetchAllPages('/tenants', {}, {
          onPage: (records) => {
            for (const raw of records) {
              const t = mapTenant(raw);
              const full = `${t.first_name} ${t.last_name}`.toLowerCase();
              if (full.includes(q)) {
                matches.push(t);
                if (matches.length >= limit) return false; // stop paging
              }
            }
            return true;
          },
        });
        if (result.error) return result;

        return {
          count: matches.length,
          tenants: matches,
          stopped_early: !!result.stoppedEarly,
        };
      }

      case 'get_tenant_details': {
        if (!input.tenant_id) return { error: 'tenant_id is required' };
        const headers = getAuthHeaders();
        const res = await fetch(`${BASE_URL}/tenants/${input.tenant_id}`, { headers });
        if (!res.ok) {
          return { error: `AppFolio API ${res.status} for tenant ${input.tenant_id}` };
        }
        const data = await res.json();
        const tenant = data.data || data;
        return mapTenantFull(Array.isArray(tenant) ? tenant[0] : tenant);
      }

      case 'list_units': {
        const limit = clampLimit(input.limit, 50, 200);
        const offset = clampOffset(input.offset);
        const params = {};
        if (input.include_hidden) params['filters[IncludeHidden]'] = 'true';

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
        const page = units.slice(offset, offset + limit);
        return {
          total: units.length,
          offset,
          limit,
          has_more: offset + limit < units.length,
          units: page,
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


