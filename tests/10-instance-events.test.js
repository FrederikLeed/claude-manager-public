/**
 * Instance event/usage tests — the per-instance lifecycle event endpoint that
 * the in-container Claude Code Stop/Notification hook (cm-notify) posts to.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  authenticate, createTestInstance, removeTestInstance, waitForState,
  api, connectWS,
} from './helpers.js';

describe('Instance events + usage', () => {
  let instanceId;

  before(async () => {
    await authenticate();
    const { instance } = await createTestInstance('test-events');
    instanceId = instance.id;
    await waitForState(instanceId, 'running', 30000);
  });

  after(async () => {
    if (instanceId) {
      try { await removeTestInstance(instanceId, true); } catch {}
    }
  });

  it('accepts a usage event and is reachable without device auth', async () => {
    // No cookie sent — endpoint must be auth-exempt (called from inside containers)
    const res = await api(`/api/instances/${instanceId}/event`, {
      method: 'POST',
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

  it('ignores usage for unknown event names', async () => {
    await api(`/api/instances/${instanceId}/event`, {
      method: 'POST',
      body: { event: 'BogusEvent', contextTokens: 999999 },
    });
    const res = await api('/api/instances');
    const inst = res.json.find((i) => i.id === instanceId);
    // Usage must retain the last KNOWN value, not the bogus 999999
    assert.notEqual(inst.usage?.contextTokens, 999999, 'unknown events must not overwrite usage');
  });
});
