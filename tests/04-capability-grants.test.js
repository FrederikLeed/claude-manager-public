/**
 * Capability grant expiry tests — auto-creation, expiry checks, renewal, recreate-without.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, authenticate, createTestInstance, createTestInstanceWithPolicy, removeTestInstance, waitForState, sleep } from './helpers.js';

describe('Capability Grants', () => {
  before(async () => {
    await authenticate();
  });

  describe('Auto-creation on docker socket', () => {
    let instanceId;

    after(async () => {
      if (instanceId) {
        try { await removeTestInstance(instanceId, true); } catch {}
      }
    });

    it('should create a grant when dockerSocket=true', async () => {
      const { status, instance } = await createTestInstance('test-grant-docker', { dockerSocket: true });
      assert.equal(status, 201);
      instanceId = instance.id;

      const grants = await api(`/api/instances/${instanceId}/grants`);
      assert.equal(grants.status, 200);
      assert.ok(Array.isArray(grants.json));

      const dockerGrant = grants.json.find((g) => g.capability_name === 'docker_socket');
      assert.ok(dockerGrant, 'Expected docker_socket grant');
      assert.equal(dockerGrant.active, 1);
      assert.ok(dockerGrant.expires_at, 'Expected expires_at');

      // Expiry should be ~24h from now
      const expiresMs = new Date(dockerGrant.expires_at).getTime() - Date.now();
      assert.ok(expiresMs > 20 * 3600000, `Expected >20h expiry, got ${(expiresMs / 3600000).toFixed(1)}h`);
      assert.ok(expiresMs < 26 * 3600000, `Expected <26h expiry, got ${(expiresMs / 3600000).toFixed(1)}h`);
    });
  });

  describe('Auto-creation on unrestricted network', () => {
    let instanceId;

    after(async () => {
      if (instanceId) {
        try { await removeTestInstance(instanceId, true); } catch {}
      }
    });

    it('should create a grant when networkPolicy=unrestricted', async () => {
      const { status, instance } = await createTestInstanceWithPolicy('test-grant-net', 'unrestricted', {
        expiryHours: 48,
      });
      assert.equal(status, 201);
      instanceId = instance.id;

      const grants = await api(`/api/instances/${instanceId}/grants`);
      assert.equal(grants.status, 200);

      const netGrant = grants.json.find((g) => g.capability_name === 'network_unrestricted');
      assert.ok(netGrant, 'Expected network_unrestricted grant');
      assert.equal(netGrant.active, 1);

      // Custom expiry of 48h
      const expiresMs = new Date(netGrant.expires_at).getTime() - Date.now();
      assert.ok(expiresMs > 44 * 3600000, `Expected >44h expiry, got ${(expiresMs / 3600000).toFixed(1)}h`);
    });
  });

  describe('No grant for restricted policy without docker socket', () => {
    let instanceId;

    after(async () => {
      if (instanceId) {
        try { await removeTestInstance(instanceId, true); } catch {}
      }
    });

    it('should not create grants for claude-github without docker socket', async () => {
      const { status, instance } = await createTestInstanceWithPolicy('test-grant-none', 'claude-github');
      assert.equal(status, 201);
      instanceId = instance.id;

      const grants = await api(`/api/instances/${instanceId}/grants`);
      assert.equal(grants.status, 200);
      assert.equal(grants.json.length, 0, 'Expected no grants');
    });
  });

  describe('Manual grant creation', () => {
    let instanceId;

    after(async () => {
      if (instanceId) {
        try { await removeTestInstance(instanceId, true); } catch {}
      }
    });

    it('should create and list a manual grant', async () => {
      const { instance } = await createTestInstance('test-grant-manual');
      instanceId = instance.id;

      const createResult = await api(`/api/instances/${instanceId}/grants`, {
        method: 'POST',
        body: { capabilityName: 'docker_socket', expiryHours: 12 },
      });
      assert.equal(createResult.status, 201);

      const grants = await api(`/api/instances/${instanceId}/grants`);
      const grant = grants.json.find((g) => g.capability_name === 'docker_socket');
      assert.ok(grant, 'Expected grant');
      assert.equal(grant.source, 'manual');
    });
  });

  describe('Grant renewal', () => {
    let instanceId;
    let grantId;

    after(async () => {
      if (instanceId) {
        try { await removeTestInstance(instanceId, true); } catch {}
      }
    });

    it('should renew a grant with new expiry', async () => {
      const { instance } = await createTestInstance('test-grant-renew', { dockerSocket: true });
      instanceId = instance.id;
      await waitForState(instanceId, 'running', 30000);

      const grants = await api(`/api/instances/${instanceId}/grants`);
      const grant = grants.json.find((g) => g.capability_name === 'docker_socket');
      assert.ok(grant);
      grantId = grant.id;

      const renewResult = await api(`/api/grants/${grantId}/renew`, {
        method: 'POST',
        body: { durationHours: 48 },
      });
      assert.equal(renewResult.status, 200);
      assert.ok(renewResult.json.expiresAt);

      // Verify new expiry is ~48h
      const newExpiresMs = new Date(renewResult.json.expiresAt).getTime() - Date.now();
      assert.ok(newExpiresMs > 44 * 3600000, `Expected >44h, got ${(newExpiresMs / 3600000).toFixed(1)}h`);
    });
  });

  describe('Grant deactivation', () => {
    let instanceId;

    after(async () => {
      if (instanceId) {
        try { await removeTestInstance(instanceId, true); } catch {}
      }
    });

    it('should deactivate a grant', async () => {
      const { instance } = await createTestInstance('test-grant-deactivate', { dockerSocket: true });
      instanceId = instance.id;

      const grants = await api(`/api/instances/${instanceId}/grants`);
      const grant = grants.json.find((g) => g.capability_name === 'docker_socket');
      assert.ok(grant);

      const result = await api(`/api/grants/${grant.id}`, { method: 'DELETE' });
      assert.equal(result.status, 200);

      // Verify deactivated (active grants endpoint only returns active=1)
      const afterGrants = await api(`/api/instances/${instanceId}/grants`);
      const stillActive = afterGrants.json.find((g) => g.id === grant.id);
      assert.ok(!stillActive, 'Grant should no longer appear in active grants');
    });
  });

  describe('Grants in instance list', () => {
    let instanceId;

    after(async () => {
      if (instanceId) {
        try { await removeTestInstance(instanceId, true); } catch {}
      }
    });

    it('should include grants in GET /api/instances', async () => {
      const { instance } = await createTestInstance('test-grant-list', { dockerSocket: true });
      instanceId = instance.id;

      const result = await api('/api/instances');
      const found = result.json.find((i) => i.id === instanceId);
      assert.ok(found, 'Instance not found in list');
      assert.ok(Array.isArray(found.grants), 'Expected grants array');
      assert.ok(found.grants.length > 0, 'Expected at least one grant');
    });
  });

  describe('Grant cleanup on instance delete', () => {
    it('should clean up grants when instance is deleted', async () => {
      const { instance } = await createTestInstance('test-grant-cleanup', { dockerSocket: true });
      const instanceId = instance.id;

      // Verify grant exists
      const grants = await api(`/api/instances/${instanceId}/grants`);
      assert.ok(grants.json.length > 0);

      // Delete instance
      await removeTestInstance(instanceId, true);

      // Grants endpoint should return empty or 404
      const afterGrants = await api(`/api/instances/${instanceId}/grants`);
      assert.ok(afterGrants.json.length === 0 || afterGrants.status === 404);
    });
  });
});
