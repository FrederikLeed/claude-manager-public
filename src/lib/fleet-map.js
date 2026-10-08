/**
 * Fleet map layout: a pure function of the topology payload, the active
 * filters and the drawing width. Identical input gives identical geometry, so
 * the periodic refetch never moves a tile under the pointer.
 *
 * Reading left to right, the way a request travels:
 *   host  ->  its instances, one lane per model family  ->  the LiteLLM router
 *   (or straight past it)  ->  the provider that answers.
 * Ribbon width is the number of instances on that path.
 */

export const LANES = [
  { id: 'claude-max', label: 'Claude Max', sub: 'subscription · direct', color: '#f0b54a', via: 'direct', provider: 'max' },
  { id: 'anthropic-api', label: 'Anthropic API', sub: 'paid credit · via LiteLLM', color: '#ef8a5c', via: 'router', provider: 'anthropic' },
  { id: 'ghcopilot', label: 'Copilot models', sub: 'Claude Code · via LiteLLM', color: '#7b8cff', via: 'router', provider: 'github' },
  { id: 'github-copilot', label: 'Copilot CLI', sub: "GitHub's agent · direct", color: '#b58cff', via: 'direct', provider: 'github' },
  { id: 'local-llm', label: 'Local LLM', sub: 'Qwen3 on the 3090 · via LiteLLM', color: '#3ccf98', via: 'router', provider: 'gpu' },
  { id: 'foundry', label: 'Azure Foundry', sub: 'retired', color: '#7d8494', via: 'router', provider: 'azure' },
  { id: 'foundry-latest', label: 'Azure Foundry latest', sub: 'retired', color: '#7d8494', via: 'router', provider: 'azure' },
];
export const LANE_BY_ID = Object.fromEntries(LANES.map((l) => [l.id, l]));

export const PROVIDERS = [
  { id: 'max', label: 'Claude Max', sub: 'Anthropic subscription', color: '#f0b54a' },
  { id: 'anthropic', label: 'Anthropic API', sub: '$200 / month credit', color: '#ef8a5c' },
  { id: 'github', label: 'GitHub Copilot', sub: 'enterprise seat · AI credits', color: '#8f8cff' },
  { id: 'gpu', label: 'Workstation GPU', sub: 'RTX 3090 · LAN · free', color: '#3ccf98' },
  { id: 'azure', label: 'Azure Foundry', sub: 'retired', color: '#7d8494' },
];

export const POLICY_SHORT = {
  unrestricted: 'open', 'claude-github': 'github', 'claude-only': 'claude only', 'claude-full-dev': 'full dev',
};

const TILE = 16;
const GAP = 5;
const PITCH = TILE + GAP;
const GROUP_GAP = 14;
const CHAR = 5.7;          // ~ width of a 9.5px mono glyph
const LABEL_H = 13;
const LANE_HEAD = 30;
const LANE_PAD = 12;
const HOST_W = 210;
const HOST_GAP = 26;

