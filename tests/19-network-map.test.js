/**
 * Network map layout: allowlisted lanes pass their host's proxy gate, open
 * lanes bypass it, and the gate fans out only to what the policies name.
 * Docker-free.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { layoutNetworkMap, destOf, policyReach, filterNetwork } from '../src/lib/network-map.js';

const POLICIES = [
  { id: 'unrestricted', unrestricted: true, allowedHosts: [] },
  { id: 'claude-only', allowedHosts: ['api.anthropic.com', 'sentry.io', '.1password.com'] },
  { id: 'claude-github', allowedHosts: ['api.anthropic.com', 'github.com', '.githubcopilot.com'] },
];
function inst(i, policy, hostId, extra = {}) {
  return {
    id: `instance:i${i}`, type: 'instance', label: `i${i}`, status: 'ok',
    egress: policy === 'unrestricted' ? 'direct' : 'proxied',
    detail: { policy, hostId, host: hostId, backend: 'anthropic-api', ...extra },
  };
}
const nodes = [
  { id: 'host:local', type: 'host', label: 'manager-host', status: 'ok', detail: { kind: 'local' } },
  { id: 'host:ws', type: 'host', label: 'ws', status: 'ok', detail: { kind: 'ssh' } },
  inst(1, 'claude-only', 'local'), inst(2, 'claude-only', 'local'), inst(3, 'claude-github', 'local'),
  inst(4, 'unrestricted', 'local'), inst(5, 'unrestricted', 'ws', { dockerSocket: true }),
];
const denials = [{ instanceId: 'i1', host: 'pypi.org', repeatsSinceLast: 2 }];

describe('network map layout', () => {
  const L = layoutNetworkMap({ nodes, edges: [] }, { policies: POLICIES, denials }, {}, 1600);

  it('classifies allowlisted hosts into destination groups', () => {
    assert.equal(destOf('api.anthropic.com'), 'anthropic');
    assert.equal(destOf('.githubcopilot.com'), 'github');
    assert.equal(destOf('registry.npmjs.org'), 'registries');
    assert.equal(destOf('*.1passwordusercontent.com'), 'onepassword');
    assert.equal(destOf('example.org'), 'other');
    assert.deepEqual(Object.keys(policyReach(POLICIES).unrestricted), ['anywhere']);
  });

  it('allowlisted lanes enter the gate; open lanes go straight to Anywhere', () => {
    assert.equal(L.gates.length, 1, 'only the host with allowlisted lanes gets a gate');
    const g = L.gates[0];
    assert.equal(g.count, 3);
    for (const r of L.ribbons.filter((x) => x.lane?.endsWith(':claude-only') || x.lane?.endsWith(':claude-github'))) assert.equal(r.gate, g.id);
    const open = L.ribbons.filter((x) => x.lane?.endsWith(':unrestricted'));
    assert.equal(open.length, 2);
    assert.ok(open.every((r) => r.bypass && r.dest === 'anywhere'));
  });

  it('the gate reaches only destinations its policies name, plus Blocked', () => {
    const outs = new Set(L.ribbons.filter((r) => r.gate && !r.lane).map((r) => r.dest));
    assert.deepEqual([...outs].sort(), ['anthropic', 'blocked', 'github', 'onepassword']);
    const gh = L.dests.find((d) => d.id === 'github');
    assert.equal(gh.count, 1, 'only claude-github reaches GitHub');
    const blocked = L.dests.find((d) => d.id === 'blocked');
    assert.equal(blocked.count, 3);
    assert.match(blocked.list[0], /pypi\.org ×3/);
  });

  it('marks denied instances and keeps every ribbon on the canvas', () => {
    assert.ok(L.tiles.find((t) => t.id === 'instance:i1').denied);
    for (const r of L.ribbons) for (const y of [r.y0, r.y1]) assert.ok(y >= 0 && y <= L.height, r.key);
    assert.equal(L.stats.socket, 1);
  });

  it('the "needs a look" filter keeps socket, denied and pending instances only', () => {
    const all = nodes.filter((n) => n.type === 'instance');
    const kept = filterNetwork(all, { flagged: true, deniedIds: new Set(['i1']) }).map((n) => n.label).sort();
    assert.deepEqual(kept, ['i1', 'i5']);
  });
});
