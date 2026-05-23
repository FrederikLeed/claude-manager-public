const BASE = '';

async function request(url, options = {}) {
  const headers = { ...options.headers };
  if (options.body) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${BASE}${url}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.message || body.error || `Request failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }

  return res.json();
}

// --- Auth ---

export function registerDevice(token, name) {
  return request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ token, name }),
  });
}

export function fetchAuthStatus() {
  return request('/api/auth/status');
}

export function fetchDevices() {
  return request('/api/auth/devices');
}

export function approveDeviceApi(id) {
  return request(`/api/auth/devices/${id}/approve`, { method: 'POST' });
}

export function revokeDeviceApi(id) {
  return request(`/api/auth/devices/${id}`, { method: 'DELETE' });
}

export function renameDeviceApi(id, name) {
  return request(`/api/auth/devices/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

// --- Instances ---

export function fetchInstances() {
  return request('/api/instances');
}

export function fetchInstance(id) {
  return request(`/api/instances/${id}`);
}

export function createInstance(opts) {
  return request('/api/instances', {
    method: 'POST',
    body: JSON.stringify(opts),
  });
}

export function startInstance(id) {
  return request(`/api/instances/${id}/start`, { method: 'POST' });
}

export function stopInstance(id) {
  return request(`/api/instances/${id}/stop`, { method: 'POST' });
}

export function removeInstance(id, removeVolume = false) {
  return request(`/api/instances/${id}?removeVolume=${removeVolume}`, {
    method: 'DELETE',
  });
}

export function updateInstance(id, fields) {
  return request(`/api/instances/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
}

export function recreateInstance(id, { dockerSocket }) {
  return request(`/api/instances/${id}/recreate`, {
    method: 'POST',
    body: JSON.stringify({ dockerSocket }),
  });
}

// --- System ---

export function fetchSystemInfo() {
  return request('/api/system');
}

export function discoverContainers() {
  return request('/api/instances/discover');
}

export function adoptContainer(dockerId, name) {
  return request('/api/instances/adopt', {
    method: 'POST',
    body: JSON.stringify({ dockerId, name }),
  });
}

export function fetchActivityLog() {
  return request('/api/system/activity');
}

export function uploadFile(file) {
  const form = new FormData();
  form.append('file', file);
  return fetch('/api/shared/upload', {
    method: 'POST',
    body: form,
    credentials: 'include',
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || body.error || 'Upload failed');
    }
    return res.json();
  });
}
