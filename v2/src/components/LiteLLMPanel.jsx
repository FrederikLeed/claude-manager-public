import { useState, useEffect } from 'react';
import { fetchLiteLLMStatus, fetchLiteLLMModels, fetchInstanceLiteLLM, rotateLiteLLMKey } from '../api.js';

export default function LiteLLMPanel({ instanceId, onClose }) {
  const [status, setStatus] = useState(null);
  const [models, setModels] = useState([]);
  const [instanceData, setInstanceData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([
      fetchLiteLLMStatus(),
      fetchLiteLLMModels(),
      fetchInstanceLiteLLM(instanceId),
    ])
      .then(([s, m, d]) => {
        setStatus(s);
        setModels(m);
        setInstanceData(d);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [instanceId]);

  const handleRotate = async () => {
    setRotating(true);
    setError(null);
    try {
      const result = await rotateLiteLLMKey(instanceId);
      setInstanceData((prev) => ({ ...prev, key: result.key }));
    } catch (err) {
      setError(err.message);
    } finally {
      setRotating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-md mx-4 p-5 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-gray-100 mb-4">LiteLLM Proxy</h3>

        {loading && <p className="text-xs text-gray-500">Loading...</p>}

        {!loading && error && (
          <div className="text-sm text-red-400 bg-red-900/20 border border-red-800 rounded px-3 py-2 mb-3">
            {error}
          </div>
        )}

        {!loading && status && !status.available && (
          <p className="text-xs text-gray-500">LiteLLM proxy is not configured.</p>
        )}

        {!loading && status?.available && (
          <div className="flex flex-col gap-4">
            {/* Status */}
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${status.healthy ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="text-xs text-gray-400">
                {status.healthy ? 'Proxy healthy' : 'Proxy unhealthy'}
              </span>
            </div>

            {/* Instance key info */}
            {instanceData && (
              <div className="border border-gray-700 rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-gray-200">Instance Key</span>
                  {instanceData.key && (
                    <code className="text-[10px] text-gray-500 font-mono">{instanceData.key}</code>
                  )}
                </div>
                {instanceData.key ? (
                  <div className="flex flex-col gap-1 text-xs text-gray-400">
                    <div className="flex justify-between">
                      <span>Spend</span>
                      <span className="text-gray-200">${(instanceData.spend || 0).toFixed(4)}</span>
                    </div>
                    {instanceData.maxBudget && (
                      <div className="flex justify-between">
                        <span>Budget</span>
                        <span className="text-gray-200">${instanceData.maxBudget}</span>
                      </div>
                    )}
                    <button
                      onClick={handleRotate}
                      disabled={rotating}
                      className="mt-2 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-500 text-gray-200 text-xs font-medium rounded transition-colors"
                    >
                      {rotating ? 'Rotating...' : 'Rotate Key'}
                    </button>
                  </div>
                ) : (
                  <p className="text-xs text-gray-500">No key assigned to this instance.</p>
                )}
              </div>
            )}

            {/* Models */}
            {models.length > 0 && (
              <div>
                <p className="text-xs text-gray-500 mb-2">Available models ({models.length}):</p>
                <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
                  {models.map((m) => (
                    <div key={m.model_name || m.id} className="text-xs text-gray-300 bg-gray-800 rounded px-2 py-1.5 flex justify-between">
                      <span className="font-mono">{m.model_name || m.id}</span>
                      {m.litellm_params?.model && (
                        <span className="text-gray-500 ml-2">{m.litellm_params.model}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
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
