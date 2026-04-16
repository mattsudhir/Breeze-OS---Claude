// Shared Breeze AI agent — the tools, system prompt, and agent loop that
// both /api/chat (web UI) and /api/cliq (Zoho Cliq Message Handler)
// call into. Keeping this in one place means a new tool or a prompt tweak
// shows up in both surfaces at once.
//
// Environment variables:
//   ANTHROPIC_API_KEY      – from console.anthropic.com
//   RM_BASE_URL, RM_USERNAME, RM_PASSWORD – inherited via lib/rmClient.js
//   ZOHO_CLIQ_WEBHOOK_URL  – optional, used by the notify_team tool
//   VAPI_API_KEY           – Vapi private key (dashboard.vapi.ai → API Keys)
//   VAPI_PHONE_NUMBER_ID   – Vapi phone number ID to call from
//   VAPI_ASSISTANT_ID      – optional; if set, overrides that assistant per-call
//                            (preserves your ElevenLabs voice). If omitted, an
//                            inline assistant is created on each call instead.
//   ELEVENLABS_VOICE_ID    – ElevenLabs voice ID for inline assistant (default: rachel)
//   ZOHO_MCP_URL           – Zoho MCP server endpoint (streamable-HTTP). When set,
//                            the agent exposes all Zoho Cliq / CRM / Projects /
//                            Creator tools alongside the local Rent Manager tools.
//                            Get the URL from mcp.zoho.com → Connect.

