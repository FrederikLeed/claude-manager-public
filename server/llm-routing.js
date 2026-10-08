/**
 * Which model an instance talks to, through which route, with which key.
 *
 * A backend is a family of routes on the LiteLLM router (or, for claude-max and
 * github-copilot, a path that bypasses it). An instance may pin one model of its
 * backend; Claude Code then sends every request, subagents and background calls
 * included, to that route. Each LiteLLM-routed instance gets its own virtual key,
 * scoped to its backend's routes and budgeted, so no instance holds a key that
 * reaches more than it was created for.
 */
import { config } from './config.js';
import { litellmFetch, getKeyInfo } from './litellm.js';

export const BACKENDS = {
  'claude-max': {
    routed: false, label: 'Claude Max', agent: 'claude',
  },
  'github-copilot': {
    routed: false, label: 'GitHub Copilot CLI', agent: 'copilot',
    // The CLI takes Copilot's own model ids; same seat as the ghcopilot/* routes.
    cliModels: true,
  },
  'local-llm': {
    routed: true, label: 'Local LLM (RTX 3090)', agent: 'claude', paid: false,
    // Qwen3 itself plus the Claude-named aliases Claude Code asks for by default.
    match: (id) => !id.includes('/') && (id.startsWith('qwen') || id.startsWith('claude-')),
    // Pinned: Claude Code's own default moves with every release (2.1.293 asks
    // for claude-opus-5-5, which no alias covers), so never rely on the aliases.
    defaultModel: 'qwen3-30b-a3b',
  },
  'anthropic-api': {
    routed: true, label: 'Anthropic API', agent: 'claude', paid: true,
    match: (id) => id.startsWith('anthropic/'),
    defaultModel: 'anthropic/claude-opus-5-5',
  },
  ghcopilot: {
    routed: true, label: 'GitHub Copilot via LiteLLM', agent: 'claude', paid: false,
    match: (id) => id.startsWith('ghcopilot/'),
    defaultModel: 'ghcopilot/claude-sonnet-5.5',
  },
  // Legacy Azure routes; the resource behind them is gone.
  foundry: {
    routed: true, label: 'Azure AI Foundry (GPT-4.1-mini)', agent: 'claude', paid: false,
    match: (id) => id === 'gpt-4.1-mini', defaultModel: 'gpt-4.1-mini', retired: true,
  },
  'foundry-latest': {
    routed: true, label: 'Azure AI Foundry (GPT Latest)', agent: 'claude', paid: false,
    match: (id) => id === 'gpt-chat-latest', defaultModel: 'gpt-chat-latest', retired: true,
  },
};

export const BACKEND_IDS = Object.keys(BACKENDS);
const CLI_MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;

export function isRouted(backend) {
  return !!BACKENDS[backend]?.routed;
}

function refuse(status, code, message) {
  const err = new Error(message);
  err.statusCode = status;
  err.code = code;
  return err;
}

export async function listRoutes() {
  const data = await litellmFetch('/v1/models');
  return (data?.data || []).map((m) => m.id).sort();
}

export function routesForBackend(backend, allRoutes) {
  const b = BACKENDS[backend];
  if (!b?.routed) return [];
  return allRoutes.filter(b.match);
}

/**
 * Validate the requested model for a backend. Returns the model to pin, or null
 * when the backend's own default applies (claude-max, local-llm aliases).
 */
export async function resolveModel(backend, model, { routes } = {}) {
  const b = BACKENDS[backend];
  if (!b) throw refuse(400, 'unknown_backend', `Unknown LLM backend "${backend}"`);
  if (b.cliModels) {
    if (!model) return null;
    if (!CLI_MODEL_RE.test(model)) throw refuse(400, 'bad_model', `"${model}" is not a Copilot model id`);
    return model;
  }
  if (!b.routed) {
    if (model) throw refuse(400, 'model_not_selectable', `${b.label} does not take a model choice`);
    return null;
  }
  const want = model || b.defaultModel || null;
  if (!want) return null;
  const allowed = routesForBackend(backend, routes || await listRoutes());
  if (!allowed.includes(want)) {
    throw refuse(400, 'model_not_on_backend', `"${want}" is not a route of ${b.label}; choose one of: ${allowed.join(', ')}`);
  }
  return want;
}

