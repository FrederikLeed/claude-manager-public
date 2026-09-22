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

  it('should keep Claude memory per instance and writable', async () => {
    // Regression: /instance-memory/<slug> used to be created root-owned, so
    // Claude could not write there, and its memory fell back to the shared
    // claude-home project folder.
    const settings = await execInInstance(instanceId, 'cat /etc/claude-code/managed-settings.json');
    assert.match(settings.json.output || '', /"autoMemoryDirectory":\s*"\/workspace\/\.claude\/memory"/);
    const write = await execInInstance(instanceId, 'touch /workspace/.claude/memory/probe.md && rm /workspace/.claude/memory/probe.md && echo writable');
    assert.match(write.json.output || '', /writable/, 'per-instance memory directory is not writable by the claude user');
    const owner = await execInInstance(instanceId, 'stat -c %u /workspace/.claude /workspace/.claude/memory');
    assert.equal((owner.json.output || '').trim().split(/\s+/).join(','), '1001,1001');
  });

  it('should keep session transcripts out of the shared project folder', async () => {
    const name = await execInInstance(instanceId, 'echo $CLAUDE_CODE_PROJECT_DIR_NAME');
    const slug = (name.json.output || '').trim();
    assert.ok(slug && slug !== '-workspace', `expected a per-instance project directory name, got ${JSON.stringify(slug)}`);
    // Claude writes transcripts to $CLAUDE_CONFIG_DIR/projects/<name>, so a
    // per-instance name keeps them out of the shared "-workspace" folder.
    const home = await execInInstance(instanceId, `echo $CLAUDE_CONFIG_DIR; ls -d /home/claude/.claude/projects/${slug} 2>/dev/null || echo not-created-yet`);
    assert.doesNotMatch(home.json.output || '', /-workspace$/m, 'instance still uses the shared -workspace project folder');
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
