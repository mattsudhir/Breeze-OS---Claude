// Property Directory — the first UI built on top of the new Postgres
// backend. Lets you manage Owners (LLCs), Properties, and Utility
// Providers, and see per-property utility configuration.
//
// This is deliberately a minimum-viable admin panel. No fancy state
// management, no react-query, no router, no modal system — just
// useState + fetch + tabs. Once Clerk + a proper shell land in a later
// PR, we can upgrade the primitives.

import { useEffect, useState, useCallback } from 'react';
import { Building2, Users, Zap, Database, RefreshCw, Plus, Trash2, Upload, Settings2, Grid3x3, Link2, UserPlus, Stethoscope, CheckCircle2, AlertCircle, AlertTriangle } from 'lucide-react';
import {
  owners as ownersApi,
  properties as propertiesApi,
  propertyUtilities as propertyUtilitiesApi,
  utilityProviders as providersApi,
  seed as seedApi,
  assignProvidersByCity as assignProvidersByCityApi,
  bulkImport as bulkImportApi,
  bulkUtilityConfig as bulkUtilityConfigApi,
  gridImport as gridImportApi,
  backfillUnitIds as backfillUnitIdsApi,
  appfolioDiagnostics as diagApi,
  getAdminToken,
  setAdminToken,
  hasAdminToken,
} from '../lib/admin';
import { parseTSV } from '../lib/tsvImport';

const UTILITY_TYPES = ['electric', 'gas', 'water', 'sewer', 'trash', 'internet', 'cable'];
// Display labels for account_holder enum values. 'none' means
// "this utility isn't supplied at the property at all" — distinct
// from "not yet configured" (no row) and "LLC-held" (we pay).
const ACCOUNT_HOLDER_OPTIONS = [
  { value: 'tenant', label: 'tenant (responsibility is theirs)' },
  { value: 'owner_llc', label: 'owner_llc (we hold the account)' },
  { value: 'none', label: 'none (utility not supplied here — N/A)' },
];
const ACCOUNT_HOLDERS = ACCOUNT_HOLDER_OPTIONS.map((o) => o.value);
const PROPERTY_TYPES = ['sfr', 'multi_family', 'commercial', 'mixed'];
const US_STATES = ['OH', 'MI', 'IN', 'KY', 'PA', 'WV', 'IL'];

// ── Shared token-gate wrapper ────────────────────────────────────

function TokenGate({ children, onTokenSet }) {
  const [value, setValue] = useState(getAdminToken());
  if (hasAdminToken()) return children;
  return (
    <div style={{ padding: 24, maxWidth: 520 }}>
      <h2>Admin token required</h2>
      <p style={{ color: '#666' }}>
        Paste your <code>BREEZE_ADMIN_TOKEN</code> to access the property directory.
        It will be stored in <code>localStorage</code> on this device only.
      </p>
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="bzadmin_..."
        style={{
          width: '100%',
          padding: 10,
          fontSize: 14,
          border: '1px solid #ccc',
          borderRadius: 6,
        }}
      />
      <button
        type="button"
        onClick={() => {
          setAdminToken(value.trim());
          if (onTokenSet) onTokenSet();
          window.location.reload();
        }}
        disabled={!value.trim()}
        style={{
          marginTop: 12,
          padding: '8px 16px',
          background: '#1565C0',
          color: 'white',
          border: 'none',
          borderRadius: 6,
          cursor: value.trim() ? 'pointer' : 'not-allowed',
          fontSize: 14,
        }}
      >
        Save token
      </button>
    </div>
  );
}

// ── Page shell with tabs ─────────────────────────────────────────