import Anthropic from '@anthropic-ai/sdk';
import { rmCall } from './rmClient.js';
import { postToCliq } from './cliqNotify.js';

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
      'you to notify, alert, ping, message, or tell someone about something. Every notification routes ' +
      'to the same team channel regardless of recipient — the recipient is only used to build a ' +
      'natural-sounding header line. ' +
      'IMPORTANT: Do NOT interrogate the user for a recipient if they did not specify one. If the user ' +
      'says "notify the team" or just "send a notification", call this tool immediately with ' +
      'recipient="the team" and use the user\'s own words as the message. Only ask a follow-up if ' +
      'the MESSAGE itself is genuinely ambiguous (e.g. "notify them" with no prior context about what).',
    input_schema: {
      type: 'object',
      properties: {
        recipient: {
          type: 'string',
          description:
            'Who or what team the message is directed to, e.g. "plumbing team", "Marcia Clark", ' +
            '"maintenance supervisor". Used in the message header only. Default to "the team" if ' +
            'the user did not specify a recipient — never block on asking for one.',
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
      required: ['message'],
    },
  },
  {
    name: 'make_call',
    description:
      'Initiate an outbound AI phone call via Vapi to a tenant or contact. Use when the user ' +
      'explicitly asks to call someone (e.g. "call Matt at 419-555-1212 and find out when he ' +
      'will pay"). The Vapi AI voice assistant will conduct the call with full context about ' +
      'why it is calling. Accepts any common US phone number format.',
    input_schema: {
      type: 'object',
      properties: {
        recipient_name: {
          type: 'string',
          description: 'Full name of the person to call, e.g. "Matt Johnson".',
        },
        phone_number: {
          type: 'string',
          description:
            'Phone number to dial. Accepts any US format: "419-555-1212", "(419) 555-1212", ' +
            '"4195551212", "+14195551212". Will be normalised to E.164 automatically.',
        },
        purpose: {
          type: 'string',
          description:
            'What the call needs to accomplish, phrased as a goal. ' +
            'e.g. "Find out when the tenant plans to pay their overdue rent balance." ' +
            'This becomes the AI caller\'s primary objective.',
        },
        context: {
          type: 'string',
          description:
            'Optional background briefing for the AI caller — amounts owed, dates, property ' +
            'name, lease details, prior conversations. More context = more natural call. ' +
            'e.g. "Matt owes $1,200 across January and February 2026. He is a current tenant ' +
            'at Unit 204, Oakwood Apartments."',
        },
      },
      required: ['recipient_name', 'phone_number', 'purpose'],
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
        // Delegate to the shared Cliq helper so the chat tool and the
        // programmatic /api/notify endpoint stay in lockstep.
        return await postToCliq({
          recipient: input.recipient,
          message: input.message,
          context: input.context,
        });
      }

      case 'make_call': {
        const vapiKey = process.env.VAPI_API_KEY;
        const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;

        // Diagnostic helper — lists every VAPI_* env var the runtime sees,
        // with values masked. Makes it obvious when a var is named slightly
        // wrong (trailing space, typo, wrong case) or scoped to the wrong
        // environment.
        const vapiEnvSeen = () => {
          const keys = Object.keys(process.env).filter((k) => k.toUpperCase().startsWith('VAPI'));
          if (keys.length === 0) return 'NONE (no VAPI_* env vars reached this runtime)';
          return keys
            .map((k) => {
              const v = process.env[k];
              if (v == null || v === '') return `${k}=<empty>`;
              const masked = v.length <= 6 ? '***' : `${v.slice(0, 3)}…${v.slice(-3)} (${v.length} chars)`;
              return `${k}=${masked}`;
            })
            .join('; ');
        };

        if (!vapiKey) {
          return {
            error:
              `VAPI_API_KEY is not configured. Runtime env: ${vapiEnvSeen()}. ` +
              `Add VAPI_API_KEY in Vercel → Settings → Environment Variables and redeploy.`,
          };
        }
        if (!phoneNumberId) {
          return {
            error:
              `VAPI_PHONE_NUMBER_ID is not configured. Runtime env: ${vapiEnvSeen()}. ` +
              `Add VAPI_PHONE_NUMBER_ID in Vercel → Settings → Environment Variables (scoped to Production) and redeploy.`,
          };
        }

        // Normalise any common US format to E.164 (+1XXXXXXXXXX)
        const digits = (input.phone_number || '').replace(/\D/g, '');
        let e164;
        if (digits.length === 10) {
          e164 = `+1${digits}`;
        } else if (digits.length === 11 && digits[0] === '1') {
          e164 = `+${digits}`;
        } else {
          return { error: `Could not parse phone number "${input.phone_number}". Provide a 10-digit US number.` };
        }

        const name = (input.recipient_name || 'the tenant').trim();
        const purpose = (input.purpose || '').trim();
        const contextInfo = (input.context || '').trim();

        // Caller identity — configurable via env vars so property groups can
        // rebrand without a code change.
        const callerName = process.env.BREEZE_CALLER_NAME || 'Alex';
        const companyName = process.env.BREEZE_COMPANY_NAME || 'Breeze Property Group';

        // Build a per-call system prompt so the caller knows exactly why it
        // is calling and what it needs to accomplish. The prompt walks the
        // model through the WHOLE conversation, not just the opener — early
        // versions stopped talking after the intro because the prompt was
        // intro-heavy and didn't explicitly instruct continuation.
        const systemPrompt = [
          `You are ${callerName}, a representative from ${companyName}. You are having a live phone conversation with ${name}.`,
          '',
          `YOUR GOAL: ${purpose}`,
          contextInfo ? `BACKGROUND YOU KNOW: ${contextInfo}` : '',
          '',
          'CONVERSATION FLOW — follow all of these steps:',
          '',
          '1) Opening: The system has already delivered your opening line ("Hi, this is ' + callerName + ' from ' + companyName + '. Am I speaking with ' + name + '?"). You do NOT need to re-introduce yourself.',
          '',
          `2) After they confirm it's them: transition directly into the reason for your call. State the purpose clearly and conversationally, using the background info above. Example: "Great, thanks. I'm calling because [reason tied to the goal]. [Key fact from background]. I wanted to check in with you about [what you need from them]."`,
          '',
          '3) Listen to their response. Respond with empathy and acknowledgement. Ask clarifying questions if needed. Work toward the goal one turn at a time.',
          '',
          `4) Keep going. This is a TWO-WAY conversation — you must respond every single time they speak, without exception. Never go silent mid-call. If you are unsure what to say, acknowledge what they said and ask a relevant follow-up question.`,
          '',
          `5) When the goal is achieved, the person commits to a next step, they say goodbye, or the conversation has naturally concluded: thank them for their time, say goodbye warmly, and IMMEDIATELY use the endCall tool to hang up. Do not linger.`,
          '',
          'STYLE:',
          '- Speak as a real human representative would. Do NOT mention being an AI, a bot, an assistant, automated, or a program. Never say "I am an AI" or similar under any circumstances — you are ' + callerName + '.',
          '- Be warm, polite, empathetic, and professional at all times.',
          '- Keep each of your turns SHORT — 1 to 3 sentences. This is a phone call, not an essay. Let the other person talk.',
          '- Stay focused on the goal. Do not discuss other tenants, other properties, or unrelated matters.',
          '- If the person disputes amounts, dates, or facts, acknowledge their concern and say you will have someone from the team follow up with them. Do not argue.',
          '- If you reach voicemail (no response, or a "leave a message" prompt), leave a brief 15-second professional message introducing yourself, stating your reason for calling, and asking them to call back. Then use the endCall tool.',
          '',
          'CRITICAL: You must actively carry the conversation forward. Every recipient turn needs a response from you. Silence is never acceptable during a live call.',
        ].filter(Boolean).join('\n');

        // First message plays only AFTER the recipient speaks, because we
        // set firstMessageMode to assistant-waits-for-user below. This means
        // the caller listens for "Hello?" first, then delivers this opener.
        const firstMessage = `Hi, this is ${callerName} from ${companyName}. Am I speaking with ${name}?`;

        // If an assistant ID is set, use overrides so the existing Vapi
        // assistant's voice, tools, and other config is reused but the
        // per-call system prompt and opener are injected. Vapi requires
        // the full model object (provider + model) when overriding messages,
        // so we force Anthropic Haiku for the call — consistent with the
        // inline path below and the right model for short outbound calls.
        // If no assistant ID, build a minimal inline assistant.
        const assistantId = process.env.VAPI_ASSISTANT_ID;
        const voiceId = process.env.ELEVENLABS_VOICE_ID || 'rachel';

        // Vapi's Anthropic provider only accepts date-stamped model IDs from
        // its allowlist — bare names like "claude-haiku-4-5" are rejected.
        // Sonnet 4.5 is a good default for outbound calls: better conversation
        // quality than Haiku and well within cost tolerance for short calls.
        // Override with VAPI_CALL_MODEL if you want something else.
        //
        // tools[] is set to ONLY Vapi's built-in endCall tool. This both
        // (a) gives the caller a clean way to hang up when the conversation
        // is done, and (b) wipes any orphaned tool references from the base
        // assistant — avoids the "Couldn't get tool for hook" 400 we hit
        // earlier without touching the base assistant's config.
        const modelConfig = {
          provider: 'anthropic',
          model: process.env.VAPI_CALL_MODEL || 'claude-sonnet-4-5-20250929',
          messages: [{ role: 'system', content: systemPrompt }],
          tools: [{ type: 'endCall' }],
          // Explicitly set generation params so Vapi doesn't fall back to
          // very conservative defaults that can leave the caller silent or
          // mid-sentence. 300 tokens is plenty for a short phone turn;
          // temperature 0.7 keeps the voice warm but not unhinged.
          maxTokens: 300,
          temperature: 0.7,
        };

        // Auto-hangup triggers. Vapi hangs up automatically if the recipient
        // says any of these phrases — belt and suspenders with the endCall
        // tool so the line always closes cleanly.
        const endCallPhrases = [
          'goodbye',
          'good bye',
          'bye',
          'take care',
          'have a good day',
          'have a great day',
          'thank you bye',
          'talk later',
          'talk to you later',
          'gotta go',
          'i have to go',
        ];
        const endCallMessage = `Thank you for your time, ${name.split(' ')[0] || ''}. Have a great day. Goodbye.`.replace(/\s+/g, ' ');

        const payload = {
          phoneNumberId,
          customer: { number: e164, name },
          ...(assistantId
            ? {
                assistantId,
                assistantOverrides: {
                  firstMessage,
                  // Caller listens for the recipient's greeting ("Hello?")
                  // before saying anything. The firstMessage above then plays
                  // as the response to that greeting.
                  firstMessageMode: 'assistant-waits-for-user',
                  endCallMessage,
                  endCallPhrases,
                  model: modelConfig,
                },
              }
            : {
                assistant: {
                  name: 'Breeze Caller',
                  firstMessage,
                  firstMessageMode: 'assistant-waits-for-user',
                  endCallMessage,
                  endCallPhrases,
                  model: modelConfig,
                  voice: {
                    provider: 'elevenlabs',
                    voiceId,
                  },
                },
              }),
        };

        try {
          console.log('[make_call] POST https://api.vapi.ai/call/phone', JSON.stringify({
            phoneNumberId: payload.phoneNumberId,
            customer: payload.customer,
            usingAssistantId: !!assistantId,
            model: modelConfig.model,
          }));

          const res = await fetch('https://api.vapi.ai/call/phone', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${vapiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
          });

          if (!res.ok) {
            const errText = await res.text();
            // Always log the raw Vapi error so it's visible in Vercel logs
            // regardless of how the LLM decides to phrase it to the user.
            console.error(`[make_call] Vapi ${res.status}:`, errText);
            return { error: `Vapi call failed (HTTP ${res.status}): ${errText.slice(0, 600)}` };
          }

          const data = await res.json();
          console.log(`[make_call] Vapi call queued: ${data.id}`);
          return {
            success: true,
            call_id: data.id,
            recipient: name,
            phone: e164,
            status: data.status || 'queued',
          };
        } catch (err) {
          console.error('[make_call] fetch failed:', err);
          return { error: `Vapi request failed: ${err.message}` };
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

Outbound calls:
- When the user asks you to call, phone, or ring someone (e.g. "call Matt at 419-555-1212 and find out when he will pay"), use the make_call tool.
- CRITICAL: If the user provided a phone number directly in their message, call make_call IMMEDIATELY with that number. Do NOT call search_tenants or get_tenant_details first — the user already gave you everything you need, and tenant lookup can fail on unrelated errors that should not block the call.
- Only look up a tenant's number (via search_tenants + get_tenant_details) when the user names a person WITHOUT giving a phone number. If that lookup fails, ask the user to provide the number directly instead of giving up.
- Populate the purpose field with a clear, goal-oriented sentence derived from what the user said.
- Populate the context field with any relevant details the user mentioned: amount owed, timeframe, property name, unit, lease dates. You do NOT need to look up extra details from Rent Manager first — use what the user told you.
- After make_call returns success, reply with a single short sentence in this exact form: "Call to <first name> is underway." and nothing else. Do NOT include the phone number, call ID, context summary, or any other detail. Example: "Call to Matt is underway."
- If make_call returns an error, surface it verbatim per the error-handling rule above.
- Do NOT place a call if the user has not explicitly asked for one — never auto-dial.

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
- The user may also verbally say "show me" as a follow-up; treat that as a request to re-emit the previous filters in a fresh marker.

Zoho tools (when available):
- You may also have access to Zoho tools — Cliq, CRM, Projects, and Creator — via the Zoho MCP server. These tools are discovered automatically; you do not need to know their names in advance.
- Use Zoho CRM tools when the user asks about leads, deals, contacts, or accounts in the CRM.
- Use Zoho Projects tools when the user asks about project tasks, milestones, or timelines.
- Use Zoho Cliq tools when the user asks about chat channels, team members, or wants to interact with Cliq beyond simple notifications (for simple notifications, prefer the local notify_team tool).
- Use Zoho Creator tools when the user asks about custom Zoho Creator apps or forms.
- If a Zoho tool returns an error, surface it verbatim per the error-handling rule above.`;

// ── Agent loop ───────────────────────────────────────────────────
//
// Runs a full tool-use loop against Claude and returns the final text +
// iteration count. Input `messages` is the standard Anthropic messages
// array (role: 'user' | 'assistant', content: string or content blocks).
// Callers wrap this with whatever transport they have (HTTP handler,
// Cliq message handler, etc.).

export async function runAgent(inputMessages, { clientOverride, systemPrompt } = {}) {
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

  // ── Zoho MCP connector ──────────────────────────────────────────
  // When ZOHO_MCP_URL is configured, we pass it to the Anthropic API
  // via the MCP connector beta. The API connects to the Zoho MCP
  // server, discovers all available tools (Cliq, CRM, Projects,
  // Creator), and lets Claude call them server-side — no local
  // dispatch needed. Local Rent Manager tools continue to work as
  // before via the tool_use / executeTool loop.
  const mcpUrl = process.env.ZOHO_MCP_URL;
  const useMcp = !!mcpUrl;

  let iterations = 0;
  let finalText = '';

  while (iterations < MAX_ITERATIONS) {
    iterations += 1;

    const apiParams = {
      model: MODEL,
      max_tokens: 2048,
      system: systemPrompt || SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    };

    if (useMcp) {
      apiParams.mcp_servers = [
        {
          type: 'url',
          url: mcpUrl,
          name: 'zoho',
        },
      ];
    }

    // Use the beta namespace when MCP is active so the API accepts
    // mcp_servers. Falls back to the standard path otherwise.
    const response = useMcp
      ? await client.beta.messages.create({
          ...apiParams,
          betas: ['mcp-client-2025-04-04'],
        })
      : await client.messages.create(apiParams);

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
