// Shared Breeze AI agent — the tools, system prompt, and agent loop that
// both /api/chat (web UI) and /api/cliq-bot (Zoho Cliq Message Handler)
// call into. Keeping this in one place means a new tool or a prompt tweak
// shows up in both surfaces at once.
//
// Environment variables:
//   ANTHROPIC_API_KEY – from console.anthropic.com
//   RM_BASE_URL, RM_USERNAME, RM_PASSWORD – inherited via lib/rmClient.js
//   ZOHO_CLIQ_WEBHOOK_URL – optional, used by the notify_team tool

import Anthropic from '@anthropic-ai/sdk';
import { rmCall } from './rmClient.js';

export const MODEL = 'claude-haiku-4-5';
export const MAX_ITERATIONS = 8;

// ── Tool definitions ─────────────────────────────────────────────

export const TOOLS = [
  {
    name: 'search_tenants',
    description:
      'Find tenants by name. Use this as a lookup step when the user asks about a specific person — ' +
      'it returns only id, display_id, name, and status. ' +
      'IMPORTANT: This tool does NOT return email, phone, lease, or balance. To get contact info or any ' +
      'other detail about a specific tenant, ALWAYS call get_tenant_details with the id from this list. ' +
      'Never answer questions about a tenant\'s email, phone, lease, or balance using only search_tenants results.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Partial or full name to search for. Leave empty to list all tenants.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_tenant_details',
    description:
      'Get the full record for a single tenant by their TenantID, including lease info, ' +
      'open charges/balance, addresses, and emergency contacts. Use this after search_tenants ' +
      'when the user wants more detail on one specific tenant.',
    input_schema: {
      type: 'object',
      properties: {
        tenant_id: { type: 'integer', description: 'TenantID from search_tenants results' },
      },
      required: ['tenant_id'],
    },
  },
  {
    name: 'list_properties',
    description: 'List all properties managed in Rent Manager. Returns name, city, state, type, and id for each.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_units',
    description:
      'List rental units. Optionally filter by property. Returns unit name, status (occupied/vacant), ' +
      'bedrooms, bathrooms, square feet, and market rent.',
    input_schema: {
      type: 'object',
      properties: {
        property_id: {
          type: 'integer',
          description: 'Optional PropertyID to filter units by. Omit to get all units.',
        },
      },
      required: [],
    },
  },
  {
    name: 'list_work_orders',
    description:
      'List maintenance work orders / service requests. Returns summary, priority, status, category, ' +
      'and the related unit/property. Use for questions about maintenance, repairs, or open issues. ' +
      'Supports filtering by status, minimum priority, category, and free-text search. The response ' +
      'includes counts so you can answer "how many" questions without iterating through the full list.',
    input_schema: {
      type: 'object',
      properties: {
        status_filter: {
          type: 'string',
          description: '"open" for incomplete tickets, "completed" for done, "all" for everything. Default: all.',
          enum: ['open', 'completed', 'all'],
        },
        min_priority: {
          type: 'string',
          description:
            'Minimum priority to include. "urgent" = only urgent/emergency; "high" = high and urgent; ' +
            '"medium" = medium, high, and urgent; "low" = everything. Default: low.',
          enum: ['urgent', 'high', 'medium', 'low'],
        },
        category: {
          type: 'string',
          description:
            'Exact category/trade to filter by. Use this only when the user names a trade like ' +
            '"plumbing", "electrical", "HVAC", "appliance", "pest". ' +
            'For everything else (e.g. "mold", "leak", "gas smell", "paint"), prefer search_text.',
        },
        search_text: {
          type: 'string',
          description:
            'Free-text keyword that is matched against the ticket summary, description, AND category. ' +
            'Use this for questions like "mold tickets", "gas smell", "kitchen issues", "leaky faucet". ' +
            'Prefer this over category unless the user explicitly named a trade.',
        },
      },
      required: [],
    },
  },
  {
    name: 'notify_team',
    description:
      'Send a notification message to the team chat (Zoho Cliq). Use when the user explicitly asks ' +
      'you to notify, alert, ping, message, or tell someone about something. Currently every ' +
      'notification routes to the same team channel regardless of recipient — include the recipient ' +
      'name in the input so the message reads naturally.',
    input_schema: {
      type: 'object',
      properties: {
        recipient: {
          type: 'string',
          description:
            'Who or what team the message is directed to, e.g. "plumbing team", "Marcia Clark", ' +
            '"maintenance supervisor". Used in the message header only.',
        },
        message: {
          type: 'string',
          description: 'The actual notification text to send. Keep it concise and actionable.',
        },
        context: {
          type: 'string',
          description:
            'Optional reference like "WO-57", "Unit 204 at Oakwood", "Marcia Clark (#t0001)". ' +
            'Helps the recipient find the record in Rent Manager.',
        },
      },
      required: ['recipient', 'message'],
    },
  },
];

