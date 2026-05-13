// GET /api/admin/list-integration-health?secret=<TOKEN>
//
// Returns every integration's last known health. Powers the topbar
// status dot + popover.

import { withAdminHandler, getDefaultOrgId } from '../../lib/adminHelpers.js';
import { getAllHealth } from '../../lib/integrationHealth.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'GET only' });
  }
  const organizationId = await getDefaultOrgId();
  const rows = await getAllHealth(organizationId);

  const integrations = rows.map((r) => ({
    name: r.name,
    display_name: r.displayName,
    status: r.status,
    last_success_at: r.lastSuccessAt,
    last_failure_at: r.lastFailureAt,
    last_error_message: r.lastErrorMessage,
    last_probe_at: r.lastProbeAt,
    consecutive_failures: r.consecutiveFailures,
    consecutive_successes: r.consecutiveSuccesses,
  }));

  const overall = integrations.some((i) => i.status === 'down')
    ? 'down'
    : integrations.some((i) => i.status === 'degraded')
      ? 'degraded'
      : integrations.length === 0
        ? 'unknown'
        : 'ok';

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    overall_status: overall,
    integrations,
  });
});
