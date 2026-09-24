import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface PaginatedList<T> {
  /** rows loaded so far (page 1 + appended pages) */
  data: T[];
  /** direct setter — existing local mutations (toggle/delete/prepend) keep working */
  setData: React.Dispatch<React.SetStateAction<T[]>>;
  /** true while the first page loads */
  loading: boolean;
  /** true while a "load more" page is in flight */
  loadingMore: boolean;
  /** false once the server returned a short page */
  hasMore: boolean;
  /** append the next page (no-op while loading or when !hasMore) */
  loadMore: () => void;
  /**
   * Reload page 1. Uses the latest loader by default; pass an explicit loader
   * when the caller knows fresher params than the last render (e.g. right
   * after setViewSpace, before re-render).
   */
  refresh: (loader?: (offset: number, limit: number) => Promise<T[]>) => void;
}

interface Opts {
  /** rows per page (default 10) */
  pageSize?: number;
}

/**
 * Generic infinite-scroll list. ONE implementation consumed by every tab:
 * the tab only supplies `(offset, limit) => Promise<rows>` and renders
 * `data` in a FlatList with `onEndReached={loadMore}`.
 *
 * Offset is tracked as pages-loaded × pageSize (not data.length), so local
 * prepends/filters never shift server pages. Appended rows are de-duplicated
 * by id. A sequence guard drops stale responses after refresh().
 */
export function usePaginatedList<T extends { id: string }>(opts: Opts = {}): PaginatedList<T> {
  const pageSize = opts.pageSize ?? 10;
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const loaderRef = useRef<((offset: number, limit: number) => Promise<T[]>) | null>(null);
  const seqRef = useRef(0);
  const pageRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const hasMoreRef = useRef(true);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(
    (loader?: (offset: number, limit: number) => Promise<T[]>) => {
      if (loader) loaderRef.current = loader;
      const run = loaderRef.current;
      if (!run) return;
      const seq = ++seqRef.current;
      pageRef.current = 0;
      hasMoreRef.current = true;
      setHasMore(true);
      setLoading(true);
      void run(0, pageSize).then(
        (rows) => {
          if (!mountedRef.current || seqRef.current !== seq) return;
          setData(rows);
          pageRef.current = 1;
          const more = rows.length >= pageSize;
          hasMoreRef.current = more;
          setHasMore(more);
          setLoading(false);
        },
        (e) => {
          console.warn('paginated refresh failed', e);
          if (mountedRef.current && seqRef.current === seq) setLoading(false);
        },
      );
    },
    [pageSize],
  );

  const loadMore = useCallback(() => {
    const run = loaderRef.current;
    if (!run || loadingMoreRef.current || !hasMoreRef.current) return;
    const seq = seqRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    void run(pageRef.current * pageSize, pageSize).then(
      (rows) => {
        if (!mountedRef.current || seqRef.current !== seq) return;
        if (rows.length === 0) {
          hasMoreRef.current = false;
          setHasMore(false);
        } else {
          setData((prev) => {
            const seen = new Set(prev.map((p) => p.id));
            const fresh = rows.filter((r) => !seen.has(r.id));
            return fresh.length > 0 ? [...prev, ...fresh] : prev;
          });
          pageRef.current += 1;
          const more = rows.length >= pageSize;
          hasMoreRef.current = more;
          setHasMore(more);
        }
        loadingMoreRef.current = false;
        setLoadingMore(false);
      },
      (e) => {
        console.warn('paginated loadMore failed', e);
        loadingMoreRef.current = false;
        if (mountedRef.current) setLoadingMore(false);
      },
    );
  }, [pageSize]);

  return useMemo(
    () => ({ data, setData, loading, loadingMore, hasMore, loadMore, refresh }),
    [data, setData, loading, loadingMore, hasMore, loadMore, refresh],
  );
}
