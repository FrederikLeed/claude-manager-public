/**
 * Instance REST API tests — CRUD, validation, error handling.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, authenticate, createTestInstance, removeTestInstance, waitForState, sleep } from './helpers.js';

describe('Instances API', () => {
  before(async () => {
    await authenticate();
  });

  describe('GET /api/instances', () => {
    it('should return an array of instances', async () => {
      const result = await api('/api/instances');
      assert.equal(result.status, 200);
      assert.ok(Array.isArray(result.json), 'Expected array');
    });
  });

  describe('GET /api/system', () => {
    it('should return Docker system info', async () => {
      const result = await api('/api/system');
      assert.equal(result.status, 200);
      assert.ok(result.json.dockerVersion, 'Expected dockerVersion');
      assert.ok(typeof result.json.cpus === 'number');
      assert.ok(typeof result.json.managedInstances === 'number');
    });
  });

  describe('POST /api/instances — create', () => {
    let testInstanceId;

    after(async () => {
      if (testInstanceId) {
        try { await removeTestInstance(testInstanceId, true); } catch {}
      }
    });

    it('should create a new instance with autoStart', async () => {
      const { status, instance } = await createTestInstance('test-create-api');
      assert.equal(status, 201, `Expected 201, got ${status}: ${JSON.stringify(instance)}`);
      assert.ok(instance.id, 'Expected instance ID');
      assert.ok(instance.dockerId, 'Expected Docker ID');
      assert.equal(instance.name, 'test-create-api');
      testInstanceId = instance.id;
    });

    it('should reject empty name', async () => {
      const result = await api('/api/instances', {
        method: 'POST',
        body: { name: '' },
      });
      assert.equal(result.status, 400);
    });

    it('should reject invalid characters in name', async () => {
      const result = await api('/api/instances', {
        method: 'POST',
        body: { name: 'test/../../../etc/passwd' },
      });
      assert.equal(result.status, 400);
    });

    it('should reject missing name', async () => {
      const result = await api('/api/instances', {
        method: 'POST',
        body: {},
      });
      assert.equal(result.status, 400);
    });
  });

  describe('Instance lifecycle — full CRUD', () => {
    let instanceId;

    it('should create an instance', async () => {
      const { status, instance } = await createTestInstance('test-lifecycle');
      assert.equal(status, 201);
      instanceId = instance.id;
      // autoStart=true, so should be running or starting
      assert.ok(['running', 'created'].includes(instance.state), `Expected running/created, got ${instance.state}`);
    });

    it('should get instance details', async () => {
      const result = await api(`/api/instances/${instanceId}`);
      assert.equal(result.status, 200);
      assert.equal(result.json.id, instanceId);
    });

    it('should wait for running state', async () => {
      const info = await waitForState(instanceId, 'running');
      assert.equal(info.state, 'running');
    });

    it('should stop the instance', async () => {
      const result = await api(`/api/instances/${instanceId}/stop`, { method: 'POST' });
      assert.equal(result.status, 200);
      assert.ok(result.json.ok);

      // Wait for stopped state
      const info = await waitForState(instanceId, 'exited', 20000);
      assert.equal(info.state, 'exited');
    });

    it('should start the instance again', async () => {
      const result = await api(`/api/instances/${instanceId}/start`, { method: 'POST' });
      assert.equal(result.status, 200);

      const info = await waitForState(instanceId, 'running');
      assert.equal(info.state, 'running');
    });

    it('should update instance metadata', async () => {
      const result = await api(`/api/instances/${instanceId}`, {
        method: 'PATCH',
        body: { notes: 'Test note', tags: ['test', 'integration'] },
      });
      assert.equal(result.status, 200);

      // Verify the update
      const get = await api(`/api/instances/${instanceId}`);
      assert.equal(get.json.notes, 'Test note');
      assert.deepEqual(get.json.tags, ['test', 'integration']);
    });

    it('should stop and remove the instance', async () => {
      // Stop first
      await api(`/api/instances/${instanceId}/stop`, { method: 'POST' });
      await waitForState(instanceId, 'exited', 20000);

      // Remove with volume
      const result = await api(`/api/instances/${instanceId}`, {
        method: 'DELETE',
        query: { removeVolume: 'true' },
      });
      assert.equal(result.status, 200);

      // Verify it's gone
      const get = await api(`/api/instances/${instanceId}`);
      assert.equal(get.status, 404);
    });
  });

  describe('GET /api/instances/:id — not found', () => {
    it('should return 404 for non-existent instance', async () => {
      const result = await api('/api/instances/nonexistent-id-12345');
      assert.equal(result.status, 404);
    });
  });

  describe('POST /api/instances/:id/stop — already stopped', () => {
    let instanceId;

    before(async () => {
      const { instance } = await createTestInstance('test-stop-idempotent', { autoStart: false });
      instanceId = instance.id;
    });

    after(async () => {
      if (instanceId) {
        try { await removeTestInstance(instanceId, true); } catch {}
      }
    });

    it('should handle stop on a non-running container gracefully', async () => {
      // Container was created with autoStart=false, so it's not running
      const result = await api(`/api/instances/${instanceId}/stop`, { method: 'POST' });
      // Should succeed (304 internally converted to success) or already stopped
      assert.ok([200, 304].includes(result.status), `Expected 200/304, got ${result.status}`);
    });
  });

  describe('GET /api/system/activity', () => {
    it('should return activity log', async () => {
      const result = await api('/api/system/activity');
      assert.equal(result.status, 200);
      assert.ok(Array.isArray(result.json));
    });
  });

  describe('GET /api/instances/discover', () => {
    it('should return discoverable containers', async () => {
      const result = await api('/api/instances/discover');
      assert.equal(result.status, 200);
      assert.ok(Array.isArray(result.json));
    });
  });
});
