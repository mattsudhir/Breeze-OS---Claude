// Accounting workspace. Tabbed view over the Stage 1-3 backend.
//
// Tabs:
//   Chart of Accounts  — live, reads /api/admin/list-gl-accounts
//   Journal Entries    — placeholder (next iteration)
//   Receivables        — placeholder
//   Receipts           — placeholder
//   Deposits           — placeholder
//   Bank Accounts      — placeholder
//   Reports            — placeholder (Stage 7)
//
// The admin endpoint is gated by BREEZE_ADMIN_TOKEN. The page asks
// for the token on first load, stashes it in sessionStorage (NOT
// localStorage — short-lived for safety), and reuses it for every
// subsequent fetch. Clearing the browser tab clears the token.

import { useEffect, useState, useMemo, useCallback } from 'react';
import {
  DollarSign, Receipt, CreditCard, Landmark, FileSpreadsheet,
  BookOpen, BarChart3, AlertCircle, RefreshCw, Search, Tag, Eye, EyeOff,
  Link2, Download, Sparkles, Check, X, Settings, Trash2, Power, Building2, Plus,
} from 'lucide-react';
import { usePlaidLink } from 'react-plaid-link';

const TABS = [
  { id: 'coa',       label: 'Chart of Accounts', icon: BookOpen },
  { id: 'entities',  label: 'Entities',          icon: Building2 },
  { id: 'journal',   label: 'Journal Entries',   icon: FileSpreadsheet },
  { id: 'ar',        label: 'Receivables',       icon: Receipt },
  { id: 'receipts',  label: 'Receipts',          icon: DollarSign },
  { id: 'deposits',  label: 'Deposits',          icon: Landmark },
  { id: 'banks',     label: 'Bank Accounts',     icon: CreditCard },
  { id: 'recon',     label: 'Reconciliation',    icon: Sparkles },
  { id: 'rules',     label: 'Rules',             icon: Settings },
  { id: 'reports',   label: 'Reports',           icon: BarChart3 },
];

const ACCOUNT_TYPE_COLORS = {
  asset:     { bg: '#E3F2FD', fg: '#1565C0' },
  liability: { bg: '#FFF3E0', fg: '#E65100' },
  equity:    { bg: '#F3E5F5', fg: '#6A1B9A' },
  income:    { bg: '#E8F5E9', fg: '#2E7D32' },
  expense:   { bg: '#FFEBEE', fg: '#C62828' },
};

const ADMIN_TOKEN_KEY = 'breeze.admin.token';

// When Clerk is configured, the Clerk session cookie alone auths
// every /api/admin/* call (verified server-side in lib/adminHelpers).
// In that mode we skip the legacy "enter your admin token" prompt
// and pass an empty token; the URL search param remains harmless
// because the server prefers Clerk over the shared-secret fallback.
const CLERK_ENABLED = Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);

function readToken() {
  if (CLERK_ENABLED) return 'clerk';
  try {
    return sessionStorage.getItem(ADMIN_TOKEN_KEY) || '';
  } catch {
    return '';
  }
}
function writeToken(v) {
  if (CLERK_ENABLED) return;
  try {
    if (v) sessionStorage.setItem(ADMIN_TOKEN_KEY, v);
    else sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    /* private mode — ignore */
  }
}

export default function AccountingPage() {
  const [activeTab, setActiveTab] = useState('coa');
  const [token, setToken] = useState(readToken());

  useEffect(() => {
    writeToken(token);
  }, [token]);

  return (
    <div className="properties-page">
      <div className="tenant-detail-topbar">
        <div className="property-detail-header" style={{ flex: 1 }}>
          <div className="wo-detail-icon" style={{ background: '#2E7D3215', color: '#2E7D32' }}>
            <DollarSign size={28} />
          </div>
          <div style={{ flex: 1 }}>
            <h2>Accounting</h2>
            <p className="property-detail-address">
              Breeze OS general ledger, receivables, banking, and reports.
            </p>
          </div>
        </div>
      </div>

      {!token ? (
        <AdminTokenPrompt onSave={setToken} />
      ) : (
        <>
          <TabBar activeTab={activeTab} onChange={setActiveTab} />
          <div style={{ marginTop: '16px' }}>
            {activeTab === 'coa' && <ChartOfAccountsTab token={token} onTokenInvalid={() => setToken('')} />}
            {activeTab === 'entities' && <EntitiesTab token={token} onTokenInvalid={() => setToken('')} />}
            {activeTab === 'journal' && <JournalEntriesTab token={token} onTokenInvalid={() => setToken('')} />}
            {activeTab === 'ar' && <ReceivablesTab token={token} onTokenInvalid={() => setToken('')} />}
            {activeTab === 'receipts' && <ReceiptsTab token={token} onTokenInvalid={() => setToken('')} />}
            {activeTab === 'deposits' && <DepositsTab token={token} onTokenInvalid={() => setToken('')} />}
            {activeTab === 'banks' && <BankAccountsTab token={token} onTokenInvalid={() => setToken('')} />}
            {activeTab === 'recon' && <ReconciliationTab token={token} onTokenInvalid={() => setToken('')} />}
            {activeTab === 'rules' && <RulesTab token={token} onTokenInvalid={() => setToken('')} />}
            {activeTab === 'reports' && <ReportsTab token={token} onTokenInvalid={() => setToken('')} />}
          </div>
        </>
      )}
    </div>
  );
}

// ── Token prompt ─────────────────────────────────────────────────

