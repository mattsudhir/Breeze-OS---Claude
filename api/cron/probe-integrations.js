// Cron entry point that calls the admin probe-integrations handler.
// Schedule: every 4 hours (see vercel.json).
//
// Auth bypass: Vercel sets a `vercel-cron: 1` header on cron-invoked
// requests; admin probe handler checks the same admin token rules as
// every other admin endpoint, so we wrap rather than re-implement.

import probe from '../admin/probe-integrations.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  // Pretend to be a POST so probe-integrations runs (it accepts GET
  // too, but matching POST keeps semantics consistent).
  req.method = 'POST';
  // Inject admin token from env so the admin handler authorises us.
  const token = process.env.BREEZE_ADMIN_TOKEN || '';
  req.query = { ...(req.query || {}), secret: token };
  return probe(req, res);
}
