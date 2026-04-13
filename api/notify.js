// Vercel Serverless Function — programmatic "Notify by Cliq" endpoint.
//
// This is the non-LLM counterpart to the `notify_team` chat tool. Anything
// in the app that needs to post a message into the team Zoho Cliq channel
// — a React component firing on a "Request Breeze OS" click, a background
// job pushing a status update, etc. — can POST here with either:
//
//   { text: "raw pre-formatted string" }
//
// or the structured shape that mirrors the chat tool:
//
//   { recipient: "the team", message: "...", context: "WO-57" }
//
// The endpoint formats the message (if structured) and forwards it through
// the shared lib/cliqNotify helper, so the wire format stays identical to
// what the chat tool produces.
//
// Environment variables:
//   ZOHO_CLIQ_WEBHOOK_URL – same webhook the notify_team tool uses.

import { postToCliq } from '../lib/cliqNotify.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const body = req.body || {};
  const { text, recipient, message, context } = body;

  // Require SOMETHING to send. Either raw text or a structured message.
  if (!text && !message) {
    return res
      .status(400)
      .json({ error: 'notify requires either a `text` or `message` field' });
  }

  const result = await postToCliq({ text, recipient, message, context });
  if (result.error) {
    // The helper never throws — it returns { error }. Surface it as 500
    // for config problems and 502 for webhook delivery failures so the
    // caller can distinguish.
    const status = /not configured|required/i.test(result.error) ? 500 : 502;
    return res.status(status).json(result);
  }
  return res.status(200).json(result);
}
