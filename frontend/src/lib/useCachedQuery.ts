import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getSnapshot, subscribeSnapshot } from './api';

export interface CachedQueryResult<T> {
  // Last known value. `undefined` ONLY when nothing has ever loaded for this
  // key. Pages should render the EmptyState only when `data` is defined and
  // happens to be empty — never when it's undefined.
  data: T | undefined;
  // True only on the very first fetch (no snapshot yet). Background
  // revalidations of an existing snapshot do NOT flip this on.
  isLoading: boolean;
  // True while a background revalidation is in flight. Use this to drive
  // subtle refresh affordances (spinning <RefreshCw>) without hiding the
  // current data.
  isRefreshing: boolean;
  error: Error | null;
  // Force a fresh fetch. Bypasses the cache and resets the snapshot.
  refresh: () => Promise<void>;
}

export interface CachedQueryOpts {
  enabled?: boolean;
}

// SWR-style data hook layered on top of the api.ts cache.
//
//   - On mount, synchronously seeds state from getSnapshot(key) so the
//     first render is never blank when prior data exists.
//   - Always fires `fetcher()` in an effect to revalidate.
//   - Subscribes to snapshot updates so a fetch triggered by ONE component
//     instance updates every other instance reading the same key (e.g.
//     Dashboard and Access both pull /api/agents).
//
// `key` MUST match the cache URL the fetcher reads/writes (use apiKeys.*).
export function useCachedQuery<T>(
  key: string,
  fetcher: () => Promise<T>,
  opts: CachedQueryOpts = {},
): CachedQueryResult<T> {
  const enabled = opts.enabled !== false;
  const [data, setData] = useState<T | undefined>(() => getSnapshot<T>(key));
  const [error, setError] = useState<Error | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  // True first-ever load = no snapshot AND we're about to fetch.
  const [isLoading, setIsLoading] = useState<boolean>(() => enabled && getSnapshot<T>(key) === undefined);

  // Hold latest fetcher in a ref so the effect doesn't tear down on every
  // render when a parent inlines its lambda.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(async () => {
    setError(null);
    const hadSnapshot = getSnapshot<T>(key) !== undefined;
    if (hadSnapshot) setIsRefreshing(true);
    else setIsLoading(true);
    try {
      const v = await fetcherRef.current();
      setData(v);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [key]);

  // Re-key effect: when `key` or `enabled` changes, re-seed from snapshot
  // (so changing a filter shows the previously-cached result for the new
  // filter instantly if we've seen it) and refetch.
  useEffect(() => {
    if (!enabled) return;
    const snap = getSnapshot<T>(key);
    setData(snap);
    setIsLoading(snap === undefined);
    setIsRefreshing(snap !== undefined);
    run();
    // Subscribe to background updates pushed into the cache by other
    // mounted components or by `api.bust()`-triggered refetches.
    const unsub = subscribeSnapshot(key, (v) => setData(v as T));
    return unsub;
  }, [key, enabled, run]);

  const refresh = useCallback(async () => {
    api.bust(key);
    await run();
  }, [key, run]);

  return { data, isLoading, isRefreshing, error, refresh };
}