/**
 * Mint the instance's own LiteLLM key: only its backend's routes, budgeted.
 * Paid routes get the small paid budget. Fails closed on an empty route list,
 * because LiteLLM reads an empty list as "every model".
 */
export async function mintInstanceKey({ instanceId, name, backend, routes }) {
  const models = routesForBackend(backend, routes || await listRoutes());
  if (!models.length) throw refuse(503, 'no_routes_for_backend', `LiteLLM serves no routes for ${backend}`);
  const paid = !!BACKENDS[backend].paid;
  const res = await litellmFetch('/key/generate', {
    method: 'POST',
    body: {
      key_alias: `cm-${instanceId}`,
      models,
      max_budget: paid ? config.LITELLM_PAID_BUDGET : config.LITELLM_DEFAULT_BUDGET,
      metadata: { instance_id: instanceId, instance_name: name, backend },
    },
  });
  if (!res?.key) throw refuse(502, 'key_mint_failed', 'LiteLLM did not return a key');
  return res.key;
}

/** Where an instance on this host reaches the router. */
export function litellmUrlFor(host) {
  if (!host || host.kind === 'local') return config.LITELLM_API_BASE;
  if (!config.LITELLM_LAN_URL) {
    throw refuse(409, 'host_cannot_reach_litellm',
      `instances on ${host.name || host.id} need LITELLM_LAN_URL (the router's LAN address) to reach LiteLLM`);
  }
  return config.LITELLM_LAN_URL;
}

/** Environment that pins Claude Code to one route for every kind of request. */
export function modelEnv(model) {
  if (!model) return [];
  return [
    `ANTHROPIC_MODEL=${model}`,
    `ANTHROPIC_DEFAULT_OPUS_MODEL=${model}`,
    `ANTHROPIC_DEFAULT_SONNET_MODEL=${model}`,
    `ANTHROPIC_DEFAULT_HAIKU_MODEL=${model}`,
    `ANTHROPIC_SMALL_FAST_MODEL=${model}`,
    `CLAUDE_CODE_SUBAGENT_MODEL=${model}`,
  ];
}

export const MODEL_ENV_PREFIXES = ['ANTHROPIC_MODEL=', 'ANTHROPIC_DEFAULT_OPUS_MODEL=', 'ANTHROPIC_DEFAULT_SONNET_MODEL=',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL=', 'ANTHROPIC_SMALL_FAST_MODEL=', 'CLAUDE_CODE_SUBAGENT_MODEL='];

/**
 * Narrow an existing key to its backend's routes, never widen it. Keys minted
 * before per-backend scoping reach every non-paid route, and an empty list
 * means "every model" to LiteLLM, so both are cut down to the backend. A key
 * that is already narrower (say, one model) keeps exactly what it had. Throws
 * if nothing would remain or the router refuses, so recreate fails closed.
 */
export async function scopeKeyToBackend(key, backend, { routes } = {}) {
  const allowed = routesForBackend(backend, routes || await listRoutes());
  if (!allowed.length) throw refuse(503, 'no_routes_for_backend', `LiteLLM serves no routes for ${backend}`);
  const info = await getKeyInfo(key);
  if (!info) throw refuse(502, 'key_info_failed', 'LiteLLM did not describe the instance key');
  const have = info.info.models || [];
  const target = have.length ? have.filter((m) => allowed.includes(m)) : allowed;
  if (!target.length) throw refuse(409, 'key_scope_empty', `the instance key reaches none of ${backend}'s routes`);
  if (have.length && target.length === have.length) return have;      // already within scope
  const res = await litellmFetch('/key/update', { method: 'POST', body: { key, models: target } });
  const got = res?.models || [];
  if (got.length !== target.length || got.some((m) => !target.includes(m))) {
    throw refuse(502, 'key_scope_failed', `could not narrow the instance key to ${backend}`);
  }
  return target;
}
