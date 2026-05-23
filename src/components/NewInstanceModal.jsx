import { useState } from 'react';

const POLICY_OPTIONS = [
  { value: 'unrestricted', label: 'Unrestricted (no firewall)', badge: null },
  { value: 'claude-github', label: 'Claude + GitHub', badge: 'Recommended' },
  { value: 'claude-only', label: 'Claude API only', badge: 'Strict' },
  { value: 'claude-full-dev', label: 'Claude + GitHub + npm/PyPI/Cargo', badge: null },
];

const LLM_OPTIONS = [
  { value: 'claude-max', label: 'Claude Max (Anthropic)', badge: null },
  { value: 'local-llm', label: 'Local LLM (Qwen3 30B)', badge: 'GPU' },
  { value: 'foundry', label: 'Azure AI Foundry (GPT-4.1-mini)', badge: null },
  { value: 'foundry-latest', label: 'Azure AI Foundry (GPT Latest)', badge: null },
];

const EXPIRY_OPTIONS = [
  { value: 24, label: '24 hours' },
  { value: 48, label: '48 hours' },
  { value: 168, label: '7 days' },
  { value: 0, label: 'No expiry' },
];

export default function NewInstanceModal({ defaultImage, onSubmit, onClose }) {
  const [name, setName] = useState('');
  const [image, setImage] = useState(defaultImage || '');
  const [notes, setNotes] = useState('');
  const [autoStart, setAutoStart] = useState(true);
  const [dockerSocket, setDockerSocket] = useState(false);
  const [networkPolicy, setNetworkPolicy] = useState('unrestricted');
  const [llmBackend, setLlmBackend] = useState('claude-max');
  const [expiryHours, setExpiryHours] = useState(24);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const needsExpiry = dockerSocket || networkPolicy === 'unrestricted';

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const opts = {
        name: name.trim(),
        image: image.trim(),
        notes: notes.trim() || undefined,
        autoStart,
        dockerSocket,
        networkPolicy,
        llmBackend,
      };
      if (needsExpiry && expiryHours > 0) {
        opts.expiryHours = expiryHours;
      }
      await onSubmit(opts);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-md mx-4 p-6 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-gray-100 mb-4">New Instance</h2>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Name *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-project"
              required
              pattern="^[a-zA-Z0-9_\- ]+$"
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Image</label>
            <input
              type="text"
              value={image}
              onChange={(e) => setImage(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What this instance is for..."
              rows={2}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Network policy</label>
            <select
              value={networkPolicy}
              onChange={(e) => setNetworkPolicy(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 text-sm focus:outline-none focus:border-blue-500"
            >
              {POLICY_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">
              {networkPolicy === 'unrestricted'
                ? 'No network restrictions. Requires a capability grant with expiry.'
                : 'Firewall applied on container start. Only listed hosts are reachable.'}
            </p>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">LLM backend</label>
            <select
              value={llmBackend}
              onChange={(e) => setLlmBackend(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 text-sm focus:outline-none focus:border-blue-500"
            >
              {LLM_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value} disabled={opt.badge === 'Coming soon'}>
                  {opt.label}{opt.badge ? ` [${opt.badge}]` : ''}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">
              {llmBackend === 'claude-max'
                ? 'Uses Anthropic API directly. Requires claude login in container.'
                : llmBackend === 'local-llm'
                ? 'Routes through LiteLLM to local Ollama. No login needed.'
                : llmBackend === 'foundry'
                ? 'Routes through LiteLLM to Azure AI Foundry (GPT-4.1-mini).'
                : 'Routes through LiteLLM to Azure AI Foundry (GPT Latest).'}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm text-gray-400">
              <input
                type="checkbox"
                checked={autoStart}
                onChange={(e) => setAutoStart(e.target.checked)}
                className="rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500"
              />
              Start immediately
            </label>

            <label className="flex items-center gap-2 text-sm text-gray-400">
              <input
                type="checkbox"
                checked={dockerSocket}
                onChange={(e) => setDockerSocket(e.target.checked)}
                className="rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500"
              />
              Docker socket access
              <span className="text-[10px] text-yellow-500 border border-yellow-800 rounded px-1 py-0.5">Privileged</span>
            </label>
          </div>

          {needsExpiry && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">Capability expiry</label>
              <select
                value={expiryHours}
                onChange={(e) => setExpiryHours(parseInt(e.target.value))}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 text-sm focus:outline-none focus:border-blue-500"
              >
                {EXPIRY_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              <p className="text-xs text-gray-500 mt-1">
                High-risk capabilities expire and require renewal.
              </p>
            </div>
          )}

          {error && (
            <div className="text-sm text-red-400 bg-red-900/20 border border-red-800 rounded px-3 py-2">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-3 mt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim()}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:text-blue-400 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {submitting ? 'Creating...' : 'Create Instance'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
