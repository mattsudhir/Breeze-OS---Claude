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
  '  count_X tool (count_tenants, count_properties, count_units,',
  '  count_work_orders). They return just numbers and are much faster',
  '  than the list_X tools, which fetch full record bodies and can time',
  '  out on large datasets.',
  '- For "open work orders" / "urgent tickets" questions, use',
  '  list_work_orders with status="open" (default) and an optional',
  '  priority filter (Urgent / Normal / Low). Use count_work_orders for',
  '  pure counts.',
  '- For "show me / list / who lives at" questions, use list_X tools with',
  '  offset and limit. Default page size is 30-50; ask for more (up to',
  '  100-200) only if the user explicitly wants a fuller list.',
  '- For tenant lookup by name, use search_tenants. Its results already',
  '  include property_name, unit_name, lease dates, rent, and balance —',
  '  do NOT call get_tenant_details just to surface those fields. Only',
  '  call get_tenant_details when you need the full mailing address or',
  '  the user explicitly asks for "the full record".',
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
  '  LeaseFrom, LeaseTo, Rent, Balance, OccupancyId.',
  '- Properties: Address1, City, State, PostalCode, Type, HiddenAt.',
  '- Units: PropertyName, Address1, Bedrooms, Bathrooms, MarketRent,',
  '  Status (vacant/occupied/etc.), HiddenAt.',
  '- Hidden/inactive records have HiddenAt set; active records do not.',
  '  When counting "active" anything, count records where HiddenAt is null.',
  '',
  'Posting tenant charges (charge_tenant — write operation):',
  '- charge_tenant creates real money owed in AppFolio. It is NOT reversible',
  '  through this API — corrections must be made manually in AppFolio.',
  '- Before calling charge_tenant, ALWAYS confirm with the user, in one',
  '  message, ALL of these:',
  '    1. Tenant name (and the unit / property if helpful)',
  '    2. Amount (formatted as $X,XXX.XX)',
  '    3. GL account (e.g. "Repairs - Plumbing")',
  '    4. Description (the line item the tenant will see)',
  '    5. Charge date (default today; ask if user wants different)',
  '  Then wait for an explicit affirmative response ("yes", "post it",',
  '  "do it", "go ahead") before invoking the tool. Treat anything other',
  '  than a clear yes as a hold — ask again or stand down.',
  '- For property damage charges, the description should name what was',
  '  damaged and when, e.g. "Damage to bathroom door — repaired Apr 15, 2026".',
  '- Common GL accounts for damage/repair chargebacks: "Repairs - General",',
  '  "Repairs - Plumbing", "Repairs - Electrical", "Repairs - Pest Control".',
  '  If you\'re unsure which one to use, call list_gl_accounts and read the',
  '  options back to the user.',
  '- After charge_tenant succeeds, confirm with the user in one short line:',
  '  "Posted $X,XXX.XX charge to <Tenant>: <description> (charge id: <id>)."',
  '  If the response also includes attachment_id, append: "Photo attached."',
  '  If it includes attachment_error, append: "Photo upload failed: <error>."',
  '  so the user knows the charge succeeded but to retry the photo manually.',
  '- If the tool returns an error, surface it verbatim per the global error',
  '  rule. Do not retry automatically.',
  '',
  'Attaching photos to charges:',
  '- charge_tenant accepts an optional attachment_url field. When the user',
  '  provides a URL or has uploaded a photo via the chat\'s paperclip button',
  '  (which surfaces as "[Attachment: <url>]" in the user message), pass that',
  '  URL through to charge_tenant. The tool will fetch the file and attach',
  '  it to the AppFolio charge automatically.',
  '- For property damage charges, ask the user if they have a photo to',
  '  attach before posting — but do not BLOCK on it. If the user has no',
  '  photo, post the charge anyway.',
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

// ── Attachment upload (multipart/form-data) ──────────────────────
//
// AppFolio's POST /charges/{id}/attachments takes a multipart body
// with a single `File` field. We accept a public URL (callers can
// pass a Vercel Blob URL, a Cliq message URL, etc.), fetch the
// bytes server-side, and stream them through to AppFolio. Files
// larger than 30MB are rejected before upload to avoid wasted
// bandwidth — that's AppFolio's documented bill-attachment cap and
// a reasonable ceiling for damage photos.
//
// Crucially, we do NOT set Content-Type on the upload request —
// fetch's FormData handler sets it with the boundary parameter.
// Forcing application/json or octet-stream here breaks the upload.

