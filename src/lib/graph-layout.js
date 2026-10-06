/**
 * Fleet layout: a pure function of the topology payload plus any positions the
 * operator has dragged.
 *
 * Radial, not columnar. Each host is a hub with its instances in a ring around
 * it, and the shared things it talks to — its gate, the model routes, the
 * providers behind them, the internet — sit on an outer arc. A fleet reads as a
 * few clusters that way, where columns turned it into one long queue once
 * providers and gates appeared.
 *
 * Still deliberately not a force simulation: identical data yields identical
 * coordinates, so the 10s refetch never moves anything under the pointer. What
 * moves is what the operator drags, and that is remembered.
 */

const NODE = {
  instance: { w: 178, h: 64 },
  host: { w: 210, h: 64 },
  proxy: { w: 150, h: 56 },
  backend: { w: 168, h: 54 },
  provider: { w: 168, h: 50 },
  internet: { w: 120, h: 86 },
};

const RING = {
  instance: 300,      // instances around their host
  hostSpacing: 760,   // between host clusters
  outer: 520,         // gate, backends, providers, internet
};

export const CANVAS = { w: 1500, h: 1000 };

function sizeOf(type) {
  return NODE[type] || { w: 150, h: 50 };
}

function place(boxes, node, x, y) {
  const { w, h } = sizeOf(node.type);
  boxes.set(node.id, {
    x: x - w / 2, y: y - h / 2, w, h,
    cx: x, cy: y,
    // Radial edges leave from the centre; the renderer trims to the border.
    port: { x, y },
    inPort: { x, y },
  });
}

function instancesOf(nodes, hostId) {
  return nodes
    .filter((n) => n.type === 'instance' && (n.detail?.hostId || n.detail?.host) === hostId)
    .sort((a, b) => (a.label || '').localeCompare(b.label || ''));
}

export function layout(topology, overrides = {}) {
  const boxes = new Map();
  if (!topology?.nodes) return { boxes, viewBox: `0 0 ${CANVAS.w} ${CANVAS.h}`, width: CANVAS.w, height: CANVAS.h };

  const hosts = topology.nodes.filter((n) => n.type === 'host');
  const proxies = topology.nodes.filter((n) => n.type === 'proxy');
  const backends = topology.nodes.filter((n) => n.type === 'backend');
  const providers = topology.nodes.filter((n) => n.type === 'provider');
  const internet = topology.nodes.find((n) => n.type === 'internet');

  const width = Math.max(CANVAS.w, hosts.length * RING.hostSpacing + 500);
  const height = CANVAS.h;
  const cy = height / 2;

  // Host clusters across the left two thirds, each a hub with its own ring.
  hosts.forEach((host, hi) => {
    const hx = 330 + hi * RING.hostSpacing;
    place(boxes, host, hx, cy);

    const kids = instancesOf(topology.nodes, host.id.replace('host:', ''));
    // Start at the top and go clockwise, leaving the right-hand sector clear so
    // the spokes toward the gate and the internet are not crossed by chips.
    const span = Math.PI * 1.45;
    const start = -Math.PI * 0.72;
    kids.forEach((inst, i) => {
      const t = kids.length === 1 ? 0.5 : i / (kids.length - 1);
      const a = start + span * t;
      const r = RING.instance + (kids.length > 6 && i % 2 ? 90 : 0);   // second ring when crowded
      place(boxes, inst, hx + Math.cos(a) * r * 1.05, cy + Math.sin(a) * r * 0.95);
    });

    const proxy = proxies.find((p) => p.id === `proxy:${host.id.replace('host:', '')}`);
    if (proxy) place(boxes, proxy, hx + RING.outer, cy - 40 + hi * 40);
  });

  // Shared outer arc: model routes, then what is behind them, then the outside.
  const outerX = 330 + (hosts.length - 1) * RING.hostSpacing + RING.outer;
  backends.forEach((b, i) => {
    const offset = (i - (backends.length - 1) / 2) * 150;
    place(boxes, b, outerX + 280, cy + offset);
  });
  providers.forEach((pr, i) => {
    const offset = (i - (providers.length - 1) / 2) * 120;
    place(boxes, pr, outerX + 520, cy + offset + 120);
  });
  if (internet) place(boxes, internet, outerX + 560, cy - 150);

  // Anything the operator dragged wins, always.
  for (const [id, pos] of Object.entries(overrides || {})) {
    const b = boxes.get(id);
    if (!b || !pos) continue;
    boxes.set(id, { ...b, x: pos.x - b.w / 2, y: pos.y - b.h / 2, cx: pos.x, cy: pos.y, port: { x: pos.x, y: pos.y }, inPort: { x: pos.x, y: pos.y } });
  }

  // Size the canvas to whatever ended up on it, dragged nodes included.
  let maxX = width, maxY = height;
  for (const b of boxes.values()) {
    maxX = Math.max(maxX, b.x + b.w + 120);
    maxY = Math.max(maxY, b.y + b.h + 120);
  }

  return { boxes, viewBox: `0 0 ${maxX} ${maxY}`, width: maxX, height: maxY };
}

/**
 * Edge geometry between two node centres, trimmed to each node's border so the
 * line starts at the edge of the box rather than under its label.
 */
function trim(from, to) {
  const dx = to.cx - from.cx;
  const dy = to.cy - from.cy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  // Distance from centre to the border of a box along this direction.
  const reach = (b) => {
    const sx = Math.abs(ux) < 1e-6 ? Infinity : (b.w / 2 + 4) / Math.abs(ux);
    const sy = Math.abs(uy) < 1e-6 ? Infinity : (b.h / 2 + 4) / Math.abs(uy);
    return Math.min(sx, sy);
  };
  return {
    a: { x: from.cx + ux * reach(from), y: from.cy + uy * reach(from) },
    b: { x: to.cx - ux * reach(to), y: to.cy - uy * reach(to) },
  };
}

export function edgePath(from, to) {
  if (!from || !to) return null;
  const { a, b } = trim(from, to);
  // A gentle arc perpendicular to the line: radial graphs become unreadable when
  // several edges share a pair of endpoints.
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const bow = Math.min(40, len * 0.08);
  const cx = mx - (dy / len) * bow;
  const cyy = my + (dx / len) * bow;
  return { d: `M ${a.x} ${a.y} Q ${cx} ${cyy}, ${b.x} ${b.y}`, a, b, c: { x: cx, y: cyy } };
}

/** Sample the quadratic at t — used to move particles along an edge. */
export function pointOnPath(a, b, t, c) {
  if (!c) return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
  };
}

/** Which reach token a policy wears. Order matches NETWORK_POLICIES nesting. */
export function reachToken(policy) {
  switch (policy) {
    case 'claude-only': return 'var(--cm-reach-1)';
    case 'claude-github': return 'var(--cm-reach-2)';
    case 'claude-full-dev': return 'var(--cm-reach-3)';
    default: return 'var(--cm-reach-4)';   // unrestricted — wide open
  }
}