// ── Tool executors ───────────────────────────────────────────────

export async function executeTool(name, input) {
  try {
    switch (name) {
      case 'search_tenants': {
        const res = await rmCall('/Tenants');
        if (!res.ok || !Array.isArray(res.data)) {
          return { error: `Could not fetch tenants: ${res.status}` };
        }
        const q = (input.query || '').toLowerCase().trim();
        let tenants = res.data.map((t) => ({
          id: t.TenantID,
          display_id: t.TenantDisplayID || `t${t.TenantID}`,
          name:
            [t.FirstName, t.LastName].filter(Boolean).join(' ') || `Tenant ${t.TenantID}`,
          status: t.Status || '',
        }));
        if (q) {
          tenants = tenants.filter((t) => t.name.toLowerCase().includes(q));
        }
        return {
          count: tenants.length,
          tenants: tenants.slice(0, 20),
          note: 'Contact info not included. Call get_tenant_details for email, phone, lease, or balance.',
        };
      }

      case 'get_tenant_details': {
        const id = input.tenant_id;
        const res = await rmCall(
          `/Tenants/${id}?embeds=Addresses,Leases,Contacts,OpenCharges,PhoneNumbers`,
        );
        if (!res.ok) return { error: `Could not fetch tenant ${id}: ${res.status}` };
        const t = Array.isArray(res.data) ? res.data[0] : res.data;
        return mapTenantFull(t);
      }

      case 'list_properties': {
        const res = await rmCall('/Properties');
        if (!res.ok || !Array.isArray(res.data)) {
          return { error: `Could not fetch properties: ${res.status}` };
        }
        return {
          count: res.data.length,
          properties: res.data.map((p) => ({
            id: p.PropertyID,
            name: p.Name || p.ShortName,
            city: p.City,
            state: p.State,
            type: p.PropertyType,
          })),
        };
      }

      case 'list_units': {
        const path = input.property_id
          ? `/Units?filters=PropertyID,eq,${input.property_id}`
          : '/Units';
        const res = await rmCall(path);
        if (!res.ok || !Array.isArray(res.data)) {
          return { error: `Could not fetch units: ${res.status}` };
        }
        return {
          count: res.data.length,
          units: res.data.slice(0, 40).map((u) => ({
            id: u.UnitID,
            property_id: u.PropertyID,
            name: u.Name,
            status: u.Status,
            bedrooms: u.Bedrooms,
            bathrooms: u.Bathrooms,
            sqft: u.SquareFeet || u.SQFT,
            market_rent: u.MarketRent,
          })),
        };
      }

      case 'list_work_orders': {
        const [woRes, catRes, priRes] = await Promise.all([
          rmCall('/ServiceManagerIssues'),
          rmCall('/ServiceManagerCategories'),
          rmCall('/ServiceManagerPriorities'),
        ]);
        if (!woRes.ok || !Array.isArray(woRes.data)) {
          return {
            error: `Could not fetch work orders (HTTP ${woRes.status}): ${
              typeof woRes.data === 'string' ? woRes.data : JSON.stringify(woRes.data)
            }`,
          };
        }

        const catMap = {};
        if (catRes.ok && Array.isArray(catRes.data)) {
          for (const c of catRes.data) {
            const id = c.ServiceManagerCategoryID || c.CategoryID || c.ID;
            const name = c.Name || c.CategoryName || '';
            if (id) catMap[id] = name;
          }
        }

        const priMap = {};
        if (priRes.ok && Array.isArray(priRes.data)) {
          for (const p of priRes.data) {
            const id = p.ServiceManagerPriorityID || p.PriorityID || p.ID;
            const name = p.Name || p.PriorityName || '';
            if (id) priMap[id] = name;
          }
        }

        const rankPriority = (p) => {
          const pl = (p || '').toLowerCase();
          if (pl.includes('emerg') || pl.includes('urgent')) return 4;
          if (pl.includes('high')) return 3;
          if (pl.includes('med') || pl.includes('normal')) return 2;
          if (pl.includes('low')) return 1;
          return 2;
        };
        const isOpen = (o) => !o.is_closed;

        let orders = woRes.data.map((w) => {
          const catId = w.CategoryID || w.ServiceManagerCategoryID;
          const priId = w.PriorityID;
          const categoryName = catMap[catId] || w.CategoryName || '';
          const priorityName = priMap[priId] || w.Priority || w.PriorityName || '';
          return {
            id: w.ServiceManagerIssueID || w.IssueID,
            summary: w.Title || w.Summary || w.Description || '',
            status: w.StatusName || w.Status || '',
            is_closed: w.IsClosed === true,
            priority: priorityName,
            category: categoryName,
            property_id: w.PropertyID,
            unit_id: w.UnitID,
            created: w.CreateDate || w.DateCreated,
          };
        });

        const totalCount = orders.length;

        if (input.status_filter === 'open') {
          orders = orders.filter(isOpen);
        } else if (input.status_filter === 'completed') {
          orders = orders.filter((o) => !isOpen(o));
        }

        if (input.min_priority) {
          const threshold = rankPriority(input.min_priority);
          orders = orders.filter((o) => rankPriority(o.priority) >= threshold);
        }

        if (input.category) {
          const q = input.category.toLowerCase();
          orders = orders.filter((o) => (o.category || '').toLowerCase().includes(q));
        }

        if (input.search_text) {
          const q = input.search_text.toLowerCase();
          orders = orders.filter((o) =>
            (o.summary || '').toLowerCase().includes(q) ||
            (o.category || '').toLowerCase().includes(q),
          );
        }

        orders.sort((a, b) => {
          const diff = rankPriority(b.priority) - rankPriority(a.priority);
          if (diff !== 0) return diff;
          return new Date(b.created || 0).getTime() - new Date(a.created || 0).getTime();
        });

        const priority_counts = {
          urgent: orders.filter((o) => rankPriority(o.priority) === 4).length,
          high: orders.filter((o) => rankPriority(o.priority) === 3).length,
          medium: orders.filter((o) => rankPriority(o.priority) === 2).length,
          low: orders.filter((o) => rankPriority(o.priority) === 1).length,
        };

        return {
          total_work_orders_in_system: totalCount,
          filtered_count: orders.length,
          priority_counts,
          filters_applied: {
            status: input.status_filter || 'all',
            min_priority: input.min_priority || 'low',
            category: input.category || 'any',
          },
          sample: orders.slice(0, 15),
        };
      }

      case 'notify_team': {
        const webhookUrl = process.env.ZOHO_CLIQ_WEBHOOK_URL;
        if (!webhookUrl) {
          return {
            error:
              'ZOHO_CLIQ_WEBHOOK_URL is not configured. Add it in Vercel → Settings → Environment Variables.',
          };
        }

        const recipient = (input.recipient || 'the team').trim();
        const message = (input.message || '').trim();
        if (!message) return { error: 'notify_team requires a non-empty message' };
        const context = input.context ? ` · ${input.context}` : '';

        const text =
          `📢 *Notify ${recipient}*${context}\n` +
          `${message}\n\n` +
          `_Sent via Breeze AI_`;

        try {
          const res = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text,
              bot: { name: 'Breeze AI' },
            }),
          });
          if (!res.ok) {
            const errText = await res.text();
            return {
              error: `Zoho Cliq webhook failed (HTTP ${res.status}): ${errText.slice(0, 400)}`,
            };
          }
          return {
            success: true,
            sent_to: recipient,
            delivered_text: text,
          };
        } catch (err) {
          return { error: `Zoho Cliq request failed: ${err.message}` };
        }
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

