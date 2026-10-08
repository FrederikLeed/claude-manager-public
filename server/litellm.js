import { config } from './config.js';

const BASE = () => config.LITELLM_API_BASE;
const KEY = () => config.LITELLM_MASTER_KEY;

export function isAvailable() {
  return !!(BASE() && KEY());
}

export async function litellmFetch(path, { method = 'GET', body } = {}) {
  const headers = {
    'Authorization': `Bearer ${KEY()}`,
  };
  if (body) headers['Content-Type'] = 'application/json';

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${BASE()}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LiteLLM ${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// Routes billed to the Anthropic API credit. A key minted for an instance must
// never reach them: LiteLLM treats an empty models list as "every model".
export const PAID_ROUTE_PREFIX = 'anthropic/';

export function instanceModels(allModelIds) {
  return allModelIds.filter((m) => !m.startsWith(PAID_ROUTE_PREFIX));
}

export async function createVirtualKey(instanceId, instanceName) {
  const all = ((await litellmFetch('/v1/models'))?.data || []).map((m) => m.id);
  const models = instanceModels(all);
  // Fail closed: an empty list would grant everything, paid routes included.
  if (!models.length) throw new Error('LiteLLM returned no models; refusing to mint an unrestricted key');
  return litellmFetch('/key/generate', {
    method: 'POST',
    body: {
      key_alias: `cm-${instanceId}`,
      models,
      metadata: { instance_id: instanceId, instance_name: instanceName },
      max_budget: config.LITELLM_DEFAULT_BUDGET,
    },
  });
}

export async function deleteVirtualKey(key) {
  return litellmFetch('/key/delete', {
    method: 'POST',
    body: { keys: [key] },
  });
}

export async function rotateVirtualKey(oldKey, instanceId, instanceName) {
  // Keep the old key's scope and budget: an anthropic-api instance's key reaches
  // paid routes a freshly minted default key must not.
  const info = (await getKeyInfo(oldKey))?.info;
  const models = info?.models?.length ? info.models : null;
  const fresh = models
    ? await litellmFetch('/key/generate', { method: 'POST', body: {
        key_alias: `cm-${instanceId}`, models, max_budget: info.max_budget ?? config.LITELLM_DEFAULT_BUDGET,
        metadata: { ...(info.metadata || {}), instance_id: instanceId, instance_name: instanceName } } })
    : await createVirtualKey(instanceId, instanceName);
  await deleteVirtualKey(oldKey);
  return fresh;
}

export async function getKeyInfo(key) {
  try {
    // POST with the key in the body: a key in the query string ends up in any
    // access log or proxy between here and the router.
    const res = await litellmFetch('/v2/key/info', { method: 'POST', body: { keys: [key] } });
    const info = Array.isArray(res?.info) ? res.info[0] : null;
    return info ? { info } : null;
  } catch {
    return null;
  }
}

export async function getModelList() {
  try {
    const data = await litellmFetch('/model/info');
    return data.data || [];
  } catch {
    return [];
  }
}

export async function getHealth() {
  try {
    const res = await fetch(`${BASE()}/health/liveliness`, {
      headers: { 'Authorization': `Bearer ${KEY()}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}
