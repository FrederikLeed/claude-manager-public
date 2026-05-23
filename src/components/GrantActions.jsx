import { useState } from 'react';
import { renewGrant, recreateWithoutGrant } from '../api.js';

export default function GrantActions({ grants, onAction, onClose }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const handleRenew = async (grant, hours = 24) => {
    setBusy(`renew-${grant.id}`);
    setError(null);
    try {
      await renewGrant(grant.id, hours);
      onAction?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const handleRecreateWithout = async (grant) => {
    if (!window.confirm(`Recreate container without ${grant.capability_name}? The container will be restarted.`)) return;
    setBusy(`recreate-${grant.id}`);
    setError(null);
    try {
      await recreateWithoutGrant(grant.id);
      onAction?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const activeGrants = grants.filter((g) => g.active);
  if (activeGrants.length === 0) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-sm mx-4 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-gray-100 mb-3">Capability Grants</h3>

        <div className="flex flex-col gap-3">
          {activeGrants.map((grant) => {
            const expired = new Date(grant.expires_at).getTime() <= Date.now();
            const capLabel = grant.capability_name === 'docker_socket' ? 'Docker Socket'
              : grant.capability_name === 'network_unrestricted' ? 'Unrestricted Network'
              : grant.capability_name;

            return (
              <div key={grant.id} className="border border-gray-700 rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-gray-200">{capLabel}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${expired ? 'bg-red-900/30 text-red-400' : 'bg-green-900/30 text-green-400'}`}>
                    {expired ? 'Expired' : `Expires ${new Date(grant.expires_at).toLocaleString()}`}
                  </span>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleRenew(grant, 24)}
                    disabled={!!busy}
                    className="flex-1 px-2 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:text-blue-400 text-white text-xs font-medium rounded transition-colors"
                  >
                    {busy === `renew-${grant.id}` ? '...' : 'Renew 24h'}
                  </button>
                  <button
                    onClick={() => handleRecreateWithout(grant)}
                    disabled={!!busy}
                    className="flex-1 px-2 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-500 text-gray-200 text-xs font-medium rounded transition-colors"
                  >
                    {busy === `recreate-${grant.id}` ? '...' : 'Remove Cap'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {error && (
          <div className="mt-3 text-sm text-red-400 bg-red-900/20 border border-red-800 rounded px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex justify-end mt-4">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