function mapTenantFull(t) {
  if (!t) return { error: 'Tenant not found' };
  const leases = Array.isArray(t.Leases) ? t.Leases : [];
  const currentLease =
    leases.find((l) => !l.MoveOutDate && !l.EndDate) || leases[0] || null;
  const openCharges = Array.isArray(t.OpenCharges) ? t.OpenCharges : [];
  const balance = openCharges.reduce(
    (sum, c) => sum + (Number(c.Amount) || 0) - (Number(c.AmountPaid) || 0),
    0,
  );
  const addresses = Array.isArray(t.Addresses) ? t.Addresses : [];
  return {
    id: t.TenantID,
    display_id: t.TenantDisplayID,
    name: [t.FirstName, t.LastName].filter(Boolean).join(' '),
    email: t.Email || '',
    home_phone: t.Phone || '',
    cell_phone: t.CellPhone || '',
    work_phone: t.WorkPhone || '',
    status: t.Status || '',
    comment: t.Comment || '',
    address: addresses[0]
      ? [addresses[0].Street, addresses[0].City, addresses[0].State, addresses[0].PostalCode]
          .filter(Boolean)
          .join(', ')
      : null,
    current_lease: currentLease
      ? {
          start_date: currentLease.StartDate,
          end_date: currentLease.EndDate || currentLease.MoveOutDate,
          rent: currentLease.Rent || currentLease.RentAmount,
          deposit: currentLease.SecurityDeposit,
          property_id: currentLease.PropertyID,
          unit_id: currentLease.UnitID,
        }
      : null,
    balance,
    open_charge_count: openCharges.length,
    emergency_contacts: (Array.isArray(t.Contacts) ? t.Contacts : []).map((c) => ({
      name: [c.FirstName, c.LastName].filter(Boolean).join(' '),
      relationship: c.Relationship,
      email: c.Email,
      phone: c.Phone,
    })),
  };
}

