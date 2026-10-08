/**
 * Network map layout: where each instance's traffic may go, as a pure
 * function of the topology, the policy files, recent proxy denials, the
 * filters and the drawing width.
 *
 * Left to right:
 *   host  ->  its instances, one lane per network policy
 *         ->  that host's cm-proxy gate (allowlisted lanes only)
 *         ->  the destination groups the allowlists actually name.
 * Open lanes skip the gate and run straight to "Anywhere"; what the proxy
 * refused recently collects in a red "Blocked" node.
 */
import { layoutLane, ribbonPath, LANE_BY_ID } from './fleet-map.js';

export { ribbonPath };

export const POLICY_LANES = [
  { id: 'unrestricted', label: 'Open', sub: 'no firewall · reaches anywhere', color: '#ff7d6b' },
  { id: 'claude-full-dev', label: 'Full dev', sub: 'Claude · GitHub · registries', color: '#f0b54a' },
  { id: 'claude-github', label: 'Claude + GitHub', sub: 'Claude · GitHub · Copilot', color: '#5aa9ff' },
  { id: 'claude-only', label: 'Claude only', sub: 'Anthropic endpoints only', color: '#3ccf98' },
];
const OTHER_LANE = { label: 'Other policy', sub: 'custom allowlist', color: '#9aa3b8' };

export const DESTINATIONS = [
  { id: 'anthropic', label: 'Anthropic & Claude', color: '#ef8a5c', test: (h) => /(anthropic\.com|claude\.com|claude\.ai|sentry\.io)$/.test(h) },
  { id: 'github', label: 'GitHub & Copilot', color: '#8f8cff', test: (h) => /(github\.com|githubusercontent\.com|githubcopilot\.com)$/.test(h) },
  { id: 'registries', label: 'Package registries', color: '#f0b54a', test: (h) => /(npmjs\.org|yarnpkg\.com|pypi\.org|pythonhosted\.org|crates\.io|docker\.io|docker\.com|golang\.org|maven\.org)$/.test(h) },
  { id: 'onepassword', label: '1Password', color: '#5aa9ff', test: (h) => /1password(usercontent|services)?\.com$/.test(h) },
  { id: 'other', label: 'Other allowlisted', color: '#9aa3b8', test: () => true },
];
export const ANYWHERE = { id: 'anywhere', label: 'Anywhere', sub: 'no allowlist', color: '#ff7d6b' };
export const BLOCKED = { id: 'blocked', label: 'Blocked recently', sub: 'refused by the proxy', color: '#ef5b5b' };

export function laneDef(policy) {
  return POLICY_LANES.find((l) => l.id === policy) || { id: policy, ...OTHER_LANE, label: policy || OTHER_LANE.label };
}

/** Destination group of one allowlisted host ("." / "*." wildcards stripped). */
export function destOf(host) {
  const h = String(host || '').replace(/^\*?\./, '').toLowerCase();
  return DESTINATIONS.find((d) => d.test(h)).id;
}

/** policyId -> { groupId -> [hosts] } from /api/policies. */
export function policyReach(policies = []) {
  const out = {};
  for (const p of policies) {
    if (p.unrestricted) { out[p.id] = { anywhere: ['*'] }; continue; }
    const groups = {};
    for (const h of p.allowedHosts || []) (groups[destOf(h)] ||= []).push(h);
    out[p.id] = groups;
  }
  return out;
}

