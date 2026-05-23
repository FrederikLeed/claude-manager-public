/**
 * Workspace image tests — verify expected tools are installed in the workspace image.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { authenticate, createTestInstance, removeTestInstance, waitForState, execInInstance, sleep } from './helpers.js';

describe('Workspace Image', () => {
  let instanceId;

  before(async () => {
    await authenticate();
    const { instance } = await createTestInstance('test-workspace-image');
    instanceId = instance.id;
    await waitForState(instanceId, 'running', 30000);
    // Give entrypoint time to complete
    await sleep(2000);
  });

  after(async () => {
    if (instanceId) {
      try { await removeTestInstance(instanceId, true); } catch {}
    }
  });

  it('should have iptables installed', async () => {
    const result = await execInInstance(instanceId, 'which iptables');
    assert.equal(result.status, 200, `Exec failed: ${JSON.stringify(result.json)}`);
    assert.ok(result.json.output?.trim(), 'Expected iptables path');
  });

  it('should have ipset installed', async () => {
    const result = await execInInstance(instanceId, 'which ipset');
    assert.equal(result.status, 200, `Exec failed: ${JSON.stringify(result.json)}`);
    assert.ok(result.json.output?.trim(), 'Expected ipset path');
  });

  it('should have cline installed', async () => {
    const result = await execInInstance(instanceId, 'which cline || npm list -g cline 2>/dev/null');
    assert.equal(result.status, 200, `Exec failed: ${JSON.stringify(result.json)}`);
    // Cline should be found either as a binary or as a global npm package
    assert.ok(result.json.output?.trim(), 'Expected cline to be installed');
  });

  it('should have Node.js 22+', async () => {
    const result = await execInInstance(instanceId, 'node --version');
    assert.equal(result.status, 200, `Exec failed: ${JSON.stringify(result.json)}`);
    const version = result.json.output?.trim();
    assert.ok(version, 'Expected node version output');
    const major = parseInt(version.replace('v', '').split('.')[0]);
    assert.ok(major >= 22, `Expected Node.js 22+, got ${version}`);
  });

  it('should have init-firewall.sh in /usr/local/bin', async () => {
    const result = await execInInstance(instanceId, 'test -x /usr/local/bin/init-firewall.sh && echo "ok"');
    assert.equal(result.status, 200);
    assert.equal(result.json.output?.trim(), 'ok', 'Expected init-firewall.sh to be executable');
  });

  it('should have dig installed (for DNS resolution in firewall)', async () => {
    const result = await execInInstance(instanceId, 'which dig');
    assert.equal(result.status, 200, `Exec failed: ${JSON.stringify(result.json)}`);
    assert.ok(result.json.output?.trim(), 'Expected dig path');
  });
});