// ── System prompt ────────────────────────────────────────────────

export const SYSTEM_PROMPT = `You are Breeze AI, a friendly and efficient property-management assistant built on top of Rent Manager. You help property managers answer questions about their portfolio — tenants, properties, units, leases, maintenance, and balances.

You have tools to query Rent Manager live. Use them whenever the user asks about real data. Prefer calling tools over guessing.

When a user asks about a specific tenant:
1. Call search_tenants first to find the right TenantID (it returns only name/id/status — no contact info).
2. For ANY question about that tenant's email, phone, lease, balance, or address, you MUST call get_tenant_details with that id. Do not answer contact or financial questions using only search_tenants — that data is not included there.

Style:
- Conversational and concise. Don't over-explain unless asked.
- When you cite a person, use their full name. When you cite a unit, use its name (not just id).
- Format currency as $X,XXX.XX.
- Format dates naturally (e.g. "April 12, 2026").
- If the user asks something that needs no tool call (greeting, follow-up clarification), just answer directly.

Error handling (important):
- If a tool returns an object containing an "error" field, do NOT paraphrase it as "authentication error", "session issue", or any other natural-language summary. Instead, report the error verbatim to the user prefixed with "Tool error:" so they can see exactly what Rent Manager returned. Example: "Tool error: Could not fetch work orders (HTTP 404): No resource found at /ServiceManagerIssues". Do not retry the same tool call if it just errored.

Notifications:
- When the user explicitly asks you to notify, alert, ping, message, text, or tell someone about something (e.g. "notify the plumbing team about WO-57", "ping Marcia that her lease is expiring", "alert maintenance about the Mold ticket"), use the notify_team tool. It posts a message to the team chat channel via Zoho Cliq.
- Always include a recipient (who it's going to) and a concrete message. If the context is a specific record (a ticket, unit, tenant), pass it in the context field.
- After the tool returns success, confirm briefly to the user — e.g. "Sent to the team chat for the plumbing team." Do NOT paste the full delivered text back; a short confirmation is enough.
- If the tool returns an error, surface it verbatim per the error-handling rule above.
- If the user implicitly wants to notify but hasn't said so (e.g. "this needs to be fixed"), ask before sending — don't auto-notify.

Show Me links:
- When you answer a question that could reasonably be drilled into on one of the app's list pages (maintenance, properties, tenants), end your reply with a single SHOWME marker on its own line so the UI can render a "Show me" button that deep-links to that page with matching filters.
- Marker format: [SHOWME view=<page> key1=value1 key2=value2 ...]
  * view is one of: maintenance, properties, tenants
  * For maintenance, valid keys are: status (open|completed|all), min_priority (urgent|high|medium|low), category (trade name), search (free text). Only include the filters you actually used in the tool call.
- Examples:
  * User: "How many urgent work orders?" → reply ends with [SHOWME view=maintenance status=open min_priority=urgent]
  * User: "Any mold tickets?" → [SHOWME view=maintenance search=mold]
  * User: "Open HVAC issues?" → [SHOWME view=maintenance status=open category=hvac]
- Only emit a marker when the answer involves a filterable list. Skip it for greetings, explanations, or questions about individual records. Do not wrap the marker in backticks, code blocks, or extra punctuation — it must match the regex exactly.
- The user may also verbally say "show me" as a follow-up; treat that as a request to re-emit the previous filters in a fresh marker.`;