export default function PropertyDirectoryPage() {
  const [tab, setTab] = useState('owners');
  const [, force] = useState(0);
  const refresh = useCallback(() => force((n) => n + 1), []);

  return (
    <TokenGate onTokenSet={refresh}>
      <div style={{ padding: 24, maxWidth: 1100 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <Database size={24} />
          <h1 style={{ margin: 0 }}>Property Directory</h1>
          <span style={{ color: '#888', fontSize: 14 }}>
            — Owners, Properties, Utility Providers
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 24, borderBottom: '1px solid #eee', flexWrap: 'wrap' }}>
          {[
            { id: 'owners', label: 'Owners (LLCs)', icon: Users },
            { id: 'properties', label: 'Properties', icon: Building2 },
            { id: 'providers', label: 'Utility Providers', icon: Zap },
            { id: 'import', label: 'Bulk Import', icon: Upload },
            { id: 'bulkConfig', label: 'Bulk Config', icon: Settings2 },
            { id: 'gridImport', label: 'Grid Import', icon: Grid3x3 },
            { id: 'backfill', label: 'Backfill Unit IDs', icon: Link2 },
            { id: 'syncLeases', label: 'Sync Leases (AppFolio)', icon: UserPlus },
            { id: 'diagnostics', label: 'AppFolio Diagnostics', icon: Stethoscope },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              style={{
                padding: '10px 16px',
                background: 'none',
                border: 'none',
                borderBottom: tab === id ? '2px solid #1565C0' : '2px solid transparent',
                color: tab === id ? '#1565C0' : '#666',
                fontSize: 14,
                fontWeight: tab === id ? 600 : 400,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </div>

        {tab === 'owners' && <OwnersTab />}
        {tab === 'properties' && <PropertiesTab />}
        {tab === 'providers' && <ProvidersTab />}
        {tab === 'import' && <BulkImportTab />}
        {tab === 'bulkConfig' && <BulkConfigTab />}
        {tab === 'gridImport' && <GridImportTab />}
        {tab === 'backfill' && <BackfillUnitIdsTab />}
        {tab === 'syncLeases' && <SyncAppfolioLeasesTab />}
        {tab === 'diagnostics' && <AppfolioDiagnosticsTab />}
      </div>
    </TokenGate>
  );
}

// ── AppFolio Diagnostics tab ─────────────────────────────────────
//
// One-tap buttons for everything we'd otherwise be pasting URLs for:
// auth check, property-id backfill (preview + apply), leases-state
// snapshot. Results render inline — no JSON reading, no screenshots.

function DiagButton({ label, hint, onClick, running, accent = '#1565C0' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={running}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        padding: '12px 14px', marginBottom: 8,
        background: running ? '#f0f0f0' : 'white',
        border: `1px solid ${accent}`, borderRadius: 8,
        cursor: running ? 'wait' : 'pointer',
      }}
    >
      <div style={{ fontWeight: 600, color: accent, fontSize: 14 }}>
        {running ? 'Running…' : label}
      </div>
      {hint && <div style={{ fontSize: 12, color: '#777', marginTop: 2 }}>{hint}</div>}
    </button>
  );
}

function ResultBlock({ result }) {
  if (!result) return null;
  const { kind, data, error } = result;
  if (error) {
    return (
      <div style={{
        padding: 12, background: '#FFEBEE', border: '1px solid #FFCDD2',
        borderRadius: 8, color: '#C62828', fontSize: 13, marginBottom: 12,
      }}>
        <AlertCircle size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
        {error}
      </div>
    );
  }

  // Auth-check rendering
  if (kind === 'auth') {
    const statuses = data.repeat_probe_statuses || [];
    const allOk = statuses.length > 0 && statuses.every((s) => s === 200);
    const anyOk = statuses.includes(200);
    const Icon = allOk ? CheckCircle2 : anyOk ? AlertTriangle : AlertCircle;
    const color = allOk ? '#2E7D32' : anyOk ? '#EF6C00' : '#C62828';
    return (
      <div style={{
        padding: 12, background: '#FAFAFA', border: `1px solid ${color}`,
        borderRadius: 8, marginBottom: 12, fontSize: 13,
      }}>
        <div style={{ fontWeight: 600, color, marginBottom: 6 }}>
          <Icon size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
          {allOk ? 'AppFolio auth healthy' : anyOk ? 'AppFolio auth INTERMITTENT' : 'AppFolio auth failing'}
        </div>
        <div style={{ color: '#555' }}>
          5 back-to-back probes: <strong>{JSON.stringify(statuses)}</strong>
        </div>
        {data.intermittent && (
          <div style={{ marginTop: 6, color: '#EF6C00' }}>
            Mixed results = the secret is valid but something (IP allowlist on the
            AppFolio credential, or rate-limiting) is rejecting some calls. Check
            AppFolio Developer Space for an &quot;Allowed IPs&quot; setting on the
            breezepg credential.
          </div>
        )}
        {(data.hints || []).map((h, i) => (
          <div key={i} style={{ marginTop: 6, color: '#555' }}>• {h}</div>
        ))}
      </div>
    );
  }

  // Backfill rendering
  if (kind === 'backfill') {
    return (
      <div style={{
        padding: 12, background: '#FAFAFA', border: '1px solid #1565C0',
        borderRadius: 8, marginBottom: 12, fontSize: 13,
      }}>
        <div style={{ fontWeight: 600, color: '#1565C0', marginBottom: 6 }}>
          {data.dry_run ? 'Backfill preview (no changes written)' : 'Backfill applied'}
        </div>
        <table style={{ fontSize: 13, borderSpacing: '0 2px' }}>
          <tbody>
            <tr><td style={{ paddingRight: 12, color: '#777' }}>AppFolio properties</td><td>{data.appfolio_properties_returned}</td></tr>
            <tr><td style={{ paddingRight: 12, color: '#777' }}>Our properties</td><td>{data.our_properties_total}</td></tr>
            <tr><td style={{ paddingRight: 12, color: '#777' }}>Matched</td><td>{data.matches_count}</td></tr>
            <tr><td style={{ paddingRight: 12, color: '#777' }}>Will update / already correct</td><td>{data.matches_will_update_count} / {data.matches_already_correct_count}</td></tr>
            <tr><td style={{ paddingRight: 12, color: '#777' }}>AppFolio unmatched</td><td>{data.appfolio_unmatched_count}</td></tr>
            <tr><td style={{ paddingRight: 12, color: '#777' }}>Our DB unmatched</td><td>{data.our_db_unmatched_count}</td></tr>
            {!data.dry_run && <tr><td style={{ paddingRight: 12, color: '#777' }}><strong>Updated</strong></td><td><strong>{data.updated}</strong></td></tr>}
            {data.conflicts > 0 && <tr><td style={{ paddingRight: 12, color: '#C62828' }}>Conflicts</td><td style={{ color: '#C62828' }}>{data.conflicts}</td></tr>}
          </tbody>
        </table>
        {data.next_step && (
          <div style={{ marginTop: 8, color: '#555', fontStyle: 'italic' }}>{data.next_step}</div>
        )}
      </div>
    );
  }

  // Leases-state rendering
  if (kind === 'leases') {
    const c = data.counts || {};
    return (
      <div style={{
        padding: 12, background: '#FAFAFA', border: '1px solid #1565C0',
        borderRadius: 8, marginBottom: 12, fontSize: 13,
      }}>
        <div style={{ fontWeight: 600, color: '#1565C0', marginBottom: 6 }}>
          Leases / units state
        </div>
        <table style={{ fontSize: 13, borderSpacing: '0 2px' }}>
          <tbody>
            <tr><td style={{ paddingRight: 12, color: '#777' }}>Properties (with source id)</td><td>{c.properties_total} ({c.properties_with_source_id})</td></tr>
            <tr><td style={{ paddingRight: 12, color: '#777' }}>Units (with source_unit_id)</td><td>{c.units_total} ({c.units_with_source_unit_id})</td></tr>
            <tr><td style={{ paddingRight: 12, color: '#777' }}>Leases total / active</td><td>{c.leases_total} / {c.leases_active}</td></tr>
            <tr><td style={{ paddingRight: 12, color: '#777' }}>Tenants total</td><td>{c.tenants_total}</td></tr>
            <tr><td style={{ paddingRight: 12, color: '#777' }}>Lease-tenant links</td><td>{c.lease_tenants_total}</td></tr>
          </tbody>
        </table>
      </div>
    );
  }

  // Single-property smoke-test rendering
  if (kind === 'smoke') {
    const af = data.appfolio || {};
    const t = data.timings || {};
    return (
      <div style={{
        padding: 12, background: '#FAFAFA', border: '1px solid #1565C0',
        borderRadius: 8, marginBottom: 12, fontSize: 13,
      }}>
        <div style={{ fontWeight: 600, color: '#1565C0', marginBottom: 6 }}>
          Single-property smoke test
        </div>
        <table style={{ fontSize: 13, borderSpacing: '0 2px' }}>
          <tbody>
            <tr><td style={{ paddingRight: 12, color: '#777' }}>Property</td><td>{data.property?.display_name}</td></tr>
            <tr><td style={{ paddingRight: 12, color: '#777' }}>/units call</td><td>{t.units_ms} ms → {af.units_returned} units</td></tr>
            <tr><td style={{ paddingRight: 12, color: '#777' }}>/tenants call</td><td>{t.tenants_ms} ms → {af.tenants_returned} tenants ({af.active_tenants} active)</td></tr>
          </tbody>
        </table>
        {data.hint && (
          <div style={{ marginTop: 8, color: '#555', fontStyle: 'italic' }}>{data.hint}</div>
        )}
        <div style={{ marginTop: 8, fontSize: 11, color: '#999' }}>
          Multiply (units_ms + tenants_ms) by ~252 to estimate a full sync.
        </div>
      </div>
    );
  }

  return (
    <pre style={{
      padding: 12, background: '#1e1e1e', color: '#d4d4d4', borderRadius: 8,
      fontSize: 11, overflowX: 'auto', marginBottom: 12,
    }}>{JSON.stringify(data, null, 2)}</pre>
  );
}

function AppfolioDiagnosticsTab() {
  const [running, setRunning] = useState(null);
  const [result, setResult] = useState(null);

  const run = async (key, kind, fn, confirmMsg) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setRunning(key);
    setResult(null);
    try {
      const data = await fn();
      if (data.ok === false) {
        setResult({ kind, error: data.error || 'Request failed' });
      } else {
        setResult({ kind, data });
      }
    } catch (err) {
      setResult({ kind, error: err.message || String(err) });
    } finally {
      setRunning(null);
    }
  };

  return (
    <div style={{ maxWidth: 640 }}>
      <p style={{ color: '#666', fontSize: 14, marginTop: 0 }}>
        One-tap AppFolio diagnostics. No URL pasting, no JSON reading — results
        render below each button.
      </p>

      <ResultBlock result={result} />

      <DiagButton
        label="1. Check AppFolio auth"
        hint="Fires 5 back-to-back probes. Tells you if the credential is healthy, dead, or intermittently rejected."
        running={running === 'auth'}
        onClick={() => run('auth', 'auth', diagApi.checkAuth)}
      />
      <DiagButton
        label="2. Backfill property IDs — preview"
        hint="Matches our properties to AppFolio's by address/name. Shows the plan; writes nothing."
        running={running === 'backfillDry'}
        onClick={() => run('backfillDry', 'backfill', diagApi.backfillPropertyIdsDryRun)}
      />
      <DiagButton
        label="3. Backfill property IDs — APPLY"
        hint="Writes the corrected source_property_id values. Run the preview first."
        accent="#C62828"
        running={running === 'backfillApply'}
        onClick={() => run(
          'backfillApply', 'backfill', diagApi.backfillPropertyIdsApply,
          'Apply property-ID backfill? This writes source_property_id on matched properties.',
        )}
      />
      <DiagButton
        label="4. Leases / units state snapshot"
        hint="Counts of properties, units, leases, tenants — to verify a sync actually landed."
        running={running === 'leases'}
        onClick={() => run('leases', 'leases', diagApi.leasesState)}
      />
      <DiagButton
        label="5. Smoke-test: sync ONE property"
        hint="Pulls /units + /tenants for a single property and reports per-call timings. Fast — use this to diagnose why the full Sync Leases hangs."
        accent="#6A1B9A"
        running={running === 'smoke'}
        onClick={() => run('smoke', 'smoke', () => diagApi.syncOneProperty({}))}
      />
    </div>
  );
}

// ── Sync AppFolio Leases tab ─────────────────────────────────────
//
// Loops /api/admin/sync-appfolio-leases-all in batches of 25 until
// has_more=false. Live progress shown as bar + per-batch summary.
// Use after bulk-importing properties + units to populate tenants +
// active leases from AppFolio's /tenants endpoint.

function SyncAppfolioLeasesTab() {
  const [running, setRunning] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [progress, setProgress] = useState({ processed: 0, total: 0 });
  const [totals, setTotals] = useState({ tenants: 0, leases: 0, skipped: 0, backfilled: 0 });
  const [errors, setErrors] = useState([]);
  const [lastError, setLastError] = useState(null);
  const [batchSize, setBatchSize] = useState(25);

  const run = async () => {
    setRunning(true);
    setStopped(false);
    setErrors([]);
    setLastError(null);
    setTotals({ tenants: 0, leases: 0, skipped: 0, backfilled: 0 });
    setProgress({ processed: 0, total: 0 });

    let offset = 0;
    let total = 0;
    let totalTenants = 0;
    let totalLeases = 0;
    let totalSkipped = 0;
    let totalBackfilled = 0;
    const seenErrors = [];

    try {
      while (true) {
        const url = new URL('/api/admin/sync-appfolio-leases-all', window.location.origin);
        url.searchParams.set('secret', getAdminToken());
        const res = await fetch(url.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: batchSize, offset }),
        });
        const json = await res.json();
        if (!res.ok && !json.aborted) {
          throw new Error(json.error || `HTTP ${res.status}`);
        }
        total = json.total_properties;
        offset = json.next_offset;
        totalTenants += json.totals?.tenants_upserted || 0;
        totalLeases += json.totals?.leases_upserted || 0;
        totalSkipped += json.totals?.leases_skipped_no_unit || 0;
        totalBackfilled += json.totals?.unit_ids_backfilled || 0;
        for (const r of json.results || []) {
          if (r.error) seenErrors.push({ name: r.display_name, error: r.error });
        }
        setProgress({ processed: offset, total });
        setTotals({ tenants: totalTenants, leases: totalLeases, skipped: totalSkipped, backfilled: totalBackfilled });
        setErrors([...seenErrors]);

        if (json.aborted) {
          setLastError(json.abort_reason || 'Sync aborted by circuit breaker.');
          break;
        }
        if (!json.has_more) break;
      }
    } catch (err) {
      setLastError(err.message || String(err));
    } finally {
      setRunning(false);
      setStopped(true);
    }
  };

  const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;

  return (
    <div>
      <div style={{
        marginBottom: 16, padding: 12, background: '#f0f9ff',
        border: '1px solid #bae6fd', borderRadius: 8, fontSize: 13, color: '#0c4a6e',
      }}>
        <strong>Sync active leases from AppFolio.</strong><br />
        Loops every property with <code>source_pms='appfolio'</code> and a
        non-null <code>source_property_id</code>. For each, pulls
        <code> /tenants?property_id=&lt;id&gt;</code>, filters to active leases
        (end date null or ≥ today), and upserts tenants + leases + lease-tenant
        links in our DB. Idempotent — safe to re-run.
        <br /><br />
        Requires <code>APPFOLIO_*</code> env vars to be set in Vercel.
        Properties must already exist (import via Bulk Import / Grid Import first).
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <label style={{ fontSize: 13, color: '#555' }}>
          Batch size:{' '}
          <input
            type="number"
            min={1}
            max={100}
            value={batchSize}
            disabled={running}
            onChange={(e) => setBatchSize(Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 25)))}
            style={{ width: 70, padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 13 }}
          />
        </label>
        <button type="button" onClick={run} disabled={running} style={primaryButtonStyle}>
          {running ? `Syncing… ${progress.processed}/${progress.total}` : 'Start sync'}
        </button>
      </div>

      {(running || stopped) && progress.total > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{
            height: 8, background: '#e5e7eb', borderRadius: 4, overflow: 'hidden', marginBottom: 6,
          }}>
            <div style={{
              height: '100%', width: `${pct}%`, background: '#1565C0',
              transition: 'width 0.3s ease',
            }} />
          </div>
          <div style={{ fontSize: 12, color: '#666' }}>
            {progress.processed} / {progress.total} properties processed ({pct}%)
            {' · '}
            <strong>{totals.tenants}</strong> tenants upserted
            {' · '}
            <strong>{totals.leases}</strong> leases upserted
            {totals.backfilled > 0 && <>{' · '}<strong>{totals.backfilled}</strong> unit IDs backfilled</>}
            {totals.skipped > 0 && <>{' · '}<strong>{totals.skipped}</strong> skipped (unit not in DB)</>}
          </div>
        </div>
      )}

      {lastError && <ErrorBox message={lastError} />}

      {stopped && !lastError && progress.processed >= progress.total && progress.total > 0 && (
        <div style={{
          padding: 16, background: '#f0fdf4', border: '1px solid #bbf7d0',
          borderRadius: 8, color: '#166534',
        }}>
          <strong>Sync complete.</strong> Refresh the Properties page to see updated occupancy.
        </div>
      )}

      {errors.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: '#b91c1c' }}>
            {errors.length} property error{errors.length === 1 ? '' : 's'}
          </summary>
          <pre style={{
            fontSize: 11, maxHeight: 300, overflow: 'auto', background: '#fff',
            padding: 8, borderRadius: 4, border: '1px solid #fecaca', marginTop: 8,
          }}>
            {JSON.stringify(errors, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

// ── Grid Import tab ──────────────────────────────────────────────

function GridImportTab() {
  const [tsv, setTsv] = useState('');
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const handlePreview = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    const res = await gridImportApi.preview(tsv);
    setBusy(false);
    if (!res.ok) return setError(res.error + (res.parseErrors ? ' — see parse errors' : ''));
    setPreview(res);
  };

  const handleCommit = async () => {
    if (!preview) return;
    if (
      !confirm(
        `Apply ${preview.plannedCount} utility upserts to the DB? ` +
          'This will insert new property_utilities rows where missing and update existing rows in place.',
      )
    ) {
      return;
    }
    setBusy(true);
    const res = await gridImportApi.commit(tsv);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setResult(res);
    setPreview(null);
  };

  const handleReset = () => {
    setTsv('');
    setPreview(null);
    setResult(null);
    setError(null);
  };

  return (
    <div>
      <div style={{ marginBottom: 16, padding: 12, background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, fontSize: 13, color: '#0c4a6e' }}>
        <strong>Grid Import — upsert utility config from a spreadsheet paste.</strong><br />
        Expected columns: <code>source_property_id</code>, optionally <code>unit_name</code>, then any of <code>electric</code>, <code>gas</code>, <code>water</code>, <code>sewer</code>, <code>trash</code> (values: <code>tenant</code>, <code>owner_llc</code>, <code>none</code>) and/or <code>electric_billback</code>, <code>gas_billback</code>, <code>water_billback</code>, <code>sewer_billback</code>, <code>trash_billback</code> (values: <code>y</code>, <code>n</code>).<br />
        Blank cells are <strong>ignored</strong> (don't change existing rows). Unit name blank means property-level default; unit name set means unit-level override. Reference columns (<code>display_name</code>, <code>city</code>, <code>state</code>, <code>zip</code>) are accepted but not written.
      </div>

      <textarea
        value={tsv}
        onChange={(e) => setTsv(e.target.value)}
        placeholder="Paste your wide-format utility grid here, including the header row…"
        rows={12}
        style={{
          width: '100%',
          padding: 10,
          fontFamily: 'monospace',
          fontSize: 12,
          border: '1px solid #d1d5db',
          borderRadius: 6,
          boxSizing: 'border-box',
          marginBottom: 12,
        }}
      />

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button type="button" onClick={handlePreview} disabled={!tsv.trim() || busy} style={primaryButtonStyle}>
          {busy ? 'Parsing…' : 'Preview'}
        </button>
        <button type="button" onClick={handleReset} style={smallButtonStyle}>
          Reset
        </button>
      </div>

      {error && <ErrorBox message={error} />}

      {preview && !result && (
        <div style={{ padding: 16, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>Preview: {preview.plannedCount} upserts planned</h3>
          {preview.planErrorCount > 0 && (
            <ErrorBox message={`${preview.planErrorCount} rows reference properties or units not in the DB — fix before commit`} />
          )}
          <div style={{ maxHeight: 240, overflow: 'auto', fontSize: 11, background: 'white', border: '1px solid #eee', borderRadius: 4 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead style={{ background: '#f3f4f6', position: 'sticky', top: 0 }}>
                <tr>
                  <th style={thStyle}>line</th>
                  <th style={thStyle}>property</th>
                  <th style={thStyle}>unit</th>
                  <th style={thStyle}>utility</th>
                  <th style={thStyle}>holder</th>
                  <th style={thStyle}>billback</th>
                </tr>
              </thead>
              <tbody>
                {preview.planPreview.map((p, i) => (
                  <tr key={i}>
                    <td style={tdStyle}>{p.lineNumber}</td>
                    <td style={tdStyle}>{p.propertyRowId?.slice(0, 8)}…</td>
                    <td style={tdStyle}>{p.unitRowId ? p.unitRowId.slice(0, 8) + '…' : '(prop)'}</td>
                    <td style={tdStyle}>{p.utilityType}</td>
                    <td style={tdStyle}>{p.accountHolder ?? '—'}</td>
                    <td style={tdStyle}>{p.billbackMode ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            onClick={handleCommit}
            disabled={busy || preview.planErrorCount > 0}
            style={{ ...primaryButtonStyle, background: '#15803d', marginTop: 12 }}
          >
            {busy ? 'Committing…' : `Commit ${preview.plannedCount} upserts`}
          </button>
        </div>
      )}

      {result && (
        <div style={{ padding: 16, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, color: '#166534' }}>
          <h3 style={{ marginTop: 0 }}>✅ Grid import complete</h3>
          <ul>
            <li><strong>{result.insertedCount}</strong> new utility rows inserted</li>
            <li><strong>{result.updatedCount}</strong> existing utility rows updated</li>
            <li><strong>{result.plannedCount}</strong> total upserts</li>
          </ul>
          <p style={{ fontSize: 12 }}>{result.message}</p>
        </div>
      )}
    </div>
  );
}

// ── Backfill Unit IDs tab ────────────────────────────────────────

function BackfillUnitIdsTab() {
  const [tsv, setTsv] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const handleRun = async () => {
    if (
      !confirm(
        'Run the Appfolio Unit ID backfill against the pasted mapping? ' +
          'This sets units.source_unit_id on every matched row. Safe to re-run.',
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    const res = await backfillUnitIdsApi.run(tsv);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setResult(res);
  };

  const handleReset = () => {
    setTsv('');
    setResult(null);
    setError(null);
  };

  return (
    <div>
      <div style={{ marginBottom: 16, padding: 12, background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, fontSize: 13, color: '#0c4a6e' }}>
        <strong>Backfill Unit IDs — populate the stable external ID on existing unit rows.</strong><br />
        Expected columns (tab-separated, optional header): <code>Property ID</code>, <code>Unit ID</code>, <code>Unit Name</code>. Parser matches on <code>(source_property_id, source_unit_name)</code> and sets <code>source_unit_id</code>. Rows that don't match an existing unit in the DB are reported as "not found" (expected for Common / blocked rows you deliberately excluded from the import).
      </div>

      <textarea
        value={tsv}
        onChange={(e) => setTsv(e.target.value)}
        placeholder="Paste the full Appfolio Unit ID mapping here (Property ID / Unit ID / Unit Name)…"
        rows={12}
        style={{
          width: '100%',
          padding: 10,
          fontFamily: 'monospace',
          fontSize: 12,
          border: '1px solid #d1d5db',
          borderRadius: 6,
          boxSizing: 'border-box',
          marginBottom: 12,
        }}
      />

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button type="button" onClick={handleRun} disabled={!tsv.trim() || busy} style={primaryButtonStyle}>
          {busy ? 'Running backfill…' : 'Run backfill'}
        </button>
        <button type="button" onClick={handleReset} style={smallButtonStyle}>
          Reset
        </button>
      </div>

      {error && <ErrorBox message={error} />}

      {result && (
        <div style={{ padding: 16, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, color: '#166534' }}>
          <h3 style={{ marginTop: 0 }}>✅ Backfill complete</h3>
          <ul>
            <li><strong>{result.dedupedRowCount}</strong> deduped rows in the input</li>
            <li><strong>{result.setCount}</strong> units had source_unit_id set</li>
            <li><strong>{result.alreadySetCount}</strong> units were already set correctly (no-op)</li>
            <li><strong>{result.notFoundCount}</strong> rows didn't match any unit in the DB</li>
            <li><strong>{result.parseErrorCount}</strong> parse errors</li>
          </ul>
          {result.notFoundCount > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer' }}>Show {result.notFoundCount} unmatched rows</summary>
              <pre style={{ fontSize: 11, maxHeight: 300, overflow: 'auto', background: 'white', padding: 8, borderRadius: 4 }}>
                {JSON.stringify(result.notFound, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

// ── Bulk Config tab — bulk apply property_utilities by filter ────

function BulkConfigTab() {
  const [providers, setProviders] = useState([]);
  const [form, setForm] = useState({
    filterMode: 'sourcePropertyIds', // 'sourcePropertyIds' | 'city' | 'zipPrefix' | 'namePattern' | 'allProperties'
    sourcePropertyIdsText: '',
    city: '',
    state: 'OH',
    zipPrefix: '',
    namePattern: '',
    utilityType: 'electric',
    accountHolder: 'tenant',
    providerId: '',
    billbackMode: 'none', // 'none' | 'full' | 'split_meter'
    notes: '',
  });
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    providersApi.list().then((res) => {
      if (res.ok) setProviders(res.providers || []);
    });
  }, []);

  const buildFilter = () => {
    const f = {};
    switch (form.filterMode) {
      case 'sourcePropertyIds': {
        const ids = form.sourcePropertyIdsText
          .split(/[,\s\n]+/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => parseInt(s, 10))
          .filter((n) => Number.isFinite(n));
        f.sourcePropertyIds = ids;
        break;
      }
      case 'city':
        f.city = form.city.trim();
        if (form.state) f.state = form.state;
        break;
      case 'zipPrefix':
        f.zipPrefix = form.zipPrefix.trim();
        break;
      case 'namePattern':
        f.namePattern = form.namePattern.trim();
        break;
      case 'allProperties':
        f.allProperties = true;
        break;
      default:
        break;
    }
    return f;
  };

  const buildBody = (dryRun) => ({
    filter: buildFilter(),
    utilityType: form.utilityType,
    accountHolder: form.accountHolder,
    providerId: form.providerId || null,
    // Send both billback_mode and the derived boolean so the server
    // stays in sync even if it's still reading the old field.
    billbackMode: form.billbackMode,
    billbackTenant: form.billbackMode !== 'none',
    notes: form.notes || null,
    dryRun,
  });

  const handlePreview = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    const res = await bulkUtilityConfigApi.apply(buildBody(true));
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setPreview(res);
  };

  const handleApply = async () => {
    if (
      !preview ||
      !confirm(
        `Apply ${form.utilityType}=${form.accountHolder} to ${preview.matchedCount} properties? ` +
          'Any existing property-level utility row for this type will be updated in place.',
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    const res = await bulkUtilityConfigApi.apply(buildBody(false));
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setResult(res);
    setPreview(null);
  };

  const update = (k) => (e) => {
    const val = e?.target?.type === 'checkbox' ? e.target.checked : e?.target?.value ?? e;
    setForm((prev) => ({ ...prev, [k]: val }));
  };

  return (
    <div>
      <div style={{ marginBottom: 16, padding: 12, background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, fontSize: 13, color: '#0c4a6e' }}>
        <strong>Bulk configure utility assignments across many properties at once.</strong>
        Pick a filter, choose a utility type + account holder, preview the match, then apply.
        Existing property-level utility rows matching the utility type will be updated in place
        (unit-level rows are never touched).
      </div>

      <div style={{ padding: 16, background: '#fafafa', borderRadius: 8, marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>1. Choose a filter</h3>
        <FormRow
          label="Match by"
          value={form.filterMode}
          onChange={update('filterMode')}
          select={[
            { value: 'sourcePropertyIds', label: 'Source Property IDs (paste list)' },
            { value: 'city', label: 'City contains' },
            { value: 'zipPrefix', label: 'ZIP starts with' },
            { value: 'namePattern', label: 'Name contains' },
            { value: 'allProperties', label: 'All properties (careful!)' },
          ]}
        />

        {form.filterMode === 'sourcePropertyIds' && (
          <FormRow
            label="Rent Manager Property IDs"
            value={form.sourcePropertyIdsText}
            onChange={update('sourcePropertyIdsText')}
            placeholder="688, 689, 690 or one per line"
          />
        )}
        {form.filterMode === 'city' && (
          <div style={{ display: 'flex', gap: 8 }}>
            <FormRow style={{ flex: 2 }} label="City" value={form.city} onChange={update('city')} placeholder="Toledo" />
            <FormRow style={{ flex: 1 }} label="State (optional)" value={form.state} onChange={update('state')} placeholder="OH" />
          </div>
        )}
        {form.filterMode === 'zipPrefix' && (
          <FormRow label="ZIP prefix" value={form.zipPrefix} onChange={update('zipPrefix')} placeholder="445 (Youngstown area)" />
        )}
        {form.filterMode === 'namePattern' && (
          <FormRow label="Name contains" value={form.namePattern} onChange={update('namePattern')} placeholder="Ottawa" />
        )}
      </div>

      <div style={{ padding: 16, background: '#fafafa', borderRadius: 8, marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>2. Utility to configure</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <FormRow
            style={{ flex: 1 }}
            label="Utility type"
            value={form.utilityType}
            onChange={update('utilityType')}
            select={['electric', 'gas', 'water', 'sewer', 'trash', 'internet', 'cable']}
          />
          <FormRow
            style={{ flex: 1 }}
            label="Account holder"
            value={form.accountHolder}
            onChange={update('accountHolder')}
            select={ACCOUNT_HOLDER_OPTIONS}
          />
        </div>
        <FormRow
          label="Provider (optional — skip to set later)"
          value={form.providerId}
          onChange={update('providerId')}
          select={[
            { value: '', label: '(none — set later)' },
            ...providers.map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
        {form.utilityType === 'water' && (
          <FormRow
            label="Billback (for LLC-held water)"
            value={form.billbackMode}
            onChange={update('billbackMode')}
            select={[
              { value: 'none', label: 'none (LLC absorbs the bill)' },
              { value: 'full', label: 'full (LLC pays, tenant billed back 100%)' },
              { value: 'split_meter', label: 'split_meter (shared meter, bill split across units)' },
            ]}
          />
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button type="button" onClick={handlePreview} disabled={busy} style={primaryButtonStyle}>
          {busy ? 'Matching…' : 'Preview match'}
        </button>
        <button
          type="button"
          onClick={() => {
            setPreview(null);
            setResult(null);
            setError(null);
          }}
          style={smallButtonStyle}
        >
          Reset
        </button>
      </div>

      {error && <ErrorBox message={error} />}

      {preview && (
        <div style={{ padding: 16, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>Matched {preview.matchedCount} properties</h3>
          {preview.matchedCount === 0 && <p style={{ color: '#888' }}>No properties matched. Adjust the filter.</p>}
          {preview.matchedCount > 0 && (
            <>
              <div style={{ maxHeight: 260, overflow: 'auto', fontSize: 12, border: '1px solid #eee', borderRadius: 6, background: 'white' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead style={{ background: '#f3f4f6', position: 'sticky', top: 0 }}>
                    <tr>
                      <th style={thStyle}>RM ID</th>
                      <th style={thStyle}>Name</th>
                      <th style={thStyle}>City</th>
                      <th style={thStyle}>State</th>
                      <th style={thStyle}>ZIP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.matchedPreview.map((p) => (
                      <tr key={p.id}>
                        <td style={tdStyle}>{p.sourcePropertyId}</td>
                        <td style={tdStyle}>{p.displayName}</td>
                        <td style={tdStyle}>{p.serviceCity}</td>
                        <td style={tdStyle}>{p.serviceState}</td>
                        <td style={tdStyle}>{p.serviceZip}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.matchedCount > preview.matchedPreview.length && (
                <p style={{ fontSize: 12, color: '#888', margin: '8px 0' }}>
                  Showing first {preview.matchedPreview.length} of {preview.matchedCount}.
                </p>
              )}
              <button
                type="button"
                onClick={handleApply}
                disabled={busy}
                style={{ ...primaryButtonStyle, background: '#15803d', marginTop: 12 }}
              >
                {busy ? 'Applying…' : `Apply ${form.utilityType}=${form.accountHolder} to ${preview.matchedCount} properties`}
              </button>
            </>
          )}
        </div>
      )}

      {result && (
        <div style={{ padding: 16, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, color: '#166534' }}>
          <h3 style={{ marginTop: 0 }}>✅ Applied</h3>
          <ul>
            <li><strong>{result.matchedCount}</strong> properties matched</li>
            <li><strong>{result.insertedCount}</strong> new utility rows inserted</li>
            <li><strong>{result.updatedCount}</strong> existing utility rows updated</li>
          </ul>
          <p style={{ fontSize: 12, color: '#555' }}>{result.message}</p>
        </div>
      )}
    </div>
  );
}

// ── Bulk import tab ──────────────────────────────────────────────

function BulkImportTab() {
  const [raw, setRaw] = useState('');
  const [parsed, setParsed] = useState(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleParse = () => {
    setError(null);
    setResult(null);
    const p = parseTSV(raw);
    if (!p.ok) {
      setError(p.error || 'Parse failed');
      setParsed(null);
      return;
    }
    setParsed(p);
  };

  const handleCommit = async () => {
    if (!parsed || parsed.rows.length === 0) return;
    if (
      !confirm(
        `Import ${parsed.summary.uniqueProperties} properties and ${parsed.rows.length} units into the database? ` +
          'This will upsert existing properties (matched by Rent Manager ID) and REPLACE their units with the pasted set.',
      )
    ) {
      return;
    }
    setImporting(true);
    setError(null);
    const res = await bulkImportApi.run({
      defaultOwnerName: 'Breeze (unassigned)',
      rows: parsed.rows,
    });
    setImporting(false);
    if (!res.ok) {
      setError(res.error || 'Import failed');
      return;
    }
    setResult(res);
  };

  const handleReset = () => {
    setRaw('');
    setParsed(null);
    setResult(null);
    setError(null);
  };

  return (
    <div>
      <div style={{ marginBottom: 16, padding: 12, background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, fontSize: 13, color: '#0c4a6e' }}>
        <strong>Paste your property+unit data below.</strong> Tab-separated, with header row.
        Expected columns: <code>Property ID · Property · Property Street Address 1 · Unit Name · Sqft · Bedrooms · Bathrooms</code>.
        Common/Confidential portfolio rows and a small skip list are filtered automatically.
        Every property is imported under a default "Breeze (unassigned)" owner — you can reassign later.
      </div>

      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder="Paste rows from Excel (including the header row)…"
        rows={12}
        style={{
          width: '100%',
          padding: 10,
          fontFamily: 'monospace',
          fontSize: 12,
          border: '1px solid #d1d5db',
          borderRadius: 6,
          boxSizing: 'border-box',
          marginBottom: 12,
        }}
      />

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button type="button" onClick={handleParse} disabled={!raw.trim()} style={primaryButtonStyle}>
          Parse & preview
        </button>
        <button type="button" onClick={handleReset} style={smallButtonStyle}>
          Reset
        </button>
      </div>

      {error && <ErrorBox message={error} />}

      {parsed && !result && (
        <div style={{ padding: 16, background: '#fafafa', borderRadius: 8, marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>Preview</h3>
          <SummaryTable summary={parsed.summary} />
          {parsed.warnings.length > 0 && (
            <details style={{ marginTop: 12 }}>
              <summary style={{ cursor: 'pointer', fontSize: 13, color: '#b91c1c' }}>
                {parsed.warnings.length} parsing warning{parsed.warnings.length === 1 ? '' : 's'} (click to expand)
              </summary>
              <div style={{ maxHeight: 200, overflow: 'auto', marginTop: 8, fontSize: 12 }}>
                {parsed.warnings.slice(0, 100).map((w, i) => (
                  <div key={i} style={{ padding: 4, borderBottom: '1px solid #eee' }}>
                    <span style={{ color: '#888' }}>line {w.lineNumber}:</span> {w.error}
                    {w.propertyColumn && <span style={{ color: '#666' }}> — "{w.propertyColumn}"</span>}
                  </div>
                ))}
              </div>
            </details>
          )}
          <h4 style={{ marginTop: 16, marginBottom: 8 }}>First 10 parsed rows</h4>
          <div style={{ maxHeight: 300, overflow: 'auto', fontSize: 12, border: '1px solid #eee', borderRadius: 6 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead style={{ background: '#f3f4f6', position: 'sticky', top: 0 }}>
                <tr>
                  <th style={thStyle}>RM ID</th>
                  <th style={thStyle}>Street</th>
                  <th style={thStyle}>City</th>
                  <th style={thStyle}>State</th>
                  <th style={thStyle}>ZIP</th>
                  <th style={thStyle}>Unit</th>
                  <th style={thStyle}>Sqft</th>
                  <th style={thStyle}>BR</th>
                  <th style={thStyle}>BA</th>
                </tr>
              </thead>
              <tbody>
                {parsed.rows.slice(0, 10).map((r, i) => (
                  <tr key={i}>
                    <td style={tdStyle}>{r.sourcePropertyId}</td>
                    <td style={tdStyle}>{r.serviceAddressLine1}</td>
                    <td style={tdStyle}>{r.serviceCity}</td>
                    <td style={tdStyle}>{r.serviceState}</td>
                    <td style={tdStyle}>{r.serviceZip}</td>
                    <td style={tdStyle}>{r.unit.sourceUnitName}</td>
                    <td style={tdStyle}>{r.unit.sqft}</td>
                    <td style={tdStyle}>{r.unit.bedrooms}</td>
                    <td style={tdStyle}>{r.unit.bathrooms}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            onClick={handleCommit}
            disabled={importing || parsed.rows.length === 0}
            style={{ ...primaryButtonStyle, marginTop: 16, background: '#15803d' }}
          >
            {importing ? 'Importing…' : `Commit ${parsed.summary.uniqueProperties} properties · ${parsed.rows.length} units`}
          </button>
        </div>
      )}

      {result && (
        <div style={{ padding: 16, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, color: '#166534' }}>
          <h3 style={{ marginTop: 0 }}>✅ Import complete</h3>
          <ul>
            <li><strong>{result.propertiesUpserted}</strong> properties upserted</li>
            <li><strong>{result.unitsInserted}</strong> units inserted</li>
            <li><strong>{result.rowErrorCount}</strong> rows skipped due to validation errors</li>
            <li>Owner: <code>{result.defaultOwnerName}</code></li>
          </ul>
          {result.warning && <p style={{ fontSize: 12, color: '#555' }}>{result.warning}</p>}
          {result.rowErrorCount > 0 && (
            <details>
              <summary style={{ cursor: 'pointer' }}>Show {result.rowErrorCount} error rows</summary>
              <pre style={{ fontSize: 11, maxHeight: 200, overflow: 'auto', background: 'white', padding: 8, borderRadius: 4 }}>
                {JSON.stringify(result.rowErrors, null, 2)}
              </pre>
            </details>
          )}
          <button type="button" onClick={handleReset} style={{ ...smallButtonStyle, marginTop: 12 }}>
            Import another batch
          </button>
        </div>
      )}
    </div>
  );
}

function SummaryTable({ summary }) {
  const rows = [
    { label: 'Total lines scanned', value: summary.totalLines + summary.blankLines },
    { label: 'Blank lines skipped', value: summary.blankLines },
    { label: 'Header row skipped', value: summary.headerRow },
    { label: 'Common / Confidential rows skipped', value: summary.skippedCommon },
    { label: 'Block-list rows skipped', value: summary.skippedBlocked },
    { label: 'Rows missing Property ID', value: summary.skippedMissing },
    { label: 'Rows with parse errors', value: summary.addressFailures },
    { label: 'Valid rows to import', value: summary.parsedRows, bold: true },
    { label: 'Unique properties', value: summary.uniqueProperties, bold: true },
  ];
  return (
    <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
      <tbody>
        {rows.map(({ label, value, bold }) => (
          <tr key={label}>
            <td style={{ padding: '4px 12px 4px 0', color: '#666' }}>{label}</td>
            <td style={{ padding: 4, fontWeight: bold ? 700 : 400, textAlign: 'right' }}>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const thStyle = {
  padding: '6px 8px',
  textAlign: 'left',
  fontWeight: 600,
  borderBottom: '1px solid #ddd',
  fontSize: 11,
  color: '#666',
};

const tdStyle = {
  padding: '4px 8px',
  borderBottom: '1px solid #f3f3f3',
  fontSize: 12,
};

// ── Owners tab ───────────────────────────────────────────────────

function OwnersTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await ownersApi.list();
    setLoading(false);
    if (!res.ok) return setError(res.error);
    setError(null);
    setRows(res.owners || []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <SectionHeader
        title={`${rows.length} owner${rows.length === 1 ? '' : 's'}`}
        onRefresh={load}
        onAdd={() => setCreating((c) => !c)}
        adding={creating}
      />
      {creating && <OwnerForm onSaved={() => { setCreating(false); load(); }} />}
      {loading && <p style={{ color: '#888' }}>Loading…</p>}
      {error && <ErrorBox message={error} />}
      {!loading && !error && rows.length === 0 && (
        <EmptyState
          message="No owners yet. Click + Add to create your first LLC entry."
        />
      )}
      {rows.map((o) => (
        <OwnerRow key={o.id} owner={o} onDeleted={load} />
      ))}
    </div>
  );
}

function OwnerRow({ owner, onDeleted }) {
  const [deleting, setDeleting] = useState(false);
  const handleDelete = async () => {
    if (!confirm(`Delete owner "${owner.legalName}"?`)) return;
    setDeleting(true);
    const res = await ownersApi.delete(owner.id);
    setDeleting(false);
    if (!res.ok) return alert(res.error);
    onDeleted();
  };
  const addr = [
    owner.mailingAddressLine1,
    owner.mailingCity && `${owner.mailingCity}, ${owner.mailingState || ''} ${owner.mailingZip || ''}`.trim(),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div
      style={{
        padding: 16,
        marginBottom: 12,
        border: '1px solid #eee',
        borderRadius: 8,
        background: 'white',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <div>
          <strong>{owner.legalName}</strong>
          {owner.dba && <span style={{ color: '#888' }}> (dba {owner.dba})</span>}
          {addr && <div style={{ color: '#666', fontSize: 13 }}>{addr}</div>}
          {owner.billingEmail && (
            <div style={{ color: '#888', fontSize: 13 }}>{owner.billingEmail}</div>
          )}
        </div>
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          style={iconButtonStyle}
          title="Delete owner"
        >
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}

function OwnerForm({ onSaved }) {
  const [form, setForm] = useState({
    legalName: '',
    dba: '',
    mailingAddressLine1: '',
    mailingCity: '',
    mailingState: 'OH',
    mailingZip: '',
    billingEmail: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const update = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleSave = async () => {
    setSaving(true);
    const res = await ownersApi.create(form);
    setSaving(false);
    if (!res.ok) return setError(res.error);
    onSaved();
  };

  return (
    <div style={formContainerStyle}>
      <h3 style={{ marginTop: 0 }}>New owner</h3>
      <FormRow label="Legal name *" value={form.legalName} onChange={update('legalName')} />
      <FormRow label="DBA (optional)" value={form.dba} onChange={update('dba')} />
      <FormRow label="Mailing address" value={form.mailingAddressLine1} onChange={update('mailingAddressLine1')} />
      <div style={{ display: 'flex', gap: 8 }}>
        <FormRow style={{ flex: 2 }} label="City" value={form.mailingCity} onChange={update('mailingCity')} />
        <FormRow style={{ flex: 1 }} label="State" value={form.mailingState} onChange={update('mailingState')} select={US_STATES} />
        <FormRow style={{ flex: 1 }} label="ZIP" value={form.mailingZip} onChange={update('mailingZip')} />
      </div>
      <FormRow label="Billing email" value={form.billingEmail} onChange={update('billingEmail')} />
      {error && <ErrorBox message={error} />}
      <button type="button" onClick={handleSave} disabled={!form.legalName || saving} style={primaryButtonStyle}>
        {saving ? 'Saving…' : 'Create owner'}
      </button>
    </div>
  );
}

// ── Properties tab ───────────────────────────────────────────────

function PropertiesTab() {
  const [rows, setRows] = useState([]);
  const [ownerMap, setOwnerMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [propRes, ownerRes] = await Promise.all([propertiesApi.list(), ownersApi.list()]);
    setLoading(false);
    if (!propRes.ok) return setError(propRes.error);
    if (!ownerRes.ok) return setError(ownerRes.error);
    setError(null);
    setRows(propRes.properties || []);
    setOwnerMap(
      Object.fromEntries((ownerRes.owners || []).map((o) => [o.id, o])),
    );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <SectionHeader
        title={`${rows.length} propert${rows.length === 1 ? 'y' : 'ies'}`}
        onRefresh={load}
        onAdd={() => setCreating((c) => !c)}
        adding={creating}
      />
      {creating && (
        <PropertyForm
          ownerOptions={Object.values(ownerMap)}
          onSaved={() => { setCreating(false); load(); }}
        />
      )}
      {loading && <p style={{ color: '#888' }}>Loading…</p>}
      {error && <ErrorBox message={error} />}
      {!loading && !error && rows.length === 0 && (
        <EmptyState message="No properties yet. Create an owner first, then add a property." />
      )}
      {rows.map((p) => (
        <PropertyRow key={p.id} property={p} owner={ownerMap[p.ownerId]} onDeleted={load} />
      ))}
    </div>
  );
}

function PropertyRow({ property, owner, onDeleted }) {
  const [expanded, setExpanded] = useState(false);
  const [utilities, setUtilities] = useState([]);
  const [loadingUtils, setLoadingUtils] = useState(false);

  const loadUtilities = useCallback(async () => {
    setLoadingUtils(true);
    const res = await propertyUtilitiesApi.list(property.id);
    setLoadingUtils(false);
    if (res.ok) setUtilities(res.utilities || []);
  }, [property.id]);

  useEffect(() => {
    if (expanded) loadUtilities();
  }, [expanded, loadUtilities]);

  const handleDelete = async () => {
    if (!confirm(`Delete property "${property.displayName}"?`)) return;
    const res = await propertiesApi.delete(property.id);
    if (!res.ok) return alert(res.error);
    onDeleted();
  };

  const addr = `${property.serviceAddressLine1}, ${property.serviceCity}, ${property.serviceState} ${property.serviceZip}`;

  return (
    <div
      style={{
        padding: 16,
        marginBottom: 12,
        border: '1px solid #eee',
        borderRadius: 8,
        background: 'white',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => setExpanded((e) => !e)}>
          <strong>{property.displayName}</strong>
          <span style={{ color: '#888', fontSize: 13, marginLeft: 8 }}>{property.propertyType}</span>
          <div style={{ color: '#666', fontSize: 13 }}>{addr}</div>
          <div style={{ color: '#888', fontSize: 12 }}>
            Owner: {owner?.legalName || '(unknown)'}
          </div>
        </div>
        <button type="button" onClick={handleDelete} style={iconButtonStyle} title="Delete property">
          <Trash2 size={16} />
        </button>
      </div>
      {expanded && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #eee' }}>
          <PropertyUtilitiesPanel
            propertyId={property.id}
            utilities={utilities}
            loading={loadingUtils}
            onChanged={loadUtilities}
          />
        </div>
      )}
    </div>
  );
}

function PropertyForm({ ownerOptions, onSaved }) {
  const [form, setForm] = useState({
    ownerId: ownerOptions[0]?.id || '',
    displayName: '',
    propertyType: 'sfr',
    serviceAddressLine1: '',
    serviceCity: '',
    serviceState: 'OH',
    serviceZip: '',
    billingAddressLine1: '',
    billingCity: '',
    billingState: '',
    billingZip: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const update = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleSave = async () => {
    setSaving(true);
    // Drop empty billing fields so they're stored as NULL rather than
    // empty strings (cleaner queries later).
    const payload = { ...form };
    for (const k of Object.keys(payload)) {
      if (payload[k] === '') payload[k] = null;
    }
    const res = await propertiesApi.create(payload);
    setSaving(false);
    if (!res.ok) return setError(res.error);
    onSaved();
  };

  return (
    <div style={formContainerStyle}>
      <h3 style={{ marginTop: 0 }}>New property</h3>
      <FormRow label="Owner (LLC) *" value={form.ownerId} onChange={update('ownerId')} select={ownerOptions.map((o) => ({ value: o.id, label: o.legalName }))} />
      <FormRow label="Display name *" value={form.displayName} onChange={update('displayName')} placeholder="105 Southard Ave" />
      <FormRow label="Property type" value={form.propertyType} onChange={update('propertyType')} select={PROPERTY_TYPES} />
      <h4 style={{ marginBottom: 4 }}>Service address</h4>
      <FormRow label="Street *" value={form.serviceAddressLine1} onChange={update('serviceAddressLine1')} />
      <div style={{ display: 'flex', gap: 8 }}>
        <FormRow style={{ flex: 2 }} label="City *" value={form.serviceCity} onChange={update('serviceCity')} />
        <FormRow style={{ flex: 1 }} label="State *" value={form.serviceState} onChange={update('serviceState')} select={US_STATES} />
        <FormRow style={{ flex: 1 }} label="ZIP *" value={form.serviceZip} onChange={update('serviceZip')} />
      </div>
      <h4 style={{ marginBottom: 4 }}>Billing address <span style={{ color: '#888', fontWeight: 400 }}>(optional — falls back to owner)</span></h4>
      <FormRow label="Street" value={form.billingAddressLine1} onChange={update('billingAddressLine1')} />
      <div style={{ display: 'flex', gap: 8 }}>
        <FormRow style={{ flex: 2 }} label="City" value={form.billingCity} onChange={update('billingCity')} />
        <FormRow style={{ flex: 1 }} label="State" value={form.billingState} onChange={update('billingState')} select={['', ...US_STATES]} />
        <FormRow style={{ flex: 1 }} label="ZIP" value={form.billingZip} onChange={update('billingZip')} />
      </div>
      {error && <ErrorBox message={error} />}
      <button
        type="button"
        onClick={handleSave}
        disabled={!form.ownerId || !form.displayName || !form.serviceAddressLine1 || saving}
        style={primaryButtonStyle}
      >
        {saving ? 'Saving…' : 'Create property'}
      </button>
    </div>
  );
}

// ── Per-property utility config ──────────────────────────────────

function PropertyUtilitiesPanel({ propertyId, utilities, loading, onChanged }) {
  const [providers, setProviders] = useState([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    utilityType: 'electric',
    providerId: '',
    accountHolder: 'tenant',
    billbackMode: 'none',
    currentAccountNumber: '',
    notes: '',
  });

  useEffect(() => {
    providersApi.list().then((res) => {
      if (res.ok) setProviders(res.providers || []);
    });
  }, []);

  const handleAdd = async () => {
    const payload = {
      propertyId,
      ...form,
      providerId: form.providerId || null,
      // Derive the legacy boolean from billback_mode for backward compat.
      billbackTenant: form.billbackMode !== 'none',
    };
    const res = await propertyUtilitiesApi.create(payload);
    if (!res.ok) return alert(res.error);
    setAdding(false);
    setForm((f) => ({ ...f, currentAccountNumber: '', notes: '', billbackMode: 'none' }));
    onChanged();
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this utility row?')) return;
    const res = await propertyUtilitiesApi.delete(id);
    if (!res.ok) return alert(res.error);
    onChanged();
  };

  const providerMap = Object.fromEntries(providers.map((p) => [p.id, p]));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ fontSize: 14 }}>Utilities ({utilities.length})</strong>
        <button type="button" onClick={() => setAdding((a) => !a)} style={smallButtonStyle}>
          {adding ? 'Cancel' : '+ Add'}
        </button>
      </div>
      {loading && <p style={{ color: '#888', fontSize: 13 }}>Loading…</p>}
      {!loading && utilities.length === 0 && !adding && (
        <p style={{ color: '#888', fontSize: 13 }}>No utilities configured.</p>
      )}
      {utilities.map((u) => (
        <div key={u.id} style={{ display: 'flex', justifyContent: 'space-between', padding: 8, borderBottom: '1px solid #f3f3f3', fontSize: 13 }}>
          <div>
            <strong>{u.utilityType}</strong>
            <span style={{ color: '#666', marginLeft: 8 }}>
              → {
                u.accountHolder === 'owner_llc'
                  ? 'LLC-held'
                  : u.accountHolder === 'tenant'
                  ? 'Tenant-held'
                  : u.accountHolder === 'none'
                  ? 'Not applicable'
                  : u.accountHolder
              }
            </span>
            {u.billbackMode && u.billbackMode !== 'none' && (
              <span style={{ color: '#E65100', marginLeft: 8 }}>
                {u.billbackMode === 'split_meter' ? 'billback (split meter)' : 'billback'}
              </span>
            )}
            {u.providerId && (
              <span style={{ color: '#888', marginLeft: 8 }}>
                via {providerMap[u.providerId]?.name || u.providerId}
              </span>
            )}
            {u.currentAccountNumber && (
              <span style={{ color: '#888', marginLeft: 8 }}>acct {u.currentAccountNumber}</span>
            )}
          </div>
          <button type="button" onClick={() => handleDelete(u.id)} style={iconButtonStyle}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      {adding && (
        <div style={{ marginTop: 12, padding: 12, background: '#fafafa', borderRadius: 6 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <FormRow style={{ flex: 1, minWidth: 120 }} label="Type" value={form.utilityType} onChange={(e) => setForm({ ...form, utilityType: e.target.value })} select={UTILITY_TYPES} />
            <FormRow style={{ flex: 2, minWidth: 160 }} label="Provider" value={form.providerId} onChange={(e) => setForm({ ...form, providerId: e.target.value })} select={[{ value: '', label: '(none)' }, ...providers.map((p) => ({ value: p.id, label: p.name }))]} />
            <FormRow style={{ flex: 1, minWidth: 120 }} label="Account holder" value={form.accountHolder} onChange={(e) => setForm({ ...form, accountHolder: e.target.value })} select={ACCOUNT_HOLDER_OPTIONS} />
          </div>
          <FormRow label="Account # (optional)" value={form.currentAccountNumber} onChange={(e) => setForm({ ...form, currentAccountNumber: e.target.value })} />
          {form.utilityType === 'water' && (
            <FormRow
              label="Billback (for LLC-held water)"
              value={form.billbackMode}
              onChange={(e) => setForm({ ...form, billbackMode: e.target.value })}
              select={[
                { value: 'none', label: 'none (LLC absorbs)' },
                { value: 'full', label: 'full (tenant billed 100%)' },
                { value: 'split_meter', label: 'split_meter (shared meter, split across units)' },
              ]}
            />
          )}
          <button type="button" onClick={handleAdd} style={{ ...primaryButtonStyle, marginTop: 8 }}>
            Add utility
          </button>
        </div>
      )}
    </div>
  );
}

// ── Providers tab ────────────────────────────────────────────────

function ProvidersTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [seeding, setSeeding] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [assignResult, setAssignResult] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await providersApi.list();
    setLoading(false);
    if (!res.ok) return setError(res.error);
    setError(null);
    setRows(res.providers || []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSeed = async () => {
    if (!confirm('Run the Ohio utility providers seed? Existing providers will not be touched.')) return;
    setSeeding(true);
    const res = await seedApi.run();
    setSeeding(false);
    if (!res.ok) return alert(res.error);
    alert(`Seed complete — ${res.createdCount} created, ${res.skippedCount} skipped.`);
    load();
  };

  const handleAssignByCity = async () => {
    const overwrite = confirm(
      'Assign providers to property_utilities rows based on each property\'s service_city.\n\n' +
      'Click OK to ONLY fill rows that currently have no provider (safer).\n' +
      'Click Cancel to abort.\n\n' +
      'To overwrite existing provider_ids too, use the advanced flow later.',
    );
    if (!overwrite) return;
    setAssigning(true);
    setAssignResult(null);
    const res = await assignProvidersByCityApi.run({ overwrite: false });
    setAssigning(false);
    if (!res.ok) {
      alert(res.error);
      return;
    }
    setAssignResult(res);
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <strong>{rows.length} provider{rows.length === 1 ? '' : 's'}</strong>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" onClick={load} style={smallButtonStyle}>
            <RefreshCw size={14} style={{ marginRight: 4 }} /> Refresh
          </button>
          <button type="button" onClick={handleSeed} disabled={seeding} style={smallButtonStyle}>
            {seeding ? 'Seeding…' : 'Run seed'}
          </button>
          <button type="button" onClick={handleAssignByCity} disabled={assigning || rows.length === 0} style={smallButtonStyle}>
            {assigning ? 'Assigning…' : 'Assign by city'}
          </button>
        </div>
      </div>

      {assignResult && (
        <div style={{ padding: 12, marginBottom: 12, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, fontSize: 13, color: '#166534' }}>
          <strong>✅ {assignResult.message}</strong>
          <ul style={{ marginTop: 4, marginBottom: 4 }}>
            <li>Properties scanned: {assignResult.propertiesScanned}</li>
            <li>Properties mapped: {assignResult.propertiesMapped}</li>
            <li>Properties unmapped (city not in map): {assignResult.propertiesUnmapped}</li>
            <li>Total provider_id writes: {assignResult.updateCount}</li>
          </ul>
          {assignResult.propertiesUnmapped > 0 && (
            <details style={{ marginTop: 4 }}>
              <summary style={{ cursor: 'pointer' }}>Show {assignResult.propertiesUnmapped} unmapped properties</summary>
              <pre style={{ fontSize: 11, maxHeight: 200, overflow: 'auto', background: 'white', padding: 8, borderRadius: 4, marginTop: 4 }}>
                {JSON.stringify(assignResult.unmapped, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
      {loading && <p style={{ color: '#888' }}>Loading…</p>}
      {error && <ErrorBox message={error} />}
      {!loading && !error && rows.length === 0 && (
        <EmptyState message={'No providers yet. Click "Run seed" to populate common Ohio utilities.'} />
      )}
      {rows.map((p) => (
        <div
          key={p.id}
          style={{
            padding: 12,
            marginBottom: 8,
            border: '1px solid #eee',
            borderRadius: 6,
            background: 'white',
            fontSize: 14,
          }}
        >
          <strong>{p.name}</strong>
          <span style={{ color: '#888', marginLeft: 8 }}>{p.phoneNumber}</span>
          {p.expectedHoldMinutes && (
            <span style={{ color: '#888', marginLeft: 8 }}>
              ~{p.expectedHoldMinutes} min hold
            </span>
          )}
          {p.callScriptNotes && (
            <div style={{ color: '#666', fontSize: 12, marginTop: 4 }}>{p.callScriptNotes}</div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Small shared primitives ──────────────────────────────────────

function SectionHeader({ title, onRefresh, onAdd, adding }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
      <strong>{title}</strong>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={onRefresh} style={smallButtonStyle}>
          <RefreshCw size={14} style={{ marginRight: 4 }} /> Refresh
        </button>
        <button type="button" onClick={onAdd} style={smallButtonStyle}>
          <Plus size={14} style={{ marginRight: 4 }} /> {adding ? 'Cancel' : 'Add'}
        </button>
      </div>
    </div>
  );
}

function FormRow({ label, value, onChange, placeholder, select, style }) {
  return (
    <div style={{ marginBottom: 10, ...style }}>
      <label style={{ fontSize: 12, color: '#666', display: 'block', marginBottom: 4 }}>
        {label}
      </label>
      {select ? (
        <select value={value} onChange={onChange} style={inputStyle}>
          {(Array.isArray(select) ? select : []).map((opt) => {
            if (typeof opt === 'string') return <option key={opt} value={opt}>{opt || '(none)'}</option>;
            return <option key={opt.value} value={opt.value}>{opt.label}</option>;
          })}
        </select>
      ) : (
        <input type="text" value={value || ''} onChange={onChange} placeholder={placeholder} style={inputStyle} />
      )}
    </div>
  );
}

function EmptyState({ message }) {
  return (
    <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>
      {message}
    </div>
  );
}

function ErrorBox({ message }) {
  return (
    <div
      style={{
        padding: 12,
        marginBottom: 12,
        background: '#fef2f2',
        color: '#b91c1c',
        border: '1px solid #fecaca',
        borderRadius: 6,
        fontSize: 13,
      }}
    >
      {message}
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────

const inputStyle = {
  width: '100%',
  padding: '8px 10px',
  fontSize: 14,
  border: '1px solid #d1d5db',
  borderRadius: 6,
  background: 'white',
  boxSizing: 'border-box',
};

const primaryButtonStyle = {
  padding: '10px 16px',
  background: '#1565C0',
  color: 'white',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 14,
  marginTop: 8,
};

const smallButtonStyle = {
  padding: '6px 12px',
  background: '#f9fafb',
  border: '1px solid #d1d5db',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 13,
  display: 'flex',
  alignItems: 'center',
};

const iconButtonStyle = {
  padding: 8,
  background: 'none',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  color: '#888',
};

const formContainerStyle = {
  padding: 16,
  marginBottom: 16,
  background: '#f9fafb',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
};
