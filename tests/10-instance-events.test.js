/**
 * Instance event/usage tests — the per-instance lifecycle event endpoint that
 * the in-container Claude Code hook (cm-notify) posts to on Stop, Notification
 * and UserPromptSubmit.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  authenticate, createTestInstance, removeTestInstance, waitForState,
  api, connectWS,
} from './helpers.js';

describe('Instance events + usage', () => {
  let instanceId;
  let asInstance;   // the headers a real in-container hook would send

  before(async () => {
    await authenticate();
    const { instance } = await createTestInstance('test-events');
    instanceId = instance.id;
    // The create response is the one place the raw token is ever returned.
    // Callbacks are bound to the calling instance now, so a request with no
    // token and a non-instance source IP is refused — which is the point.
    asInstance = { Authorization: `Bearer ${instance.eventToken}` };
    await waitForState(instanceId, 'running', 30000);
  });

  after(async () => {
    if (instanceId) {
      try { await removeTestInstance(instanceId, true); } catch {}
    }
  });

  it('refuses a callback that carries no instance token', async () => {
    const res = await api(`/api/instances/${instanceId}/event`, {
      method: 'POST',
      cookie: 'none=none',
      body: { event: 'Stop', contextTokens: 1 },
    });
    assert.equal(res.status, 403, 'a bare request from a non-instance IP must not be able to speak as the instance');
  });

  it('accepts a usage event from the instance itself without device auth', async () => {
    // No cookie — the hook runs inside the container and proves itself with
    // the per-instance token instead.
    const res = await api(`/api/instances/${instanceId}/event`, {
      method: 'POST',
      headers: asInstance,
      cookie: 'none=none',
      body: { event: 'Stop', contextTokens: 54200, outputTokens: 640, model: 'claude-opus-4-8' },
    });
    assert.equal(res.status, 202, `Expected 202, got ${res.status}: ${res.text}`);
  });

  it('surfaces the reported usage on the instance list', async () => {
    const res = await api('/api/instances');
    const inst = res.json.find((i) => i.id === instanceId);
    assert.ok(inst, 'instance should be present');
    assert.ok(inst.usage, 'instance should carry a usage object');
    assert.equal(inst.usage.contextTokens, 54200);
    assert.equal(inst.usage.outputTokens, 640);
    assert.equal(inst.usage.model, 'claude-opus-4-8');
  });

  it('broadcasts an instance_notify event over the WebSocket', async () => {
    const conn = await connectWS('/api/instances/events');
    try {
      await api(`/api/instances/${instanceId}/event`, {
        method: 'POST',
      headers: asInstance,
        body: { event: 'Notification', message: 'needs attention', contextTokens: 100 },
      });
      const messages = await conn.waitForMessages(1, 5000);
      const parsed = messages.map((m) => { try { return JSON.parse(m); } catch { return null; } }).filter(Boolean);
      const notify = parsed.find((m) => m.type === 'instance_notify' && m.id === instanceId);
      assert.ok(notify, `Expected an instance_notify message, got: ${JSON.stringify(parsed)}`);
      assert.equal(notify.event, 'Notification');
      assert.equal(notify.message, 'needs attention');
    } finally {
      conn.close();
    }
  });

  it('stores the three parts of the context window separately', async () => {
    const res = await api(`/api/instances/${instanceId}/event`, {
      method: 'POST',
      headers: asInstance,
      cookie: 'none=none',
      body: {
        event: 'Stop',
        contextTokens: 10_000, outputTokens: 500,
        inputTokens: 1000, cacheReadTokens: 8000, cacheCreationTokens: 1000,
      },
    });
    assert.equal(res.status, 202, res.text);

    const list = await api('/api/instances');
    const inst = list.json.find((i) => i.id === instanceId);
    assert.deepEqual(inst.usage.split, { input: 1000, cacheRead: 8000, cacheCreation: 1000 });
    assert.equal(inst.usage.contextTokens, 10_000);
  });

  it('derives the total from the parts when an older hook sends no total', async () => {
    await api(`/api/instances/${instanceId}/event`, {
      method: 'POST',
      headers: asInstance,
      body: { event: 'Stop', inputTokens: 200, cacheReadTokens: 300, cacheCreationTokens: 500 },
    });
    const list = await api('/api/instances');
    const inst = list.json.find((i) => i.id === instanceId);
    assert.equal(inst.usage.contextTokens, 1000, 'total should be the sum of the parts');
  });

  it('reports no split at all rather than zeros when only a total arrives', async () => {
    await api(`/api/instances/${instanceId}/event`, {
      method: 'POST',
      headers: asInstance,
      body: { event: 'Stop', contextTokens: 4242 },
    });
    const list = await api('/api/instances');
    const inst = list.json.find((i) => i.id === instanceId);
    assert.equal(inst.usage.contextTokens, 4242);
    assert.equal(inst.usage.split, null, 'unknown must not be reported as a 0% cache hit rate');
  });

  it('persists the status message and replaces it on the next event', async () => {
    await api(`/api/instances/${instanceId}/event`, {
      method: 'POST',
      headers: asInstance,
      body: { event: 'Notification', message: 'Claude needs your permission to use Bash' },
    });
    let inst = (await api('/api/instances')).json.find((i) => i.id === instanceId);
    assert.equal(inst.usage.statusMessage, 'Claude needs your permission to use Bash');
    assert.equal(inst.usage.lastEvent, 'Notification');

    // The message belongs to the event. A Stop with nothing to say must clear it,
    // or the dashboard keeps claiming the instance is waiting for permission.
    await api(`/api/instances/${instanceId}/event`, {
      method: 'POST',
      headers: asInstance,
      body: { event: 'Stop', contextTokens: 10 },
    });
    inst = (await api('/api/instances')).json.find((i) => i.id === instanceId);
    assert.equal(inst.usage.statusMessage, null, 'a stale permission prompt must not survive a Stop');
    assert.equal(inst.usage.lastEvent, 'Stop');
  });

  it('accepts UserPromptSubmit — the event that distinguishes waiting from working', async () => {
    const res = await api(`/api/instances/${instanceId}/event`, {
      method: 'POST',
      headers: asInstance,
      body: { event: 'UserPromptSubmit', message: 'fix the auth bug', contextTokens: 1234 },
    });
    assert.equal(res.status, 202, res.text);
    const inst = (await api('/api/instances')).json.find((i) => i.id === instanceId);
    assert.equal(inst.usage.lastEvent, 'UserPromptSubmit');
    assert.equal(inst.usage.statusMessage, 'fix the auth bug');
  });

  it('ignores usage for unknown event names', async () => {
    await api(`/api/instances/${instanceId}/event`, {
      method: 'POST',
      headers: asInstance,
      body: { event: 'BogusEvent', contextTokens: 999999 },
    });
    const res = await api('/api/instances');
    const inst = res.json.find((i) => i.id === instanceId);
    // Usage must retain the last KNOWN value, not the bogus 999999
    assert.notEqual(inst.usage?.contextTokens, 999999, 'unknown events must not overwrite usage');
  });
});