// ── Agent loop ───────────────────────────────────────────────────
//
// Runs a full tool-use loop against Claude and returns the final text +
// iteration count. Input `messages` is the standard Anthropic messages
// array (role: 'user' | 'assistant', content: string or content blocks).
// Callers wrap this with whatever transport they have (HTTP handler,
// Cliq message handler, etc.).

export async function runAgent(inputMessages, { clientOverride } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error(
      'ANTHROPIC_API_KEY not configured. Add it in Vercel → Settings → Environment Variables.',
    );
    err.status = 500;
    throw err;
  }

  const client = clientOverride || new Anthropic();
  const messages = inputMessages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let iterations = 0;
  let finalText = '';

  while (iterations < MAX_ITERATIONS) {
    iterations += 1;

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      finalText = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      break;
    }

    if (response.stop_reason === 'tool_use') {
      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      const toolResults = [];
      for (const call of toolUses) {
        const result = await executeTool(call.name, call.input || {});
        toolResults.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: JSON.stringify(result),
        });
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    finalText = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    break;
  }

  if (!finalText) {
    finalText = "I wasn't able to get a clear answer. Try rephrasing your question?";
  }

  return { reply: finalText, iterations, messages };
}

// ── Helpers ──────────────────────────────────────────────────────

// Strip trailing [SHOWME ...] marker from a reply. Cliq users don't have
// the Breeze web UI to drill into, so we don't send the marker across that
// transport.
const SHOWME_REGEX = /\s*\[SHOWME\s+[^\]]+\]\s*$/i;
export function stripShowMe(text) {
  if (!text) return text;
  return text.replace(SHOWME_REGEX, '').trimEnd();
}
