// Vapi outbound-call invoker for utility workflow tasks.
//
// This is the "hands" of the move-event state machine: it takes a
// utility-level action (verify the utility is off the LLC, transfer
// the utility into the LLC, etc.) and actually places a Vapi phone
// call to the provider to make it happen.
//
// Distinct from lib/breezeAgent.js's existing make_call chat tool —
// that one is chat-driven and general-purpose. This one is workflow-
// driven, builds a utility-specific system prompt from structured
// context, and asks the Vapi assistant to emit a structured outcome
// the webhook handler can mechanically act on.
//
// Environment variables (shared with make_call):
//   VAPI_API_KEY           — Vapi private key
//   VAPI_PHONE_NUMBER_ID   — Vapi phone number ID to call from
//   VAPI_ASSISTANT_ID      — optional assistant ID to override
//   VAPI_CALL_MODEL        — optional model override for Claude
//   ELEVENLABS_VOICE_ID    — optional voice for inline assistant
//   BREEZE_CALLER_NAME     — who the AI identifies as (default "Alex")
//   BREEZE_COMPANY_NAME    — company name (default "Breeze Property Group")

// ── Prompt templates per action type ─────────────────────────────

// Utility calls need to emit a structured outcome at end-of-call so
// the webhook handler can transition state deterministically. The
// assistant uses Vapi's "structured data extraction" feature via an
// analysis schema attached to the call. If structured extraction
// isn't available, we fall back to parsing the transcript.
//
// Outcome schema (emitted at end of call):
//   {
//     outcome: "success" | "closed" | "hold_timeout" | "voicemail" |
//              "needs_human" | "failed",
//     callback_at: ISO 8601 string | null,  // for "closed"
//     new_account_number: string | null,    // for "success" on transfer
//     confirmation_number: string | null,   // for "success"
//     notes: string                          // free text for humans
//   }

