// One-click "Apply pending migrations" button. Rendered inline in
// error cards that look like schema-drift errors (column X / relation X
// does not exist) so staff can fix the broken page without opening
// a terminal.
//
// Usage:
//   <MigrationFixButton error={errorMessage} onApplied={reload} />
//
// The component is always renderable, but visually de-emphasizes
// itself when the error doesn't look schema-related. Pass
// `alwaysShow={true}` to render it regardless.

import { useState } from 'react';
import { Wrench } from 'lucide-react';

const CLERK_ENABLED = Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const ADMIN_TOKEN_KEY = 'breeze.admin.token';
const getToken = () => {
  if (CLERK_ENABLED) return 'clerk';
  try { return sessionStorage.getItem(ADMIN_TOKEN_KEY) || ''; } catch { return ''; }
};

function looksLikeMigrationDrift(errorText) {
  if (!errorText) return false;
  const s = String(errorText).toLowerCase();
  return (
    s.includes('does not exist') ||
    s.includes('column') && s.includes('not exist') ||
    s.includes('relation') && s.includes('does not exist') ||
    s.includes('undefined table') ||
    s.includes('undefined column')
  );
}

export default function MigrationFixButton({ error, onApplied, alwaysShow = false }) {
  const [state, setState] = useState('idle'); // idle | running | done | error
  const [result, setResult] = useState(null);
  const [runErr, setRunErr] = useState(null);

  const relevant = alwaysShow || looksLikeMigrationDrift(error);
  if (!relevant && state === 'idle') return null;

  const run = async () => {
    setState('running');
    setRunErr(null);
    setResult(null);
    try {
      const url = new URL('/api/admin/run-migrations', window.location.origin);
      url.searchParams.set('secret', getToken());
      const res = await fetch(url.toString(), { method: 'POST' });
      const json = await res.json();
      if (!json.ok) {
        setRunErr(json.error || 'migration run failed');
        setState('error');
        return;
      }
      setResult(json);
      setState('done');
      if (onApplied) onApplied();
    } catch (err) {
      setRunErr(err.message || String(err));
      setState('error');
    }
  };

  return (
    <div style={{
      marginTop: 10,
      padding: '10px 12px',
      borderRadius: 6,
      background: state === 'done' ? '#E8F5E9' : '#FFF8E1',
      border: `1px solid ${state === 'done' ? '#A5D6A7' : '#FFD54F'}`,
      fontSize: 12,
    }}>
      {state === 'idle' && (
        <>
          <div style={{ color: '#5D4037', marginBottom: 6 }}>
            <strong>Looks like a schema drift.</strong> The code shipped a new
            column or table that the database hasn't been told about yet. One
            click runs all pending migrations.
          </div>
          <button
            type="button"
            onClick={run}
            style={{
              padding: '6px 14px', background: '#F57F17', color: 'white',
              border: 'none', borderRadius: 5, fontWeight: 600, fontSize: 12,
              cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            <Wrench size={12} /> Apply pending migrations
          </button>
        </>
      )}
      {state === 'running' && (
        <div style={{ color: '#5D4037' }}>
          <Wrench size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />
          Applying migrations…
        </div>
      )}
      {state === 'done' && (
        <div style={{ color: '#2E7D32' }}>
          <strong>Migrations applied.</strong>
          {' '}
          {result?.newly_applied > 0
            ? `Applied ${result.newly_applied} new migration${result.newly_applied === 1 ? '' : 's'}.`
            : 'Schema was already up to date — different issue.'}
          {' '}
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginLeft: 6, padding: '2px 8px', background: '#2E7D32', color: 'white',
              border: 'none', borderRadius: 4, fontSize: 11, cursor: 'pointer',
            }}
          >
            Reload page
          </button>
        </div>
      )}
      {state === 'error' && (
        <div style={{ color: '#C62828' }}>
          <strong>Migration run failed:</strong> {runErr}
        </div>
      )}
    </div>
  );
}
