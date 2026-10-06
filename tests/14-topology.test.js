/**
 * The fleet graph's data model. Pure unit tests — no Docker, no server.
 *
 * A topology view is read as a statement of fact about what can reach what, so
 * the invariants worth protecting are about honesty: no edge may point at a node
 * that does not exist, and an egress edge must carry a grade saying how well the
 * claim is actually backed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
const layoutSrc = readFileSync(new URL('../src/lib/graph-layout.js', import.meta.url), 'utf8');
const topologySrc = readFileSync(new URL('../server/topology.js', import.meta.url), 'utf8');
const graphViewSrc = readFileSync(new URL('../src/components/GraphView.jsx', import.meta.url), 'utf8');

/**
 * Every status string topology.js can actually emit for a node.
 *
 * Literals inside call parentheses are not statuses — in
 * `.includes('proxy') ? 'warning' : 'ok'`, 'proxy' is an argument.
 */
function emittedStatuses() {
  const out = new Set();
  for (const line of topologySrc.split('\n')) {
    if (!/^\s*status:/.test(line)) continue;
    let bare = line;
    for (let i = 0; i < 10 && /\([^()]*\)/.test(bare); i++) bare = bare.replace(/\([^()]*\)/g, '');
    // ...and so are comparison operands: in `c.state === 'running' ? 'ok' : …`
    // the emitted statuses are 'ok' and 'stopped', never 'running'.
    bare = bare.replace(/[=!]==?\s*'[^']*'/g, '');
    for (const m of bare.matchAll(/'([a-z-]+)'/g)) out.add(m[1]);
  }
  return out;
}

