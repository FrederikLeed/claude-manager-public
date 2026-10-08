/**
 * The anthropic/* routes are billed to the Anthropic API credit. No key handed
 * to an instance may reach them, and none of them may log $0. Docker-free.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const { instanceModels, PAID_ROUTE_PREFIX } = await import('../server/litellm.js');

describe('paid Anthropic routes stay out of instance keys', () => {
  it('minted instance keys list models explicitly and exclude anthropic/*', () => {
    assert.equal(PAID_ROUTE_PREFIX, 'anthropic/');
    assert.deepEqual(instanceModels(['qwen3-30b-a3b', 'anthropic/claude-opus-5-5', 'claude-opus-4-8']), ['qwen3-30b-a3b', 'claude-opus-4-8']);
    const src = read('server/litellm.js');
    assert.match(src, /key_alias: `cm-\$\{instanceId\}`,\n\s+models,/, 'createVirtualKey must pass a models list');
    assert.match(src, /if \(!models\.length\) throw/, 'an empty list grants every model: fail closed');
  });

  it('instances never receive the master key', () => {
    const src = read('server/docker.js');
    assert.doesNotMatch(src, /backendKeys\[llmBackend\] \|\| config\.LITELLM_MASTER_KEY/);
    assert.doesNotMatch(src, /push\(`ANTHROPIC_API_KEY=\$\{config\.LITELLM_MASTER_KEY\}`/);
    assert.match(src, /err\.code = 'backend_key_missing'/);
    // checked before admit(), i.e. before any volume or container exists
    const create = src.slice(src.indexOf('export async function createInstance'));
    assert.ok(create.indexOf('backendKeyFor(llmBackend)') < create.indexOf('createVolume'));
    // recreate swaps an old master key for the backend key
    const re = src.slice(src.indexOf('export async function recreateInstance'));
    const body = re.slice(0, re.indexOf('\nexport '));
    assert.match(body, /backendKeyFor\(routedBackend\)[\s\S]*startsWith\('ANTHROPIC_API_KEY='\)/);
    // a master key is dropped even when the backend is not routed (fail closed)
    assert.match(body, /isMaster = config\.LITELLM_MASTER_KEY && e === `ANTHROPIC_API_KEY=\$\{config\.LITELLM_MASTER_KEY\}`/);
    // and the swap happens before the old container is stopped
    assert.ok(body.indexOf('backendKeyFor(routedBackend)') < body.indexOf('container.stop('));
  });

  it('every anthropic/* route has a price, so budgets count it', () => {
    const cfg = read('litellm/config.yaml');
    const blocks = cfg.split(/\n(?=  - model_name: )/).filter((b) => b.includes('model_name: anthropic/'));
    assert.ok(blocks.length >= 14, `expected the workspace's models, got ${blocks.length}`);
    for (const b of blocks) {
      const name = b.match(/model_name: (\S+)/)[1];
      assert.match(b, /input_cost_per_token: 0\.0+[1-9]/, `${name} input price`);
      assert.match(b, /output_cost_per_token: 0\.0+[1-9]/, `${name} output price`);
      assert.match(b, /anthropic-workspace-id: /, `${name} workspace header`);
    }
  });
});
