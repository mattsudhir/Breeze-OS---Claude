// App-wide data source state.
//
// Until now the AppFolio / Rent Manager toggle lived inside ChatHome.jsx
// as local state, so switching the source in chat had no effect on
// Properties / Tenants / Maintenance / Dashboard / Classic — those
// pages were hardcoded to Rent Manager via src/services/rentManager.js.
//
// This context lifts the choice to the app shell so every menu page
// reads from the same active backend. The state is persisted to
// localStorage under `breezeChatBackend` (kept the existing key so
// users don't lose their preference across the lift).
//
// Long-term direction: only one backend (AppFolio) at all. The
// toggle stays for a transition period to compare data and confirm
// we're not missing anything before we cut over for good. Once the
// cutover happens, this context can collapse to a constant.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';

const STORAGE_KEY = 'breezeChatBackend';
const DEFAULT_DATA_SOURCE = 'appfolio';

// Order here is the order shown in the dropdown. Add backends here
// when registering a new one in lib/backends/index.js.
export const DATA_SOURCES = [
  {
    value: 'appfolio',
    label: 'AppFolio',
    hint: 'Breeze Property Group production data',
  },
  {
    value: 'rm-demo',
    label: 'Rent Manager',
    hint: 'Rent Manager sample15 sandbox',
  },
];

function readInitial() {
  if (typeof window === 'undefined') return DEFAULT_DATA_SOURCE;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && DATA_SOURCES.some((d) => d.value === stored)) return stored;
  } catch {
    // localStorage blocked (private mode / iframe) — fall back to default
  }
  return DEFAULT_DATA_SOURCE;
}

const DataSourceContext = createContext(null);

export function DataSourceProvider({ children }) {
  const [dataSource, setDataSourceState] = useState(readInitial);

  // Persist on every change, but defensively in case storage is
  // disabled — the in-memory state still works for the session.
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, dataSource);
    } catch {
      /* ignore */
    }
  }, [dataSource]);

  const setDataSource = useCallback((next) => {
    if (!DATA_SOURCES.some((d) => d.value === next)) {
      console.warn(`[DataSourceContext] unknown source "${next}", ignoring`);
      return;
    }
    setDataSourceState(next);
  }, []);

  return (
    <DataSourceContext.Provider value={{ dataSource, setDataSource, sources: DATA_SOURCES }}>
      {children}
    </DataSourceContext.Provider>
  );
}

export function useDataSource() {
  const ctx = useContext(DataSourceContext);
  if (!ctx) {
    throw new Error('useDataSource must be used within <DataSourceProvider>');
  }
  return ctx;
}
