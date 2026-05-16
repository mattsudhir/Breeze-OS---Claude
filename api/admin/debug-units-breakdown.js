// GET /api/admin/debug-units-breakdown?secret=<TOKEN>
//
// Compares AppFolio's /units result against what's in our DB. Tells
// us at a glance whether NonRevenue is being filtered correctly and
// whether any AppFolio units are missing from our directory (or vice
// versa).
//
// Read-only. Safe to run anytime.
//
// Response:
//   {
//     ok: true,
//     appfolio: { total, non_revenue, rentable, missing_field },
//     local:   { total },
//     diff:    { local_minus_appfolio_rentable, ids_in_local_only, ids_in_appfolio_only }
//   }

import { eq } from 'drizzle-orm';
import { withAdminHandler, getDefaultOrgId } from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import { fetchAllPages } from '../../lib/backends/appfolio.js';

export const config = { maxDuration: 60 };

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'GET or POST only' });
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  // AppFolio side.
  const af = await fetchAllPages('/units', {});
  if (af.error) {
    return res.status(502).json({ ok: false, error: `AppFolio /units: ${af.error}` });
  }
  const afUnits = af.data || [];
  let nonRevenue = 0, rentable = 0, missingField = 0;
  const afIds = new Set();
  const nrSamples = [];
  for (const u of afUnits) {
    const id = String(u.Id || u.id || '');
    if (id) afIds.add(id);
    if (u.NonRevenue === true) {
      nonRevenue += 1;
      if (nrSamples.length < 5) {
        nrSamples.push({ id, name: u.Name || u.UnitNumber || u.Address1 || null });
      }
    } else if (u.NonRevenue === false) {
      rentable += 1;
    } else {
      missingField += 1; // unexpected — neither true nor false
    }
  }

  // Local side.
  const localUnits = await db
    .select({ id: schema.units.id, sourceUnitId: schema.units.sourceUnitId, sourceUnitName: schema.units.sourceUnitName })
    .from(schema.units)
    .where(eq(schema.units.organizationId, organizationId));
  const localIds = new Set(localUnits.map((u) => String(u.sourceUnitId || '')).filter(Boolean));

  // Diff. Only meaningful subset (we don't show 600+ ids).
  const localOnly = [...localIds].filter((id) => !afIds.has(id)).slice(0, 20);
  const appfolioOnly = [...afIds].filter((id) => !localIds.has(id)).slice(0, 20);
  // Local rows with NULL source_unit_id (shouldn't exist after a clean reimport).
  const localNoSourceId = localUnits.filter((u) => !u.sourceUnitId).slice(0, 20).map((u) => ({
    id: u.id, name: u.sourceUnitName,
  }));

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    appfolio: {
      total: afUnits.length,
      non_revenue: nonRevenue,
      rentable,
      missing_field: missingField,
      non_revenue_samples: nrSamples,
    },
    local: {
      total: localUnits.length,
      with_source_unit_id: localIds.size,
      without_source_unit_id: localUnits.length - localIds.size,
      without_source_unit_id_samples: localNoSourceId,
    },
    diff: {
      local_count_minus_appfolio_rentable: localUnits.length - rentable,
      sample_local_only_source_ids: localOnly,
      sample_appfolio_only_source_ids: appfolioOnly,
    },
  });
});