function buildSystemPrompt(ctx) {
  const {
    action,           // 'verify_off_llc' | 'transfer_to_llc' | 'verify_on_llc'
    utilityType,      // 'electric' | 'gas' | ...
    providerName,     // 'Columbia Gas of Ohio'
    llcLegalName,     // 'SLM Toledo Investments LLC'
    authorizedCallerName, // 'Matt Smith' or null
    serviceAddress,   // '105 Southard Ave, Toledo, OH 43604'
    tenantName,       // new tenant (for move-in) or outgoing tenant (for move-out)
    effectiveDate,    // 'May 1, 2026'
    callerName,       // 'Alex'
    companyName,      // 'Breeze Property Group'
  } = ctx;

  const who = callerName;
  const authLine = authorizedCallerName
    ? `Your supervisor on this account is ${authorizedCallerName}, who is listed as an authorized representative. If the rep asks who you are, identify as ${who} calling on behalf of ${authorizedCallerName} with written authorization from ${llcLegalName}.`
    : `You are calling on behalf of ${llcLegalName}, the property owner, and you have written authorization to make account changes on their behalf.`;

  // Per-action goal. The rest of the prompt is shared.
  let goal;
  let expectedOutcome;
  if (action === 'verify_off_llc') {
    goal =
      `Verify that the ${utilityType} service at ${serviceAddress} is NOT currently in ` +
      `${llcLegalName}'s name. The previous tenant moved out, and the new tenant ` +
      (tenantName ? `(${tenantName}) ` : '') +
      `was supposed to transfer service into their own account effective ${effectiveDate}. ` +
      `Ask the rep to look up the account at ${serviceAddress} and confirm the current account holder. ` +
      `If it's still on ${llcLegalName}, that's a problem — record the outcome as 'needs_human' and end the call politely. ` +
      `If it's on someone else's name (the new tenant's), mark the outcome as 'success' and record the new account holder name in the notes.`;
    expectedOutcome = "'success' if the utility is NOT on the LLC anymore, 'needs_human' if it is still on the LLC";
  } else if (action === 'transfer_to_llc') {
    goal =
      `Close the ${utilityType} service currently associated with ${serviceAddress} ` +
      (tenantName ? `(under the outgoing tenant ${tenantName}) ` : '') +
      `and open a new account in ${llcLegalName}'s name effective ${effectiveDate}. ` +
      `Billing should go to the LLC's mailing address on file. Capture the new account number and any confirmation number the rep provides.`;
    expectedOutcome = "'success' with new_account_number and confirmation_number populated";
  } else if (action === 'verify_on_llc') {
    goal =
      `Confirm that the ${utilityType} service at ${serviceAddress} is currently in ` +
      `${llcLegalName}'s name. This is a routine verification — no action is needed ` +
      `beyond confirming the account holder. If it's NOT on the LLC, record 'needs_human'.`;
    expectedOutcome = "'success' if the utility IS on the LLC";
  } else {
    goal = `Unknown action "${action}". End the call and record 'failed'.`;
    expectedOutcome = "'failed'";
  }

  return [
    `You are ${who}, a representative from ${companyName}. You are having a live phone conversation with a customer service representative at ${providerName}.`,
    '',
    `YOUR GOAL: ${goal}`,
    '',
    `BACKGROUND YOU KNOW:`,
    `- Service address: ${serviceAddress}`,
    `- Property owner (LLC): ${llcLegalName}`,
    authorizedCallerName ? `- Authorized representative on file: ${authorizedCallerName}` : `- You have written authorization from ${llcLegalName} to make account changes`,
    tenantName ? `- Tenant involved: ${tenantName}` : '',
    `- Effective date: ${effectiveDate}`,
    `- Utility type: ${utilityType}`,
    '',
    authLine,
    '',
    'CONVERSATION FLOW:',
    '',
    '1) Opening: The system has already delivered your opening line. After the rep responds, state the reason for your call clearly. If you get an IVR first, navigate it using DTMF — common paths are "press 1 for existing customer", "press 2 for account changes", "press 0 for operator".',
    '',
    '2) Once you reach a human rep: introduce yourself, name the property, and state the goal in one or two sentences. Example: "Hi, I\'m calling on behalf of ' + llcLegalName + '. We need to ' + (action === 'transfer_to_llc' ? 'transfer ' + utilityType + ' service at ' + serviceAddress + ' into the LLC\'s name effective ' + effectiveDate : 'verify the current account holder for ' + utilityType + ' service at ' + serviceAddress) + '."',
    '',
    '3) Listen carefully to what the rep asks. Provide the background info above as they ask for it. Do NOT invent any information you were not given. If they ask for something you don\'t have (SSN, payment info, account PIN), politely say you don\'t have that on file and ask what alternative they can accept.',
    '',
    '4) Stay on task. If the rep tries to upsell products or services, politely decline and redirect.',
    '',
    '5) HOLD HANDLING: If the rep says "please hold" or you get put in a queue, wait quietly. If the hold exceeds 5 minutes of total silence, politely end the call and record the outcome as "hold_timeout".',
    '',
    '6) CLOSED HANDLING: If the IVR or rep says the office is closed, note the reopening time mentioned and end the call. Record outcome "closed" and set callback_at to the ISO timestamp of when they open.',
    '',
    '7) VOICEMAIL: If you reach voicemail, leave a brief 20-second professional message: who you are, what LLC you represent, the purpose of the call, and ask them to call back. Record outcome "voicemail" and end the call.',
    '',
    '8) SUCCESS: When you have completed the goal (confirmed the account state, or successfully transferred/opened an account), thank the rep and say goodbye. Use the endCall tool to hang up. Record outcome "success". If a new account number or confirmation number was provided, capture it.',
    '',
    `9) Expected outcomes: the normal result for this call is ${expectedOutcome}.`,
    '',
    'STYLE:',
    '- Speak as a real human representative would. Do NOT mention being an AI, a bot, an assistant, automated, or a program. Never say "I am an AI" unless the rep directly asks whether you\'re an AI — in which case answer honestly that you\'re an AI assistant authorized to handle this call on behalf of the property manager.',
    '- Be warm, polite, patient, and professional. Utility reps are often dealing with difficult calls.',
    '- Keep each of your turns SHORT — 1 to 3 sentences. This is a phone call, not an essay.',
    '- Use the property manager\'s preferred name for the LLC exactly: "' + llcLegalName + '".',
    '- If the rep disputes amounts, dates, or facts, do NOT argue. Acknowledge their concern and say you will have someone from the team follow up.',
    '',
    'AT END OF CALL: use the outcomeReport tool (or structured output if instructed) to emit the final outcome JSON. This is CRITICAL — the workflow engine reads this to decide what to do next.',
  ].filter(Boolean).join('\n');
}

