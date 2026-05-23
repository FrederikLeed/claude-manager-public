import { useState, useEffect, useCallback } from 'react';
import { fetchGrants } from '../api.js';

export function useGrants(instanceId) {
  const [grants, setGrants] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!instanceId) return;
    setLoading(true);
    try {
      const data = await fetchGrants(instanceId);
      setGrants(data);
    } catch {
      setGrants([]);
    } finally {
      setLoading(false);
    }
  }, [instanceId]);

  useEffect(() => { load(); }, [load]);

  return { grants, loading, refresh: load };
}
