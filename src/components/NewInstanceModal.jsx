import { useEffect, useState } from 'react';

const POLICY_OPTIONS = [
  { value: 'unrestricted', label: 'Unrestricted (no firewall)', badge: null },
  { value: 'claude-github', label: 'Claude + GitHub', badge: 'Recommended' },
  { value: 'claude-only', label: 'Claude API only', badge: 'Strict' },
  { value: 'claude-full-dev', label: 'Claude + GitHub + npm/PyPI/Cargo', badge: null },
];

// Shown while /api/llm/backends loads, or if it fails.
const FALLBACK_BACKENDS = [{ id: 'claude-max', label: 'Claude Code · Claude Max', agent: 'claude', models: [], available: true }];

const BACKEND_HINT = {
  'claude-max': 'Claude Code, signed in with your Claude Max subscription on that host.',
  'local-llm': 'Claude Code running Qwen3 on the workstation GPU, via LiteLLM. Free, but weak at multi-step tool use.',
  'anthropic-api': 'Claude Code on the Anthropic API credit, via LiteLLM. The instance gets its own key with a small budget.',
  ghcopilot: "Claude Code (Anthropic's harness) running a GitHub Copilot model, via LiteLLM. Billed in Copilot AI credits.",
  'github-copilot': "GitHub's own Copilot CLI instead of Claude Code, on your Copilot seat. Needs an unrestricted, claude-github or claude-full-dev policy.",
  foundry: 'Azure AI Foundry. The resource is retired; this backend no longer answers.',
  'foundry-latest': 'Azure AI Foundry. The resource is retired; this backend no longer answers.',
};

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
  const [llmModel, setLlmModel] = useState('');
  const [backends, setBackends] = useState(FALLBACK_BACKENDS);
  const [claudeLogin, setClaudeLogin] = useState(null);   // { hostId, loggedIn } for Claude Max on the chosen host
  const [expiryHours, setExpiryHours] = useState(24);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [hosts, setHosts] = useState([]);
  const [hostId, setHostId] = useState('local');

  useEffect(() => {
    // Only hosts that accept instances are offerable: a production host may be
    // registered and watched without ever being a placement target.
    fetch('/api/hosts')
      .then((r) => (r.ok ? r.json() : { hosts: [] }))
      .then((d) => {
        const usable = (d.hosts || []).filter((h) => h.enabled && h.acceptsInstances);
        setHosts(usable);
        if (usable.length && !usable.some((h) => h.id === 'local')) setHostId(usable[0].id);
      })
      .catch(() => setHosts([]));
  }, []);

  useEffect(() => {
    fetch('/api/llm/backends')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (Array.isArray(d) && d.length) setBackends(d); })
      .catch(() => {});
  }, []);

  // Claude Max instances share their host's Claude login; say so before creating
  // one on a host where Claude is not logged in.
  useEffect(() => {
    if (llmBackend !== 'claude-max' || !hostId) { setClaudeLogin(null); return undefined; }
    let alive = true;
    setClaudeLogin({ hostId, loggedIn: undefined });
    fetch(`/api/hosts/${encodeURIComponent(hostId)}/claude-login?refresh=1`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setClaudeLogin(d ? { hostId, loggedIn: d.loggedIn } : null); })
      .catch(() => { if (alive) setClaudeLogin(null); });
    return () => { alive = false; };
  }, [llmBackend, hostId]);

  const backend = backends.find((b) => b.id === llmBackend) || backends[0];
  // Claude Max has nothing to pick; every other backend lists its models.
  const modelChoices = backend?.models || [];
  const chooseBackend = (id) => {
    setLlmBackend(id);
    const b = backends.find((x) => x.id === id);
    setLlmModel(b?.defaultModel || (id === 'github-copilot' && b?.models?.[0]) || '');
  };

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
        hostId,
      };
      if (llmModel && modelChoices.includes(llmModel)) opts.llmModel = llmModel;
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

          {hosts.length > 0 && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">Host</label>
              <select
                value={hostId}
                onChange={(e) => setHostId(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 text-sm focus:outline-none focus:border-blue-500"
              >
                {hosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}{h.status === 'error' ? ' — unreachable' : ''}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500 mt-1">
                The instance and its workspace volume stay on this host.
              </p>
            </div>
          )}

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
              id="llm-backend"
              value={llmBackend}
              onChange={(e) => chooseBackend(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 text-sm focus:outline-none focus:border-blue-500"
            >
              {backends.map((b) => (
                <option key={b.id} value={b.id} disabled={!b.available}>
                  {b.label}{b.paid ? ' [paid credit]' : ''}{!b.available ? ' [unavailable]' : ''}
                </option>
              ))}
            </select>
            {modelChoices.length > 0 && (
              <select
                id="llm-model"
                aria-label="Model"
                value={llmModel}
                onChange={(e) => setLlmModel(e.target.value)}
                className="mt-2 w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 text-sm font-mono focus:outline-none focus:border-blue-500"
              >
                {llmBackend === 'github-copilot' && <option value="">Copilot default</option>}
                {modelChoices.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            )}
            <p className="text-xs text-gray-500 mt-1">{BACKEND_HINT[llmBackend] || ''}</p>
            {llmBackend === 'claude-max' && claudeLogin?.loggedIn === false && (
              <div role="alert" className="mt-2 text-xs rounded-lg border border-amber-700 bg-amber-950/40 text-amber-200 px-3 py-2">
                Claude isn't logged in on <b>{(hosts.find((h) => h.id === hostId)?.name || hostId)}</b>. The instance will start, but Claude Code will ask for <code>/login</code>.
                Log in once in any Claude Max instance on that host; every Claude Max instance there shares the login.
              </div>
            )}
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