// Build the Vapi /call/phone request body.
function buildCallPayload(ctx, options) {
  const {
    phoneNumberId,
    assistantId,
    providerPhoneE164,
    recipientNameForDisplay,
    systemPrompt,
  } = options;

  const firstMessage = `Hi, this is ${ctx.callerName} from ${ctx.companyName} calling about a utility account.`;

  const endCallPhrases = [
    'goodbye',
    'good bye',
    'bye',
    'take care',
    'have a good day',
    'have a great day',
    'thank you bye',
    'talk later',
    'gotta go',
    'appreciate it bye',
  ];
  const endCallMessage = `Thank you for your time. Have a great day. Goodbye.`;

  const modelConfig = {
    provider: 'anthropic',
    model: process.env.VAPI_CALL_MODEL || 'claude-sonnet-4-5-20250929',
    messages: [{ role: 'system', content: systemPrompt }],
    tools: [{ type: 'endCall' }],
    maxTokens: 300,
    temperature: 0.7,
  };

  // Analysis config instructs Vapi to extract structured data from the
  // transcript at end-of-call and include it in endOfCallReport.
  // The webhook handler reads message.analysis.structuredData to
  // decide what to do next.
  const structuredDataSchema = {
    type: 'object',
    properties: {
      outcome: {
        type: 'string',
        enum: ['success', 'closed', 'hold_timeout', 'voicemail', 'needs_human', 'failed'],
        description: 'Final outcome of the call.',
      },
      callback_at: {
        type: 'string',
        description: 'ISO 8601 timestamp for when to call back if the office was closed. Null otherwise.',
      },
      new_account_number: {
        type: 'string',
        description: 'New utility account number if one was created during the call. Null otherwise.',
      },
      confirmation_number: {
        type: 'string',
        description: 'Confirmation number the rep provided at the end of a successful transaction. Null otherwise.',
      },
      notes: {
        type: 'string',
        description: 'Free-text notes about what happened on the call, for human review.',
      },
    },
    required: ['outcome', 'notes'],
  };

  const analysisPlan = {
    structuredDataPlan: {
      enabled: true,
      schema: structuredDataSchema,
    },
    summaryPlan: {
      enabled: true,
    },
    successEvaluationPlan: {
      enabled: true,
      rubric: 'PassFail',
    },
  };

  const basePayload = {
    phoneNumberId,
    customer: { number: providerPhoneE164, name: recipientNameForDisplay || 'Utility Rep' },
  };

  if (assistantId) {
    return {
      ...basePayload,
      assistantId,
      assistantOverrides: {
        firstMessage,
        firstMessageMode: 'assistant-waits-for-user',
        endCallMessage,
        endCallPhrases,
        model: modelConfig,
        analysisPlan,
      },
    };
  }

  // No assistant ID — build an inline assistant. Requires voice config.
  const voiceId = process.env.ELEVENLABS_VOICE_ID || 'rachel';
  return {
    ...basePayload,
    assistant: {
      name: 'Breeze Utility Caller',
      firstMessage,
      firstMessageMode: 'assistant-waits-for-user',
      endCallMessage,
      endCallPhrases,
      model: modelConfig,
      voice: {
        provider: 'elevenlabs',
        voiceId,
      },
      analysisPlan,
    },
  };
}

// ── Main entry point ─────────────────────────────────────────────

/**
 * Place a utility-workflow Vapi call.
 *
 * @param {object} ctx
 * @param {string} ctx.action                - 'verify_off_llc' | 'transfer_to_llc' | 'verify_on_llc'
 * @param {string} ctx.utilityType           - 'electric' | 'gas' | ...
 * @param {string} ctx.providerName          - 'Columbia Gas of Ohio'
 * @param {string} ctx.providerPhoneE164     - '+18003440573'
 * @param {string} ctx.llcLegalName          - 'SLM Toledo Investments LLC'
 * @param {string} [ctx.authorizedCallerName]
 * @param {string} ctx.serviceAddress        - '105 Southard Ave, Toledo, OH 43604'
 * @param {string} [ctx.tenantName]
 * @param {string} ctx.effectiveDate         - 'May 1, 2026'
 * @returns {Promise<{ok, vapiCallId?, systemPrompt, error?}>}
 */
export async function placeUtilityCall(ctx) {
  const vapiKey = process.env.VAPI_API_KEY;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  const assistantId = process.env.VAPI_ASSISTANT_ID;

  if (!vapiKey) {
    return { ok: false, error: 'VAPI_API_KEY is not configured.' };
  }
  if (!phoneNumberId) {
    return { ok: false, error: 'VAPI_PHONE_NUMBER_ID is not configured.' };
  }
  if (!ctx.providerPhoneE164) {
    return { ok: false, error: 'Provider phone number is missing — seed utility_providers first.' };
  }

  const callerName = process.env.BREEZE_CALLER_NAME || 'Alex';
  const companyName = process.env.BREEZE_COMPANY_NAME || 'Breeze Property Group';
  const fullCtx = { ...ctx, callerName, companyName };

  const systemPrompt = buildSystemPrompt(fullCtx);
  const payload = buildCallPayload(fullCtx, {
    phoneNumberId,
    assistantId,
    providerPhoneE164: ctx.providerPhoneE164,
    recipientNameForDisplay: ctx.providerName,
    systemPrompt,
  });

  try {
    console.log('[vapiCaller] POST /call/phone', JSON.stringify({
      action: ctx.action,
      utilityType: ctx.utilityType,
      providerName: ctx.providerName,
      serviceAddress: ctx.serviceAddress,
      llcLegalName: ctx.llcLegalName,
      usingAssistantId: !!assistantId,
    }));
    const res = await fetch('https://api.vapi.ai/call/phone', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${vapiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[vapiCaller] Vapi ${res.status}:`, errText);
      return {
        ok: false,
        error: `Vapi call failed (HTTP ${res.status}): ${errText.slice(0, 600)}`,
        systemPrompt,
      };
    }
    const data = await res.json();
    console.log(`[vapiCaller] call queued: ${data.id}`);
    return {
      ok: true,
      vapiCallId: data.id,
      systemPrompt,
    };
  } catch (err) {
    console.error('[vapiCaller] fetch failed:', err);
    return {
      ok: false,
      error: `Vapi request failed: ${err.message}`,
      systemPrompt,
    };
  }
}

// Exported for tests and for the webhook handler's reverse lookup.
export { buildSystemPrompt, buildCallPayload };
