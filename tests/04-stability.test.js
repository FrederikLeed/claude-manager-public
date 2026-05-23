/**
 * Stability tests — stress, rapid operations, error recovery.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, authenticate, createTestInstance, removeTestInstance, waitForState, sleep, getAuthCookie } from './helpers.js';

describe('Stability', () => {
  before(async () => {
    await authenticate();
  });

  describe('Rapid create/destroy cycles', () => {
    it('should handle 3 sequential create/remove cycles', async () => {
      for (let i = 0; i < 3; i++) {
        const { status, instance } = await createTestInstance(`test-rapid-${i}`, { autoStart: true });
        assert.equal(status, 201, `Cycle ${i} create failed`);

        // Wait for running
        await waitForState(instance.id, 'running', 30000);

        // Remove
        const del = await removeTestInstance(instance.id, true);
        assert.equal(del.status, 200, `Cycle ${i} remove failed`);

        // Brief pause between cycles
        await sleep(1000);
      }
    });

    it('should handle create without autoStart then remove', async () => {
      const { status, instance } = await createTestInstance('test-no-start', { autoStart: false });
      assert.equal(status, 201);
      assert.equal(instance.state, 'created');

      const del = await removeTestInstance(instance.id, true);
      assert.equal(del.status, 200);
    });
  });

  describe('Concurrent operations', () => {
    it('should handle 3 concurrent instance creates', async () => {
      const promises = [0, 1, 2].map(i =>
        createTestInstance(`test-concurrent-${i}`, { autoStart: true })
      );
      const results = await Promise.all(promises);

      const ids = [];
      for (let i = 0; i < results.length; i++) {
        assert.equal(results[i].status, 201, `Concurrent create ${i} failed: ${JSON.stringify(results[i].instance)}`);
        ids.push(results[i].instance.id);
      }

      // Wait for all to be running
      await Promise.all(ids.map(id => waitForState(id, 'running', 30000)));

      // Cleanup all
      await Promise.all(ids.map(id => removeTestInstance(id, true)));
    });
  });

  describe('Docker socket toggle (recreate)', () => {
    let instanceId;

    after(async () => {
      if (instanceId) {
        try { await removeTestInstance(instanceId, true); } catch {}
      }
    });

    it('should recreate instance with docker socket enabled', async () => {
      const { instance } = await createTestInstance('test-recreate', { autoStart: true });
      instanceId = instance.id;
      await waitForState(instanceId, 'running', 30000);

      // Recreate with docker socket
      const result = await api(`/api/instances/${instanceId}/recreate`, {
        method: 'POST',
        body: { dockerSocket: true },
      });
      assert.equal(result.status, 200);
      assert.ok(result.json.dockerSocket, 'Should have docker socket after recreate');

      // Should be running again
      await waitForState(instanceId, 'running', 30000);

      // Recreate back without docker socket
      const result2 = await api(`/api/instances/${instanceId}/recreate`, {
        method: 'POST',
        body: { dockerSocket: false },
      });
      assert.equal(result2.status, 200);
      await waitForState(instanceId, 'running', 30000);
    });
  });

  describe('Error recovery', () => {
    it('should handle stop on non-existent instance gracefully', async () => {
      const result = await api('/api/instances/fake-id-99999/stop', { method: 'POST' });
      assert.ok([404, 500].includes(result.status), `Expected 404/500, got ${result.status}`);
    });

    it('should handle start on non-existent instance gracefully', async () => {
      const result = await api('/api/instances/fake-id-99999/start', { method: 'POST' });
      assert.ok([404, 500].includes(result.status));
    });

    it('should handle delete on non-existent instance gracefully', async () => {
      const result = await api('/api/instances/fake-id-99999', { method: 'DELETE' });
      assert.ok([404, 500].includes(result.status));
    });

    it('should handle double-stop gracefully', async () => {
      const { instance } = await createTestInstance('test-double-stop', { autoStart: true });
      try {
        await waitForState(instance.id, 'running', 30000);

        // First stop
        await api(`/api/instances/${instance.id}/stop`, { method: 'POST' });
        await waitForState(instance.id, 'exited', 20000);

        // Second stop — should not error
        const r2 = await api(`/api/instances/${instance.id}/stop`, { method: 'POST' });
        assert.equal(r2.status, 200, 'Double stop should succeed');
      } finally {
        await removeTestInstance(instance.id, true);
      }
    });

    it('should handle double-start gracefully', async () => {
      const { instance } = await createTestInstance('test-double-start', { autoStart: true });
      try {
        await waitForState(instance.id, 'running', 30000);

        // Start again — should not error (already running → 304 handled)
        const r = await api(`/api/instances/${instance.id}/start`, { method: 'POST' });
        assert.equal(r.status, 200, 'Double start should succeed');
      } finally {
        await removeTestInstance(instance.id, true);
      }
    });
  });

  describe('WebSocket events stream', () => {
    it('should connect to event stream', async () => {
      const ws = new WebSocket('ws://localhost:3001/api/instances/events', { headers: { Cookie: getAuthCookie() || '' } });
      const connected = await new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(false), 5000);
        ws.addEventListener('open', () => {
          clearTimeout(timeout);
          resolve(true);
        });
        ws.addEventListener('error', () => {
          clearTimeout(timeout);
          resolve(false);
        });
      });
      assert.ok(connected, 'Should connect to event stream');
      ws.close();
    });

    it('should receive events when instances change', async () => {
      const ws = new WebSocket('ws://localhost:3001/api/instances/events', { headers: { Cookie: getAuthCookie() || '' } });
      const messages = [];

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WS connect timeout')), 5000);
        ws.addEventListener('open', () => { clearTimeout(timeout); resolve(); });
        ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('WS error')); });
      });

      ws.addEventListener('message', (event) => {
        try { messages.push(JSON.parse(event.data)); } catch {}
      });

      // Create an instance — should trigger events
      const { instance } = await createTestInstance('test-events', { autoStart: true });
      await sleep(3000);

      // Should have received some events
      assert.ok(messages.length > 0, `Expected events, got ${messages.length}`);

      // Cleanup
      ws.close();
      await removeTestInstance(instance.id, true);
    });
  });
});