export function modelShort(model) {
  if (!model) return 'default';
  return model.replace(/^(anthropic|ghcopilot)\//, '').replace(/^claude-/, '').replace(/-20\d{6}$/, '');
}

export function instanceState(node) {
  if (node.status !== 'ok') return 'stopped';
  if (node.detail?.lastEvent === 'Notification') return 'attention';
  return 'running';
}

export function filterInstances(instances, f = {}) {
  const q = (f.query || '').trim().toLowerCase();
  return instances.filter((n) => {
    const d = n.detail || {};
    if (f.backends && f.backends.size && !f.backends.has(d.backend || 'claude-max')) return false;
    if (f.hosts && f.hosts.size && !f.hosts.has(d.hostId)) return false;
    if (f.egress === 'open' && n.egress !== 'direct') return false;
    if (f.egress === 'proxied' && n.egress !== 'proxied') return false;
    if (f.runningOnly && n.status !== 'ok') return false;
    if (q) {
      const hay = `${n.label} ${d.model || ''} ${d.backend || ''} ${d.policy || ''} ${d.host || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

const POLICY_ORDER = ['unrestricted', 'claude-github', 'claude-only', 'claude-full-dev'];

/** Lay out one lane: model groups flowing left to right, wrapping rows. */
/**
 * One lane: groups of tiles flowing left to right, wrapping rows. Groups are
 * keyed by `groupKey` and captioned by `groupLabel` (model by default).
 */
export function layoutLane(items, x0, y0, width, { groupKey = (n) => n.detail?.model || '', groupLabel = modelShort } = {}) {
  const groups = new Map();
  for (const n of items) {
    const key = groupKey(n);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  const ordered = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  const tiles = [];
  const labels = [];
  let x = x0;
  let y = y0;
  let rowH = 0;
  for (const [model, list] of ordered) {
    list.sort((a, b) => POLICY_ORDER.indexOf(a.detail?.policy) - POLICY_ORDER.indexOf(b.detail?.policy)
      || (a.detail?.hostId || '').localeCompare(b.detail?.hostId || '') || a.label.localeCompare(b.label));
    const text = groupLabel(model);
    const perRow = Math.max(1, Math.floor((width + GAP) / PITCH));
    const cols = Math.min(list.length, perRow);
    const rows = Math.ceil(list.length / cols);
    const w = Math.max(cols * PITCH - GAP, text.length * CHAR);
    const h = LABEL_H + rows * PITCH - GAP;
    if (x > x0 && x + w > x0 + width) { x = x0; y += rowH + GROUP_GAP; rowH = 0; }
    labels.push({ x, y: y + 9, text, model });
    list.forEach((n, i) => {
      tiles.push({ id: n.id, node: n, x: x + (i % cols) * PITCH, y: y + LABEL_H + Math.floor(i / cols) * PITCH, size: TILE });
    });
    x += w + GROUP_GAP;
    rowH = Math.max(rowH, h);
  }
  return { tiles, labels, height: (y - y0) + rowH };
}

/**
 * @returns {{width, height, hosts, lanes, tiles, router, providers, ribbons, stats}}
 */
export function layoutFleetMap(topology, filters = {}, width = 1400) {
  const W = Math.max(1100, width);
  const allInstances = (topology?.nodes || []).filter((n) => n.type === 'instance');
  const instances = filterInstances(allInstances, filters);
  const hostNodes = (topology?.nodes || []).filter((n) => n.type === 'host');

  const fieldX = 24 + HOST_W + 28;
  const routerX = Math.round(W * 0.70);
  const providerW = 220;
  const providerX = W - 24 - providerW;
  const fieldW = routerX - 150 - fieldX;

  const hosts = [];
  const lanes = [];
  const tiles = [];
  const labels = [];
  let y = 18;

  for (const h of hostNodes) {
    const hostId = h.id.replace(/^host:/, '');
    const mine = instances.filter((n) => n.detail?.hostId === hostId);
    if (!mine.length && filters.hosts?.size && !filters.hosts.has(hostId)) continue;
    const top = y;
    const byLane = new Map();
    for (const n of mine) {
      const lane = n.detail?.backend || 'claude-max';
      if (!byLane.has(lane)) byLane.set(lane, []);
      byLane.get(lane).push(n);
    }
    let ly = y;
    for (const def of LANES) {
      const items = byLane.get(def.id);
      if (!items?.length) continue;
      const laid = layoutLane(items, fieldX, ly + LANE_HEAD, fieldW);
      const height = LANE_HEAD + laid.height + LANE_PAD;
      lanes.push({
        key: `${hostId}:${def.id}`, hostId, def, x: fieldX, y: ly, w: fieldW, h: height,
        count: items.length, running: items.filter((n) => n.status === 'ok').length,
        anchorY: ly + height / 2,
      });
      for (const t of laid.tiles) tiles.push({ ...t, lane: `${hostId}:${def.id}`, color: def.color });
      for (const l of laid.labels) labels.push({ ...l, lane: `${hostId}:${def.id}` });
      ly += height + 8;
    }
    const bandH = Math.max(150, ly - y);
    hosts.push({
      id: hostId, node: h, x: 24, y: top, w: HOST_W, h: bandH,
      count: mine.length, running: mine.filter((n) => n.status === 'ok').length,
    });
    y = top + bandH + HOST_GAP;
  }
  const height = Math.max(y + 10, 520);

  // ── ribbons ──────────────────────────────────────────────────────────────
  const thick = (n) => Math.max(3, Math.min(46, 3 + n * 1.15));
  const providerLoad = new Map(PROVIDERS.map((p) => [p.id, { router: 0, direct: [] }]));
  const routerIn = [];
  for (const lane of lanes) {
    const t = thick(lane.count);
    if (lane.def.via === 'router') routerIn.push({ lane, t });
    else providerLoad.get(lane.def.provider)?.direct.push({ lane, t });
  }

  // Router: tall enough for everything that enters it, centred on its sources.
  const routerT = routerIn.reduce((s, r) => s + r.t, 0);
  const routerH = Math.max(120, routerT + 60);
  const routerCy = routerIn.length
    ? routerIn.reduce((s, r) => s + r.lane.anchorY * r.t, 0) / Math.max(1, routerT)
    : height / 2;
  const split = PROVIDERS.map((p) => ({
    id: p.id, label: p.label, color: p.color,
    count: routerIn.filter((r) => r.lane.def.provider === p.id).reduce((s, r) => s + r.lane.count, 0),
  })).filter((s) => s.count);
  const routerHFull = Math.max(routerH, 96 + split.length * 22);
  const router = {
    x: routerX - 80, y: Math.max(16, Math.min(height - routerHFull - 16, routerCy - routerHFull / 2)), w: 160, h: routerHFull,
    count: routerIn.reduce((s, r) => s + r.lane.count, 0),
    split,
  };

  // Out of the router, one band per provider, as wide as the lanes it carries.
  const routerOut = new Map();
  for (const { lane, t } of routerIn) {
    const p = lane.def.provider;
    routerOut.set(p, (routerOut.get(p) || 0) + t);
  }

  // Providers stacked on the right in their fixed order, sized by what arrives.
  const used = PROVIDERS.filter((p) => routerOut.has(p.id) || providerLoad.get(p.id).direct.length);
  const providers = [];
  const PROV_GAP = 22;
  const provHeights = used.map((p) => {
    const inT = (routerOut.get(p.id) || 0) + providerLoad.get(p.id).direct.reduce((s, d) => s + d.t, 0);
    return Math.max(64, inT + 34);
  });
  const totalProv = provHeights.reduce((s, h) => s + h, 0) + PROV_GAP * Math.max(0, used.length - 1);
  let py = Math.max(16, (height - totalProv) / 2);
  used.forEach((p, i) => {
    const count = [...lanes].filter((l) => l.def.provider === p.id).reduce((s, l) => s + l.count, 0);
    providers.push({ ...p, x: providerX, y: py, w: providerW, h: provHeights[i], count });
    py += provHeights[i] + PROV_GAP;
  });
  const provById = Object.fromEntries(providers.map((p) => [p.id, p]));

  const ribbons = [];
  // lane -> router: stacked on the router's left edge in source order
  let rOff = router.y + (router.h - routerT) / 2;
  for (const { lane, t } of [...routerIn].sort((a, b) => a.lane.anchorY - b.lane.anchorY)) {
    ribbons.push({
      key: `${lane.key}>router`, lane: lane.key, provider: lane.def.provider, color: lane.def.color, t,
      x0: lane.x + lane.w, y0: lane.anchorY, x1: router.x, y1: rOff + t / 2,
    });
    rOff += t;
  }
  // router -> provider, and direct lanes -> provider, stacked on the provider's left edge
  for (const p of providers) {
    const inT = (routerOut.get(p.id) || 0) + providerLoad.get(p.id).direct.reduce((s, d) => s + d.t, 0);
    let off = p.y + (p.h - inT) / 2;
    const arrivals = [];
    if (routerOut.has(p.id)) arrivals.push({ kind: 'router', t: routerOut.get(p.id), y: router.y + router.h / 2 });
    for (const d of providerLoad.get(p.id).direct) arrivals.push({ kind: 'direct', ...d, y: d.lane.anchorY });
    arrivals.sort((a, b) => a.y - b.y);
    for (const a of arrivals) {
      if (a.kind === 'router') {
        ribbons.push({ key: `router>${p.id}`, provider: p.id, color: p.color, t: a.t, x0: router.x + router.w, y0: null, x1: p.x, y1: off + a.t / 2, fromRouter: true });
      } else {
        ribbons.push({ key: `${a.lane.key}>${p.id}`, lane: a.lane.key, provider: p.id, color: a.lane.def.color, t: a.t, x0: a.lane.x + a.lane.w, y0: a.lane.anchorY, x1: p.x, y1: off + a.t / 2, direct: true });
      }
      off += a.t;
    }
  }
  // router -> provider bands leave the router's right edge stacked in provider order
  let ro = router.y + (router.h - routerT) / 2;
  for (const r of ribbons.filter((x) => x.fromRouter).sort((a, b) => a.y1 - b.y1)) {
    r.y0 = ro + r.t / 2;
    ro += r.t;
  }

  const stats = {
    instances: allInstances.length,
    shown: instances.length,
    running: allInstances.filter((n) => n.status === 'ok').length,
    hosts: hostNodes.length,
    models: new Set(allInstances.map((n) => `${n.detail?.backend}|${n.detail?.model || ''}`)).size,
    proxied: allInstances.filter((n) => n.egress === 'proxied').length,
  };
  return { width: W, height, hosts, lanes, tiles, labels, router, providers: [...Object.values(provById)], ribbons, stats };
}

/** A sankey band between two vertical edges, as an SVG path. */
export function ribbonPath({ x0, y0, x1, y1, t }) {
  const mx = (x0 + x1) / 2;
  const h = t / 2;
  return `M${x0},${y0 - h} C${mx},${y0 - h} ${mx},${y1 - h} ${x1},${y1 - h} L${x1},${y1 + h} C${mx},${y1 + h} ${mx},${y0 + h} ${x0},${y0 + h} Z`;
}
