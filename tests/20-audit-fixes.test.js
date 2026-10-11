/**
 * Fixes from the 2026-10-11 audit of model selection. Docker-free.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
process.env.DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'cm-audit-'));
const db = await import('../server/db.js');
db.initDb();

describe('Copilot cost counts cached tokens at a tenth', () => {
  it('every ghcopilot route has a cache-read price of input/10', () => {
    const blocks = read('litellm/config.yaml').split(/\n(?=  - model_name: )/).filter((b) => b.includes('model_name: ghcopilot/'));
    assert.ok(blocks.length >= 10);
    for (const b of blocks) {
      const inp = Number(b.match(/input_cost_per_token: ([0-9.e-]+)/)[1]);
      const cached = Number(b.match(/cache_read_input_token_cost: ([0-9.e-]+)/)?.[1]);
      assert.ok(Math.abs(cached - inp / 10) < 1e-12, b.split('\n')[0]);
    }
  });
});

describe('backends are named by their harness', () => {
  it('labels say which agent runs, and the dialog hints agree', async () => {
    const { BACKENDS } = await import('../server/llm-routing.js');
    for (const [id, b] of Object.entries(BACKENDS)) {
      if (b.agent === 'claude') assert.match(b.label, /^Claude Code · /, id);
      else assert.match(b.label, /^Copilot CLI · /, id);
    }
    assert.match(read('src/components/NewInstanceModal.jsx'), /ghcopilot: "Claude Code \(Anthropic's harness\) running a GitHub Copilot model/);
  });
});

describe('keys are kept as hashes only', () => {
  it('setLiteLLMKey stores the sha256 that LiteLLM uses, and old plaintext rows are migrated', () => {
    db.upsertInstance({ id: 'hash0001', name: 'hash test', image: 'x', hostId: 'local' });
    db.setLiteLLMKey('hash0001', 'sk-example-not-a-real-key');
    const stored = db.getLiteLLMKeyHash('hash0001');
    assert.match(stored, /^[0-9a-f]{64}$/);
    assert.equal(stored, db.hashKey('sk-example-not-a-real-key'));
    assert.ok(!JSON.stringify(db.getInstance('hash0001')).includes('sk-example'), 'no raw key anywhere in the row');
    assert.match(read('server/db.js'), /WHERE litellm_key LIKE 'sk-%'[\s\S]*hashKey\(r\.litellm_key\)/);
  });
  it('nothing in the server asks the database for a raw key any more', () => {
    for (const f of ['server/docker.js', 'server/routes/litellm.js', 'server/routes/instances.js']) {
      assert.doesNotMatch(read(f), /getLiteLLMKey\(/, f);
    }
  });
  it('rotation recreates the instance with the new key before revoking the old one', () => {
    const src = read('server/routes/litellm.js');
    const fn = src.slice(src.indexOf("'/api/instances/:id/litellm/rotate'"));
    const iRecreate = fn.indexOf('recreateInstance(id, { litellmKey: fresh.key })');
    const iRevokeOld = fn.indexOf('deleteVirtualKey(oldHash)');
    assert.ok(iRecreate > 0 && iRevokeOld > iRecreate);
    assert.match(fn, /spend: info\.spend \|\| 0/, 'rotation must not reset the spend so far');
    assert.match(fn, /catch \(err\) \{\n\s+await deleteVirtualKey\(fresh\.key\)/);
  });
});

describe('create and recreate fail closed and clean up', () => {
  const src = read('server/docker.js');
  const create = src.slice(src.indexOf('export async function createInstance'), src.indexOf('\nexport ', src.indexOf('export async function createInstance') + 10));
  it('a LiteLLM backend without a router is refused, not silently unrouted', async () => {
    const { assertRouterConfigured } = await import('../server/docker.js');
    assert.throws(() => assertRouterConfigured('ghcopilot', ''), (e) => e.code === 'litellm_not_configured' && e.statusCode === 409);
    assert.throws(() => assertRouterConfigured('anthropic-api', ''), (e) => e.code === 'litellm_not_configured');
    assert.doesNotThrow(() => assertRouterConfigured('claude-max', ''));
    assert.doesNotThrow(() => assertRouterConfigured('ghcopilot', 'http://cm-litellm:4000'));
    assert.match(create, /assertRouterConfigured\(llmBackend\);\n\s+const routed = isRouted\(llmBackend\);/);
  });
  it('the volume and key made by a failed create are undone', () => {
    assert.match(create, /undo\.push\(\(\) => docker\.getVolume\(volumeName\)\.remove\(\)\)/);
    assert.match(create, /undo\.push\(\(\) => deleteVirtualKey\(litellmKey\)\)/);
    assert.match(create, /for \(const step of undo\.reverse\(\)\)/);
    // the undo region opens before the volume and closes after the container exists
    assert.ok(create.indexOf('const undo = [];') < create.indexOf('docker.createVolume('));
    assert.ok(create.indexOf('for (const step of undo.reverse())') > create.indexOf('docker.createContainer('));
  });
});

describe('Claude login per host', () => {
  it('is checked by file existence only, cached, and shared between concurrent callers', () => {
    const src = read('server/claude-login.js');
    assert.match(src, /existsSync\(`\$\{LOCAL_CLAUDE_HOME\}\/\.credentials\.json`\)/);
    assert.match(src, /test -f \/root\/claude-home\/\.credentials\.json/);
    assert.doesNotMatch(src, /cat |readFile/, 'never read the credentials');
    assert.match(src, /inflight\.has\(hostId\)/);
  });
  it('the dialog warns before a Claude Max instance on a host without a login', () => {
    const m = read('src/components/NewInstanceModal.jsx');
    assert.match(m, /\/api\/hosts\/\$\{encodeURIComponent\(hostId\)\}\/claude-login/);
    assert.match(m, /llmBackend === 'claude-max' && claudeLogin\?\.loggedIn === false/);
  });
});
