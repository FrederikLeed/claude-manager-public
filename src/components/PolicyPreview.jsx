import { useState, useEffect } from 'react';
import { fetchPolicies, fetchInstanceAccess } from '../api.js';

export default function PolicyPreview({ policyName, instanceId, onClose }) {
  const [policy, setPolicy] = useState(null);
  const [access, setAccess] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const promises = [
      fetchPolicies()
        .then((policies) => policies.find((p) => p.id === policyName || p.name === policyName) || null)
        .catch(() => null),
    ];
    if (instanceId) {
      promises.push(
        fetchInstanceAccess(instanceId).catch(() => null)
      );
    }
    Promise.all(promises).then(([pol, acc]) => {
      setPolicy(pol);
      setAccess(acc);
      setLoading(false);
    });
  }, [policyName, instanceId]);

  const baseHosts = new Set(policy?.allowedHosts || []);
  const approvedHosts = (access?.approvedHosts || []).filter(h => !baseHosts.has(h));

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-sm mx-4 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-gray-100 mb-1">
          Network Access{policyName ? `: ${policyName}` : ''}
        </h3>

        {loading && <p className="text-xs text-gray-500 mt-3">Loading...</p>}

        {!loading && (
          <>
            {policy?.description && (
              <p className="text-xs text-gray-400 mt-1 mb-3">{policy.description}</p>
            )}

            {(!policy || policy.unrestricted) ? (
              <p className="text-xs text-yellow-400 mb-3">No network restrictions applied.</p>
            ) : (
              <div className="mb-3">
                <p className="text-xs text-gray-500 mb-2">Base policy hosts:</p>
                <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
                  {policy.allowedHosts?.map((host) => (
                    <code key={host} className="text-xs text-gray-300 bg-gray-800 rounded px-2 py-1 font-mono">
                      {host}
                    </code>
                  ))}
                </div>
              </div>
            )}

            {approvedHosts.length > 0 && (
              <div>
                <p className="text-xs text-green-500 mb-2">Approved additional hosts:</p>
                <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
                  {approvedHosts.map((host) => (
                    <code key={host} className="text-xs text-green-300 bg-green-900/20 border border-green-800/30 rounded px-2 py-1 font-mono">
                      {host}
                    </code>
                  ))}
                </div>
              </div>
            )}

            {!policy?.unrestricted && approvedHosts.length === 0 && !policy?.allowedHosts?.length && (
              <p className="text-xs text-gray-500 mt-3">No access information available.</p>
            )}
          </>
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