function AdminTokenPrompt({ onSave }) {
  const [draft, setDraft] = useState('');
  const [reveal, setReveal] = useState(false);
  return (
    <div className="dashboard-card" style={{ padding: '24px', maxWidth: '520px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
        <AlertCircle size={18} color="#E65100" />
        <strong>Admin token required</strong>
      </div>
      <p style={{ color: '#555', fontSize: '13px', margin: '0 0 12px' }}>
        Paste the value of <code>BREEZE_ADMIN_TOKEN</code> from your Vercel
        environment variables to access live accounting data. The token
        is held in <code>sessionStorage</code> for this browser tab only
        and is cleared when you close the tab.
      </p>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <input
          type={reveal ? 'text' : 'password'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="BREEZE_ADMIN_TOKEN value"
          autoComplete="off"
          style={{
            flex: 1, padding: '8px 12px', border: '1px solid #ddd',
            borderRadius: '6px', fontSize: '14px', fontFamily: 'monospace',
          }}
        />
        <button
          type="button"
          onClick={() => setReveal((r) => !r)}
          className="btn-secondary"
          title={reveal ? 'Hide' : 'Reveal'}
          style={{ padding: '6px 10px' }}
        >
          {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
        <button
          type="button"
          onClick={() => draft.trim() && onSave(draft.trim())}
          className="btn-primary"
          disabled={!draft.trim()}
        >
          Continue
        </button>
      </div>
    </div>
  );
}

// ── Tab bar ──────────────────────────────────────────────────────

function TabBar({ activeTab, onChange }) {
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: '4px',
      borderBottom: '1px solid #e0e0e0', paddingBottom: '8px',
    }}>
      {TABS.map((t) => {
        const Icon = t.icon;
        const active = t.id === activeTab;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              padding: '8px 14px', borderRadius: '6px 6px 0 0',
              border: 'none',
              background: active ? '#2E7D3210' : 'transparent',
              color: active ? '#2E7D32' : '#555',
              fontWeight: active ? 600 : 500,
              borderBottom: active ? '2px solid #2E7D32' : '2px solid transparent',
              cursor: 'pointer',
              fontSize: '13px',
            }}
          >
            <Icon size={14} />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Placeholder tab ──────────────────────────────────────────────

function PlaceholderTab({ label, hint }) {
  return (
    <div className="dashboard-card" style={{ padding: '24px' }}>
      <h3 style={{ marginTop: 0 }}>{label}</h3>
      <p style={{ color: '#666', fontSize: '14px' }}>{hint}</p>
      <p style={{ color: '#999', fontSize: '12px', marginTop: '16px' }}>
        Tab not yet implemented — schema and service layer ready in the
        backend; UI lands in a follow-up.
      </p>
    </div>
  );
}

// ── Chart of Accounts tab ───────────────────────────────────────

function ChartOfAccountsTab({ token, onTokenInvalid }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL('/api/admin/list-gl-accounts', window.location.origin);
      url.searchParams.set('secret', token);
      if (showInactive) url.searchParams.set('include_inactive', 'true');
      if (typeFilter) url.searchParams.set('account_type', typeFilter);
      const res = await fetch(url.toString());
      if (res.status === 401) {
        onTokenInvalid();
        return;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showInactive, typeFilter]);

  const filtered = useMemo(() => {
    if (!data?.accounts) return [];
    const q = search.trim().toLowerCase();
    if (!q) return data.accounts;
    return data.accounts.filter((a) =>
      (a.code || '').toLowerCase().includes(q) ||
      (a.name || '').toLowerCase().includes(q) ||
      (a.account_subtype || '').toLowerCase().includes(q),
    );
  }, [data, search]);

  const summary = useMemo(() => {
    if (!data?.accounts) return null;
    const byType = {};
    let withTags = 0;
    for (const a of data.accounts) {
      byType[a.account_type] = (byType[a.account_type] || 0) + 1;
      if (Object.keys(a.tags || {}).length > 0) withTags += 1;
    }
    return {
      total: data.accounts.length,
      withTags,
      byType,
    };
  }, [data]);

  return (
    <div>
      {/* Filters */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '8px',
        marginBottom: '12px', alignItems: 'center',
      }}>
        <div style={{ position: 'relative', flex: 1, minWidth: '220px' }}>
          <Search size={14} style={{
            position: 'absolute', top: '10px', left: '10px', color: '#999',
          }} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search code, name, subtype..."
            style={{
              width: '100%', padding: '8px 12px 8px 32px',
              border: '1px solid #ddd', borderRadius: '6px', fontSize: '13px',
            }}
          />
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          style={{
            padding: '8px 10px', border: '1px solid #ddd',
            borderRadius: '6px', fontSize: '13px', background: 'white',
          }}
        >
          <option value="">All types</option>
          <option value="asset">Asset</option>
          <option value="liability">Liability</option>
          <option value="equity">Equity</option>
          <option value="income">Income</option>
          <option value="expense">Expense</option>
        </select>
        <label style={{
          display: 'inline-flex', alignItems: 'center', gap: '4px',
          fontSize: '13px', color: '#555', cursor: 'pointer',
        }}>
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Show inactive
        </label>
        <button
          type="button"
          onClick={load}
          className="btn-secondary"
          style={{ padding: '6px 12px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      {/* Summary */}
      {summary && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: '8px',
          marginBottom: '12px',
        }}>
          <Pill label="Total" value={summary.total} />
          <Pill label="With tags" value={summary.withTags} />
          {Object.entries(summary.byType).map(([type, count]) => (
            <Pill
              key={type}
              label={type}
              value={count}
              bg={ACCOUNT_TYPE_COLORS[type]?.bg}
              fg={ACCOUNT_TYPE_COLORS[type]?.fg}
            />
          ))}
          {data?.count !== filtered.length && (
            <Pill label="Filtered" value={filtered.length} bg="#E0E0E0" fg="#222" />
          )}
        </div>
      )}

      {/* Body */}
      {loading && <div style={{ padding: '24px', color: '#666' }}>Loading...</div>}
      {error && (
        <div className="dashboard-card" style={{ padding: '16px', background: '#FFEBEE', color: '#C62828' }}>
          <strong>Failed to load:</strong> {error}
        </div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div className="dashboard-card" style={{ padding: '24px', textAlign: 'center', color: '#666' }}>
          No accounts found. Run <code>/api/admin/import-appfolio-coa?dry_run=false</code> or <code>/api/admin/seed-chart-of-accounts</code>.
        </div>
      )}

      {!loading && !error && filtered.length > 0 && (
        <div className="dashboard-card" style={{ padding: 0, overflow: 'hidden' }}>
          <style>{`
            .coa-table-wrap { max-height: calc(100vh - 320px); overflow: auto; }
            .coa-table { width: 100%; border-collapse: separate; border-spacing: 0; }
            .coa-table thead th {
              position: sticky; top: 0; z-index: 2;
              background: #FAFAFA; padding: 10px 12px;
              border-bottom: 1px solid #E0E0E0;
              font-size: 12px; color: #555; text-align: left;
              font-weight: 600;
            }
            .coa-table tbody td {
              padding: 8px 12px; border-bottom: 1px solid #F0F0F0;
              font-size: 13px; vertical-align: middle;
            }
            .coa-row-asset     { border-left: 3px solid #1565C0; }
            .coa-row-liability { border-left: 3px solid #E65100; }
            .coa-row-equity    { border-left: 3px solid #6A1B9A; }
            .coa-row-income    { border-left: 3px solid #2E7D32; }
            .coa-row-expense   { border-left: 3px solid #C62828; }
            .coa-row-child td:first-child {
              padding-left: 28px;
              position: relative;
            }
            .coa-row-child td:first-child::before {
              content: '└';
              position: absolute; left: 12px; top: 8px;
              color: #BBB; font-size: 12px; font-family: monospace;
            }
            .coa-postings-zero { color: #BBB; }
            .coa-postings-nonzero { color: #1A1A1A; font-weight: 600; }
            @media (max-width: 720px) {
              .coa-col-subtype, .coa-col-tags { display: none; }
            }
          `}</style>
          <div className="coa-table-wrap">
            <table className="coa-table">
              <thead>
                <tr>
                  <th style={{ width: '70px' }}>Code</th>
                  <th>Name</th>
                  <th style={{ width: '100px' }}>Type</th>
                  <th className="coa-col-subtype" style={{ width: '140px' }}>Subtype</th>
                  <th style={{ width: '80px', textAlign: 'right' }}>Postings</th>
                  <th className="coa-col-tags">Tags</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => (
                  <AccountRow key={a.id} account={a} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function AccountRow({ account }) {
  const tone = ACCOUNT_TYPE_COLORS[account.account_type] || { bg: '#eee', fg: '#333' };
  const rowClass = [
    `coa-row-${account.account_type}`,
    account.parent_code ? 'coa-row-child' : '',
  ].filter(Boolean).join(' ');
  return (
    <tr className={rowClass} style={{ opacity: account.is_active ? 1 : 0.55 }}>
      <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>
        {account.code}
      </td>
      <td>
        {account.name}
        {account.is_system && (
          <span style={{
            marginLeft: '6px', fontSize: '10px', color: '#666',
            background: '#f0f0f0', padding: '1px 6px', borderRadius: '8px',
          }}>system</span>
        )}
        {account.is_bank && (
          <span style={{
            marginLeft: '6px', fontSize: '10px', color: '#fff',
            background: '#1565C0', padding: '1px 6px', borderRadius: '8px',
          }}>bank</span>
        )}
        {!account.is_active && (
          <span style={{
            marginLeft: '6px', fontSize: '10px', color: '#fff',
            background: '#999', padding: '1px 6px', borderRadius: '8px',
          }}>inactive</span>
        )}
      </td>
      <td>
        <span style={{
          display: 'inline-block', padding: '2px 8px', borderRadius: '10px',
          background: tone.bg, color: tone.fg, fontSize: '11px', fontWeight: 600,
        }}>
          {account.account_type}
        </span>
      </td>
      <td className="coa-col-subtype" style={{ fontSize: '12px', color: '#666' }}>
        {account.account_subtype || '—'}
      </td>
      <td
        style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
        className={account.posting_count > 0 ? 'coa-postings-nonzero' : 'coa-postings-zero'}
      >
        {account.posting_count}
      </td>
      <td className="coa-col-tags">
        {Object.keys(account.tags || {}).length === 0 ? (
          <span style={{ color: '#bbb', fontSize: '12px' }}>—</span>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            {Object.entries(account.tags).flatMap(([ns, values]) =>
              values.map((v) => (
                <span
                  key={`${ns}:${v}`}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: '3px',
                    padding: '1px 6px', borderRadius: '8px',
                    background: '#F5F5F5', color: '#444',
                    fontSize: '10px', fontFamily: 'monospace',
                  }}
                  title={`${ns}=${v}`}
                >
                  <Tag size={9} />
                  {ns}:{v}
                </span>
              )),
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

function Pill({ label, value, bg = '#E0E0E0', fg = '#333' }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '4px',
      padding: '3px 10px', borderRadius: '12px', background: bg, color: fg,
      fontSize: '12px', fontWeight: 600,
    }}>
      <span style={{ textTransform: 'capitalize' }}>{label}</span>
      <span style={{ fontWeight: 700 }}>{value}</span>
    </span>
  );
}

function formatCents(cents) {
  if (cents === null || cents === undefined) return '—';
  const n = Number(cents) / 100;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Bank Accounts tab ───────────────────────────────────────────

function BankAccountsTab({ token, onTokenInvalid }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [converting, setConverting] = useState(false);
  const [convertResult, setConvertResult] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL('/api/admin/list-bank-accounts', window.location.origin);
      url.searchParams.set('secret', token);
      const res = await fetch(url.toString());
      if (res.status === 401) { onTokenInvalid(); return; }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      setData(await res.json());
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);

  const runConvert = async (dryRun) => {
    setConverting(true);
    setConvertResult(null);
    try {
      const url = new URL('/api/admin/convert-parked-bank-accounts', window.location.origin);
      url.searchParams.set('secret', token);
      url.searchParams.set('dry_run', String(dryRun));
      const res = await fetch(url.toString(), { method: 'POST' });
      if (res.status === 401) { onTokenInvalid(); return; }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      setConvertResult(await res.json());
      if (!dryRun) await load();
    } catch (err) {
      setConvertResult({ ok: false, error: err.message || String(err) });
    } finally {
      setConverting(false);
    }
  };

  if (loading) return <div style={{ padding: '24px', color: '#666' }}>Loading...</div>;
  if (error) {
    return (
      <div className="dashboard-card" style={{ padding: '16px', background: '#FFEBEE', color: '#C62828' }}>
        <strong>Failed to load:</strong> {error}
      </div>
    );
  }

  const parked = data?.parked_summary;
  const accounts = data?.bank_accounts || [];

  return (
    <div>
      <PlaidLinkButton token={token} onLinked={load} onTokenInvalid={onTokenInvalid} />

      {parked && parked.still_unlinked > 0 && (
        <div className="dashboard-card" style={{
          padding: '16px', marginBottom: '12px',
          borderLeft: '4px solid #E65100', background: '#FFF8E1',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
            <AlertCircle size={18} color="#E65100" />
            <strong>{parked.still_unlinked} parked GL accounts not yet linked as bank_accounts</strong>
          </div>
          <p style={{ color: '#555', fontSize: '13px', margin: '0 0 12px' }}>
            The AppFolio COA importer parked {parked.bank} bank GLs and {parked.credit_card} credit-card GLs
            as inactive placeholders. Click below to create a <code>bank_account</code> row for each,
            wired 1:1 to its GL (credit-card GLs are also reclassified asset → liability).
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => runConvert(true)}
              disabled={converting}
              style={{ padding: '6px 14px' }}
            >
              {converting ? 'Running...' : 'Dry-run preview'}
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => runConvert(false)}
              disabled={converting}
              style={{ padding: '6px 14px' }}
            >
              {converting ? 'Converting...' : `Convert all ${parked.still_unlinked}`}
            </button>
          </div>
          {convertResult && (
            <div style={{
              marginTop: '10px', padding: '8px', borderRadius: '6px',
              background: convertResult.ok === false ? '#FFEBEE' : '#E8F5E9',
              fontSize: '12px',
            }}>
              {convertResult.ok === false ? (
                <span style={{ color: '#C62828' }}>{convertResult.error}</span>
              ) : (
                <>
                  <strong>{convertResult.dry_run ? 'Dry run' : 'Conversion'}:</strong>{' '}
                  processed {convertResult.summary?.processed}, created{' '}
                  {convertResult.summary?.created_count}, skipped{' '}
                  {convertResult.summary?.skipped_count}, errors{' '}
                  {convertResult.summary?.error_count}.
                </>
              )}
            </div>
          )}
        </div>
      )}

      {accounts.length === 0 ? (
        <div className="dashboard-card" style={{ padding: '24px', textAlign: 'center', color: '#666' }}>
          No bank accounts yet. {parked && parked.still_unlinked > 0 && 'Use the converter above to create them from the parked AppFolio GLs.'}
        </div>
      ) : (
        <div className="dashboard-card" style={{ padding: 0, overflow: 'hidden' }}>
          <style>{`
            .ba-list { display: flex; flex-direction: column; }
            .ba-row {
              display: grid;
              grid-template-columns: 70px 1fr 130px 110px;
              gap: 12px;
              padding: 12px 14px;
              border-bottom: 1px solid #F0F0F0;
              align-items: center;
              border-left: 3px solid transparent;
            }
            .ba-row:last-child { border-bottom: 0; }
            .ba-row-checking      { border-left-color: #1565C0; }
            .ba-row-savings       { border-left-color: #1565C0; }
            .ba-row-money_market  { border-left-color: #1565C0; }
            .ba-row-investment    { border-left-color: #6A1B9A; }
            .ba-row-credit_card   { border-left-color: #C62828; }
            .ba-code  { font-family: monospace; font-weight: 600; font-size: 13px; }
            .ba-name  { font-weight: 600; font-size: 14px; }
            .ba-meta  { color: #666; font-size: 12px; margin-top: 2px; }
            .ba-meta code { font-family: monospace; }
            .ba-balance { text-align: right; font-family: monospace; font-variant-numeric: tabular-nums; font-weight: 600; }
            .ba-plaid { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
            .ba-pill {
              display: inline-block; padding: 2px 8px;
              border-radius: 10px; font-size: 10px; font-weight: 700;
            }
            .ba-pill-linked     { background: #E8F5E9; color: #2E7D32; }
            .ba-pill-reauth     { background: #FFF3E0; color: #E65100; }
            .ba-pill-disconn    { background: #FFEBEE; color: #C62828; }
            .ba-pill-unlinked   { background: #F5F5F5; color: #666; }
            .ba-pill-trust      { background: #6A1B9A; color: #fff; margin-left: 6px; }

            @media (max-width: 720px) {
              .ba-row {
                grid-template-columns: 1fr auto;
                grid-template-areas:
                  "head plaid"
                  "meta balance";
                gap: 4px 8px;
              }
              .ba-cell-code   { display: none; }
              .ba-cell-name   { grid-area: head; }
              .ba-cell-meta   { grid-area: meta; }
              .ba-cell-balance { grid-area: balance; }
              .ba-cell-plaid  { grid-area: plaid; }
              .ba-name { font-size: 15px; }
              .ba-balance { font-size: 14px; }
            }
          `}</style>
          <div className="ba-list">
            {accounts.map((b) => (
              <div key={b.id} className={`ba-row ba-row-${b.account_type}`}>
                <div className="ba-cell-code ba-code">{b.gl_code}</div>
                <div className="ba-cell-name">
                  <div className="ba-name">
                    {b.display_name}
                    {b.is_trust && <span className="ba-pill ba-pill-trust">trust</span>}
                  </div>
                  <div className="ba-meta">
                    <span style={{ textTransform: 'capitalize' }}>{b.account_type.replace('_', ' ')}</span>
                    {b.institution_name && <> · {b.institution_name}</>}
                    {b.account_last4 && <> · <code>****{b.account_last4}</code></>}
                  </div>
                </div>
                <div className="ba-cell-balance ba-balance">
                  {formatCents(b.current_balance_cents)}
                </div>
                <div className="ba-cell-plaid ba-plaid">
                  <span className={
                    b.plaid_status === 'linked'           ? 'ba-pill ba-pill-linked' :
                    b.plaid_status === 're_auth_required' ? 'ba-pill ba-pill-reauth' :
                    b.plaid_status === 'disconnected'     ? 'ba-pill ba-pill-disconn' :
                                                            'ba-pill ba-pill-unlinked'
                  }>
                    {b.plaid_status}
                  </span>
                  {b.plaid_status === 'linked' && (
                    <SyncTransactionsButton token={token} bankAccountId={b.id} onTokenInvalid={onTokenInvalid} />
                  )}
                  {b.plaid_status === 're_auth_required' && (
                    <PlaidRelinkButton
                      token={token}
                      bankAccountId={b.id}
                      onRelinked={load}
                      onTokenInvalid={onTokenInvalid}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Receivables tab ──────────────────────────────────────────────

function ReceivablesTab({ token, onTokenInvalid }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL('/api/admin/list-posted-charges', window.location.origin);
      url.searchParams.set('secret', token);
      if (statusFilter) url.searchParams.set('status', statusFilter);
      const res = await fetch(url.toString());
      if (res.status === 401) { onTokenInvalid(); return; }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      setData(await res.json());
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [token, statusFilter, onTokenInvalid]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ padding: '24px', color: '#666' }}>Loading...</div>;
  if (error) {
    return (
      <div className="dashboard-card" style={{ padding: '16px', background: '#FFEBEE', color: '#C62828' }}>
        <strong>Failed to load:</strong> {error}
      </div>
    );
  }
  const charges = data?.charges || [];

  return (
    <div>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          style={{
            padding: '8px 10px', border: '1px solid #ddd',
            borderRadius: '6px', fontSize: '13px', background: 'white',
          }}
        >
          <option value="">All non-voided</option>
          <option value="open">Open</option>
          <option value="partially_paid">Partially paid</option>
          <option value="paid">Paid</option>
          <option value="voided">Voided</option>
        </select>
        <button
          type="button"
          onClick={load}
          className="btn-secondary"
          style={{ padding: '6px 12px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      {data?.summary_by_status && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
          {data.summary_by_status.map((s) => (
            <Pill
              key={s.status}
              label={s.status}
              value={`${s.count} (${formatCents(s.total_balance_cents)} owed)`}
              bg={s.status === 'paid' ? '#E8F5E9' : s.status === 'voided' ? '#F5F5F5' : '#FFF3E0'}
              fg={s.status === 'paid' ? '#2E7D32' : s.status === 'voided' ? '#888' : '#E65100'}
            />
          ))}
        </div>
      )}

      {charges.length === 0 ? (
        <div className="dashboard-card" style={{ padding: '24px', textAlign: 'center', color: '#666' }}>
          No posted charges yet. Hit <code>/api/admin/ar-happy-path</code> to fire the smoke-test scheduled charge.
        </div>
      ) : (
        <div className="dashboard-card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="properties-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Due</th>
                <th>Tenant</th>
                <th>Lease</th>
                <th>Type</th>
                <th>Description</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th style={{ textAlign: 'right' }}>Balance</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {charges.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{c.due_date}</td>
                  <td>{c.tenant_display || <span style={{ color: '#bbb' }}>—</span>}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{c.lease_number || '—'}</td>
                  <td>{c.charge_type}</td>
                  <td style={{ color: '#555', fontSize: '13px' }}>{c.description}</td>
                  <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{formatCents(c.amount_cents)}</td>
                  <td style={{
                    textAlign: 'right', fontFamily: 'monospace',
                    color: c.balance_cents === 0 ? '#999' : '#222',
                  }}>
                    {formatCents(c.balance_cents)}
                  </td>
                  <td>
                    <span style={{
                      display: 'inline-block', padding: '2px 8px', borderRadius: '10px',
                      background: c.status === 'paid' ? '#E8F5E9' :
                                  c.status === 'voided' ? '#F5F5F5' :
                                  c.status === 'partially_paid' ? '#FFF3E0' : '#E3F2FD',
                      color: c.status === 'paid' ? '#2E7D32' :
                             c.status === 'voided' ? '#888' :
                             c.status === 'partially_paid' ? '#E65100' : '#1565C0',
                      fontSize: '11px', fontWeight: 600,
                    }}>
                      {c.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Journal Entries tab ──────────────────────────────────────────

function JournalEntriesTab({ token, onTokenInvalid }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL('/api/admin/list-journal-entries', window.location.origin);
      url.searchParams.set('secret', token);
      url.searchParams.set('include_lines', 'true');
      url.searchParams.set('limit', '100');
      const res = await fetch(url.toString());
      if (res.status === 401) { onTokenInvalid(); return; }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      setData(await res.json());
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [token, onTokenInvalid]);

  useEffect(() => { load(); }, [load]);

  const toggle = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (loading) return <div style={{ padding: '24px', color: '#666' }}>Loading...</div>;
  if (error) {
    return (
      <div className="dashboard-card" style={{ padding: '16px', background: '#FFEBEE', color: '#C62828' }}>
        <strong>Failed to load:</strong> {error}
      </div>
    );
  }
  const entries = data?.entries || [];

  return (
    <div>
      <div style={{ marginBottom: '12px' }}>
        <button
          type="button"
          onClick={load}
          className="btn-secondary"
          style={{ padding: '6px 12px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          <RefreshCw size={14} />
          Refresh
        </button>
        <span style={{ marginLeft: '8px', fontSize: '13px', color: '#666' }}>
          {entries.length} most recent {entries.length === 100 ? '(limited)' : ''}
        </span>
      </div>

      {entries.length === 0 ? (
        <div className="dashboard-card" style={{ padding: '24px', textAlign: 'center', color: '#666' }}>
          No journal entries yet.
        </div>
      ) : (
        <div className="dashboard-card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="properties-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ width: '50px' }}>#</th>
                <th>Date</th>
                <th>Type</th>
                <th>Memo</th>
                <th style={{ textAlign: 'right' }}>Total</th>
                <th>Status</th>
                <th>Lines</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const isExpanded = expanded.has(e.id);
                return (
                  <>
                    <tr
                      key={e.id}
                      onClick={() => toggle(e.id)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>{e.entry_number}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{e.entry_date}</td>
                      <td style={{ fontSize: '12px' }}>{e.entry_type}</td>
                      <td style={{ color: '#555', fontSize: '13px' }}>{e.memo || '—'}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>
                        {formatCents(e.total_debit_cents)}
                      </td>
                      <td>
                        <span style={{
                          display: 'inline-block', padding: '2px 8px', borderRadius: '10px',
                          background: e.status === 'posted' ? '#E8F5E9' :
                                      e.status === 'reversed' ? '#FFF3E0' : '#F5F5F5',
                          color: e.status === 'posted' ? '#2E7D32' :
                                 e.status === 'reversed' ? '#E65100' : '#888',
                          fontSize: '11px', fontWeight: 600,
                        }}>
                          {e.status}
                        </span>
                      </td>
                      <td style={{ fontSize: '12px', color: '#666' }}>
                        {e.line_count} {isExpanded ? '▾' : '▸'}
                      </td>
                    </tr>
                    {isExpanded && e.lines && (
                      <tr key={`${e.id}-lines`}>
                        <td colSpan="7" style={{ background: '#FAFAFA', padding: '0' }}>
                          <table style={{ width: '100%' }}>
                            <thead>
                              <tr style={{ background: '#F0F0F0', fontSize: '11px' }}>
                                <th style={{ padding: '4px 12px' }}>#</th>
                                <th style={{ padding: '4px 12px' }}>GL</th>
                                <th style={{ padding: '4px 12px' }}>Memo</th>
                                <th style={{ padding: '4px 12px', textAlign: 'right' }}>Debit</th>
                                <th style={{ padding: '4px 12px', textAlign: 'right' }}>Credit</th>
                              </tr>
                            </thead>
                            <tbody>
                              {e.lines.map((l) => (
                                <tr key={l.id} style={{ fontSize: '12px' }}>
                                  <td style={{ padding: '4px 12px', fontFamily: 'monospace', color: '#888' }}>{l.line_number}</td>
                                  <td style={{ padding: '4px 12px', fontFamily: 'monospace' }}>
                                    {l.gl_code} <span style={{ color: '#888' }}>· {l.gl_name}</span>
                                  </td>
                                  <td style={{ padding: '4px 12px', color: '#555' }}>{l.memo || '—'}</td>
                                  <td style={{ padding: '4px 12px', textAlign: 'right', fontFamily: 'monospace' }}>
                                    {l.debit_cents > 0 ? formatCents(l.debit_cents) : ''}
                                  </td>
                                  <td style={{ padding: '4px 12px', textAlign: 'right', fontFamily: 'monospace' }}>
                                    {l.credit_cents > 0 ? formatCents(l.credit_cents) : ''}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Plaid link button ────────────────────────────────────────────

function PlaidLinkButton({ token, onLinked, onTokenInvalid }) {
  const [linkToken, setLinkToken] = useState(null);
  const [error, setError] = useState(null);
  const [linking, setLinking] = useState(false);
  const [plaidUnavailable, setPlaidUnavailable] = useState(false);

  // Fetch a Plaid Link token on demand.
  const fetchLinkToken = useCallback(async () => {
    try {
      const url = new URL('/api/admin/plaid-link-token', window.location.origin);
      url.searchParams.set('secret', token);
      const res = await fetch(url.toString());
      if (res.status === 401) { onTokenInvalid(); return null; }
      const json = await res.json();
      if (!json.ok) {
        if (json.error?.includes('not configured')) {
          setPlaidUnavailable(true);
        } else {
          setError(json.error || 'failed to get link token');
        }
        return null;
      }
      setLinkToken(json.link_token);
      return json.link_token;
    } catch (err) {
      setError(err.message || String(err));
      return null;
    }
  }, [token, onTokenInvalid]);

  const onPlaidSuccess = useCallback(async (public_token, metadata) => {
    setLinking(true);
    setError(null);
    try {
      const url = new URL('/api/admin/plaid-exchange-public-token', window.location.origin);
      url.searchParams.set('secret', token);
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public_token, metadata }),
      });
      if (res.status === 401) { onTokenInvalid(); return; }
      const json = await res.json();
      if (!json.ok) {
        setError(json.error || 'exchange failed');
        return;
      }
      onLinked();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLinking(false);
      setLinkToken(null);
    }
  }, [token, onLinked, onTokenInvalid]);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: onPlaidSuccess,
    onExit: () => setLinkToken(null),
  });

  // Auto-open Plaid Link as soon as we receive a token.
  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  const onClick = async () => {
    setError(null);
    if (linkToken) { open(); return; }
    await fetchLinkToken();
  };

  if (plaidUnavailable) {
    return (
      <div className="dashboard-card" style={{
        padding: '12px', marginBottom: '12px',
        background: '#FFF8E1', borderLeft: '4px solid #E65100',
        fontSize: '13px', color: '#555',
      }}>
        <strong>Plaid not configured.</strong> Set <code>PLAID_CLIENT_ID</code>, <code>PLAID_SECRET</code>, <code>PLAID_ENV</code>, and <code>BREEZE_ENCRYPTION_KEY</code> in Vercel env vars to enable linking. Sandbox mode is fine for testing.
      </div>
    );
  }

  return (
    <div style={{ marginBottom: '12px' }}>
      <button
        type="button"
        className="btn-primary"
        onClick={onClick}
        disabled={linking}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: '6px',
          padding: '8px 14px',
        }}
      >
        <Link2 size={14} />
        {linking ? 'Saving…' : 'Link a bank with Plaid'}
      </button>
      {error && (
        <span style={{ marginLeft: '12px', color: '#C62828', fontSize: '12px' }}>
          {error}
        </span>
      )}
    </div>
  );
}

// ── Per-row re-link button (re_auth_required → linked) ─────────

function PlaidRelinkButton({ token, bankAccountId, onRelinked, onTokenInvalid }) {
  const [linkToken, setLinkToken] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const fetchUpdateToken = useCallback(async () => {
    setError(null);
    const url = new URL('/api/admin/plaid-link-token', window.location.origin);
    url.searchParams.set('secret', token);
    try {
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bank_account_id: bankAccountId }),
      });
      if (res.status === 401) { onTokenInvalid(); return null; }
      const json = await res.json();
      if (!json.ok) {
        setError(json.error || 'failed to get update-mode link token');
        return null;
      }
      setLinkToken(json.link_token);
      return json.link_token;
    } catch (err) {
      setError(err.message || String(err));
      return null;
    }
  }, [token, bankAccountId, onTokenInvalid]);

  const onSuccess = useCallback(async () => {
    setBusy(true);
    try {
      const url = new URL('/api/admin/plaid-relink-complete', window.location.origin);
      url.searchParams.set('secret', token);
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bank_account_id: bankAccountId }),
      });
      if (res.status === 401) { onTokenInvalid(); return; }
      const json = await res.json();
      if (!json.ok) {
        setError(json.error || 'relink-complete failed');
        return;
      }
      onRelinked();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
      setLinkToken(null);
    }
  }, [token, bankAccountId, onRelinked, onTokenInvalid]);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onExit: () => setLinkToken(null),
  });

  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
      <button
        type="button"
        onClick={fetchUpdateToken}
        disabled={busy}
        title="Plaid lost authentication for this bank. Re-link to resume syncing."
        style={{
          padding: '4px 10px', fontSize: '12px', borderRadius: '6px',
          border: '1px solid #E65100', background: '#FFF3E0', color: '#E65100',
          cursor: busy ? 'not-allowed' : 'pointer', fontWeight: 600,
          display: 'inline-flex', alignItems: 'center', gap: '4px',
        }}
      >
        <Link2 size={12} />
        {busy ? 'Re-linking…' : 'Re-link'}
      </button>
      {error && (
        <span style={{ color: '#C62828', fontSize: '11px' }} title={error}>
          ⚠ failed
        </span>
      )}
    </span>
  );
}

// ── Per-row sync button ──────────────────────────────────────────

function SyncTransactionsButton({ token, bankAccountId, onTokenInvalid }) {
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState(null);

  const onClick = async () => {
    setSyncing(true);
    setResult(null);
    try {
      const url = new URL('/api/admin/plaid-sync-transactions', window.location.origin);
      url.searchParams.set('secret', token);
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bank_account_id: bankAccountId }),
      });
      if (res.status === 401) { onTokenInvalid(); return; }
      const json = await res.json();
      if (!json.ok) {
        setResult({ error: json.error });
        return;
      }
      const summary = json.synced?.[0];
      setResult({
        added: summary?.added ?? 0,
        inserted: summary?.inserted_count ?? 0,
      });
    } catch (err) {
      setResult({ error: err.message || String(err) });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <span style={{ marginLeft: '6px' }}>
      <button
        type="button"
        onClick={onClick}
        disabled={syncing}
        title="Pull latest transactions from Plaid"
        style={{
          padding: '2px 8px', fontSize: '10px',
          border: '1px solid #ddd', borderRadius: '8px',
          background: 'white', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: '2px',
        }}
      >
        <Download size={9} />
        {syncing ? 'syncing…' : 'sync'}
      </button>
      {result && (
        <span style={{ marginLeft: '4px', fontSize: '10px', color: result.error ? '#C62828' : '#666' }}>
          {result.error || `+${result.inserted}`}
        </span>
      )}
    </span>
  );
}

// ── Reconciliation tab ──────────────────────────────────────────

function ReconciliationTab({ token, onTokenInvalid }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL('/api/admin/list-pending-reconciliation', window.location.origin);
      url.searchParams.set('secret', token);
      const res = await fetch(url.toString());
      if (res.status === 401) { onTokenInvalid(); return; }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      setData(await res.json());
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [token, onTokenInvalid]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ padding: '24px', color: '#666' }}>Loading...</div>;
  if (error) {
    return (
      <div className="dashboard-card" style={{ padding: '16px', background: '#FFEBEE', color: '#C62828' }}>
        <strong>Failed to load:</strong> {error}
      </div>
    );
  }

  const txns = data?.transactions || [];

  return (
    <div>
      <style>{`
        .recon-intro {
          background: linear-gradient(135deg, #F3E5F5 0%, #E8EAF6 100%);
          border-left: 3px solid #6A1B9A;
          padding: 14px 16px; border-radius: 8px;
          margin-bottom: 12px; font-size: 13px; color: #444;
        }
        .recon-txn-card {
          padding: 12px 14px; border-bottom: 1px solid #F0F0F0;
        }
        .recon-txn-card:last-child { border-bottom: 0; }
        .recon-txn-head {
          display: flex; justify-content: space-between;
          align-items: baseline; gap: 8px; flex-wrap: wrap;
        }
        .recon-txn-merchant { font-weight: 600; font-size: 14px; color: #1A1A1A; }
        .recon-txn-amount {
          font-family: monospace; font-weight: 700; font-size: 15px;
          font-variant-numeric: tabular-nums;
        }
        .recon-txn-amount-out { color: #C62828; }
        .recon-txn-amount-in  { color: #2E7D32; }
        .recon-txn-meta { color: #777; font-size: 12px; margin-top: 2px; }
        .recon-txn-desc {
          color: #555; font-size: 12px; margin-top: 4px;
          font-family: monospace; word-break: break-word;
        }
        .recon-input-row { display: flex; gap: 8px; margin-top: 10px; align-items: stretch; }
        .recon-input {
          flex: 1; padding: 8px 12px; border: 1px solid #ddd;
          border-radius: 6px; font-size: 13px; font-family: inherit;
        }
        .recon-input:focus { border-color: #6A1B9A; outline: none; }
        .recon-submit {
          padding: 8px 14px; border: none; border-radius: 6px;
          background: #6A1B9A; color: white; font-weight: 600;
          font-size: 13px; cursor: pointer; display: inline-flex;
          align-items: center; gap: 6px; white-space: nowrap;
        }
        .recon-submit:disabled { background: #BBB; cursor: not-allowed; }
        .recon-candidate {
          margin-top: 10px; padding: 8px 12px; border-radius: 6px;
          background: #F3E5F5; border-left: 3px solid #6A1B9A;
        }
        .recon-candidate-actions {
          display: flex; gap: 6px; margin-top: 8px;
        }
        .recon-btn {
          padding: 4px 10px; font-size: 12px; border-radius: 6px;
          border: 1px solid; cursor: pointer; display: inline-flex;
          align-items: center; gap: 4px;
        }
        .recon-btn-confirm {
          background: #2E7D32; color: white; border-color: #2E7D32;
        }
        .recon-btn-reject {
          background: white; color: #C62828; border-color: #C62828;
        }
      `}</style>

      <div className="recon-intro">
        <strong style={{ color: '#6A1B9A' }}>
          <Sparkles size={14} style={{ verticalAlign: '-2px' }} /> AI-assisted reconciliation
        </strong>
        <p style={{ margin: '6px 0 0' }}>
          For each unreconciled bank transaction, type a one-line explanation
          ("plumber for SLM units" / "monthly software bill") and Claude generates
          a reusable rule that auto-categorizes similar future transactions. Rules
          earn auto-trust as they're confirmed; rules rejected 3+ times auto-disable.
        </p>
      </div>

      <div style={{ marginBottom: '8px' }}>
        <button
          type="button"
          onClick={load}
          className="btn-secondary"
          style={{ padding: '6px 12px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          <RefreshCw size={14} />
          Refresh
        </button>
        <span style={{ marginLeft: '8px', fontSize: '13px', color: '#666' }}>
          {txns.length} transaction{txns.length === 1 ? '' : 's'} awaiting review
        </span>
      </div>

      {txns.length === 0 ? (
        <div className="dashboard-card" style={{ padding: '24px', textAlign: 'center', color: '#666' }}>
          No transactions waiting on reconciliation. Sync a Plaid-linked bank account
          to pull fresh ones.
        </div>
      ) : (
        <div className="dashboard-card" style={{ padding: 0, overflow: 'hidden' }}>
          {txns.map((t) => (
            <ReconTxnRow
              key={t.id}
              txn={t}
              token={token}
              onTokenInvalid={onTokenInvalid}
              onChanged={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ReconTxnRow({ txn, token, onTokenInvalid, onChanged }) {
  const [oneLiner, setOneLiner] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resultMsg, setResultMsg] = useState(null);

  const submit = async () => {
    if (!oneLiner.trim()) return;
    setSubmitting(true);
    setResultMsg(null);
    try {
      const url = new URL('/api/admin/explain-and-rule', window.location.origin);
      url.searchParams.set('secret', token);
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bank_transaction_id: txn.id,
          one_liner: oneLiner.trim(),
        }),
      });
      if (res.status === 401) { onTokenInvalid(); return; }
      const json = await res.json();
      if (!json.ok) {
        setResultMsg({ error: json.error || 'rule generation failed' });
        return;
      }
      setResultMsg({
        success: true,
        ruleName: json.rule.name,
        glAccount: json.rule.target?.gl_account_code,
        confidence: json.rule.initial_confidence,
        explanation: json.rule.explanation,
        candidateId: json.candidate?.candidate_id,
      });
      setOneLiner('');
      onChanged();
    } catch (err) {
      setResultMsg({ error: err.message || String(err) });
    } finally {
      setSubmitting(false);
    }
  };

  const candidateAction = async (candidateId, action) => {
    const url = new URL('/api/admin/match-candidate-action', window.location.origin);
    url.searchParams.set('secret', token);
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidate_id: candidateId, action }),
    });
    if (res.status === 401) { onTokenInvalid(); return; }
    onChanged();
  };

  // Plaid sign convention: positive = money OUT (debit) of the
  // bank, negative = money IN (credit). Render with $ sign and a
  // visual cue.
  const isOutflow = Number(txn.amount_cents) > 0;
  const dollars = (Math.abs(Number(txn.amount_cents)) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });

  return (
    <div className="recon-txn-card">
      <div className="recon-txn-head">
        <div>
          <div className="recon-txn-merchant">
            {txn.merchant_name || txn.description || '(no description)'}
          </div>
          <div className="recon-txn-meta">
            {txn.posted_date} · {txn.bank_account_name || '(unknown bank)'}
            {txn.pending && (
              <span style={{
                marginLeft: 6, padding: '1px 6px', borderRadius: 8,
                background: '#FFF3E0', color: '#E65100',
                fontSize: 10, fontWeight: 600,
              }}>pending</span>
            )}
          </div>
        </div>
        <div className={
          'recon-txn-amount ' +
          (isOutflow ? 'recon-txn-amount-out' : 'recon-txn-amount-in')
        }>
          {isOutflow ? '−' : '+'}${dollars}
        </div>
      </div>
      {txn.description && txn.description !== txn.merchant_name && (
        <div className="recon-txn-desc">{txn.description}</div>
      )}

      {/* Existing candidates from prior rule matches */}
      {txn.candidates.length > 0 && txn.candidates.map((c) => (
        <div key={c.id} className="recon-candidate">
          <div style={{ fontSize: '12px' }}>
            <strong>Auto-match candidate</strong>
            {' · '}confidence {(c.confidence_score * 100).toFixed(0)}%
            {' · '}status: {c.status}
          </div>
          <div style={{ fontSize: '11px', color: '#666', marginTop: 2 }}>
            Reasons: {(c.match_reason_codes || []).join(', ')}
          </div>
          {c.status !== 'confirmed' && c.status !== 'rejected' && (
            <div className="recon-candidate-actions">
              <button
                type="button"
                className="recon-btn recon-btn-confirm"
                onClick={() => candidateAction(c.id, 'confirm')}
              >
                <Check size={11} /> Confirm
              </button>
              <button
                type="button"
                className="recon-btn recon-btn-reject"
                onClick={() => candidateAction(c.id, 'reject')}
              >
                <X size={11} /> Reject
              </button>
            </div>
          )}
        </div>
      ))}

      {/* Natural-language input */}
      <div className="recon-input-row">
        <input
          type="text"
          value={oneLiner}
          onChange={(e) => setOneLiner(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          disabled={submitting}
          placeholder="Tell me what this is, e.g. 'plumber for SLM units, all repairs'"
          className="recon-input"
        />
        <button
          type="button"
          onClick={submit}
          disabled={submitting || !oneLiner.trim()}
          className="recon-submit"
          title="Generate a rule from this explanation"
        >
          <Sparkles size={13} />
          {submitting ? 'Thinking…' : 'Categorize'}
        </button>
      </div>

      {resultMsg && (
        <div style={{
          marginTop: 8, padding: '8px 10px', borderRadius: 6,
          background: resultMsg.error ? '#FFEBEE' : '#E8F5E9',
          fontSize: 12,
          color: resultMsg.error ? '#C62828' : '#2E7D32',
        }}>
          {resultMsg.error ? (
            <>Failed: {resultMsg.error}</>
          ) : (
            <>
              <strong>Rule created: {resultMsg.ruleName}</strong>
              {' · '}GL {resultMsg.glAccount}
              {' · '}confidence {(resultMsg.confidence * 100).toFixed(0)}%
              <div style={{ marginTop: 4, color: '#555' }}>{resultMsg.explanation}</div>
              <div style={{ marginTop: 4, color: '#888' }}>
                Refresh — the rule is now active and will auto-suggest matches for similar transactions going forward.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Rules tab ───────────────────────────────────────────────────

function RulesTab({ token, onTokenInvalid }) {
  const [rules, setRules] = useState([]);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showInactive, setShowInactive] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rulesUrl = new URL('/api/admin/list-match-rules', window.location.origin);
      rulesUrl.searchParams.set('secret', token);
      if (showInactive) rulesUrl.searchParams.set('include_inactive', 'true');
      const settingsUrl = new URL('/api/admin/recon-settings', window.location.origin);
      settingsUrl.searchParams.set('secret', token);

      const [rulesRes, settingsRes] = await Promise.all([
        fetch(rulesUrl.toString()),
        fetch(settingsUrl.toString()),
      ]);
      if (rulesRes.status === 401 || settingsRes.status === 401) {
        onTokenInvalid();
        return;
      }
      if (!rulesRes.ok) throw new Error(`list-match-rules HTTP ${rulesRes.status}`);
      if (!settingsRes.ok) throw new Error(`recon-settings HTTP ${settingsRes.status}`);
      const rulesJson = await rulesRes.json();
      const settingsJson = await settingsRes.json();
      setRules(rulesJson.rules || []);
      setSettings({
        autoMatchConfidence: settingsJson.auto_match_confidence,
        autoMatchMinTimesUsed: settingsJson.auto_match_min_times_used,
      });
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [token, onTokenInvalid, showInactive]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ padding: '24px', color: '#666' }}>Loading...</div>;
  if (error) {
    return (
      <div className="dashboard-card" style={{ padding: '16px', background: '#FFEBEE', color: '#C62828' }}>
        <strong>Failed to load:</strong> {error}
      </div>
    );
  }

  return (
    <div>
      <ReconSettingsCard
        settings={settings}
        token={token}
        onSaved={load}
        onTokenInvalid={onTokenInvalid}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', margin: '12px 0 8px' }}>
        <button
          type="button"
          onClick={load}
          className="btn-secondary"
          style={{ padding: '6px 12px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          <RefreshCw size={14} /> Refresh
        </button>
        <span style={{ fontSize: '13px', color: '#666' }}>
          {rules.length} rule{rules.length === 1 ? '' : 's'}
        </span>
        <label style={{ marginLeft: 'auto', fontSize: '13px', color: '#555', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Show inactive
        </label>
      </div>

      {rules.length === 0 ? (
        <div className="dashboard-card" style={{ padding: '24px', textAlign: 'center', color: '#666' }}>
          No rules yet. Rules are created from the <strong>Reconciliation</strong> tab — type a one-line
          explanation of any pending bank transaction and Claude generates one.
        </div>
      ) : (
        <div className="dashboard-card" style={{ padding: 0, overflow: 'hidden' }}>
          {rules.map((r) => (
            <RuleRow
              key={r.id}
              rule={r}
              token={token}
              onChanged={load}
              onTokenInvalid={onTokenInvalid}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ReconSettingsCard({ settings, token, onSaved, onTokenInvalid }) {
  const [confidence, setConfidence] = useState(settings?.autoMatchConfidence ?? 0.95);
  const [minTimesUsed, setMinTimesUsed] = useState(settings?.autoMatchMinTimesUsed ?? 5);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  // Sync from props when parent reloads.
  useEffect(() => {
    if (settings) {
      setConfidence(settings.autoMatchConfidence);
      setMinTimesUsed(settings.autoMatchMinTimesUsed);
    }
  }, [settings]);

  const dirty =
    settings &&
    (Number(confidence) !== Number(settings.autoMatchConfidence) ||
      Number(minTimesUsed) !== Number(settings.autoMatchMinTimesUsed));

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const url = new URL('/api/admin/recon-settings', window.location.origin);
      url.searchParams.set('secret', token);
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auto_match_confidence: Number(confidence),
          auto_match_min_times_used: Number(minTimesUsed),
        }),
      });
      if (res.status === 401) { onTokenInvalid(); return; }
      const json = await res.json();
      if (!json.ok) {
        setMsg({ error: json.error || 'save failed' });
        return;
      }
      setMsg({ success: true });
      onSaved();
    } catch (err) {
      setMsg({ error: err.message || String(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dashboard-card" style={{ padding: '14px 16px', background: 'linear-gradient(135deg, #F3E5F5 0%, #E8EAF6 100%)', borderLeft: '3px solid #6A1B9A' }}>
      <div style={{ fontSize: '14px', fontWeight: 600, color: '#6A1B9A', marginBottom: '4px' }}>
        <Sparkles size={14} style={{ verticalAlign: '-2px', marginRight: '4px' }} />
        Auto-match thresholds
      </div>
      <div style={{ fontSize: '12px', color: '#555', marginBottom: '10px' }}>
        A pending candidate is auto-matched (skips human review) when its confidence is at least
        the threshold AND its rule has been confirmed at least the minimum number of times.
        Lower these to ramp auto-trust faster; raise them for stricter review.
      </div>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: '12px', color: '#444' }}>
          Confidence threshold (0–1)
          <input
            type="number"
            min="0"
            max="1"
            step="0.01"
            value={confidence}
            onChange={(e) => setConfidence(e.target.value)}
            style={{ padding: '6px 10px', border: '1px solid #ccc', borderRadius: '6px', width: '120px', marginTop: '2px' }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: '12px', color: '#444' }}>
          Min rule uses
          <input
            type="number"
            min="0"
            step="1"
            value={minTimesUsed}
            onChange={(e) => setMinTimesUsed(e.target.value)}
            style={{ padding: '6px 10px', border: '1px solid #ccc', borderRadius: '6px', width: '120px', marginTop: '2px' }}
          />
        </label>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          style={{
            padding: '8px 16px',
            background: !dirty || saving ? '#BBB' : '#6A1B9A',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            fontWeight: 600,
            fontSize: '13px',
            cursor: !dirty || saving ? 'not-allowed' : 'pointer',
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {msg && (
          <span style={{ fontSize: '12px', color: msg.error ? '#C62828' : '#2E7D32', marginLeft: '8px' }}>
            {msg.error ? `Failed: ${msg.error}` : 'Saved'}
          </span>
        )}
      </div>
    </div>
  );
}

function RuleRow({ rule, token, onChanged, onTokenInvalid }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const action = async (act) => {
    if (act === 'delete' && !window.confirm(`Delete rule "${rule.name}"? This cannot be undone.`)) {
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const url = new URL('/api/admin/match-rule-action', window.location.origin);
      url.searchParams.set('secret', token);
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rule_id: rule.id, action: act }),
      });
      if (res.status === 401) { onTokenInvalid(); return; }
      const json = await res.json();
      if (!json.ok) {
        setErr(json.error || 'action failed');
        return;
      }
      onChanged();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const target = rule.target || {};
  const confidence = (Number(rule.confidence_score) * 100).toFixed(0);
  const useRate =
    rule.times_used + rule.times_rejected > 0
      ? Math.round((rule.times_used / (rule.times_used + rule.times_rejected)) * 100)
      : null;

  return (
    <div style={{
      padding: '12px 14px',
      borderBottom: '1px solid #F0F0F0',
      opacity: rule.is_active ? 1 : 0.55,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: '200px' }}>
          <div style={{ fontWeight: 600, fontSize: '14px', color: '#1A1A1A' }}>
            {rule.name}
            <span style={{
              marginLeft: '8px',
              padding: '1px 8px',
              borderRadius: '10px',
              fontSize: '10px',
              fontWeight: 600,
              background: rule.is_active ? '#E8F5E9' : '#EEEEEE',
              color: rule.is_active ? '#2E7D32' : '#757575',
              verticalAlign: '2px',
            }}>
              {rule.is_active ? 'active' : 'inactive'}
            </span>
          </div>
          {rule.natural_language_description && (
            <div style={{ fontSize: '12px', color: '#666', fontStyle: 'italic', marginTop: '3px' }}>
              "{rule.natural_language_description}"
            </div>
          )}
          <div style={{ fontSize: '12px', color: '#555', marginTop: '4px' }}>
            <strong>Target:</strong> {target.gl_account_code || '(none)'}
            {' · '}
            <strong>Confidence:</strong> {confidence}%
            {' · '}
            <strong>Used:</strong> {rule.times_used}
            {' · '}
            <strong>Rejected:</strong> {rule.times_rejected}
            {useRate !== null && ` (${useRate}% accept rate)`}
            {rule.last_matched_at && (
              <>
                {' · '}
                <strong>Last match:</strong> {new Date(rule.last_matched_at).toLocaleDateString()}
              </>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => action(rule.is_active ? 'disable' : 'enable')}
            disabled={busy}
            title={rule.is_active ? 'Stop applying this rule' : 'Resume applying this rule'}
            style={{
              padding: '6px 10px', fontSize: '12px', borderRadius: '6px',
              border: '1px solid #999', background: 'white', color: '#444',
              cursor: busy ? 'not-allowed' : 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: '4px',
            }}
          >
            <Power size={12} />
            {rule.is_active ? 'Disable' : 'Enable'}
          </button>
          <button
            type="button"
            onClick={() => action('delete')}
            disabled={busy}
            title="Delete this rule (historical candidates remain)"
            style={{
              padding: '6px 10px', fontSize: '12px', borderRadius: '6px',
              border: '1px solid #C62828', background: 'white', color: '#C62828',
              cursor: busy ? 'not-allowed' : 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: '4px',
            }}
          >
            <Trash2 size={12} />
            Delete
          </button>
        </div>
      </div>
      {err && (
        <div style={{ marginTop: '6px', padding: '6px 10px', background: '#FFEBEE', color: '#C62828', borderRadius: '4px', fontSize: '12px' }}>
          {err}
        </div>
      )}
    </div>
  );
}

// ── Entities tab ────────────────────────────────────────────────

const ENTITY_TYPE_LABELS = {
  llc: 'LLC',
  corp: 'Corporation',
  partnership: 'Partnership',
  sole_prop: 'Sole Proprietorship',
  trust: 'Trust',
  individual: 'Individual',
};

function EntitiesTab({ token, onTokenInvalid }) {
  const [entities, setEntities] = useState([]);
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [showInactive, setShowInactive] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const eUrl = new URL('/api/admin/list-entities', window.location.origin);
      eUrl.searchParams.set('secret', token);
      if (showInactive) eUrl.searchParams.set('include_inactive', 'true');
      const pUrl = new URL('/api/admin/list-properties-with-entity', window.location.origin);
      pUrl.searchParams.set('secret', token);
      const [eRes, pRes] = await Promise.all([
        fetch(eUrl.toString()),
        fetch(pUrl.toString()),
      ]);
      if (eRes.status === 401 || pRes.status === 401) { onTokenInvalid(); return; }
      if (!eRes.ok) throw new Error(`list-entities HTTP ${eRes.status}`);
      if (!pRes.ok) throw new Error(`list-properties-with-entity HTTP ${pRes.status}`);
      const eJson = await eRes.json();
      const pJson = await pRes.json();
      setEntities(eJson.entities || []);
      setProperties(pJson.properties || []);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [token, onTokenInvalid, showInactive]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ padding: '24px', color: '#666' }}>Loading...</div>;
  if (error) {
    return (
      <div className="dashboard-card" style={{ padding: '16px', background: '#FFEBEE', color: '#C62828' }}>
        <strong>Failed to load:</strong> {error}
      </div>
    );
  }

  const unassigned = properties.filter((p) => !p.entity_id);

  return (
    <div>
      <div className="dashboard-card" style={{ padding: '14px 16px', background: 'linear-gradient(135deg, #E3F2FD 0%, #E8EAF6 100%)', borderLeft: '3px solid #1565C0' }}>
        <div style={{ fontSize: '14px', fontWeight: 600, color: '#1565C0', marginBottom: '4px' }}>
          <Building2 size={14} style={{ verticalAlign: '-2px', marginRight: '4px' }} />
          Legal entities
        </div>
        <div style={{ fontSize: '12px', color: '#555' }}>
          Each LLC, partnership, or other legal entity that owns one or more properties.
          Journal lines tag the entity_id (resolved from the property automatically) so
          P&amp;L and tax statements can be produced per-entity. Consolidated reports sum
          across entities.
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', margin: '12px 0 8px' }}>
        <button
          type="button"
          onClick={load}
          className="btn-secondary"
          style={{ padding: '6px 12px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          <RefreshCw size={14} /> Refresh
        </button>
        <button
          type="button"
          onClick={() => setEditing('new')}
          style={{
            padding: '6px 14px', background: '#1565C0', color: 'white',
            border: 'none', borderRadius: '6px', fontWeight: 600, fontSize: '13px',
            cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px',
          }}
        >
          <Plus size={14} /> New entity
        </button>
        <span style={{ fontSize: '13px', color: '#666' }}>
          {entities.length} entit{entities.length === 1 ? 'y' : 'ies'}
        </span>
        <label style={{ marginLeft: 'auto', fontSize: '13px', color: '#555', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Show inactive
        </label>
      </div>

      {editing && (
        <EntityEditor
          entity={editing === 'new' ? null : editing}
          token={token}
          onSaved={() => { setEditing(null); load(); }}
          onCancel={() => setEditing(null)}
          onTokenInvalid={onTokenInvalid}
        />
      )}

      {entities.length === 0 ? (
        <div className="dashboard-card" style={{ padding: '24px', textAlign: 'center', color: '#666' }}>
          No entities yet. Click <strong>New entity</strong> to create your first one
          (typically your operating LLC or the entity that holds the property).
        </div>
      ) : (
        <div className="dashboard-card" style={{ padding: 0, overflow: 'hidden' }}>
          {entities.map((e) => (
            <EntityRow
              key={e.id}
              entity={e}
              properties={properties.filter((p) => p.entity_id === e.id)}
              unassignedProperties={unassigned}
              token={token}
              onChanged={load}
              onTokenInvalid={onTokenInvalid}
              onEdit={() => setEditing(e)}
            />
          ))}
        </div>
      )}

      {unassigned.length > 0 && (
        <div className="dashboard-card" style={{ marginTop: '12px', padding: '12px 14px' }}>
          <div style={{ fontWeight: 600, fontSize: '13px', color: '#E65100', marginBottom: '6px' }}>
            <AlertCircle size={13} style={{ verticalAlign: '-2px', marginRight: '4px' }} />
            Properties with no entity ({unassigned.length})
          </div>
          <div style={{ fontSize: '12px', color: '#666' }}>
            Until each property is assigned to an entity, its postings carry a null
            entity_id and don't appear in per-entity reports.
          </div>
          <ul style={{ margin: '8px 0 0', paddingLeft: '20px', fontSize: '12px', color: '#444' }}>
            {unassigned.slice(0, 10).map((p) => (
              <li key={p.id}>{p.display_name} <span style={{ color: '#888' }}>({p.service_city}, {p.service_state})</span></li>
            ))}
            {unassigned.length > 10 && (
              <li style={{ color: '#888' }}>...and {unassigned.length - 10} more</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function EntityRow({ entity, properties, unassignedProperties, token, onChanged, onTokenInvalid, onEdit }) {
  const [addPropOpen, setAddPropOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const assign = async (propertyId, entityId) => {
    setBusy(true);
    try {
      const url = new URL('/api/admin/assign-property-entity', window.location.origin);
      url.searchParams.set('secret', token);
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId, entity_id: entityId }),
      });
      if (res.status === 401) { onTokenInvalid(); return; }
      onChanged();
      setAddPropOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: '14px 16px', borderBottom: '1px solid #F0F0F0', opacity: entity.is_active ? 1 : 0.55 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: '200px' }}>
          <div style={{ fontWeight: 600, fontSize: '15px', color: '#1A1A1A' }}>
            {entity.name}
            <span style={{
              marginLeft: '8px', padding: '1px 8px', borderRadius: '10px',
              fontSize: '10px', fontWeight: 600,
              background: '#E3F2FD', color: '#1565C0', verticalAlign: '2px',
            }}>
              {ENTITY_TYPE_LABELS[entity.entity_type] || entity.entity_type}
            </span>
            {!entity.is_active && (
              <span style={{
                marginLeft: '6px', padding: '1px 8px', borderRadius: '10px',
                fontSize: '10px', fontWeight: 600,
                background: '#EEE', color: '#757575', verticalAlign: '2px',
              }}>inactive</span>
            )}
          </div>
          {entity.legal_name && entity.legal_name !== entity.name && (
            <div style={{ fontSize: '12px', color: '#666', marginTop: '2px' }}>{entity.legal_name}</div>
          )}
          <div style={{ fontSize: '12px', color: '#555', marginTop: '4px' }}>
            {entity.tax_id_last4 && <><strong>EIN:</strong> ***-**-{entity.tax_id_last4} · </>}
            {entity.formation_state && <><strong>State:</strong> {entity.formation_state} · </>}
            <strong>FYE month:</strong> {entity.fiscal_year_end_month}
            {' · '}
            <strong>Properties:</strong> {entity.property_count}
          </div>
        </div>
        <button
          type="button"
          onClick={onEdit}
          style={{
            padding: '6px 12px', fontSize: '12px', borderRadius: '6px',
            border: '1px solid #999', background: 'white', color: '#444',
            cursor: 'pointer',
          }}
        >
          Edit
        </button>
      </div>

      {properties.length > 0 && (
        <div style={{ marginTop: '10px', paddingTop: '8px', borderTop: '1px dashed #EEE' }}>
          <div style={{ fontSize: '11px', color: '#888', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '4px' }}>
            Properties
          </div>
          {properties.map((p) => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', fontSize: '13px' }}>
              <span>
                {p.display_name} <span style={{ color: '#888' }}>({p.service_city}, {p.service_state})</span>
              </span>
              <button
                type="button"
                onClick={() => assign(p.id, null)}
                disabled={busy}
                title="Unassign"
                style={{ background: 'none', border: 'none', color: '#888', cursor: busy ? 'not-allowed' : 'pointer', fontSize: '11px' }}
              >
                unassign
              </button>
            </div>
          ))}
        </div>
      )}

      {entity.is_active && unassignedProperties.length > 0 && (
        <div style={{ marginTop: '8px' }}>
          {!addPropOpen ? (
            <button
              type="button"
              onClick={() => setAddPropOpen(true)}
              style={{ background: 'none', border: 'none', color: '#1565C0', fontSize: '12px', cursor: 'pointer', padding: 0 }}
            >
              + Assign a property to this entity
            </button>
          ) : (
            <select
              onChange={(e) => e.target.value && assign(e.target.value, entity.id)}
              disabled={busy}
              defaultValue=""
              style={{ padding: '5px 8px', fontSize: '12px', borderRadius: '4px', border: '1px solid #BBB' }}
            >
              <option value="" disabled>Choose a property…</option>
              {unassignedProperties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name} ({p.service_city}, {p.service_state})
                </option>
              ))}
            </select>
          )}
        </div>
      )}
    </div>
  );
}

function EntityEditor({ entity, token, onSaved, onCancel, onTokenInvalid }) {
  const [name, setName] = useState(entity?.name || '');
  const [legalName, setLegalName] = useState(entity?.legal_name || '');
  const [entityType, setEntityType] = useState(entity?.entity_type || 'llc');
  const [taxId, setTaxId] = useState('');
  const [formationState, setFormationState] = useState(entity?.formation_state || '');
  const [formationDate, setFormationDate] = useState(entity?.formation_date || '');
  const [fye, setFye] = useState(entity?.fiscal_year_end_month ?? 12);
  const [isActive, setIsActive] = useState(entity?.is_active ?? true);
  const [notes, setNotes] = useState(entity?.notes || '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const save = async () => {
    if (!name.trim()) { setErr('Name is required'); return; }
    setSaving(true);
    setErr(null);
    try {
      const body = {
        id: entity?.id,
        name: name.trim(),
        legal_name: legalName.trim() || null,
        entity_type: entityType,
        formation_state: formationState.trim() || null,
        formation_date: formationDate || null,
        fiscal_year_end_month: Number(fye),
        is_active: isActive,
        notes: notes.trim() || null,
      };
      if (taxId.trim()) body.tax_id = taxId.trim();

      const url = new URL('/api/admin/upsert-entity', window.location.origin);
      url.searchParams.set('secret', token);
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 401) { onTokenInvalid(); return; }
      const json = await res.json();
      if (!json.ok) { setErr(json.error || 'save failed'); return; }
      onSaved();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dashboard-card" style={{ padding: '16px', marginBottom: '12px', border: '2px solid #1565C0' }}>
      <div style={{ fontWeight: 700, fontSize: '14px', marginBottom: '12px', color: '#1565C0' }}>
        {entity ? `Edit ${entity.name}` : 'New entity'}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <EntityField label="Display name *">
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} style={entityInputStyle} />
        </EntityField>
        <EntityField label="Legal name (if different)">
          <input type="text" value={legalName} onChange={(e) => setLegalName(e.target.value)} style={entityInputStyle} />
        </EntityField>
        <EntityField label="Entity type *">
          <select value={entityType} onChange={(e) => setEntityType(e.target.value)} style={entityInputStyle}>
            {Object.entries(ENTITY_TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </EntityField>
        <EntityField label={`EIN / Tax ID ${entity?.tax_id_last4 ? `(currently ending ${entity.tax_id_last4})` : ''}`}>
          <input
            type="text"
            value={taxId}
            onChange={(e) => setTaxId(e.target.value)}
            placeholder={entity?.tax_id_last4 ? 'Leave blank to keep existing' : '12-3456789'}
            style={entityInputStyle}
          />
        </EntityField>
        <EntityField label="Formation state">
          <input type="text" value={formationState} onChange={(e) => setFormationState(e.target.value)} placeholder="DE" maxLength={2} style={entityInputStyle} />
        </EntityField>
        <EntityField label="Formation date">
          <input type="date" value={formationDate} onChange={(e) => setFormationDate(e.target.value)} style={entityInputStyle} />
        </EntityField>
        <EntityField label="Fiscal year-end month">
          <input type="number" min="1" max="12" value={fye} onChange={(e) => setFye(e.target.value)} style={entityInputStyle} />
        </EntityField>
        <EntityField label="Active">
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', paddingTop: '6px' }}>
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            {isActive ? 'Active' : 'Inactive'}
          </label>
        </EntityField>
        <div style={{ gridColumn: 'span 2' }}>
          <EntityField label="Notes">
            <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...entityInputStyle, fontFamily: 'inherit' }} />
          </EntityField>
        </div>
      </div>
      {err && <div style={{ marginTop: '8px', color: '#C62828', fontSize: '12px' }}>Error: {err}</div>}
      <div style={{ marginTop: '12px', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          style={{ padding: '7px 14px', border: '1px solid #999', background: 'white', color: '#444', borderRadius: '6px', fontSize: '13px', cursor: saving ? 'not-allowed' : 'pointer' }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          style={{ padding: '7px 16px', background: saving ? '#BBB' : '#1565C0', color: 'white', border: 'none', borderRadius: '6px', fontWeight: 600, fontSize: '13px', cursor: saving ? 'not-allowed' : 'pointer' }}
        >
          {saving ? 'Saving…' : (entity ? 'Save changes' : 'Create entity')}
        </button>
      </div>
    </div>
  );
}

const entityInputStyle = {
  padding: '7px 10px', border: '1px solid #CCC', borderRadius: '5px',
  fontSize: '13px', width: '100%', boxSizing: 'border-box',
};

function EntityField({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: '12px', color: '#444', gap: '3px' }}>
      <span style={{ fontWeight: 600 }}>{label}</span>
      {children}
    </label>
  );
}

// ── Receipts tab ────────────────────────────────────────────────

function ReceiptsTab({ token, onTokenInvalid }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL('/api/admin/list-receipts', window.location.origin);
      url.searchParams.set('secret', token);
      if (filter !== 'all') url.searchParams.set('deposit_status', filter);
      const res = await fetch(url.toString());
      if (res.status === 401) { onTokenInvalid(); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token, onTokenInvalid, filter]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ padding: 24, color: '#666' }}>Loading…</div>;
  if (error) {
    return (
      <div className="dashboard-card" style={{ padding: 16, background: '#FFEBEE', color: '#C62828' }}>
        <strong>Failed to load:</strong> {error}
      </div>
    );
  }

  const receipts = data?.receipts || [];

  return (
    <div>
      <div style={{
        padding: '14px 16px', marginBottom: 12,
        background: 'linear-gradient(135deg, #FFF3E0 0%, #FFE0B2 100%)',
        borderLeft: '3px solid #E65100', borderRadius: 8,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#E65100', marginBottom: 4 }}>
          <DollarSign size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} />
          Receipts
        </div>
        <div style={{ fontSize: 12, color: '#555' }}>
          Money-in events. Receipts post to Undeposited Funds (1110) until you group them
          into a Deposit on the Deposits tab — that's when cash actually hits the bank GL.
          {' '}
          <strong>Currently undeposited:</strong> {formatCents(data?.undeposited_total_cents || 0)}
          {' '}across {data?.undeposited_count || 0} receipt{data?.undeposited_count === 1 ? '' : 's'}.
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <button
          type="button"
          onClick={load}
          className="btn-secondary"
          style={{ padding: '6px 12px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <RefreshCw size={14} /> Refresh
        </button>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid #CCC', borderRadius: 6, fontSize: 13 }}
        >
          <option value="all">All</option>
          <option value="undeposited">Undeposited only</option>
          <option value="deposited">Deposited only</option>
        </select>
        <span style={{ fontSize: 13, color: '#666' }}>
          {receipts.length} receipt{receipts.length === 1 ? '' : 's'}
        </span>
      </div>

      {receipts.length === 0 ? (
        <div className="dashboard-card" style={{ padding: 24, textAlign: 'center', color: '#666' }}>
          No receipts yet. Receipts are created by the AR happy-path flow or by an
          inbound payment from Plaid / PayNearMe / Modern Treasury when those rails
          land in Stage 4.
        </div>
      ) : (
        <div className="dashboard-card" style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#FAFAFA', borderBottom: '1px solid #E0E0E0' }}>
                <th style={th}>Date</th>
                <th style={th}>Tenant</th>
                <th style={th}>Lease</th>
                <th style={th}>Method</th>
                <th style={th}>Reference</th>
                <th style={{ ...th, textAlign: 'right' }}>Amount</th>
                <th style={th}>Deposit</th>
              </tr>
            </thead>
            <tbody>
              {receipts.map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid #F0F0F0' }}>
                  <td style={td}>{r.received_date}</td>
                  <td style={td}>{r.tenant_display || '—'}</td>
                  <td style={td}>{r.lease_number || '—'}</td>
                  <td style={td}>{r.payment_method}</td>
                  <td style={{ ...td, fontFamily: 'monospace', fontSize: 11 }}>
                    {r.external_reference || '—'}
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>
                    {formatCents(r.amount_cents)}
                  </td>
                  <td style={td}>
                    {r.deposit_id ? (
                      <span style={{
                        padding: '1px 8px', borderRadius: 10, fontSize: 10,
                        fontWeight: 600, background: '#E8F5E9', color: '#2E7D32',
                      }}>deposited</span>
                    ) : (
                      <span style={{
                        padding: '1px 8px', borderRadius: 10, fontSize: 10,
                        fontWeight: 600, background: '#FFF3E0', color: '#E65100',
                      }}>undeposited</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Deposits tab ────────────────────────────────────────────────

function DepositsTab({ token, onTokenInvalid }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL('/api/admin/list-deposits', window.location.origin);
      url.searchParams.set('secret', token);
      const res = await fetch(url.toString());
      if (res.status === 401) { onTokenInvalid(); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token, onTokenInvalid]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ padding: 24, color: '#666' }}>Loading…</div>;
  if (error) {
    return (
      <div className="dashboard-card" style={{ padding: 16, background: '#FFEBEE', color: '#C62828' }}>
        <strong>Failed to load:</strong> {error}
      </div>
    );
  }

  const deposits = data?.deposits || [];

  return (
    <div>
      <div style={{
        padding: '14px 16px', marginBottom: 12,
        background: 'linear-gradient(135deg, #E8F5E9 0%, #C8E6C9 100%)',
        borderLeft: '3px solid #2E7D32', borderRadius: 8,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#2E7D32', marginBottom: 4 }}>
          <Landmark size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} />
          Deposits
        </div>
        <div style={{ fontSize: 12, color: '#555' }}>
          Groups of receipts that hit a bank account on a specific date. Deposits move
          money out of Undeposited Funds and into the bank's GL — matching what shows
          up on the bank statement.
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <button
          type="button"
          onClick={load}
          className="btn-secondary"
          style={{ padding: '6px 12px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <RefreshCw size={14} /> Refresh
        </button>
        <span style={{ fontSize: 13, color: '#666' }}>
          {deposits.length} deposit{deposits.length === 1 ? '' : 's'}
        </span>
      </div>

      {deposits.length === 0 ? (
        <div className="dashboard-card" style={{ padding: 24, textAlign: 'center', color: '#666' }}>
          No deposits yet. Once you have receipts in Undeposited Funds, build a deposit
          by selecting them + assigning a bank account. (Build-deposit form lands in
          the next iteration.)
        </div>
      ) : (
        <div className="dashboard-card" style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#FAFAFA', borderBottom: '1px solid #E0E0E0' }}>
                <th style={th}>Date</th>
                <th style={th}>Bank</th>
                <th style={th}>Type</th>
                <th style={th}>Reference</th>
                <th style={th}>Receipts</th>
                <th style={th}>Status</th>
                <th style={{ ...th, textAlign: 'right' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {deposits.map((d) => (
                <tr key={d.id} style={{ borderBottom: '1px solid #F0F0F0' }}>
                  <td style={td}>{d.deposit_date}</td>
                  <td style={td}>{d.bank_account_display || '—'}</td>
                  <td style={td}>{d.deposit_type}</td>
                  <td style={{ ...td, fontFamily: 'monospace', fontSize: 11 }}>
                    {d.external_reference || '—'}
                  </td>
                  <td style={{ ...td, textAlign: 'center' }}>{d.receipt_count}</td>
                  <td style={td}>{d.status}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>
                    {formatCents(d.amount_cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Reports tab ─────────────────────────────────────────────────

function ReportsTab({ token, onTokenInvalid }) {
  const [entities, setEntities] = useState([]);
  const [selectedEntity, setSelectedEntity] = useState('');
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const url = new URL('/api/admin/list-entities', window.location.origin);
        url.searchParams.set('secret', token);
        const res = await fetch(url.toString());
        if (res.status === 401) { onTokenInvalid(); return; }
        const json = await res.json();
        setEntities(json.entities || []);
      } catch { /* fine */ }
    })();
  }, [token, onTokenInvalid]);

  const runReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    setReport(null);
    try {
      const url = new URL('/api/admin/entity-trial-balance', window.location.origin);
      url.searchParams.set('secret', token);
      if (selectedEntity) url.searchParams.set('entity_id', selectedEntity);
      if (asOf) url.searchParams.set('as_of', asOf);
      const res = await fetch(url.toString());
      if (res.status === 401) { onTokenInvalid(); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setReport(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token, onTokenInvalid, selectedEntity, asOf]);

  const byType = (type) => (report?.accounts || []).filter((a) => a.account_type === type);
  const sumByType = (type) => byType(type).reduce((s, a) => s + a.net_cents, 0);

  return (
    <div>
      <div style={{
        padding: '14px 16px', marginBottom: 12,
        background: 'linear-gradient(135deg, #E3F2FD 0%, #E1F5FE 100%)',
        borderLeft: '3px solid #1565C0', borderRadius: 8,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#1565C0', marginBottom: 4 }}>
          <BarChart3 size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} />
          Reports
        </div>
        <div style={{ fontSize: 12, color: '#555' }}>
          Trial balance + P&amp;L grouped by account type. Filter by entity to produce
          per-entity statements; leave blank for the consolidated view.
        </div>
      </div>

      <div className="dashboard-card" style={{ padding: '14px 16px', marginBottom: 12 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#444', gap: 3 }}>
            <span style={{ fontWeight: 600 }}>Entity</span>
            <select
              value={selectedEntity}
              onChange={(e) => setSelectedEntity(e.target.value)}
              style={{ padding: '7px 10px', border: '1px solid #CCC', borderRadius: 6, fontSize: 13, minWidth: 240 }}
            >
              <option value="">All (consolidated)</option>
              {entities.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#444', gap: 3 }}>
            <span style={{ fontWeight: 600 }}>As of</span>
            <input
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              style={{ padding: '7px 10px', border: '1px solid #CCC', borderRadius: 6, fontSize: 13 }}
            />
          </label>
          <button
            type="button"
            onClick={runReport}
            disabled={loading}
            style={{
              padding: '8px 16px', background: loading ? '#BBB' : '#1565C0',
              color: 'white', border: 'none', borderRadius: 6, fontWeight: 600,
              fontSize: 13, cursor: loading ? 'not-allowed' : 'pointer',
            }}
          >
            {loading ? 'Running…' : 'Run report'}
          </button>
        </div>
      </div>

      {error && (
        <div className="dashboard-card" style={{ padding: 12, background: '#FFEBEE', color: '#C62828', fontSize: 13 }}>
          {error}
        </div>
      )}

      {report && (
        <>
          <div className="dashboard-card" style={{ padding: '12px 16px', marginBottom: 8, display: 'flex', flexWrap: 'wrap', gap: 16 }}>
            <SummaryStat label="Total debits"  value={formatCents(report.total_debit_cents)} />
            <SummaryStat label="Total credits" value={formatCents(report.total_credit_cents)} />
            <SummaryStat label="In balance?"   value={report.in_balance ? '✓ yes' : '✗ no'} color={report.in_balance ? '#2E7D32' : '#C62828'} />
            <SummaryStat label="As of"         value={report.as_of || 'all-time'} />
          </div>

          {(['asset', 'liability', 'equity', 'income', 'expense']).map((type) => {
            const accounts = byType(type);
            if (accounts.length === 0) return null;
            const total = sumByType(type);
            return (
              <div key={type} className="dashboard-card" style={{ marginBottom: 8, padding: 0, overflow: 'hidden' }}>
                <div style={{
                  padding: '10px 14px', background: ACCOUNT_TYPE_COLORS[type]?.bg || '#EEE',
                  color: ACCOUNT_TYPE_COLORS[type]?.fg || '#444', fontWeight: 700, fontSize: 13,
                  textTransform: 'capitalize',
                }}>
                  {type} <span style={{ fontWeight: 400, opacity: 0.7 }}>({accounts.length})</span>
                  <span style={{ float: 'right', fontFamily: 'monospace' }}>{formatCents(total)}</span>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <tbody>
                    {accounts.map((a) => (
                      <tr key={a.gl_account_id} style={{ borderBottom: '1px solid #F0F0F0' }}>
                        <td style={{ ...td, fontFamily: 'monospace', color: '#666', width: 80 }}>{a.code}</td>
                        <td style={td}>{a.name}</td>
                        <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>
                          {a.debit_cents > 0 ? formatCents(a.debit_cents) : ''}
                        </td>
                        <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>
                          {a.credit_cents > 0 ? formatCents(a.credit_cents) : ''}
                        </td>
                        <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>
                          {formatCents(a.net_cents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}

          {/* Net income line at the bottom — revenue minus expenses */}
          {(byType('income').length > 0 || byType('expense').length > 0) && (
            <div className="dashboard-card" style={{ padding: '12px 16px', background: '#FAFAFA', fontWeight: 700, display: 'flex', justifyContent: 'space-between' }}>
              <span>Net income (revenue − expenses)</span>
              <span style={{ fontFamily: 'monospace' }}>
                {formatCents(sumByType('income') - sumByType('expense'))}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SummaryStat({ label, value, color }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: color || '#1A1A1A', fontFamily: 'monospace' }}>{value}</div>
    </div>
  );
}

const th = { padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#555', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4 };
const td = { padding: '10px 12px', color: '#222' };
