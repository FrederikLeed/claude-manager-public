import { config } from './config.js';

const BASE = () => config.LITELLM_API_BASE;
const KEY = () => config.LITELLM_MASTER_KEY;

export function isAvailable() {
  return !!(BASE() && KEY());
}

async function litellmFetch(path, { method = 'GET', body } = {}) {
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

export async function createVirtualKey(instanceId, instanceName) {
  return litellmFetch('/key/generate', {
    method: 'POST',
    body: {
      key_alias: `cm-${instanceId}`,
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
  await deleteVirtualKey(oldKey);
  return createVirtualKey(instanceId, instanceName);
}

export async function getKeyInfo(key) {
  try {
    return await litellmFetch(`/key/info?key=${encodeURIComponent(key)}`);
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
