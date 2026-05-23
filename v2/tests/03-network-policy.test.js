/**
 * Network egress policy tests — policy creation, firewall enforcement, recreation.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, authenticate, createTestInstanceWithPolicy, removeTestInstance, waitForState, execInInstance, sleep } from './helpers.js';

describe('Network Egress Policy', () => {
  before(async () => {
    await authenticate();
  });

  describe('GET /api/policies', () => {
    it('should list available policies', async () => {
      const result = await api('/api/policies');
      assert.equal(result.status, 200);
      assert.ok(Array.isArray(result.json), 'Expected array');
      assert.ok(result.json.length >= 1, 'Expected at least one policy');

      const names = result.json.map((p) => p.name);
      assert.ok(names.includes('claude-github'), 'Expected claude-github policy');
      assert.ok(names.includes('unrestricted'), 'Expected unrestricted policy');
    });

    it('should return allowed_hosts for non-unrestricted policies', async () => {
      const result = await api('/api/policies');
      const claudeGithub = result.json.find((p) => p.name === 'claude-github');
      assert.ok(claudeGithub, 'claude-github policy not found');
      assert.ok(Array.isArray(claudeGithub.allowedHosts), 'Expected allowed_hosts array');
      assert.ok(claudeGithub.allowedHosts.includes('api.anthropic.com'), 'Expected api.anthropic.com in allowed_hosts');
    });
  });

  describe('Create with unrestricted policy', () => {
    let instanceId;

    after(async () => {
      if (instanceId) {
        try { await removeTestInstance(instanceId, true); } catch {}
      }
    });

    it('should create instance without CapAdd for unrestricted', async () => {
      const { status, instance } = await createTestInstanceWithPolicy('test-policy-unrestricted', 'unrestricted');
      assert.equal(status, 201, `Expected 201, got ${status}`);
      instanceId = instance.id;

      await waitForState(instanceId, 'running');

      // Verify no network policy label means unrestricted
      const details = await api(`/api/instances/${instanceId}`);
      assert.ok(details.json.networkPolicy === 'unrestricted' || !details.json.networkPolicy,
        'Expected unrestricted or no network policy');
    });
  });

  describe('Create with claude-github policy', () => {
    let instanceId;

    after(async () => {
      if (instanceId) {
        try { await removeTestInstance(instanceId, true); } catch {}
      }
    });

    it('should create instance with network policy', async () => {
      const { status, instance } = await createTestInstanceWithPolicy('test-policy-github', 'claude-github');
      assert.equal(status, 201, `Expected 201, got ${status}`);
      instanceId = instance.id;

      await waitForState(instanceId, 'running', 30000);
    });

    it('should have network policy in instance info', async () => {
      const result = await api(`/api/instances/${instanceId}`);
      assert.equal(result.status, 200);
      assert.equal(result.json.networkPolicy, 'claude-github');
    });

    it('should allow curl to api.anthropic.com', async () => {
      // Give firewall time to initialize
      await sleep(3000);
      const result = await execInInstance(instanceId, 'curl -s --max-time 10 -o /dev/null -w "%{http_code}" https://api.anthropic.com');
      // Any HTTP response (even 401) means the connection was allowed
      assert.ok(result.status === 200, `Exec failed: ${JSON.stringify(result.json)}`);
      const output = result.json?.output?.trim();
      assert.ok(output && output !== '000', `Expected HTTP response code, got "${output}" — connection may have been blocked`);
    });

    it('should block curl to example.com', async () => {
      const result = await execInInstance(instanceId, 'curl -s --max-time 5 -o /dev/null -w "%{http_code}" https://example.com');
      assert.ok(result.status === 200, `Exec failed: ${JSON.stringify(result.json)}`);
      const output = result.json?.output?.trim();
      // 000 = connection failed (blocked by firewall) or timeout
      assert.ok(output === '000' || output === '', `Expected blocked connection (000), got "${output}"`);
    });
  });

  describe('Create with claude-only policy', () => {
    let instanceId;

    after(async () => {
      if (instanceId) {
        try { await removeTestInstance(instanceId, true); } catch {}
      }
    });

    it('should create and verify claude-only blocks github.com', async () => {
      const { status, instance } = await createTestInstanceWithPolicy('test-policy-only', 'claude-only');
      assert.equal(status, 201);
      instanceId = instance.id;

      await waitForState(instanceId, 'running', 30000);
      await sleep(3000);

      const result = await execInInstance(instanceId, 'curl -s --max-time 5 -o /dev/null -w "%{http_code}" https://github.com');
      assert.ok(result.status === 200);
      const output = result.json?.output?.trim();
      assert.ok(output === '000' || output === '', `Expected github.com blocked, got "${output}"`);
    });
  });

  describe('Recreate with different policy', () => {
    let instanceId;

    after(async () => {
      if (instanceId) {
        try { await removeTestInstance(instanceId, true); } catch {}
      }
    });

    it('should recreate from claude-github to unrestricted', async () => {
      const { status, instance } = await createTestInstanceWithPolicy('test-policy-recreate', 'claude-github');
      assert.equal(status, 201);
      instanceId = instance.id;
      await waitForState(instanceId, 'running', 30000);

      // Recreate with unrestricted
      const recreateResult = await api(`/api/instances/${instanceId}/recreate`, {
        method: 'POST',
        body: { networkPolicy: 'unrestricted' },
      });
      assert.equal(recreateResult.status, 200);

      await waitForState(instanceId, 'running', 30000);

      // Verify policy changed
      const details = await api(`/api/instances/${instanceId}`);
      assert.ok(details.json.networkPolicy === 'unrestricted' || !details.json.networkPolicy);
    });
  });

  describe('Policy in instance list', () => {
    let instanceId;

    after(async () => {
      if (instanceId) {
        try { await removeTestInstance(instanceId, true); } catch {}
      }
    });

    it('should include networkPolicy in GET /api/instances', async () => {
      const { status, instance } = await createTestInstanceWithPolicy('test-policy-list', 'claude-full-dev');
      assert.equal(status, 201);
      instanceId = instance.id;
      await waitForState(instanceId, 'running', 30000);

      const result = await api('/api/instances');
      const found = result.json.find((i) => i.id === instanceId);
      assert.ok(found, 'Instance not found in list');
      assert.equal(found.networkPolicy, 'claude-full-dev');
    });
  });
});
