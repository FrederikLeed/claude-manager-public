export const CONTAINER_STATES = {
  RUNNING: 'running',
  STOPPED: 'exited',
  CREATED: 'created',
  REMOVING: 'removing',
  PAUSED: 'paused',
  RESTARTING: 'restarting',
  DEAD: 'dead',
};

export const DISPLAY_STATES = {
  running: { label: 'Running', color: 'green' },
  exited: { label: 'Stopped', color: 'gray' },
  created: { label: 'Created', color: 'yellow' },
  removing: { label: 'Removing', color: 'red' },
  paused: { label: 'Paused', color: 'blue' },
  restarting: { label: 'Restarting', color: 'yellow' },
  dead: { label: 'Dead', color: 'red' },
};

export const LABELS = {
  MANAGED: 'claude-manager.managed',
  ID: 'claude-manager.id',
  NAME: 'claude-manager.name',
  NETWORK_POLICY: 'claude-manager.network-policy',
  LLM_BACKEND: 'claude-manager.llm-backend',
};

export const CONTAINER_PREFIX = 'cm-instance-';

export const WS_EVENTS = {
  INSTANCE_UPDATED: 'instance_updated',
  INSTANCE_CREATED: 'instance_created',
  INSTANCE_REMOVED: 'instance_removed',
  GRANT_EXPIRED: 'grant_expired',
  ACCESS_REQUESTED: 'access_requested',
  ACCESS_RESOLVED: 'access_resolved',
  // Reported from inside a container by the Claude Code Stop/Notification hook
  INSTANCE_NOTIFY: 'instance_notify',
  // Workspace image rebuild status (latest Claude Code)
  WORKSPACE_IMAGE: 'workspace_image',
  // Security scan status + new-critical alerts
  SECURITY_SCAN: 'security_scan',
  // Post-image-update connectivity smoke test + policy-lint alerts
  CONNECTIVITY_CHECK: 'connectivity_check',
};

// Claude Code hook events that an instance reports to the manager
export const INSTANCE_EVENTS = ['Stop', 'Notification'];

export const NETWORK_POLICIES = ['claude-only', 'claude-github', 'claude-full-dev', 'unrestricted'];

// Hosts Claude Code MUST reach to function. A restricted policy that omits any
// of these silently breaks Claude Code (squid 403 -> ERR_BAD_REQUEST). The
// policy lint asserts every restricted claude-* policy allowlists these. Keep
// in sync as Anthropic's endpoints drift — e.g. the Claude Code v2.1.x move to
// platform.claude.com that this guard was built to catch. The smoke test runs
// the real `claude` binary so it ALSO catches drift to endpoints not listed here.
export const REQUIRED_CLAUDE_HOSTS = ['api.anthropic.com', 'platform.claude.com'];

export const LLM_BACKENDS = [
  { id: 'claude-max', name: 'Claude Max', description: 'Anthropic direct (requires claude login)' },
  { id: 'local-llm', name: 'Local LLM', description: 'Qwen3 30B via Ollama (RTX 3090)' },
  { id: 'foundry', name: 'Azure AI Foundry (GPT-4.1-mini)', description: 'GPT-4.1-mini via Azure AI Foundry' },
  { id: 'foundry-latest', name: 'Azure AI Foundry (GPT Latest)', description: 'GPT Latest via Azure AI Foundry' },
];

export const CAPABILITY_NAMES = {
  DOCKER_SOCKET: 'docker_socket',
  NETWORK_UNRESTRICTED: 'network_unrestricted',
};

export const DEFAULT_EXPIRY_MS = {
  docker_socket: 24 * 60 * 60 * 1000,
  network_unrestricted: 24 * 60 * 60 * 1000,
  host_mount: 7 * 24 * 60 * 60 * 1000,
};

// Hostname allowed in a squid ACL: exact host, or a subdomain wildcard written
// as ".example.com" / "*.example.com". Anything else (spaces, newlines, paths,
// ports, IPs with ranges) is rejected — the value is written verbatim into a
// squid config include, so a newline would inject a directive.
export const ACL_HOST_RE = /^(\*\.|\.)?(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
export function isValidAclHost(host) {
  return typeof host === 'string' && ACL_HOST_RE.test(host);
}
