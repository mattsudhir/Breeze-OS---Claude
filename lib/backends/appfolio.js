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
// AppFolio's API split:
//   - Database API v0  → shared host api.appfolio.com/api/v0
//   - Reports API v1/v2 → per-customer subdomain
//                          (https://<customer>.appfolio.com/api/v2/reports/...)
// Both are gated by HTTP Basic auth on the customer's
// CLIENT_ID/CLIENT_SECRET. Subdomain default is Breeze Property
// Group's 'breezepg'; APPFOLIO_DATABASE_API_URL is a full-URL
// override for the Database API base when AppFolio ever ports a
// customer to their own subdomain for that API too.
const DEFAULT_SUBDOMAIN = 'breezepg';
const APPFOLIO_SUBDOMAIN =
  (process.env.APPFOLIO_SUBDOMAIN || '').trim() || DEFAULT_SUBDOMAIN;
const BASE_URL =
  (process.env.APPFOLIO_DATABASE_API_URL || '').trim() ||
  'https://api.appfolio.com/api/v0';
const DEFAULT_REPORTS_SUBDOMAIN = APPFOLIO_SUBDOMAIN;

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
  'Updating work orders (update_work_order — write operation):',
  '- update_work_order PATCHes /work_orders/{id}. Pass the AppFolio',
  '  ID and only the fields you are changing — anything omitted is',
  '  left untouched.',
  '- Common edits: status (Completed, Canceled, Scheduled, Waiting),',
  '  priority (Urgent, Normal, Low), scheduled_start / scheduled_end',
  '  (ISO 8601), description / job_description, vendor_id.',
  '- Before calling, confirm with the user what changes you are about',
  '  to make. Acceptable to skip the confirmation when the user gives',
  '  a clear single-step instruction like "mark WO-1234 completed" —',
  '  the instruction itself is the confirmation. Anything more',
  '  ambiguous (multi-field, status changes that affect billing),',
  '  read it back first.',
  '- After success, confirm the change in one short line. Surface',
  '  errors verbatim per the global rule.',
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

// ── Reports API helpers ──────────────────────────────────────────
//
// The Reports API is a separate AppFolio surface from the Database
// API v0 covered by everything above. Different host (per-tenant
// subdomain), different auth credentials (its own Client ID/Secret
// configured in the AppFolio web UI rather than the Developer
// Space). Used for chart-of-accounts, GL entries, bills, receipts.
// See docs/accounting/appfolio-access-setup.md and
// docs/accounting/appfolio-coa-analysis.md.

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
    const developerId = process.env.APPFOLIO_DEVELOPER_ID;
    if (developerId) headers['X-AppFolio-Developer-ID'] = developerId;
    return headers;
  }
  // Fallback to v0 creds — will 401 against Reports API but produces
  // a clear diagnostic in the introspect endpoint's response.
  return getAuthHeaders();
}

async function postReport(reportName, body = {}) {
  const headers = {
    ...getReportsAuthHeaders(),
    'Content-Type': 'application/json',
  };
  const subdomain =
    process.env.APPFOLIO_DATABASE_SUBDOMAIN || DEFAULT_REPORTS_SUBDOMAIN;
  // v2 POST is the empirically-confirmed shape (see commit history
  // for the URL probe results).
  let url = `https://${subdomain}.appfolio.com/api/v2/reports/${reportName}.json`;

  const allRows = [];
  let page = 0;
  let lastPayload = null;
  while (url) {
    page += 1;
    if (page > 20) break;

    // 429-aware retry. AppFolio's Reports API rate-limits; honor
    // Retry-After when present, otherwise back off 2/4/8s.
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

// Diagnostic — tries multiple URL/method combinations against the
// Reports API and reports each response. Used by
// /api/admin/appfolio-introspect to localize broken setups.
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
      label: 'subdomain v2 reports POST',
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
      : 'Reports API basic auth falling back to APPFOLIO_CLIENT_ID / APPFOLIO_CLIENT_SECRET — these are WRONG for the Reports API. Set APPFOLIO_REPORTS_CLIENT_ID / APPFOLIO_REPORTS_CLIENT_SECRET from the AppFolio web UI (Tools → API Settings → Reports API).',
    variants: results,
  };
}

