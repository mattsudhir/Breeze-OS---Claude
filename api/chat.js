// Vercel Serverless Function — LLM chat with Rent Manager tool use.
//
// Takes a list of chat messages from the frontend, runs an agent loop
// against Claude Haiku 4.5, and lets the model call RM via the tools
// defined below. Returns the final natural-language answer.
//
// Environment variables:
//   ANTHROPIC_API_KEY – from console.anthropic.com
//   RM_BASE_URL, RM_USERNAME, RM_PASSWORD – inherited via lib/rmClient.js

import Anthropic from '@anthropic-ai/sdk';
import { rmCall } from '../lib/rmClient.js';

const MODEL = 'claude-haiku-4-5';
const MAX_ITERATIONS = 8;

// ── Tool definitions ─────────────────────────────────────────────
// Each tool's input schema is a JSON Schema object. Claude decides when
// to call which based on the description.

const TOOLS = [
  {
    name: 'search_tenants',
    description:
      'Search for tenants by name, email, or phone. Use this when the user asks about a specific person. ' +
      'Returns a list of matching tenants with id, name, email, phone, status, and current unit/property if available. ' +
      'If the user asks a follow-up question about one tenant, use get_tenant_details with the id from this list.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Partial or full name, email, or phone number to search for. Leave empty to list all tenants.',
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
      'List maintenance work orders / service requests. Returns id, summary, priority, status, ' +
      'and the related unit/property. Use for questions about maintenance, repairs, or open issues.',
    input_schema: {
      type: 'object',
      properties: {
        status_filter: {
          type: 'string',
          description: 'Optional: "open" to show only incomplete orders, "all" for everything. Default: all.',
          enum: ['open', 'all'],
        },
      },
      required: [],
    },
  },
];

// ── Tool executors ───────────────────────────────────────────────
// These call Rent Manager and return compact, model-friendly results.

async function executeTool(name, input) {
  try {
    switch (name) {
      case 'search_tenants': {
        const res = await rmCall('/Tenants');
        if (!res.ok || !Array.isArray(res.data)) {
          return { error: `Could not fetch tenants: ${res.status}` };
        }
        const q = (input.query || '').toLowerCase().trim();
        let tenants = res.data.map(mapTenantSummary);
        if (q) {
          tenants = tenants.filter(
            (t) =>
              t.name.toLowerCase().includes(q) ||
              (t.email || '').toLowerCase().includes(q) ||
              (t.phone || '').toLowerCase().includes(q),
          );
        }
        return { count: tenants.length, tenants: tenants.slice(0, 20) };
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
        const res = await rmCall('/ServiceManagerOrders');
        if (!res.ok || !Array.isArray(res.data)) {
          return { error: `Could not fetch work orders: ${res.status}` };
        }
        let orders = res.data.map((w) => ({
          id: w.ServiceManagerOrderID || w.OrderID,
          summary: w.Summary || w.Description,
          status: w.Status,
          priority: w.Priority,
          property_id: w.PropertyID,
          unit_id: w.UnitID,
          created: w.CreateDate || w.DateCreated,
        }));
        if (input.status_filter === 'open') {
          orders = orders.filter((o) => {
            const s = (o.status || '').toLowerCase();
            return !s.includes('complete') && !s.includes('closed');
          });
        }
        return { count: orders.length, work_orders: orders.slice(0, 20) };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

function mapTenantSummary(t) {
  return {
    id: t.TenantID,
    display_id: t.TenantDisplayID,
    name: [t.FirstName, t.LastName].filter(Boolean).join(' ') || `Tenant ${t.TenantID}`,
    email: t.Email || '',
    phone: t.Phone || t.CellPhone || '',
    status: t.Status || '',
    property_id: t.PropertyID,
    unit_id: t.UnitID,
  };
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

const SYSTEM_PROMPT = `You are Breeze AI, a friendly and efficient property-management assistant built on top of Rent Manager. You help property managers answer questions about their portfolio — tenants, properties, units, leases, maintenance, and balances.

You have tools to query Rent Manager live. Use them whenever the user asks about real data. Prefer calling tools over guessing. When a user asks about a specific person, start with search_tenants, then drill into get_tenant_details if you need lease, balance, or contact specifics.

Style:
- Conversational and concise. Don't over-explain unless asked.
- When you cite a person, use their full name. When you cite a unit, use its name (not just id).
- Format currency as $X,XXX.XX.
- Format dates naturally (e.g. "April 12, 2026").
- If a tool returns an error, tell the user briefly what went wrong rather than retrying forever.
- If the user asks something that needs no tool call (greeting, follow-up clarification), just answer directly.`;

// ── Agent loop ───────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY not configured. Add it in Vercel → Settings → Environment Variables.',
    });
  }

  try {
    const { messages: inputMessages = [] } = req.body || {};
    if (!Array.isArray(inputMessages) || inputMessages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }

    const client = new Anthropic();
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

      // Append assistant response to the history
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

      // Any other stop reason — treat as done
      finalText = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      break;
    }

    if (!finalText) {
      finalText = "I wasn't able to get a clear answer. Try rephrasing your question?";
    }

    return res.status(200).json({
      ok: true,
      reply: finalText,
      iterations,
    });
  } catch (err) {
    console.error('Chat handler error:', err);
    // Typed exception handling
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(401).json({ error: 'Invalid Anthropic API key' });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'Rate limited — try again in a moment' });
    }
    if (err instanceof Anthropic.APIError) {
      return res.status(err.status || 500).json({ error: err.message });
    }
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}