describe('graph palette tokens', () => {
  it('declares exactly four reach steps, in nesting order', () => {
    const steps = [...css.matchAll(/--cm-reach-(\d): *(#[0-9a-f]{6})/gi)];
    assert.equal(steps.length, 4, 'the reach ramp is four steps: the four network policies');
    assert.deepEqual(steps.map((m) => m[1]), ['1', '2', '3', '4']);
  });

  it('keeps status colours out of the reach ramp', () => {
    const reach = [...css.matchAll(/--cm-reach-\d: *(#[0-9a-f]{6})/gi)].map((m) => m[1].toLowerCase());
    const status = [...css.matchAll(/--cm-(good|warn|serious|critical): *(#[0-9a-f]{6})/gi)].map((m) => m[2].toLowerCase());
    for (const s of status) {
      assert.ok(!reach.includes(s), `${s} is a status colour and must never also be a reach step`);
    }
  });

  it('maps every network policy to a reach token', () => {
    for (const policy of ['claude-only', 'claude-github', 'claude-full-dev']) {
      assert.match(layoutSrc, new RegExp(`'${policy}'`), `${policy} must have an explicit reach step`);
    }
    assert.match(layoutSrc, /default:\s*return 'var\(--cm-reach-4\)'/, 'unrestricted is the fallback: widest reach');
  });
});

describe('node status vocabulary', () => {
  // The bug this exists to prevent: the graph gated its "needs input" ring on
  // n.status === 'running', but topology.js reports a running container as 'ok'.
  // The gate was simply never true, and nothing failed — the ring just never
  // appeared, which looks exactly like "no instance is waiting".
  it('only compares n.status against values topology.js can emit', () => {
    const emitted = emittedStatuses();
    assert.ok(emitted.size > 0, 'should have found the emitted statuses');
    const compared = [...graphViewSrc.matchAll(/n\.status\s*===\s*'([a-z-]+)'/g)].map((m) => m[1]);
    for (const value of compared) {
      assert.ok(
        emitted.has(value),
        `GraphView compares n.status === '${value}', which topology.js never emits (it emits: ${[...emitted].sort().join(', ')})`,
      );
    }
  });

  it('has a STATUS entry for every status topology.js emits', () => {
    const block = graphViewSrc.match(/const STATUS = \{([\s\S]*?)\n\};/);
    assert.ok(block, 'GraphView must declare a STATUS map');
    const keys = new Set([...block[1].matchAll(/^\s*([a-z-]+):/gm)].map((m) => m[1]));
    for (const value of emittedStatuses()) {
      assert.ok(keys.has(value), `topology.js emits status '${value}' with no STATUS entry to render it`);
    }
  });
});

describe('topology honesty', () => {
  it('grades a restricted instance on a remote host as unenforceable', () => {
    // server/proxy.js writes ACLs through a local-only Docker client and
    // HTTPS_PROXY is a single global, so a policy on a remote host is a label
    // with nothing behind it. The graph must say so rather than drawing a gate.
    assert.match(topologySrc, /unenforceable/);
    assert.match(topologySrc, /kind !== 'local'/);
  });

  it('reads allowed-host counts from the field listPolicies actually returns', () => {
    assert.match(topologySrc, /allowedHosts\?\.length/);
    assert.ok(!/policyByName\.get\(policy\)\?\.hosts\?\.length/.test(topologySrc),
      'listPolicies() returns allowedHosts, not hosts — the old field silently yielded null');
  });

  it('ships its own blind spots alongside its claims', () => {
    assert.match(topologySrc, /notShown/);
    assert.match(topologySrc, /iptables lock/);
  });

  it('never invents an instance-to-instance relation', () => {
    assert.ok(!/kind: 'talks-to'|instance-to-instance/.test(topologySrc),
      'no such relation is recorded anywhere in the system');
  });
});

describe('graph layout places every instance', () => {
  it('puts instances in their host tray, matched on id and not display name', async () => {
    const { layout } = await import('../src/lib/graph-layout.js');
    // A host whose display name differs from its id is the normal case: the id
    // is 'local', the machine calls itself something else.
    const topology = {
      nodes: [
        { id: 'host:local', type: 'host', label: 'host-a', detail: { acceptsInstances: true } },
        { id: 'instance:a', type: 'instance', label: 'one', detail: { host: 'host-a', hostId: 'local' } },
        { id: 'instance:b', type: 'instance', label: 'two', detail: { host: 'host-a', hostId: 'local' } },
        { id: 'internet', type: 'internet', label: 'Internet', detail: {} },
      ],
      edges: [],
    };
    const { boxes } = layout(topology);
    assert.ok(boxes.get('instance:a'), 'instance a must be placed');
    assert.ok(boxes.get('instance:b'), 'instance b must be placed');
    // Radial: instances ring their host rather than sitting in a tray, so the
    // invariant is proximity to the hub, not containment.
    const hub = boxes.get('host:local');
    for (const id of ['instance:a', 'instance:b']) {
      const n = boxes.get(id);
      const d = Math.hypot(n.cx - hub.cx, n.cy - hub.cy);
      assert.ok(d > 100 && d < 600, `${id} should sit on its host's ring, was ${Math.round(d)}px away`);
    }
  });

  it('lets the operator override any position, and keeps the rest computed', async () => {
    const { layout } = await import('../src/lib/graph-layout.js');
    const topology = {
      nodes: [
        { id: 'host:local', type: 'host', label: 'host-a', detail: { acceptsInstances: true } },
        { id: 'instance:a', type: 'instance', label: 'a', detail: { hostId: 'local' } },
        { id: 'instance:b', type: 'instance', label: 'b', detail: { hostId: 'local' } },
      ],
      edges: [],
    };
    const base = layout(topology);
    const moved = layout(topology, { 'instance:a': { x: 1234, y: 567 } });
    assert.equal(moved.boxes.get('instance:a').cx, 1234, 'a dragged node lands exactly where it was dropped');
    assert.equal(moved.boxes.get('instance:a').cy, 567);
    assert.equal(
      moved.boxes.get('instance:b').cx,
      base.boxes.get('instance:b').cx,
      'and nothing else moves because of it',
    );
  });
})

describe('edge styling', () => {
  // The bug this pins: the proxy -> internet edge is the trunk of the whole
  // egress story, and it had no style entry, so it fell through to
  // 'not-checked' — a 1.5px dotted grey line, fainter than the direct-egress
  // lines it is supposed to dominate. Then giving it a grade re-broke it,
  // because grade was consulted before kind.
  const table = graphViewSrc.match(/const gradeStroke = \(t\) => \(\{([\s\S]*?)\n\}\);/);

  it('gives the gate\'s egress to the internet an explicit style', () => {
    assert.ok(table, 'GraphView must declare the style table');
    assert.match(table[1], /'allowlisted-egress':/, 'the egress trunk needs its own entry, not the not-checked fallback');
  });

  it('draws the trunk heavier than the direct-egress lines it competes with', () => {
    const w = (key) => {
      const m = table[1].match(new RegExp(`'?${key}'?: \\{[^}]*width: ([0-9.]+)`));
      return m ? Number(m[1]) : null;
    };
    const trunk = w('allowlisted-egress');
    const open = w('open');          // what an unrestricted instance's direct line uses
    assert.ok(trunk && open, 'both styles should declare a width');
    assert.ok(trunk > open, `trunk (${trunk}) must be heavier than direct egress (${open})`);
  });

  it('resolves an edge style by kind before grade', () => {
    // Every kind that has its own entry must win over whatever grade it carries,
    // or a graded trunk silently reverts to the generic enforced look.
    assert.match(
      graphViewSrc,
      /GRADE\[e\.kind\] \|\| GRADE\[e\.grade\]/,
      'kind must be consulted before grade',
    );
  });
});
