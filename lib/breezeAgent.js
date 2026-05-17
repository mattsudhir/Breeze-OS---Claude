// Shared Breeze AI agent — the tools, system prompt, and agent loop that
// both /api/chat (web UI) and /api/cliq (Zoho Cliq Message Handler)
// call into. Keeping this in one place means a new tool or a prompt tweak
// shows up in both surfaces at once.
//
// Environment variables:
//   ANTHROPIC_API_KEY      – from console.anthropic.com
//   APPFOLIO_CLIENT_ID     – AppFolio Database API client ID (default backend)
//   APPFOLIO_CLIENT_SECRET – AppFolio Database API client secret
//   APPFOLIO_DEVELOPER_ID  – AppFolio developer/customer ID
//   RM_BASE_URL, RM_USERNAME, RM_PASSWORD – used by the 'rm-demo' backend
//   DATABASE_URL           – used by the 'breeze' (Postgres) backend
//   ZOHO_MCP_SERVER_URL    – used by the 'zoho-mcp' backend
//   ZOHO_CLIQ_WEBHOOK_URL  – optional, used by the notify_team tool
//   VAPI_API_KEY           – Vapi private key (dashboard.vapi.ai → API Keys)
//   VAPI_PHONE_NUMBER_ID   – Vapi phone number ID to call from
//   VAPI_ASSISTANT_ID      – optional; if set, overrides that assistant per-call
//                            (preserves your ElevenLabs voice). If omitted, an
//                            inline assistant is created on each call instead.
//   ELEVENLABS_VOICE_ID    – ElevenLabs voice ID for inline assistant (default: rachel)

import Anthropic from '@anthropic-ai/sdk';
import { postToCliq } from './cliqNotify.js';
import { getChatBackend, DEFAULT_BACKEND } from './backends/index.js';
import { logAgentAction } from './agentAudit.js';

export const MODEL = 'claude-haiku-4-5';
export const MAX_ITERATIONS = 8;

// ── Tool definitions ─────────────────────────────────────────────
//
// Data tools (search_tenants, list_properties, list_units, etc.) live
// in the per-backend modules under lib/backends/ — they're different
// across RM, Breeze Postgres, and Zoho MCP. The tools below are
// orchestration tools that work the same regardless of data source:
// notifying the team via Cliq and placing outbound Vapi calls.

export const COMMON_TOOLS = [
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
  {
    name: 'daily_briefing',
    description:
      "Pull a structured snapshot of what's happened across the portfolio since the user's last briefing (or the last 30 days if they've never been briefed). " +
      "Use ONLY when the user explicitly asks for a briefing, daily summary, what they should know today, what's new, or similar (e.g. \"what's my briefing?\", \"daily summary\", \"what should I know?\", \"catch me up\"). " +
      "Do NOT use for narrow factual questions the user can ask directly (\"how many tenants do we have\" → use search_tenants). " +
      "The tool returns a structured JSON snapshot — your job is to render it as a tight, scannable briefing: lead with anything emergency-priority, then group by signal, then close with one suggested next action phrased as a question. " +
      "Use bullets, emoji for visual scanning (🚨 for emergencies, ⚠️ for high-priority, 💰 for money, 🏠 for leases, ✅ for completions), and stay under one screen of text. " +
      "If a signal is zero or empty, omit it entirely — don't say \"no past-due tenants\" if there are none, just skip that section.",
    input_schema: {
      type: 'object',
      properties: {
        entity_id: {
          type: 'string',
          description:
            'Optional entity (LLC) UUID to scope the briefing to one owner. Omit for the full org view.',
        },
        dry_run: {
          type: 'boolean',
          description:
            'Set true to preview the snapshot without advancing the "last briefed at" marker. ' +
            'Default false — a normal briefing call updates the marker so the NEXT briefing only covers what\'s new.',
        },
      },
      required: [],
    },
  },
];

// ── Tool executors ───────────────────────────────────────────────
//
// executeTool dispatches to either:
//   (a) one of the common orchestration tools (notify_team, make_call)
//       which work identically regardless of data source, or
//   (b) the supplied backend's own executeTool() — the backend handles
//       all data-reading tools (search_tenants, list_properties, etc.)

