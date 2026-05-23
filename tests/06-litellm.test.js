/**
 * LiteLLM proxy integration tests.
 * These tests require a running LiteLLM instance. If LiteLLM is not available,
 * most tests will be skipped gracefully.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, authenticate, createTestInstance, removeTestInstance, waitForState } from './helpers.js';

describe('LiteLLM Integration', () => {
  let litellmAvailable = false;

  before(async () => {
    await authenticate();

    // Check if LiteLLM is available
    const status = await api('/api/litellm/status');
    litellmAvailable = status.json?.available === true;
    if (!litellmAvailable) {
      console.log('  [skip] LiteLLM not configured — skipping most tests');
    }
  });

  describe('GET /api/litellm/status', () => {
    it('should return availability status', async () => {
      const result = await api('/api/litellm/status');
      assert.equal(result.status, 200);
      assert.ok('available' in result.json, 'Expected available field');
      assert.ok('healthy' in result.json, 'Expected healthy field');
    });
  });

  describe('GET /api/litellm/models', () => {
    it('should return model list (or empty if unavailable)', async () => {
      const result = await api('/api/litellm/models');
      assert.equal(result.status, 200);
      assert.ok(Array.isArray(result.json), 'Expected array');
    });
  });

  describe('Instance LiteLLM key lifecycle', () => {
    let instanceId;

    after(async () => {
      if (instanceId) {
        try { await removeTestInstance(instanceId, true); } catch {}
      }
    });

    it('should create instance with LiteLLM key if available', async () => {
      const { status, instance } = await createTestInstance('test-litellm-key');
      assert.equal(status, 201);
      instanceId = instance.id;
      await waitForState(instanceId, 'running', 30000);

      const llmInfo = await api(`/api/instances/${instanceId}/litellm`);
      assert.equal(llmInfo.status, 200);

      if (litellmAvailable) {
        assert.equal(llmInfo.json.available, true);
        assert.ok(llmInfo.json.key, 'Expected key to be assigned');
        assert.ok(typeof llmInfo.json.spend === 'number', 'Expected spend to be a number');
      } else {
        // When LiteLLM isn't available, the endpoint should still work
        assert.ok(llmInfo.json.available === false || llmInfo.json.key === null);
      }
    });

    it('should rotate key if LiteLLM is available', { skip: !litellmAvailable }, async () => {
      const result = await api(`/api/instances/${instanceId}/litellm/rotate`, { method: 'POST' });
      assert.equal(result.status, 200);
      assert.ok(result.json.key, 'Expected new key');
    });
  });

  describe('GET /api/instances/:id/litellm — no instance', () => {
    it('should handle non-existent instance', async () => {
      const result = await api('/api/instances/nonexistent-12345/litellm');
      assert.equal(result.status, 200);
      // Should return available status but no key
      if (litellmAvailable) {
        assert.ok(result.json.key === null || result.json.key === undefined);
      }
    });
  });
});
