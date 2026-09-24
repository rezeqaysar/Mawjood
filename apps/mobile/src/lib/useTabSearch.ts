import { useEffect, useMemo, useRef, useState } from 'react';
import { useDebouncedValue } from './useDebouncedValue';

interface Opts<T, R> {
  /** server-side search; when set, results come from the server (debounced) */
  search?: (q: string) => Promise<R>;
  /** client-side mode: filter these items (used when `search` is absent) */
  items?: T[];
  filter?: (items: T[], q: string) => R;
  debounceMs?: number;
}

export interface TabSearch<R> {
  query: string;
  setQuery: (q: string) => void;
  /** true while a server search for the current query is in flight */
  searching: boolean;
  /** null when not searching */
  results: R | null;
  /** true when the query is non-empty (show results instead of the list) */
  inSearch: boolean;
}

/**
 * Generic per-tab search. ONE hook consumed by every tab — the tab only
 * declares WHERE to search:
 *   server: useTabSearch({ search: (q) => engine.search(sid, q, { kinds: ['task'], includeNotes: false }) })
 *   client: useTabSearch({ items: lists, filter: (ls, q) => ls.filter(...) })
 * Debounced so we never hit the server per keystroke.
 */
export function useTabSearch<T, R = T[]>(opts: Opts<T, R> = {}): TabSearch<R> {
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query.trim(), opts.debounceMs ?? 400);
  // server results are tagged with the query they were fetched for, so
  // `searching` / `results` derive from state — no setState inside effects.
  const [serverState, setServerState] = useState<{ q: string; r: R } | null>(null);

  // freshest search fn without re-subscribing the effect on every render
  const searchRef = useRef(opts.search);
  useEffect(() => {
    searchRef.current = opts.search;
  });

  useEffect(() => {
    const q = debounced;
    const search = searchRef.current;
    if (!q || !search) return;
    let alive = true;
    search(q).then(
      (r) => {
        if (alive) setServerState({ q, r });
      },
      (e) => {
        console.warn('tab search failed', e);
        if (alive) setServerState({ q, r: [] as unknown as R });
      },
    );
    return () => {
      alive = false;
    };
  }, [debounced]);

  const inSearch = query.trim().length > 0;
  const serverMode = opts.search != null;
  const serverResults = debounced && serverState?.q === debounced ? serverState.r : null;
  const clientResults =
    !serverMode && opts.filter && debounced
      ? opts.filter(opts.items ?? [], debounced.toLowerCase())
      : null;

  return useMemo(
    () => ({
      query,
      setQuery,
      searching: serverMode && !!debounced && serverState?.q !== debounced,
      results: (serverMode ? serverResults : clientResults) as R | null,
      inSearch,
    }),
    [query, serverMode, debounced, serverState, serverResults, clientResults, inSearch],
  );
}