const ATTACHMENT_MAX_BYTES = 30 * 1024 * 1024;

function deriveFilename(url, explicit) {
  if (explicit) return explicit;
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last || 'attachment';
  } catch {
    return 'attachment';
  }
}

async function uploadChargeAttachment(chargeId, attachmentUrl, explicitFilename) {
  let fileResp;
  try {
    fileResp = await fetch(attachmentUrl);
  } catch (err) {
    return { error: `Could not fetch attachment URL: ${err.message}` };
  }
  if (!fileResp.ok) {
    return {
      error: `Could not fetch attachment URL (HTTP ${fileResp.status})`,
    };
  }

  const fileBuffer = await fileResp.arrayBuffer();
  if (fileBuffer.byteLength === 0) {
    return { error: 'Attachment URL returned an empty file' };
  }
  if (fileBuffer.byteLength > ATTACHMENT_MAX_BYTES) {
    const mb = (fileBuffer.byteLength / 1024 / 1024).toFixed(1);
    return { error: `Attachment is ${mb}MB — max is 30MB` };
  }

  const contentType = fileResp.headers.get('content-type') || 'application/octet-stream';
  const filename = deriveFilename(attachmentUrl, explicitFilename);

  const formData = new FormData();
  formData.append('File', new Blob([fileBuffer], { type: contentType }), filename);

  const auth = getAuthHeaders();
  const uploadHeaders = {
    Authorization: auth.Authorization,
    'X-AppFolio-Developer-ID': auth['X-AppFolio-Developer-ID'],
  };

  const uploadResp = await fetch(
    `${BASE_URL}/charges/${chargeId}/attachments`,
    { method: 'POST', headers: uploadHeaders, body: formData },
  );
  if (!uploadResp.ok) {
    const text = await uploadResp.text().catch(() => '');
    return {
      error: `AppFolio attachment upload failed (HTTP ${uploadResp.status}): ${text.slice(0, 300)}`,
    };
  }
  const data = await uploadResp.json().catch(() => ({}));
  return { id: data.Id, filename };
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
  {
    name: 'count_work_orders',
    description:
      'Return the number of work orders in AppFolio with a breakdown by status ' +
      '(open / completed / canceled / total) and by priority (urgent / normal / low). ' +
      'Use this for "how many open work orders" or "how many urgent tickets" ' +
      'questions instead of list_work_orders.',
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
      'Search for tenants by name. Returns matching tenants with full contact ' +
      'info, property/unit assignment, lease dates, rent, and balance. Stops ' +
      'paging once enough matches are found, so it is fast even on large ' +
      'portfolios. You usually do NOT need to call get_tenant_details after ' +
      'this — most common follow-up questions can be answered from the ' +
      'search result fields directly.',
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
  {
    name: 'list_work_orders',
    description:
      'List maintenance work orders / service requests with priority, status, ' +
      'job description, scheduled times, and property/unit/vendor assignment. ' +
      'For counts use count_work_orders (faster). Defaults to "open" tickets ' +
      '(status in New / Assigned / Scheduled / Waiting / Estimate Requested / ' +
      'Estimated). Pass status="all" or status="completed" to widen.',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description:
            'Filter by status. "open" (default — anything not Completed/Canceled), ' +
            '"completed", "canceled", or "all" for everything.',
        },
        priority: {
          type: 'string',
          description: 'Filter by priority: Urgent, Normal, or Low. Optional.',
        },
        offset: {
          type: 'integer',
          description: 'Number of records to skip. Default 0.',
        },
        limit: {
          type: 'integer',
          description: 'Max records to return. Default 50, max 1000.',
        },
      },
      required: [],
    },
  },

  // ── GL accounts (lookup helper for charge_tenant) ──
  {
    name: 'list_gl_accounts',
    description:
      'List general ledger accounts in AppFolio. Use this to find the right GL ' +
      'account name (e.g. "Repairs - Plumbing") before calling charge_tenant. ' +
      'Optional `query` for partial-name filtering.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional partial name to filter by (e.g. "repairs", "plumbing").',
        },
        limit: {
          type: 'integer',
          description: 'Max accounts to return. Default 30, max 200.',
        },
      },
      required: [],
    },
  },

  // ── Write tools — creates real money owed in AppFolio ──
  {
    name: 'charge_tenant',
    description:
      'Post a charge against a tenant\'s occupancy in AppFolio (e.g. property damage, ' +
      'repair charge-back, utility billback, late fee). Charges attach to the tenant\'s ' +
      'OccupancyId, not the tenant directly. The tool resolves OccupancyId from tenant_id ' +
      'and resolves the GL account name to a UUID, so callers only need human-readable ' +
      'names. ' +
      'IMPORTANT: This creates real money owed by the tenant. Always confirm tenant name, ' +
      'amount, GL account, description, and date with the user, and wait for explicit ' +
      'approval ("yes" / "post it" / "do it") before calling this tool.',
    input_schema: {
      type: 'object',
      properties: {
        tenant_id: {
          type: 'string',
          description:
            'AppFolio tenant ID (UUID). The tool resolves the OccupancyId from this. ' +
            'Required unless occupancy_id is passed.',
        },
        occupancy_id: {
          type: 'string',
          description:
            'Alternative: pass an OccupancyId directly. Only used if tenant_id is omitted.',
        },
        amount_due: {
          type: 'string',
          description: 'Charge amount in dollars, decimal string. e.g. "250.00".',
        },
        description: {
          type: 'string',
          description:
            'Human-readable description of the charge that will appear on the tenant\'s ' +
            'ledger. e.g. "Damage to bathroom door — repair April 15, 2026".',
        },
        gl_account: {
          type: 'string',
          description:
            'GL account name to post against (e.g. "Repairs - Plumbing", "Repairs - General", ' +
            '"Repairs - Electrical", "Repairs - Pest Control"). Partial matches are accepted; ' +
            'if ambiguous, the tool returns the candidate matches and you must re-call with ' +
            'a more specific name.',
        },
        charged_on: {
          type: 'string',
          description:
            'Date of the charge, YYYY-MM-DD. Defaults to today if omitted.',
        },
        attachment_url: {
          type: 'string',
          description:
            'Optional public HTTPS URL of a photo or PDF that documents the charge ' +
            '(damage photo, repair invoice, etc.). The tool fetches the file and ' +
            'attaches it to the AppFolio charge after the charge is posted. If the ' +
            'attachment fails, the charge still stands and the response includes an ' +
            'attachment_error field — surface it to the user verbatim.',
        },
        attachment_filename: {
          type: 'string',
          description:
            'Optional filename for the attachment, e.g. "bathroom-door.jpg". If ' +
            'omitted, a name is derived from attachment_url\'s path or defaults to ' +
            '"attachment".',
        },
      },
      required: ['amount_due', 'description', 'gl_account'],
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

      case 'count_work_orders': {
        let total = 0;
        let open = 0;
        let completed = 0;
        let canceled = 0;
        const byStatus = {};
        const byPriority = {};
        const result = await fetchAllPages('/work_orders', {}, {
          onPage: (records) => {
            for (const w of records) {
              total += 1;
              const status = (w.Status || 'unknown').toString();
              const priority = (w.Priority || 'unknown').toString().toLowerCase();
              byStatus[status] = (byStatus[status] || 0) + 1;
              byPriority[priority] = (byPriority[priority] || 0) + 1;
              if (status === 'Completed' || status === 'Work Completed') {
                completed += 1;
              } else if (status === 'Canceled') {
                canceled += 1;
              } else {
                open += 1;
              }
            }
            return true;
          },
        });
        if (result.error) return result;
        return { total, open, completed, canceled, by_status: byStatus, by_priority: byPriority };
      }

      // ── List tools (paginated, return record bodies) ──
      case 'list_properties': {
        const limit = clampLimit(input.limit, 50, 2000);
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
        const limit = clampLimit(input.limit, 30, 5000);
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
        const limit = clampLimit(input.limit, 20, 500);

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

        // AppFolio Database API v0 does NOT expose per-record path
        // lookups (GET /tenants/:id 404s). The supported pattern is
        // a filtered list query — fetch with filters[Id]=<id> and
        // return the first match.
        const result = await fetchAllPages('/tenants', {
          'filters[Id]': input.tenant_id,
        }, { maxPages: 1 });
        if (result.error) return result;

        const raw = (result.data || []).find(
          (t) => (t.Id || t.id) === input.tenant_id,
        ) || result.data?.[0];

        if (!raw) {
          return { error: `Tenant ${input.tenant_id} not found in AppFolio` };
        }
        return mapTenantFull(raw);
      }

      // ── GL accounts ──
      case 'list_gl_accounts': {
        const q = (input.query || '').toLowerCase().trim();
        const limit = clampLimit(input.limit, 30, 200);
        const result = await fetchAllPages('/gl_accounts');
        if (result.error) return result;

        let accounts = (result.data || []).map((g) => ({
          id: g.Id || g.id,
          name: g.Name || g.AccountName || '',
          number: g.Number || '',
          type: g.Type || g.AccountType || '',
        }));

        if (q) {
          accounts = accounts.filter((a) => a.name.toLowerCase().includes(q));
        }
        return {
          count: accounts.length,
          accounts: accounts.slice(0, limit),
        };
      }

      // ── Tenant charges (write — creates real money owed) ──
      case 'charge_tenant': {
        if (!input.amount_due) return { error: 'amount_due is required' };
        if (!input.description) return { error: 'description is required' };
        if (!input.gl_account) return { error: 'gl_account is required' };
        if (!input.tenant_id && !input.occupancy_id) {
          return { error: 'Either tenant_id or occupancy_id is required' };
        }

        // Resolve OccupancyId from tenant_id if needed. Charges in
        // AppFolio attach to an occupancy, not a tenant directly —
        // multiple tenants can share one occupancy (a couple, roommates).
        let occupancyId = input.occupancy_id;
        let tenantName = '';
        if (!occupancyId) {
          const tenantResult = await fetchAllPages('/tenants', {
            'filters[Id]': input.tenant_id,
          }, { maxPages: 1 });
          if (tenantResult.error) return tenantResult;
          const tenant = (tenantResult.data || [])[0];
          if (!tenant) {
            return { error: `Tenant ${input.tenant_id} not found in AppFolio` };
          }
          occupancyId = tenant.OccupancyId;
          tenantName = [tenant.FirstName, tenant.LastName].filter(Boolean).join(' ');
          if (!occupancyId) {
            return {
              error: `Tenant ${tenantName || input.tenant_id} has no current occupancy — cannot post a charge to a former tenant`,
            };
          }
        }

        // Resolve gl_account name → UUID via /gl_accounts. Fuzzy
        // case-insensitive substring match. If 0 or >1 hits, return
        // an actionable error so the agent can re-prompt the user.
        const glResult = await fetchAllPages('/gl_accounts');
        if (glResult.error) return glResult;

        const q = input.gl_account.toLowerCase().trim();
        const candidates = (glResult.data || []).map((g) => ({
          id: g.Id || g.id,
          name: g.Name || g.AccountName || '',
        }));
        const matches = candidates.filter((g) => g.name.toLowerCase().includes(q));

        if (matches.length === 0) {
          return {
            error: `No GL account matched "${input.gl_account}". Use list_gl_accounts to see available accounts.`,
          };
        }
        if (matches.length > 1) {
          return {
            error:
              `Multiple GL accounts matched "${input.gl_account}". Pass a more specific name. ` +
              `Matches: ${matches.map((m) => m.name).join(', ')}`,
            matches,
          };
        }
        const glAccountId = matches[0].id;
        const glAccountName = matches[0].name;

        const chargedOn = input.charged_on || new Date().toISOString().slice(0, 10);
        const payload = {
          AmountDue: String(input.amount_due),
          ChargedOn: chargedOn,
          Description: input.description,
          GlAccountId: glAccountId,
          OccupancyId: occupancyId,
        };

        const headers = {
          ...getAuthHeaders(),
          'Content-Type': 'application/json',
        };
        const res = await fetch(`${BASE_URL}/charges`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          return {
            error: `AppFolio charge creation failed (HTTP ${res.status}): ${text.slice(0, 400)}`,
          };
        }
        const data = await res.json();
        const result = {
          success: true,
          charge_id: data.Id,
          amount: payload.AmountDue,
          description: payload.Description,
          gl_account_name: glAccountName,
          gl_account_id: glAccountId,
          charged_on: chargedOn,
          occupancy_id: occupancyId,
          tenant_name: tenantName || undefined,
        };

        // Optional attachment upload. The charge is already posted at
        // this point — if the attachment fails for any reason we keep
        // the charge and surface the failure as `attachment_error` so
        // the user can retry the upload manually in AppFolio without
        // duplicating the charge itself.
        if (input.attachment_url) {
          const attachResult = await uploadChargeAttachment(
            data.Id,
            input.attachment_url,
            input.attachment_filename,
          );
          if (attachResult.error) {
            result.attachment_error = attachResult.error;
          } else {
            result.attachment_id = attachResult.id;
            result.attachment_filename = attachResult.filename;
          }
        }

        return result;
      }

      case 'list_units': {
        const limit = clampLimit(input.limit, 50, 5000);
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

      case 'list_work_orders': {
        const limit = clampLimit(input.limit, 50, 1000);
        const offset = clampOffset(input.offset);

        // Status filter. Pass through directly when AppFolio
        // recognises the value (their Status values are documented:
        // Assigned / Canceled / Completed / Estimate Requested /
        // Estimated / New / Scheduled / Waiting / Work Completed).
        // 'open' maps to the union of in-progress states; 'all' is
        // unfiltered.
        const params = {};
        const statusFilterRaw = (input.status || 'open').toString().toLowerCase();
        if (statusFilterRaw === 'completed') {
          params['filters[Status]'] = 'Completed,Work Completed';
        } else if (statusFilterRaw === 'canceled') {
          params['filters[Status]'] = 'Canceled';
        } else if (statusFilterRaw === 'open') {
          params['filters[Status]'] =
            'New,Assigned,Scheduled,Waiting,Estimate Requested,Estimated';
        } // else 'all' — no filter

        const result = await fetchAllPages('/work_orders', params);
        if (result.error) return result;

        let workOrders = result.data.map((w) => {
          const assigned = Array.isArray(w.AssignedUsers) ? w.AssignedUsers : [];
          const assignedTo = assigned[0]?.Name
            || [assigned[0]?.FirstName, assigned[0]?.LastName].filter(Boolean).join(' ')
            || '';
          const status = w.Status || '';
          return {
            id: w.Id || w.id,
            displayId: w.WorkOrderNumber ? `WO-${w.WorkOrderNumber}` : (w.Id || ''),
            summary: w.JobDescription || w.WorkOrderIssue || w.Description || '',
            description: w.Description || w.TenantRemarks || '',
            isClosed: status === 'Completed' || status === 'Work Completed' || status === 'Canceled',
            status,
            priority: w.Priority || '',
            categoryName: w.VendorTrade || '',
            propertyId: w.PropertyId || null,
            unitId: w.UnitId || null,
            tenantId: w.RequestingTenantId || null,
            occupancyId: w.OccupancyId || null,
            vendorId: w.VendorId || null,
            createdDate: w.CreatedAt || null,
            scheduledDate: w.ScheduledStart || null,
            completedDate: w.WorkCompletedOn || w.CompletedOn || null,
            assignedTo,
            link: w.Link || null,
          };
        });

        // Optional client-side priority filter — AppFolio doesn't
        // document a filters[Priority] knob, so we filter post-fetch.
        if (input.priority) {
          const p = input.priority.toString().toLowerCase();
          workOrders = workOrders.filter((w) => (w.priority || '').toLowerCase() === p);
        }

        const page = workOrders.slice(offset, offset + limit);
        return {
          total: workOrders.length,
          offset,
          limit,
          has_more: offset + limit < workOrders.length,
          work_orders: page,
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
  // The basic /tenants record from AppFolio already carries property
  // and unit assignment plus lease/financial fields, so we surface
  // them here. That way "which unit does X live in?" or "what's X's
  // balance?" answers from search_tenants alone — no detail call,
  // no second AppFolio round trip.
  //
  // occupancy_id is required by charge_tenant (charges attach to
  // occupancies in AppFolio, not directly to tenants), so we include
  // it here too even though it's not user-facing.
  return {
    id: t.Id || t.id,
    occupancy_id: t.OccupancyId || null,
    unit_id: t.UnitId || null,
    property_id: t.PropertyId || null,
    first_name: t.FirstName || '',
    last_name: t.LastName || '',
    name: [t.FirstName, t.LastName].filter(Boolean).join(' ') || 'Unknown',
    email: t.Email || '',
    phone: t.Phone || t.HomePhone || '',
    mobile: t.MobilePhone || t.CellPhone || '',
    status: t.Status || '',
    property_name: t.PropertyName || '',
    unit_name: t.UnitName || '',
    move_in_date: t.MoveInDate || null,
    move_out_date: t.MoveOutDate || null,
    lease_start: t.LeaseFrom || null,
    lease_end: t.LeaseTo || null,
    rent: t.Rent || t.MonthlyRent || null,
    balance: t.Balance || t.CurrentBalance || null,
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


