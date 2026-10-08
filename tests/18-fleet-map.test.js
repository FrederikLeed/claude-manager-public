/**
 * Fleet model map layout: pure geometry over a topology payload. Docker-free.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { layoutFleetMap, filterInstances, modelShort, LANES } from '../src/lib/fleet-map.js';

function inst(i, backend, model, policy, hostId, up = true) {
  return {
    id: `instance:${i}`, type: 'instance', label: `i${i}`, status: up ? 'ok' : 'stopped',
    egress: policy === 'unrestricted' ? 'direct' : 'proxied',
    detail: { backend, model, policy, hostId, host: hostId },
  };
}
const POL = ['unrestricted', 'claude-github', 'claude-only', 'claude-full-dev'];
const nodes = [
  { id: 'host:local', type: 'host', label: 'manager-host', status: 'ok', detail: { kind: 'local' } },
  { id: 'host:ws', type: 'host', label: 'ws', status: 'ok', detail: { kind: 'ssh' } },
];
let k = 0;
for (const m of ['anthropic/claude-opus-5-5', 'anthropic/claude-fable-5-1']) for (const p of POL) nodes.push(inst(k++, 'anthropic-api', m, p, 'local'));
for (const m of ['ghcopilot/gpt-6.1-sol', 'ghcopilot/claude-sonnet-5.5']) nodes.push(inst(k++, 'ghcopilot', m, 'unrestricted', 'ws'));
nodes.push(inst(k++, 'github-copilot', 'gpt-6.1-sol', 'claude-github', 'local'));
nodes.push(inst(k++, 'claude-max', null, 'unrestricted', 'ws', false));
nodes.push(inst(k++, 'local-llm', 'qwen3-30b-a3b', 'claude-only', 'local'));
const topo = { nodes, edges: [] };

describe('fleet map layout', () => {
  const L = layoutFleetMap(topo, {}, 1600);

  it('places every instance exactly once, without overlap, inside the canvas', () => {
    assert.equal(L.tiles.length, k);
    const ids = new Set(L.tiles.map((t) => t.id));
    assert.equal(ids.size, k);
    for (let i = 0; i < L.tiles.length; i++) for (let j = i + 1; j < L.tiles.length; j++) {
      const a = L.tiles[i]; const b = L.tiles[j];
      const apart = a.x + a.size <= b.x || b.x + b.size <= a.x || a.y + a.size <= b.y || b.y + b.size <= a.y;
      assert.ok(apart, `${a.id} overlaps ${b.id}`);
    }
    for (const t of L.tiles) assert.ok(t.x >= 0 && t.y >= 0 && t.x + t.size <= L.width && t.y + t.size <= L.height);
  });

  it('routes LiteLLM backends through the router and direct ones straight to the provider', () => {
    const byLane = (id) => L.ribbons.filter((r) => r.lane?.endsWith(`:${id}`));
    assert.ok(byLane('anthropic-api').every((r) => r.x1 === L.router.x), 'anthropic-api enters the router');
    assert.ok(byLane('github-copilot').every((r) => r.direct), 'Copilot CLI bypasses it');
    assert.ok(byLane('claude-max').every((r) => r.direct), 'Claude Max bypasses it');
    // Copilot CLI and Copilot-via-LiteLLM meet at the same provider
    const gh = L.providers.find((p) => p.id === 'github');
    assert.equal(gh.count, 3);
    assert.equal(L.router.count, 8 + 2 + 1);
  });

  it('ribbons stay within the canvas and never get thinner than 3px', () => {
    for (const r of L.ribbons) {
      assert.ok(r.t >= 3);
      for (const y of [r.y0, r.y1]) assert.ok(y >= 0 && y <= L.height, `${r.key} y=${y}`);
    }
  });

  it('filters by backend, egress, state and text', () => {
    const all = nodes.filter((n) => n.type === 'instance');
    assert.equal(filterInstances(all, { backends: new Set(['anthropic-api']) }).length, 8);
    assert.equal(filterInstances(all, { egress: 'open' }).length, 2 + 2 + 1);
    assert.equal(filterInstances(all, { runningOnly: true }).length, k - 1);
    assert.equal(filterInstances(all, { query: 'fable' }).length, 4);
  });

  it('short model names drop the route prefix and date suffix', () => {
    assert.equal(modelShort('anthropic/claude-opus-4-5-20251101'), 'opus-4-5');
    assert.equal(modelShort('ghcopilot/gpt-6.1-sol'), 'gpt-6.1-sol');
    assert.equal(modelShort(null), 'default');
  });

  it('knows every backend the server offers', async () => {
    const { BACKEND_IDS } = await import('../server/llm-routing.js');
    for (const id of BACKEND_IDS) assert.ok(LANES.some((l) => l.id === id), `no lane for ${id}`);
  });
});
