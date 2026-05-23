import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchInstances, createInstance, startInstance, stopInstance, removeInstance, recreateInstance } from '../api.js';

export function useInstances() {
  const [instances, setInstances] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const reconnectDelay = useRef(1000);

  const loadInstances = useCallback(async () => {
    try {
      const data = await fetchInstances();
      setInstances(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    loadInstances().finally(() => setLoading(false));
  }, [loadInstances]);

  // WebSocket connection
  useEffect(() => {
    function connect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${location.host}/api/instances/events`);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectDelay.current = 1000; // Reset on successful connect
      };

      ws.onmessage = () => {
        // On any event, re-fetch the full list for consistency
        loadInstances();
      };

      ws.onclose = () => {
        wsRef.current = null;
        // Reconnect with exponential backoff
        reconnectTimer.current = setTimeout(() => {
          reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30000);
          connect();
        }, reconnectDelay.current);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [loadInstances]);

  const create = useCallback(async (opts) => {
    const result = await createInstance(opts);
    await loadInstances();
    return result;
  }, [loadInstances]);

  const start = useCallback(async (id) => {
    await startInstance(id);
    await loadInstances();
  }, [loadInstances]);

  const stop = useCallback(async (id) => {
    await stopInstance(id);
    await loadInstances();
  }, [loadInstances]);

  const remove = useCallback(async (id, removeVolume = false) => {
    await removeInstance(id, removeVolume);
    await loadInstances();
  }, [loadInstances]);

  const recreate = useCallback(async (id, opts) => {
    const result = await recreateInstance(id, opts);
    await loadInstances();
    return result;
  }, [loadInstances]);

  return { instances, loading, error, create, start, stop, remove, recreate, refresh: loadInstances };
}
