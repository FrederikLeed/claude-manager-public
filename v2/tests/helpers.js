/**
 * Shared test helpers for claude-manager v2 integration tests.
 * Uses the running v2 dev server at localhost:3002.
 */

const API_BASE = process.env.TEST_API_BASE || 'http://localhost:3002';
const WS_BASE = API_BASE.replace(/^http/, 'ws');
let _cookie = null;

/**
 * Make an authenticated API request.
 */
export async function api(path, options = {}) {
  const { method = 'GET', body, query, cookie } = options;
  let url = `${API_BASE}${path}`;
  if (query) {
    const params = new URLSearchParams(query);
    url += `?${params}`;
  }

  const headers = {};
  if (body) {
    headers['Content-Type'] = 'application/json';
  }
  if (_cookie || cookie) {
    headers['Cookie'] = cookie || _cookie;
  }

  const fetchOptions = { method, headers };
  if (body) fetchOptions.body = JSON.stringify(body);

  const response = await fetch(url, fetchOptions);

  // Capture set-cookie header
  const setCookie = response.headers.get('set-cookie');
  if (setCookie && setCookie.includes('cm_device_token')) {
    _cookie = setCookie.split(';')[0];
  }

  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }

  return { status: response.status, json, text, headers: response.headers };
}

/**
 * Register and authenticate as a test device.
 * Uses a well-known token. If a device already exists from a prior session,
 * re-uses it. Otherwise registers fresh (first device = auto-admin).
 */
export async function authenticate(token = 'first-device-token-for-testing-001') {
  const result = await api('/api/auth/register', {
    method: 'POST',
    body: { token, name: 'Integration Test' },
  });
  if (result.status !== 200) {
    throw new Error(`Auth failed: ${result.text}`);
  }
  if (!result.json.approved) {
    throw new Error(`Device not approved. Register a device manually first or clear the test DB.`);
  }
  return result.json;
}

/**
 * Create a test instance and return its info.
 */
export async function createTestInstance(name = 'test-instance', options = {}) {
  const result = await api('/api/instances', {
    method: 'POST',
    body: {
      name,
      autoStart: options.autoStart ?? true,
      dockerSocket: options.dockerSocket ?? false,
      ...options,
    },
  });
  return { status: result.status, instance: result.json };
}

/**
 * Remove a test instance (force, keep volume).
 */
export async function removeTestInstance(id, removeVolume = true) {
  return api(`/api/instances/${id}`, {
    method: 'DELETE',
    query: { removeVolume: removeVolume.toString() },
  });
}

/**
 * Wait for a container to reach a specific state.
 */
export async function waitForState(id, targetState, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await api(`/api/instances/${id}`);
    if (result.json?.state === targetState) return result.json;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Timeout waiting for instance ${id} to reach state "${targetState}"`);
}

/**
 * Get the current auth cookie value for WebSocket connections.
 */
export function getAuthCookie() {
  return _cookie;
}

/**
 * Connect a WebSocket to an endpoint. Returns { ws, messages, close }.
 */
export function connectWS(path) {
  const url = `${WS_BASE}${path}`;
  // Node 22 has built-in WebSocket — pass cookie via headers
  const ws = new WebSocket(url, { headers: { Cookie: _cookie || '' } });
  const messages = [];

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`WS connect timeout: ${path}`)), 5000);

    ws.addEventListener('open', () => {
      clearTimeout(timeout);
      ws.addEventListener('message', (event) => {
        messages.push(event.data);
      });
      resolve({
        ws,
        messages,
        send: (data) => ws.send(data),
        close: () => ws.close(),
        waitForMessages: async (count, timeoutMs = 5000) => {
          const start = Date.now();
          while (messages.length < count && Date.now() - start < timeoutMs) {
            await new Promise(r => setTimeout(r, 100));
          }
          return messages.slice();
        },
      });
    });

    ws.addEventListener('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Cleanup: remove all test instances created during tests.
 */
export async function cleanupTestInstances() {
  const result = await api('/api/instances');
  if (!result.json || !Array.isArray(result.json)) return;

  for (const instance of result.json) {
    if (instance.name?.startsWith('test-')) {
      try {
        await removeTestInstance(instance.id, true);
      } catch { /* best effort */ }
    }
  }
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Create a test instance with a network policy.
 */
export async function createTestInstanceWithPolicy(name, policy, options = {}) {
  return createTestInstance(name, { networkPolicy: policy, ...options });
}

/**
 * Execute a command inside a running test instance.
 */
export async function execInInstance(id, cmd) {
  const result = await api(`/api/instances/${id}/exec`, {
    method: 'POST',
    body: { cmd },
  });
  return result;
}

/**
 * Make a direct LiteLLM API call (for test verification).
 */
const LITELLM_BASE = process.env.LITELLM_TEST_URL || 'http://localhost:4000';
export async function litellmApi(path, options = {}) {
  const { method = 'GET', body } = options;
  const masterKey = process.env.LITELLM_MASTER_KEY || 'sk-litellm-master-key';
  const headers = {
    'Authorization': `Bearer ${masterKey}`,
  };
  if (body) headers['Content-Type'] = 'application/json';

  const fetchOptions = { method, headers };
  if (body) fetchOptions.body = JSON.stringify(body);

  const response = await fetch(`${LITELLM_BASE}${path}`, fetchOptions);
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json, text };
}
