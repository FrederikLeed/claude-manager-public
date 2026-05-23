import { useState, useEffect, useCallback } from 'react';
import { fetchAccessRequests, approveAccessRequest, denyAccessRequest } from '../api.js';

function timeAgo(isoString) {
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function AccessRequests({ instances, refreshTrigger, onResolved }) {
  const [requests, setRequests] = useState([]);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    fetchAccessRequests()
      .then(setRequests)
      .catch(() => setRequests([]));
  }, []);

  useEffect(() => { load(); }, [load, refreshTrigger]);

  // Poll every 10s for new requests
  useEffect(() => {
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, [load]);

  const handleApprove = async (req) => {
    setBusy(`approve-${req.id}`);
    setError(null);
    try {
      await approveAccessRequest(req.id);
      load();
      onResolved?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const handleDeny = async (req) => {
    setBusy(`deny-${req.id}`);
    setError(null);
    try {
      await denyAccessRequest(req.id);
      load();
      onResolved?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  if (requests.length === 0) return null;

  const instanceName = (id) => {
    const inst = instances?.find((i) => i.id === id);
    return inst?.name || id;
  };

  return (
    <div className="mb-6">
      <h2 className="text-sm font-semibold text-amber-400 mb-2 flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
        Access Requests ({requests.length})
      </h2>
      <div className="flex flex-col gap-2">
        {requests.map((req) => (
          <div
            key={req.id}
            className="bg-amber-900/10 border border-amber-800/50 rounded-lg px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium text-gray-100 truncate">
                  {instanceName(req.instance_id)}
                </span>
                <span className="text-[10px] text-gray-500">
                  {timeAgo(req.created_at)}
                </span>
              </div>
              <div className="text-xs text-gray-400">
                {req.requested_policy && (
                  <span>
                    Wants policy: <span className="text-amber-300 font-medium">{req.requested_policy}</span>
                  </span>
                )}
                {req.requested_hosts && (
                  <span>
                    {req.requested_policy && ' + '}
                    Hosts: <span className="text-amber-300 font-medium">{req.requested_hosts.join(', ')}</span>
                  </span>
                )}
              </div>
              {req.reason && (
                <div className="text-xs text-gray-500 mt-1 italic">"{req.reason}"</div>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => handleApprove(req)}
                disabled={!!busy}
                className="px-3 py-1.5 bg-green-600 hover:bg-green-700 disabled:bg-green-800 disabled:text-green-400 text-white text-xs font-medium rounded-lg transition-colors"
              >
                {busy === `approve-${req.id}` ? '...' : 'Approve'}
              </button>
              <button
                onClick={() => handleDeny(req)}
                disabled={!!busy}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-500 text-gray-200 text-xs font-medium rounded-lg transition-colors"
              >
                {busy === `deny-${req.id}` ? '...' : 'Deny'}
              </button>
            </div>
          </div>
        ))}
      </div>
      {error && (
        <div className="mt-2 text-sm text-red-400 bg-red-900/20 border border-red-800 rounded px-3 py-2">
          {error}
        </div>
      )}
    </div>
  );
}

/**
 * Small badge for InstanceRow — shows count of pending requests.
 */
export function AccessRequestBadge({ count, onClick }) {
  if (!count) return null;
  return (
    <button
      onClick={onClick}
      className="text-[10px] text-amber-400 border border-amber-700 rounded px-1.5 py-0.5 shrink-0 hover:bg-amber-900/30 transition-colors animate-pulse"
      title={`${count} pending access request${count > 1 ? 's' : ''}`}
    >
      {count} req
    </button>
  );
}