const COMMON_TOOL_NAMES = new Set(['notify_team', 'make_call', 'daily_briefing']);

export async function executeTool(name, input, backend = null) {
  if (!COMMON_TOOL_NAMES.has(name)) {
    if (!backend) {
      return { error: `Tool "${name}" requires a data backend but none was provided.` };
    }
    return backend.executeTool(name, input);
  }

  try {
    switch (name) {
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

      case 'daily_briefing': {
        // Self-fetch the data collector endpoint so we get the same
        // signals shape an external caller would. Re-attaches the
        // BREEZE_ADMIN_TOKEN from env so the collector authenticates;
        // this only works in environments where the agent is running
        // server-side with that env var set (Vercel, local dev).
        // See api/admin/daily-briefing-data.js + ADR 0005.
        const base = process.env.BREEZE_PUBLIC_URL
          || process.env.VERCEL_URL
          || 'http://localhost:3000';
        const baseUrl = base.startsWith('http') ? base : `https://${base}`;
        const token = process.env.BREEZE_ADMIN_TOKEN || '';
        const params = new URLSearchParams();
        if (token) params.set('secret', token);
        if (input.entity_id) params.set('entity_id', input.entity_id);
        if (input.dry_run === true) params.set('dry_run', 'true');
        try {
          const url = `${baseUrl}/api/admin/daily-briefing-data?${params}`;
          const resp = await fetch(url, {
            method: 'GET',
            headers: token ? { 'X-Breeze-Admin-Token': token } : {},
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok || data.ok === false) {
            return { error: data.error || `briefing data fetch failed: HTTP ${resp.status}` };
          }
          // Return the snapshot to Claude. The model's job (per the
          // tool description + system prompt) is to render the
          // narrative briefing from this structured input.
          return data;
        } catch (err) {
          return { error: `briefing tool failed: ${err.message}` };
        }
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

// ── System prompt ────────────────────────────────────────────────

export const SYSTEM_PROMPT = `You are Breeze AI, a friendly and efficient property-management assistant. You help property managers answer questions about their portfolio — tenants, properties, units, leases, maintenance, balances, and operations.

You have tools to query the configured data source live. Use them whenever the user asks about real data. Prefer calling tools over guessing. The available data source is described in the "Data source" section below — respect its limits and surface honest errors when a concept isn't tracked.

When a user asks about a specific tenant (in data sources that track tenants):
1. Call search_tenants first to find the right TenantID (it returns only name/id/status — no contact info).
2. For ANY question about that tenant's email, phone, lease, balance, or address, you MUST call get_tenant_details with that id. Do not answer contact or financial questions using only search_tenants — that data is not included there.

Style:
- Conversational and concise. Don't over-explain unless asked.
- When you cite a person, use their full name. When you cite a unit, use its name (not just id).
- Format currency as $X,XXX.XX.
- Format dates naturally (e.g. "April 12, 2026").
- If the user asks something that needs no tool call (greeting, follow-up clarification), just answer directly.

Error handling (important):
- If a tool returns an object containing an "error" field, do NOT paraphrase it as "authentication error", "session issue", or any other natural-language summary. Instead, report the error verbatim to the user prefixed with "Tool error:" so they can see exactly what the backend returned. Example: "Tool error: Could not fetch work orders (HTTP 404): No resource found at /ServiceManagerIssues". Do not retry the same tool call if it just errored.

Notifications:
- When the user explicitly asks you to notify, alert, ping, message, text, or tell someone about something (e.g. "notify the plumbing team about WO-57", "ping Marcia that her lease is expiring", "alert maintenance about the Mold ticket"), use the notify_team tool. It posts a message to the team chat channel via Zoho Cliq.
- Always include a recipient (who it's going to) and a concrete message. If the context is a specific record (a ticket, unit, tenant), pass it in the context field.
- After the tool returns success, confirm briefly to the user — e.g. "Sent to the team chat for the plumbing team." Do NOT paste the full delivered text back; a short confirmation is enough.
- If the tool returns an error, surface it verbatim per the error-handling rule above.
- If the user implicitly wants to notify but hasn't said so (e.g. "this needs to be fixed"), ask before sending — don't auto-notify.

Daily briefings:
- When the user explicitly asks for a briefing, daily summary, what they should know today, what's new, or "catch me up", use the daily_briefing tool. It returns a structured snapshot of what's happened across the portfolio since their last briefing (or the last 30 days if they've never been briefed).
- Render the snapshot as a single-screen briefing: lead with anything emergency-priority, then group by signal, then close with one suggested next action phrased as a question.
- Use emoji for visual scanning: 🚨 emergencies, ⚠️ high-priority, 💰 money / past due, 🏠 leases, 🔧 stale tickets, ✅ completions, 📋 approvals queue.
- If a signal is zero or empty, omit it entirely — don't say "no past-due tenants", just skip that section.
- Do NOT use this tool for narrow factual questions (e.g. "how many tenants do we have" → use search_tenants directly). Briefings are for the "what should I focus on today?" type of question only.

Outbound calls:
- When the user asks you to call, phone, or ring someone (e.g. "call Matt at 419-555-1212 and find out when he will pay"), use the make_call tool.
- CRITICAL: If the user provided a phone number directly in their message, call make_call IMMEDIATELY with that number. Do NOT call search_tenants or get_tenant_details first — the user already gave you everything you need, and tenant lookup can fail on unrelated errors that should not block the call.
- Only look up a tenant's number (via search_tenants + get_tenant_details) when the user names a person WITHOUT giving a phone number. If that lookup fails, ask the user to provide the number directly instead of giving up.
- Populate the purpose field with a clear, goal-oriented sentence derived from what the user said.
- Populate the context field with any relevant details the user mentioned: amount owed, timeframe, property name, unit, lease dates. You do NOT need to look up extra details from the backend first — use what the user told you.
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
- The user may also verbally say "show me" as a follow-up; treat that as a request to re-emit the previous filters in a fresh marker.`;

// ── Agent loop ───────────────────────────────────────────────────
//
// Runs a full tool-use loop against Claude and returns the final text +
// iteration count. Input `messages` is the standard Anthropic messages
// array (role: 'user' | 'assistant', content: string or content blocks).
// Callers wrap this with whatever transport they have (HTTP handler,
// Cliq message handler, etc.).

export async function runAgent(
  inputMessages,
  {
    clientOverride,
    systemPrompt,
    dataSource,
    // Audit context — passed through to logAgentAction so the audit
    // log can answer "who / which surface / which session" later.
    // All optional; the caller (api/chat.js, api/cliq.js, the cron
    // worker, etc.) fills in what it knows.
    auditSurface = 'chat',
    auditUserId = null,
    auditConversationId = null,
  } = {},
) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error(
      'ANTHROPIC_API_KEY not configured. Add it in Vercel → Settings → Environment Variables.',
    );
    err.status = 500;
    throw err;
  }

  const backend = getChatBackend(dataSource || DEFAULT_BACKEND);
  const backendTools = await backend.getTools();
  const tools = [...backendTools, ...COMMON_TOOLS];

  // Compose the final system prompt: caller override (if any) wins,
  // otherwise base SYSTEM_PROMPT + the backend's own addendum describing
  // what data it has.
  const effectiveSystem =
    systemPrompt ||
    `${SYSTEM_PROMPT}\n\n${backend.systemPromptAddendum || ''}`.trim();

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
      system: effectiveSystem,
      tools,
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
        const startedAt = Date.now();
        let result;
        let threwError = null;
        try {
          result = await executeTool(call.name, call.input || {}, backend);
        } catch (err) {
          threwError = err;
          result = { error: err?.message || String(err) };
        }
        const durationMs = Date.now() - startedAt;

        // Fire-and-forget audit. logAgentAction never throws, never
        // blocks the agent loop; we don't await it for that reason —
        // the chat reply doesn't have to wait on a DB round trip.
        const success =
          !threwError &&
          !(result && typeof result === 'object' && 'error' in result);
        logAgentAction({
          surface: auditSurface,
          userId: auditUserId,
          conversationId: auditConversationId,
          backendName: backend.name || dataSource || null,
          toolName: call.name,
          toolInput: call.input || {},
          toolOutput: result,
          success,
          durationMs,
          errorText: threwError ? threwError.message : null,
        });

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
