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
    // the model is validated before anything exists; the instance's own key is
    // minted just before the container and revoked if the container fails
    const create = src.slice(src.indexOf('export async function createInstance'));
    assert.ok(create.indexOf('resolveModel(') < create.indexOf('createVolume'));
    assert.ok(create.indexOf('mintInstanceKey(') < create.indexOf('createContainer('));
    assert.match(create, /if \(litellmKey\) await deleteVirtualKey\(litellmKey\)/);
    // recreate prefers the instance's own key, falling back to the backend key
    const re = src.slice(src.indexOf('export async function recreateInstance'));
    const body = re.slice(0, re.indexOf('\nexport '));
    assert.match(body, /const stored = routed \? getLiteLLMKey\(instanceId\) : null;[\s\S]*stored \|\| backendKeyFor\(routedBackend\)[\s\S]*startsWith\('ANTHROPIC_API_KEY='\)/);
    // a stored key is narrowed to its backend's routes before reuse, before the stop
    assert.match(body, /if \(stored\) await scopeKeyToBackend\(stored, routedBackend\);/);
    assert.ok(body.indexOf('scopeKeyToBackend(') < body.indexOf('container.stop('));
    // a master key is dropped even when the backend is not routed (fail closed)
    assert.match(body, /isMaster = config\.LITELLM_MASTER_KEY && e === `ANTHROPIC_API_KEY=\$\{config\.LITELLM_MASTER_KEY\}`/);
    // and the swap happens before the old container is stopped
    assert.ok(body.indexOf('backendKeyFor(routedBackend)') < body.indexOf('container.stop('));
    // the API response never carries the instance's key
    assert.match(read('server/routes/instances.js'), /const \{ litellmKey: _key, \.\.\.shown \} = instance;/);
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

describe('GitHub Copilot routes', () => {
  it('every copilot/* route has a stand-in price and the token never sits in the image', () => {
    const cfg = read('litellm/config.yaml');
    const blocks = cfg.split(/\n(?=  - model_name: )/).filter((b) => b.includes('model_name: ghcopilot/'));
    assert.ok(blocks.length >= 10, `ghcopilot routes: ${blocks.length}`);
    for (const b of blocks) {
      assert.match(b, /model: github_copilot\//);
      assert.match(b, /input_cost_per_token: 0\.0+[1-9]/);
    }
    assert.doesNotMatch(cfg, /apento|LEGO/i, 'no org names in a file that goes public');
    const ep = read('litellm/copilot-entrypoint.sh');
    assert.match(ep, /umask 077/);
    assert.match(read('docker-compose.yml'), /tmpfs:\n\s+- \/run\/gh-copilot:mode=0700/);
  });
});

describe('per-backend routing', async () => {
  const r = await import('../server/llm-routing.js');
  const ROUTES = ['anthropic/claude-opus-5-5', 'anthropic/claude-fable-5-1', 'ghcopilot/gpt-6.1-sol', 'ghcopilot/claude-sonnet-5.5',
    'qwen3-30b-a3b', 'claude-opus-4-8', 'lab-gemma3', 'gpt-4.1-mini'];
  it('each backend scopes to its own routes; paid routes only for anthropic-api', () => {
    assert.deepEqual(r.routesForBackend('anthropic-api', ROUTES), ['anthropic/claude-opus-5-5', 'anthropic/claude-fable-5-1']);
    assert.deepEqual(r.routesForBackend('ghcopilot', ROUTES), ['ghcopilot/gpt-6.1-sol', 'ghcopilot/claude-sonnet-5.5']);
    assert.deepEqual(r.routesForBackend('local-llm', ROUTES), ['qwen3-30b-a3b', 'claude-opus-4-8']);
    for (const b of ['local-llm', 'ghcopilot', 'foundry', 'foundry-latest']) {
      assert.ok(!r.routesForBackend(b, ROUTES).some((m) => m.startsWith('anthropic/')), b);
    }
    assert.deepEqual(r.routesForBackend('claude-max', ROUTES), []);
  });
  it('a model must belong to its backend', async () => {
    assert.equal(await r.resolveModel('anthropic-api', 'anthropic/claude-fable-5-1', { routes: ROUTES }), 'anthropic/claude-fable-5-1');
    assert.equal(await r.resolveModel('anthropic-api', null, { routes: ROUTES }), 'anthropic/claude-opus-5-5');
    await assert.rejects(r.resolveModel('ghcopilot', 'anthropic/claude-opus-5-5', { routes: ROUTES }), (e) => e.code === 'model_not_on_backend');
    await assert.rejects(r.resolveModel('claude-max', 'anything', { routes: ROUTES }), (e) => e.code === 'model_not_selectable');
    assert.equal(await r.resolveModel('github-copilot', 'gpt-6.1-sol', { routes: ROUTES }), 'gpt-6.1-sol');
    await assert.rejects(r.resolveModel('github-copilot', 'x; rm -rf /', { routes: ROUTES }), (e) => e.code === 'bad_model');
  });
  it('model env pins every kind of Claude Code request', () => {
    const env = r.modelEnv('ghcopilot/gpt-6.1-sol');
    for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) {
      assert.ok(env.includes(`${k}=ghcopilot/gpt-6.1-sol`), k);
    }
  });
  it('remote hosts reach the router by its LAN URL, or refuse', () => {
    assert.throws(() => r.litellmUrlFor({ id: 'ws', kind: 'ssh' }), (e) => e.code === 'host_cannot_reach_litellm');
  });
});

describe('scopeKeyToBackend only narrows', () => {
  it('intersects with the backend, treats an empty list as unscoped, never adds', () => {
    const src = read('server/llm-routing.js');
    const fn = src.slice(src.indexOf('export async function scopeKeyToBackend'));
    assert.match(fn, /const target = have\.length \? have\.filter\(\(m\) => allowed\.includes\(m\)\) : allowed;/);
    assert.match(fn, /if \(have\.length && target\.length === have\.length\) return have;/);
    assert.match(fn, /if \(!target\.length\) throw/);
  });
});