export function filterNetwork(instances, f = {}) {
  const q = (f.query || '').trim().toLowerCase();
  return instances.filter((n) => {
    const d = n.detail || {};
    if (f.policies && f.policies.size && !f.policies.has(d.policy)) return false;
    if (f.runningOnly && n.status !== 'ok') return false;
    if (f.flagged && !(d.dockerSocket || d.pendingRequests || f.deniedIds?.has(n.id.replace(/^instance:/, '')))) return false;
    if (q) {
      const hay = `${n.label} ${d.policy || ''} ${d.backend || ''} ${d.model || ''} ${d.host || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

const HOST_W = 210;
const HOST_GAP = 26;
const LANE_HEAD = 30;
const LANE_PAD = 12;

const backendLabel = (b) => LANE_BY_ID[b]?.label || b || 'Claude Max';

export function layoutNetworkMap(topology, { policies = [], denials = [] } = {}, filters = {}, width = 1400) {
  const W = Math.max(1100, width);
  const all = (topology?.nodes || []).filter((n) => n.type === 'instance');
  const hostNodes = (topology?.nodes || []).filter((n) => n.type === 'host');
  const reach = policyReach(policies);

  // Denials: per instance, and the hosts most often refused overall.
  const deniedIds = new Set(denials.map((d) => d.instanceId));
  const instances = filterNetwork(all, { ...filters, deniedIds });
  const byHostDenied = new Map();
  const deniedHosts = new Map();
  const hostOf = new Map(all.map((n) => [n.id.replace(/^instance:/, ''), n.detail?.hostId]));
  for (const d of denials) {
    const h = hostOf.get(d.instanceId) || 'local';
    byHostDenied.set(h, (byHostDenied.get(h) || 0) + 1 + (d.repeatsSinceLast || 0));
    deniedHosts.set(d.host, (deniedHosts.get(d.host) || 0) + 1 + (d.repeatsSinceLast || 0));
  }

  const fieldX = 24 + HOST_W + 28;
  const gateX = Math.round(W * 0.60);
  const destW = 250;
  const destX = W - 24 - destW;
  const fieldW = gateX - 120 - fieldX;

  const hosts = [];
  const lanes = [];
  const tiles = [];
  const labels = [];
  let y = 18;

  for (const h of hostNodes) {
    const hostId = h.id.replace(/^host:/, '');
    const mine = instances.filter((n) => n.detail?.hostId === hostId);
    if (!mine.length) continue;
    const top = y;
    const byLane = new Map();
    for (const n of mine) {
      const p = n.detail?.policy || 'unrestricted';
      if (!byLane.has(p)) byLane.set(p, []);
      byLane.get(p).push(n);
    }
    const order = [...POLICY_LANES.map((l) => l.id), ...[...byLane.keys()].filter((k) => !POLICY_LANES.some((l) => l.id === k))];
    let ly = y;
    for (const pid of order) {
      const items = byLane.get(pid);
      if (!items?.length) continue;
      const def = laneDef(pid);
      const laid = layoutLane(items, fieldX, ly + LANE_HEAD, fieldW, {
        groupKey: (n) => n.detail?.backend || 'claude-max',
        groupLabel: backendLabel,
      });
      const height = LANE_HEAD + laid.height + LANE_PAD;
      const proxied = items.some((n) => n.egress === 'proxied');
      lanes.push({
        key: `${hostId}:${pid}`, hostId, policy: pid, def, x: fieldX, y: ly, w: fieldW, h: height,
        count: items.length, running: items.filter((n) => n.status === 'ok').length,
        proxied, anchorY: ly + height / 2,
        reach: reach[pid] || (proxied ? {} : { anywhere: ['*'] }),
        allowedHosts: policies.find((p) => p.id === pid)?.allowedHosts?.length ?? null,
      });
      for (const t of laid.tiles) {
        const id = t.node.id.replace(/^instance:/, '');
        tiles.push({ ...t, lane: `${hostId}:${pid}`, color: def.color, denied: deniedIds.has(id) });
      }
      for (const l of laid.labels) labels.push({ ...l, lane: `${hostId}:${pid}` });
      ly += height + 8;
    }
    const bandH = Math.max(150, ly - y);
    hosts.push({
      id: hostId, node: h, x: 24, y: top, w: HOST_W, h: bandH,
      count: mine.length, running: mine.filter((n) => n.status === 'ok').length,
    });
    y = top + bandH + HOST_GAP;
  }
  const height = Math.max(y + 10, 560);
  const thick = (n) => Math.max(3, Math.min(46, 3 + n * 1.15));

  // ── gates: one cm-proxy per host that has allowlisted lanes ───────────────
  const gates = [];
  for (const h of hosts) {
    const mineLanes = lanes.filter((l) => l.hostId === h.id && l.proxied);
    if (!mineLanes.length) continue;
    const inT = mineLanes.reduce((s, l) => s + thick(l.count), 0);
    const gh = Math.max(110 + mineLanes.length * 21, inT + 70);
    const cy = mineLanes.reduce((s, l) => s + l.anchorY * thick(l.count), 0) / inT;
    gates.push({
      id: `gate:${h.id}`, hostId: h.id, hostLabel: h.node.label,
      enforced: h.node.detail?.kind === 'local',
      x: gateX - 95, y: Math.max(h.y, Math.min(h.y + h.h - gh, cy - gh / 2)), w: 190, h: gh,
      inT, lanes: mineLanes, count: mineLanes.reduce((s, l) => s + l.count, 0),
      denied: byHostDenied.get(h.id) || 0,
    });
  }

  // ── destinations: only groups something can reach, plus Blocked ─────────
  const destCount = new Map();
  const destHosts = new Map();
  for (const l of lanes) {
    for (const [g, hostsList] of Object.entries(l.reach)) {
      destCount.set(g, (destCount.get(g) || 0) + l.count);
      const set = destHosts.get(g) || new Set();
      hostsList.forEach((x) => set.add(x));
      destHosts.set(g, set);
    }
  }
  const destDefs = [...DESTINATIONS, ANYWHERE].filter((d) => destCount.has(d.id));
  if (denials.length) destDefs.push(BLOCKED);

  // Arrivals per destination, to size and stack.
  const arrivals = new Map(destDefs.map((d) => [d.id, []]));
  for (const g of gates) {
    const perDest = new Map();
    for (const l of g.lanes) for (const dest of Object.keys(l.reach)) perDest.set(dest, (perDest.get(dest) || 0) + l.count);
    for (const [dest, n] of perDest) arrivals.get(dest)?.push({ kind: 'gate', gate: g, t: thick(n), n, y: g.y + g.h / 2 });
    if (g.denied && arrivals.has('blocked')) {
      arrivals.get('blocked').push({ kind: 'gate', gate: g, t: Math.max(3, Math.min(30, 2 + Math.log2(1 + g.denied) * 4)), n: g.denied, y: g.y + g.h / 2, blocked: true });
    }
  }
  for (const l of lanes.filter((x) => !x.proxied)) {
    arrivals.get('anywhere')?.push({ kind: 'lane', lane: l, t: thick(l.count), n: l.count, y: l.anchorY });
  }

  const DEST_GAP = 18;
  const dests = destDefs.map((d) => {
    const inT = (arrivals.get(d.id) || []).reduce((s, a) => s + a.t, 0);
    const list = d.id === 'blocked'
      ? [...deniedHosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([hst, n]) => `${hst} ×${n}`)
      : d.id === 'anywhere' ? ['any host, any port'] : [...(destHosts.get(d.id) || [])].slice(0, 3);
    const more = d.id === 'blocked' ? Math.max(0, deniedHosts.size - 3) : Math.max(0, (destHosts.get(d.id)?.size || 0) - 3);
    return { ...d, inT, list, more, count: d.id === 'blocked' ? [...byHostDenied.values()].reduce((s, n) => s + n, 0) : destCount.get(d.id) || 0, h: Math.max(78, inT + 30, 44 + list.length * 14) };
  });
  const total = dests.reduce((s, d) => s + d.h, 0) + DEST_GAP * Math.max(0, dests.length - 1);
  let dy = Math.max(16, (height - total) / 2);
  for (const d of dests) { d.x = destX; d.y = dy; d.w = destW; dy += d.h + DEST_GAP; }
  const destById = Object.fromEntries(dests.map((d) => [d.id, d]));

  // ── ribbons ──────────────────────────────────────────────────────────────
  const ribbons = [];
  for (const g of gates) {
    let off = g.y + (g.h - g.inT) / 2;
    for (const l of [...g.lanes].sort((a, b) => a.anchorY - b.anchorY)) {
      const t = thick(l.count);
      ribbons.push({ key: `${l.key}>${g.id}`, lane: l.key, gate: g.id, color: l.def.color, toColor: '#c9d2e6', t, x0: l.x + l.w, y0: l.anchorY, x1: g.x, y1: off + t / 2 });
      off += t;
    }
  }
  for (const d of dests) {
    let off = d.y + (d.h - d.inT) / 2;
    const arr = [...(arrivals.get(d.id) || [])].sort((a, b) => a.y - b.y);
    for (const a of arr) {
      const y1 = off + a.t / 2;
      if (a.kind === 'gate') {
        ribbons.push({ key: `${a.gate.id}>${d.id}`, gate: a.gate.id, dest: d.id, color: '#c9d2e6', toColor: d.color, t: a.t, x0: a.gate.x + a.gate.w, y0: null, x1: d.x, y1, blocked: !!a.blocked });
      } else {
        ribbons.push({ key: `${a.lane.key}>${d.id}`, lane: a.lane.key, dest: d.id, color: a.lane.def.color, toColor: d.color, t: a.t, x0: a.lane.x + a.lane.w, y0: a.lane.anchorY, x1: d.x, y1, bypass: true });
      }
      off += a.t;
    }
  }
  // Gate outflows leave the gate's right edge stacked in destination order.
  for (const g of gates) {
    const outs = ribbons.filter((r) => r.gate === g.id && r.y0 === null).sort((a, b) => a.y1 - b.y1);
    const outT = outs.reduce((s, r) => s + r.t, 0);
    let o = g.y + (g.h - outT) / 2;
    for (const r of outs) { r.y0 = o + r.t / 2; o += r.t; }
  }

  const stats = {
    instances: all.length,
    shown: instances.length,
    proxied: all.filter((n) => n.egress === 'proxied').length,
    open: all.filter((n) => n.egress !== 'proxied').length,
    socket: all.filter((n) => n.detail?.dockerSocket).length,
    blocked: denials.reduce((s, d) => s + 1 + (d.repeatsSinceLast || 0), 0),
    deniedInstances: deniedIds.size,
  };
  return { width: W, height, hosts, lanes, tiles, labels, gates, dests: Object.values(destById), ribbons, stats };
}
