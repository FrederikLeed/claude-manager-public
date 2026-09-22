/**
 * Auth system tests — device registration, TOFU, admin checks.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, sleep, TEST_DEVICE_TOKEN } from './helpers.js';

describe('Auth system', () => {
  // Use a unique DB, so tests don't conflict with existing dev state.
  // For now we test against the running dev server.

  describe('POST /api/auth/register', () => {
    it('should reject tokens shorter than 16 characters', async () => {
      const result = await api('/api/auth/register', {
        method: 'POST',
        body: { token: 'short', name: 'Bad Token' },
      });
      assert.equal(result.status, 400);
    });

    it('should register a device and return deviceId', async () => {
      const result = await api('/api/auth/register', {
        method: 'POST',
        body: { token: TEST_DEVICE_TOKEN, name: 'First Device' },
      });
      assert.equal(result.status, 200);
      assert.ok(result.json.deviceId);
      // If this is the first device it will be approved; if not, it depends on admin approval
      assert.ok(typeof result.json.approved === 'boolean');
    });

    it('should be idempotent for the same token', async () => {
      const token = 'idempotent-test-token-12345678';
      const r1 = await api('/api/auth/register', {
        method: 'POST',
        body: { token, name: 'Idempotent 1' },
      });
      const r2 = await api('/api/auth/register', {
        method: 'POST',
        body: { token, name: 'Idempotent 2' },
      });
      assert.equal(r1.status, 200);
      assert.equal(r2.status, 200);
      assert.equal(r1.json.deviceId, r2.json.deviceId);
    });

    it('should reject missing token', async () => {
      const result = await api('/api/auth/register', {
        method: 'POST',
        body: { name: 'No Token' },
      });
      assert.equal(result.status, 400);
    });
  });

  describe('GET /api/auth/status', () => {
    it('should return unknown without cookie', async () => {
      const result = await api('/api/auth/status', { cookie: 'invalid=nothing' });
      assert.equal(result.status, 200);
      assert.equal(result.json.status, 'unknown');
    });
  });

  describe('Auth protection', () => {
    it('should block /api/instances without auth', async () => {
      const result = await api('/api/instances', { cookie: 'invalid=nothing' });
      assert.equal(result.status, 401);
    });

    it('should block /api/system without auth', async () => {
      const result = await api('/api/system', { cookie: 'invalid=nothing' });
      assert.equal(result.status, 401);
    });

    it('should allow /api/auth/status without auth', async () => {
      const result = await api('/api/auth/status', { cookie: 'invalid=nothing' });
      assert.equal(result.status, 200);
    });

    it('should allow /api/auth/register without auth', async () => {
      const result = await api('/api/auth/register', {
        method: 'POST',
        body: { token: 'auth-protection-test-token-1234', name: 'Auth Test' },
        cookie: 'invalid=nothing',
      });
      assert.equal(result.status, 200);
    });

    // Regression: the auth hook gated on the raw request.url, but Fastify routes
    // on the decoded path — so "/%61pi/..." (= "/api/...") skipped auth while
    // still hitting the handler. Must be blocked, not served.
    it('should block percent-encoded /api path without auth', async () => {
      const result = await api('/%61pi/instances', { cookie: 'invalid=nothing' });
      assert.equal(result.status, 401);
    });

    it('should block double-encoded /api path without auth', async () => {
      const result = await api('/%2561pi/instances', { cookie: 'invalid=nothing' });
      // Either rejected by auth (401) or not routed to the handler (404) —
      // never 200 with handler data.
      assert.notEqual(result.status, 200);
    });
  });
});
