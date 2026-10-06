import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The fleet graph, refreshed on a timer.
 *
 * 10s matches the metrics cache TTL in server/metrics.js and the traffic
 * window in proxy-log.js — polling faster would redraw the same numbers.
 * Only polls while the view is actually mounted and the tab is visible.
 */
export function useTopology(active) {
  const [topology, setTopology] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const inflight = useRef(false);

  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const res = await fetch('/api/topology', { credentials: 'include' });
      if (!res.ok) throw new Error(`topology: ${res.status}`);
      setTopology(await res.json());
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    setLoading(true);
    refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 10_000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  return { topology, loading, error, refresh };
}
