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
  Link2, Download,
} from 'lucide-react';
import { usePlaidLink } from 'react-plaid-link';

const TABS = [
  { id: 'coa',       label: 'Chart of Accounts', icon: BookOpen },
  { id: 'journal',   label: 'Journal Entries',   icon: FileSpreadsheet },
  { id: 'ar',        label: 'Receivables',       icon: Receipt },
  { id: 'receipts',  label: 'Receipts',          icon: DollarSign },
  { id: 'deposits',  label: 'Deposits',          icon: Landmark },
  { id: 'banks',     label: 'Bank Accounts',     icon: CreditCard },
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

function readToken() {
  try {
    return sessionStorage.getItem(ADMIN_TOKEN_KEY) || '';
  } catch {
    return '';
  }
}
function writeToken(v) {
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
            {activeTab === 'journal' && <PlaceholderTab label="Journal Entries" hint="Recent entries + posting form. Backed by /api/admin/post-journal-entry (coming soon)." />}
            {activeTab === 'ar' && <PlaceholderTab label="Receivables" hint="Open posted_charges grouped by tenant / lease / property." />}
            {activeTab === 'receipts' && <PlaceholderTab label="Receipts" hint="Recent receipts + record-receipt form. Backed by /api/admin/ar-happy-path or a focused record endpoint." />}
            {activeTab === 'deposits' && <PlaceholderTab label="Deposits" hint="Undeposited Funds queue + build-deposit form." />}
            {activeTab === 'banks' && <BankAccountsTab token={token} onTokenInvalid={() => setToken('')} />}
            {activeTab === 'reports' && <PlaceholderTab label="Reports" hint="P&L, rent roll, owner statements (Stage 7)." />}
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
          <table className="properties-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ width: '70px' }}>Code</th>
                <th>Name</th>
                <th style={{ width: '100px' }}>Type</th>
                <th style={{ width: '120px' }}>Subtype</th>
                <th style={{ width: '80px', textAlign: 'right' }}>Postings</th>
                <th>Tags</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => (
                <AccountRow key={a.id} account={a} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AccountRow({ account }) {
  const tone = ACCOUNT_TYPE_COLORS[account.account_type] || { bg: '#eee', fg: '#333' };
  const indent = account.parent_code ? '20px' : '0';
  return (
    <tr style={{ opacity: account.is_active ? 1 : 0.55 }}>
      <td style={{ fontFamily: 'monospace', fontWeight: 600, paddingLeft: indent }}>
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
      <td style={{ fontSize: '12px', color: '#666' }}>
        {account.account_subtype || '—'}
      </td>
      <td style={{ textAlign: 'right', color: account.posting_count > 0 ? '#222' : '#aaa' }}>
        {account.posting_count}
      </td>
      <td>
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
          <table className="properties-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ width: '70px' }}>Code</th>
                <th>Display Name</th>
                <th>Institution</th>
                <th style={{ width: '100px' }}>Type</th>
                <th style={{ width: '120px', textAlign: 'right' }}>Balance</th>
                <th style={{ width: '110px' }}>Plaid</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((b) => (
                <tr key={b.id}>
                  <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>{b.gl_code}</td>
                  <td>
                    {b.display_name}
                    {b.is_trust && (
                      <span style={{
                        marginLeft: '6px', fontSize: '10px', color: '#fff',
                        background: '#6A1B9A', padding: '1px 6px', borderRadius: '8px',
                      }}>trust</span>
                    )}
                  </td>
                  <td style={{ fontSize: '12px', color: '#666' }}>
                    {b.institution_name || '—'}
                    {b.account_last4 && <span style={{ fontFamily: 'monospace', marginLeft: '4px' }}>****{b.account_last4}</span>}
                  </td>
                  <td>
                    <span style={{
                      display: 'inline-block', padding: '2px 8px', borderRadius: '10px',
                      background: b.account_type === 'credit_card' ? '#FFEBEE' : '#E3F2FD',
                      color: b.account_type === 'credit_card' ? '#C62828' : '#1565C0',
                      fontSize: '11px', fontWeight: 600,
                    }}>
                      {b.account_type}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>
                    {formatCents(b.current_balance_cents)}
                  </td>
                  <td>
                    <span style={{
                      display: 'inline-block', padding: '2px 8px', borderRadius: '10px',
                      background: b.plaid_status === 'linked' ? '#E8F5E9' :
                                  b.plaid_status === 're_auth_required' ? '#FFF3E0' :
                                  b.plaid_status === 'disconnected' ? '#FFEBEE' : '#F5F5F5',
                      color: b.plaid_status === 'linked' ? '#2E7D32' :
                             b.plaid_status === 're_auth_required' ? '#E65100' :
                             b.plaid_status === 'disconnected' ? '#C62828' : '#666',
                      fontSize: '11px', fontWeight: 600,
                    }}>
                      {b.plaid_status}
                    </span>
                    {b.plaid_status === 'linked' && (
                      <SyncTransactionsButton token={token} bankAccountId={b.id} onTokenInvalid={onTokenInvalid} />
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