// Exported so the AppFolio mirror layer (lib/appfolioMirror.js) can
// reuse the same auth + pagination contract for bulk syncs and
// single-record refreshes via filters[Id]=. Internal callers in
// this file still use it the same way.
export async function fetchAllPages(endpoint, params = {}, { onPage, maxPages = 20 } = {}) {
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

    // 429-aware retry. AppFolio's Database API rate-limits at the
    // edge; honor Retry-After when present, otherwise back off
    // 2/4/8s. Caps Retry-After at 90s so a runaway header value
    // can't stall the function past Vercel's 300s ceiling.
    let res;
    let attempt = 0;
    while (true) {
      attempt += 1;
      res = await fetch(url, { headers });
      if (res.status !== 429 || attempt >= 4) break;
      const retryAfter = parseInt(res.headers.get('retry-after'), 10);
      const waitMs = Math.min(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1000 * 2 ** attempt,
        90_000,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
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
      const baseHost = BASE_URL.replace(/\/api\/v0\/?$/, '');
      url = `${baseHost}${data.next_page_path}`;
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
    name: 'list_occupancies',
    description:
      'List occupancies (lease records linking a tenant to a unit) with lease ' +
      'dates, monthly rent, and move-in/move-out dates. AppFolio\'s /tenants list ' +
      'response leaves rent and dates blank — those fields live here. Used to ' +
      'enrich tenant cards with the actual lease terms.',
    input_schema: {
      type: 'object',
      properties: {
        active_only: {
          type: 'boolean',
          description:
            'When true (default false for parity with list_tenants), exclude ' +
            'occupancies with a non-null MoveOutDate / HiddenAt.',
        },
        offset: {
          type: 'integer',
          description: 'Number of records to skip. Default 0.',
        },
        limit: {
          type: 'integer',
          description: 'Max records to return. Default 50, max 10000.',
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
          description: 'Max records to return. Default 50, max 10000.',
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

  // ── Write tools ──
  {
    name: 'update_work_order',
    description:
      'Update a work order in AppFolio (PATCH /work_orders/{id}). Use to ' +
      'change status (mark Completed, Canceled, etc.), priority, scheduled ' +
      'times, vendor assignment, or to add notes. Pass the AppFolio work-order ' +
      'ID and only the fields you want to change — anything omitted is left ' +
      'untouched. Returns { success: true, work_order_id } on a clean PATCH.',
    input_schema: {
      type: 'object',
      properties: {
        work_order_id: {
          type: 'string',
          description: 'AppFolio work-order ID (UUID).',
        },
        status: {
          type: 'string',
          description:
            'New status. AppFolio enum: New, Assigned, Scheduled, Waiting, ' +
            'Completed, Canceled, Work Completed.',
        },
        priority: {
          type: 'string',
          description: 'New priority: Urgent, Normal, or Low.',
        },
        job_description: {
          type: 'string',
          description: 'Replace the work-order summary / job description.',
        },
        description: {
          type: 'string',
          description: 'Replace the longer description / instructions.',
        },
        scheduled_start: {
          type: 'string',
          description: 'ISO 8601 timestamp for when the work is scheduled to start.',
        },
        scheduled_end: {
          type: 'string',
          description: 'ISO 8601 timestamp for when the work is scheduled to end.',
        },
        vendor_id: {
          type: 'string',
          description: 'Reassign the vendor (UUID). Pass null to clear.',
        },
        completed_on: {
          type: 'string',
          description: 'YYYY-MM-DD — set when marking the WO Completed.',
        },
        canceled_on: {
          type: 'string',
          description: 'YYYY-MM-DD — set when marking the WO Canceled.',
        },
      },
      required: ['work_order_id'],
    },
  },
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
  // ── Reports API tools (chart of accounts, GL, bills, receipts) ─
  {
    name: 'list_gl_accounts',
    description:
      'List the chart of accounts from AppFolio (Reports API). Returns ' +
      'account numbers, names, types, and any account hierarchy AppFolio ' +
      'exposes.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_general_ledger',
    description:
      'Fetch journal entries from the AppFolio general ledger within a ' +
      'date range (Reports API). Each row is a posted GL entry with date, ' +
      'account, debit/credit, memo, and source reference.',
    input_schema: {
      type: 'object',
      properties: {
        from_date: { type: 'string', description: 'YYYY-MM-DD (inclusive).' },
        to_date: { type: 'string', description: 'YYYY-MM-DD (inclusive).' },
        accounting_basis: {
          type: 'string',
          enum: ['Cash', 'Accrual'],
          description: 'Defaults to Accrual.',
        },
      },
      required: ['from_date', 'to_date'],
    },
  },
  {
    name: 'list_bill_detail',
    description:
      'Fetch vendor bills from AppFolio (Reports API) within a date range. ' +
      'Includes payee, amounts, due dates, payment status, and per-line GL detail.',
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

      // ── Work-order edit (write) ──
      case 'update_work_order': {
        if (!input.work_order_id) return { error: 'work_order_id is required' };

        // Build the PATCH body. Only include fields the caller
        // actually passed — AppFolio leaves omitted fields untouched.
        // Map our lower_snake keys to AppFolio's PascalCase shape.
        const fieldMap = {
          status: 'Status',
          priority: 'Priority',
          job_description: 'JobDescription',
          description: 'Description',
          scheduled_start: 'ScheduledStart',
          scheduled_end: 'ScheduledEnd',
          vendor_id: 'VendorId',
          completed_on: 'CompletedOn',
          canceled_on: 'CanceledOn',
        };
        const body = {};
        for (const [src, dst] of Object.entries(fieldMap)) {
          if (input[src] !== undefined) body[dst] = input[src];
        }
        if (Object.keys(body).length === 0) {
          return { error: 'No fields to update — pass at least one of: status, priority, job_description, description, scheduled_start, scheduled_end, vendor_id, completed_on, canceled_on.' };
        }

        const headers = {
          ...getAuthHeaders(),
          'Content-Type': 'application/json',
        };
        const res = await fetch(
          `${BASE_URL}/work_orders/${input.work_order_id}`,
          { method: 'PATCH', headers, body: JSON.stringify(body) },
        );
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          return {
            error: `AppFolio work-order update failed (HTTP ${res.status}): ${text.slice(0, 400)}`,
          };
        }
        // PATCH returns { Id } on success per AppFolio's docs.
        const data = await res.json().catch(() => ({}));
        return {
          success: true,
          work_order_id: data.Id || input.work_order_id,
          updated_fields: Object.keys(body),
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
          // PropertyId is on every AppFolio /units row but we weren't
          // surfacing it — PropertiesPage groups by propertyId and
          // would silently degrade to all-units-flat without this.
          property_id: u.PropertyId || null,
          unit_group_id: u.UnitGroupId || null,
          current_occupancy_id: u.CurrentOccupancyId || null,
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
          // AppFolio flags common-area / model / office / non-rentable
          // units with NonRevenue=true. We surface it so menu pages
          // can drop them from unit counts (otherwise a 287-property
          // / 666-unit portfolio that's actually closer to ~600
          // rentable units looks inflated).
          non_revenue: !!u.NonRevenue,
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

      case 'list_occupancies': {
        const limit = clampLimit(input.limit, 50, 10000);
        const offset = clampOffset(input.offset);
        const activeOnly = input.active_only === true;

        const result = await fetchAllPages('/occupancies');
        if (result.error) return result;

        let occupancies = result.data.map(mapOccupancy);
        if (activeOnly) {
          occupancies = occupancies.filter(
            (o) => !o.move_out_date && !o.hidden,
          );
        }

        const page = occupancies.slice(offset, offset + limit);
        return {
          total: occupancies.length,
          offset,
          limit,
          has_more: offset + limit < occupancies.length,
          occupancies: page,
        };
      }

      case 'list_work_orders': {
        // Cap raised to 10k for parity with list_units / list_tenants
        // — Breeze portfolios with large historical work-order tables
        // were getting truncated at 1000 during the mirror bulk-sync.
        const limit = clampLimit(input.limit, 50, 10000);
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

      // ── Reports API tool executors ───────────────────────────
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
        const body = { from_date: input.from_date, to_date: input.to_date };
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
        const body = { from_date: input.from_date, to_date: input.to_date };
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

// Occupancy = lease record. AppFolio joins tenant ↔ unit through
// this table; rent + lease dates + move-in/out all live here, not
// on the tenant. Multiple tenants can share one occupancy
// (couples, roommates), keyed by occupancy id.
function mapOccupancy(o) {
  if (!o) return null;
  return {
    id: o.Id || o.id,
    tenant_id: o.TenantId || null,
    unit_id: o.UnitId || null,
    property_id: o.PropertyId || null,
    lease_start: o.LeaseFromDate || o.LeaseFrom || null,
    lease_end: o.LeaseToDate || o.LeaseTo || null,
    move_in_date: o.MoveInDate || null,
    move_out_date: o.MoveOutDate || null,
    rent: o.Rent || o.MonthlyRent || null,
    deposit: o.Deposit || o.SecurityDeposit || null,
    status: o.Status || '',
    hidden: !!o.HiddenAt,
    last_updated_at: o.LastUpdatedAt || null,
  };
}

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


