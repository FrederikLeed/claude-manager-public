import { useState, useEffect, useCallback } from 'react';
import { registerDevice, fetchAuthStatus } from '../api.js';

const TOKEN_KEY = 'cm_device_token';

// crypto.randomUUID() requires secure context (HTTPS/localhost).
// Fallback for HTTP access via IP on local network.
function generateToken() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    try { return crypto.randomUUID(); } catch { /* not secure context */ }
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function useAuth() {
  const [status, setStatus] = useState('loading'); // loading | unknown | pending | approved
  const [deviceId, setDeviceId] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [deviceName, setDeviceName] = useState(null);

  const checkStatus = useCallback(async () => {
    try {
      const result = await fetchAuthStatus();
      setStatus(result.status);
      setDeviceId(result.deviceId || null);
      setIsAdmin(!!result.isAdmin);
      setDeviceName(result.name || null);
      return result.status;
    } catch {
      setStatus('unknown');
      return 'unknown';
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      // Check if we already have a session
      const currentStatus = await checkStatus();
      if (cancelled) return;

      if (currentStatus !== 'unknown') return; // already registered

      // Generate and register a new device token
      let token = localStorage.getItem(TOKEN_KEY);
      if (!token) {
        token = generateToken();
        localStorage.setItem(TOKEN_KEY, token);
      }

      try {
        // Pass reset_token from URL if present (emergency admin recovery)
        const urlParams = new URLSearchParams(window.location.search);
        const resetToken = urlParams.get('reset_token');
        const url = resetToken
          ? `/api/auth/register?reset_token=${encodeURIComponent(resetToken)}`
          : '/api/auth/register';

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
          credentials: 'include',
        });
        const result = await res.json();
        if (cancelled) return;

        // Clean URL if reset_token was used
        if (resetToken) {
          window.history.replaceState({}, '', window.location.pathname);
        }

        setDeviceId(result.deviceId);
        setIsAdmin(result.isAdmin);
        setStatus(result.approved ? 'approved' : 'pending');
      } catch {
        if (!cancelled) setStatus('unknown');
      }
    }

    init();
    return () => { cancelled = true; };
  }, [checkStatus]);

  return { status, deviceId, isAdmin, deviceName, checkStatus };
}
