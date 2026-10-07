import { useEffect, useMemo, useRef, useState } from 'react';
import { layout, edgePath, pointOnPath, reachToken } from '../lib/graph-layout.js';
import { statusFromUsage } from '../lib/instance-status.js';
import GraphDetail from './GraphDetail.jsx';

/**
 * The fleet, drawn.
 *
 * Two stacked layers, for the reason UniFi's topology does the same: a canvas
 * underneath carries the glowing links and the particles (cheap at any count,
 * 60fps), and SVG on top carries nodes, labels and hit targets so text stays
 * crisp and clicks land where they look.
 *
 * Nothing animates that is not actually moving. Particle density on an egress
 * link is requests per minute measured at the proxy; a quiet instance's link is
 * still. A denied request is a particle that dies at the gate, because that is
 * what happened to it.
 */

/**
 * Canvas takes no CSS custom properties: ctx.strokeStyle = 'var(--x)' is invalid
 * and silently paints black. Resolve the tokens once against the document.
 */
function resolveTokens() {
  const css = getComputedStyle(document.documentElement);
  const get = (n, fallback) => css.getPropertyValue(n).trim() || fallback;
  return {
    reach1: get('--cm-reach-1', '#184f95'),
    reach2: get('--cm-reach-2', '#256abf'),
    reach3: get('--cm-reach-3', '#3987e5'),
    reach4: get('--cm-reach-4', '#86b6ef'),
    critical: get('--cm-critical', '#d03b3b'),
    serious: get('--cm-serious', '#ec835a'),
    ink2: get('--cm-ink-2', '#9ca3af'),
    ink4: get('--cm-ink-4', '#4b5563'),
    flow: '#cfe3fb',
    bg: get('--cm-bg', '#030712'),
  };
}

const STATUS = {
  ok: { color: 'var(--cm-good)', glyph: '▶', word: 'running' },
  stopped: { color: 'var(--cm-ink-3)', glyph: '■', word: 'stopped' },
  unreachable: { color: 'var(--cm-critical)', glyph: '✕', word: 'unreachable' },
  disabled: { color: 'var(--cm-ink-4)', glyph: '◌', word: 'disabled' },
  warning: { color: 'var(--cm-warn)', glyph: '◷', word: 'degraded' },
};

/**
 * Heat colour for a load fraction (1 = one full core, or 100% of RAM).
 * Cool blue → amber → red. Sequential, because it encodes magnitude.
 */
function heatColor(v) {
  const x = Math.max(0, Math.min(1.6, v)) / 1.6;
  const stops = [
    [0.0, [57, 135, 229]],    // reach blue — idle
    [0.45, [250, 178, 25]],   // amber — working
    [0.75, [236, 131, 90]],   // hot
    [1.0, [208, 59, 59]],     // burning
  ];
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (x >= stops[i][0] && x <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
  }
  const t = (x - a[0]) / Math.max(1e-6, b[0] - a[0]);
  const c = a[1].map((v0, i) => Math.round(v0 + (b[1][i] - v0) * t));
  return c;
}

const gradeStroke = (t) => ({
  enforced: { stroke: t.reach2, dash: null, width: 2 },
  open: { stroke: t.reach4, dash: null, width: 2 },
  // Three different failures get three different geometries, not one red: they
  // need three different fixes.
  unenforceable: { stroke: t.critical, dash: '2 6', width: 2 },
  broken: { stroke: t.serious, dash: '8 4', width: 2 },
  'not-checked': { stroke: t.ink4, dash: '1 5', width: 1.5 },
  'runs-on': { stroke: t.ink4, dash: null, width: 1 },
  // The gate's own way out. Every restricted instance's traffic converges here,
  // so this is the trunk of the egress story and it is drawn like one. It had no
  // entry at all, which meant it fell through to 'not-checked' — a 1.5px dotted
  // grey line, the faintest mark on a canvas full of brighter direct-egress ones.
  'allowlisted-egress': { stroke: t.reach2, dash: null, width: 4 },
  // Which model an instance talks to is a route, not an enforcement claim, so it
  // gets no grade — but it still has to be legible. Solid, lighter ink, and
  // labelled at the midpoint rather than left to fade into the background.
  'uses-model': { stroke: '#c9d2dd', dash: null, width: 2 },
  reaches: { stroke: t.ink4, dash: '4 4', width: 1 },
});

export default function GraphView({ topology, loading }) {
  const [selected, setSelected] = useState(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const fitted = useRef(false);
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const dragRef = useRef(null);

  // Positions the operator dragged, kept per node id. Survives reloads: an
  // arrangement you made is yours until you reset it.
  const [positions, setPositions] = useState(() => {
    try { return JSON.parse(localStorage.getItem('cm-graph-positions') || '{}'); } catch { return {}; }
  });
  const persist = (next) => {
    setPositions(next);
    try { localStorage.setItem('cm-graph-positions', JSON.stringify(next)); } catch { /* private mode */ }
  };
  const { boxes, viewBox, width, height } = useMemo(() => layout(topology, positions), [topology, positions]);
  const nodeDrag = useRef(null);

  /**
   * What the selection is about: its own edges, and for a container-ish node
   * (a host, a gate) everything underneath it. Selecting one instance should
   * leave one path lit, not the whole fleet.
   */
  const focus = useMemo(() => {
    if (!selected || !topology) return null;
    const edges = new Set();
    const nodes = new Set([selected.id]);
    const add = (e, i) => { edges.add(i); nodes.add(e.source); nodes.add(e.target); };

    const children = selected.type === 'host'
      ? new Set(topology.nodes
          .filter((n) => n.type === 'instance' && `host:${n.detail?.hostId}` === selected.id)
          .map((n) => n.id))
      : new Set();

    topology.edges.forEach((e, i) => {
      if (e.source === selected.id || e.target === selected.id) add(e, i);
      else if (children.has(e.source) || children.has(e.target)) add(e, i);
    });

    // Follow the path onward: an instance's gate also reaches the internet, and
    // that second hop is part of the same story.
    topology.edges.forEach((e, i) => {
      if (edges.has(i)) return;
      if (nodes.has(e.source) && e.source !== selected.id && e.kind !== 'runs-on') add(e, i);
    });

    return { edges, nodes };
  }, [selected, topology]);

  // Edges that carry measured flow, prepared once per payload.
  const flows = useMemo(() => {
    if (!topology) return [];
    return topology.edges
      .map((e) => {
        const from = boxes.get(e.source);
        const to = boxes.get(e.target);
        if (!from || !to) return null;
        const path = edgePath(from, to);
        if (!path) return null;
        const src = topology.nodes.find((n) => n.id === e.source);
        const traffic = src?.traffic || null;
        return { ...e, index: topology.edges.indexOf(e), a: path.a, b: path.b, c: path.c, d: path.d, traffic };
      })
      .filter(Boolean);
  }, [topology, boxes]);

  const focusEdges = focus?.edges || null;
  const inFocus = (e) => !focus || focus.edges.has(e.index);
  const nodeDim = (id) => (focus && !focus.nodes.has(id) ? 0.3 : 1);

  // ── the moving layer ──────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const ctx = canvas.getContext('2d');
    const T = resolveTokens();
    const GRADE = gradeStroke(T);
    let raf;
    let frame = 0;
    const particles = [];

    // One particle per request, capped: beyond ~40 the eye reads "busy" and
    // more dots only cost frames.
    //
    // ONLY egress edges move. The traffic count comes from the squid access log,
    // so it describes the instance→proxy→internet path and nothing else. Putting
    // those same dots on a model edge would animate a number that was never
    // measured there — the graph would be inventing throughput.
    for (const e of flows) {
      if (e.kind !== 'egress-via' && e.kind !== 'direct-egress') continue;
      if (focusEdges && !focusEdges.has(e.index)) continue;   // only the selection flows
      const rate = (e.traffic?.allowed || 0) + (e.traffic?.denied || 0);
      if (!rate) continue;
      const n = Math.min(40, Math.ceil(rate / 3));
      for (let i = 0; i < n; i++) {
        particles.push({
          edge: e,
          t: i / n,
          speed: 0.0016 + Math.min(rate, 120) / 90000,
          denied: e.traffic?.denied > 0 && i % Math.max(2, Math.round((e.traffic.allowed + e.traffic.denied) / Math.max(1, e.traffic.denied))) === 0,
        });
      }
    }

    // Nodes that are working hard enough to be worth seeing from across the room.
    const hot = [];
    for (const n of topology?.nodes || []) {
      const box = boxes.get(n.id);
      if (!box || !n.load || n.load.cpu == null) continue;
      hot.push({ id: n.id, box, cpu: n.load.cpu, mem: n.load.mem || 0, temp: n.load.cpuTemp ?? null });
    }
    // Embers: one per 25% of a core ABOVE a full core. Nothing below that burns.
    const embers = [];
    for (const h of hot) {
      const over = Math.max(0, h.cpu - 1);
      const count = Math.min(26, Math.round(over * 16));
      for (let i = 0; i < count; i++) {
        embers.push({
          h,
          t: i / Math.max(1, count),
          speed: 0.004 + (i % 5) * 0.0012,
          drift: ((i % 7) - 3) * 0.35,
          size: 1.8 + (i % 3) * 0.9,
        });
      }
    }

    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const draw = () => {
      ctx.clearRect(0, 0, width, height);

      // ── heat auras, under everything ──────────────────────────────────────
      for (const h of hot) {
        const level = Math.max(h.cpu, h.mem * 0.8);
        if (level < 0.06) continue;
        const [r, g, bl] = heatColor(level);
        const cx = h.box.x + h.box.w / 2;
        const cy = h.box.y + h.box.h / 2;
        // Tight halo: half the node plus a margin that grows with load. The
        // first version scaled with the node's long edge and merged every hot
        // node into one orange cloud.
        const half = Math.hypot(h.box.w, h.box.h) / 2;
        const radius = half + 18 + Math.min(1.4, level) * 46;
        // A slow breath so a hot node is alive, tied to load rather than decorative.
        const pulse = reduced ? 1 : 1 + Math.sin(frame / (26 - Math.min(18, level * 12))) * 0.06 * Math.min(1, level);
        const grad = ctx.createRadialGradient(cx, cy, half * 0.8, cx, cy, radius * pulse);
        grad.addColorStop(0, `rgba(${r},${g},${bl},${0.36 * Math.min(1, level)})`);
        grad.addColorStop(0.5, `rgba(${r},${g},${bl},${0.16 * Math.min(1, level)})`);
        grad.addColorStop(1, `rgba(${r},${g},${bl},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, radius * pulse, 0, Math.PI * 2);
        ctx.fill();
      }

      // Links first: a soft glow under a thin core, so a busy link reads as lit
      // rather than thick. Egress underneath, model routes on top — otherwise a
      // busy egress link buries the one line that says which model this uses.
      // Painter's order, lowest first: plain links, then model routes, then the
      // gate's egress trunk on top. With 20+ instances the trunk is the one line
      // that must survive the crossfire.
      const z = (e) => (e.kind === 'allowlisted-egress' ? 2 : e.kind === 'uses-model' ? 1 : 0);
      const ordered = [...flows].sort((a, b) => z(a) - z(b));
      for (const e of ordered) {
        // Kind first, then grade. The table holds both: a kind with its own
        // entry (the egress trunk, model routes) has one fixed look, while
        // egress-via and direct-egress have no kind entry and are styled by how
        // well their claim is backed. Checking grade first silently gave the
        // trunk the generic 'enforced' style and threw its width away.
        const g = GRADE[e.kind] || GRADE[e.grade] || GRADE['not-checked'];
        const lit = !focusEdges || focusEdges.has(e.index);
        const trunk = e.kind === 'allowlisted-egress';
        // With nothing selected every edge drew at the same 0.85, so twenty-odd
        // direct-egress lines fanning into the internet node carried exactly as
        // much weight as the one line that says "and everything restricted goes
        // through here". Rank them: the trunk reads first, a direct line to the
        // internet stays visible as context but recedes. Nothing is hidden — an
        // open instance also says so on its own chip, in its bar and its label.
        const rank = trunk ? 1 : e.kind === 'direct-egress' ? 0.34 : 0.72;
        const path = new Path2D(e.d);
        ctx.save();
        ctx.strokeStyle = g.stroke;
        ctx.globalAlpha = lit ? (trunk ? 0.28 : 0.14) : 0.03;
        ctx.lineWidth = trunk ? 18 : 10;
        ctx.stroke(path);
        ctx.globalAlpha = lit ? rank : 0.12;
        ctx.lineWidth = g.width;
        if (g.dash) ctx.setLineDash(g.dash.split(' ').map(Number));
        ctx.stroke(path);
        ctx.restore();

        // An arrowhead where a model route lands, so direction is explicit.
        if ((e.kind === 'uses-model' || e.kind === 'allowlisted-egress') && lit) {
          const tip = pointOnPath(e.a, e.b, 0.97, e.c);
          const back = pointOnPath(e.a, e.b, 0.9, e.c);
          const ang = Math.atan2(tip.y - back.y, tip.x - back.x);
          ctx.save();
          ctx.fillStyle = g.stroke;
          ctx.globalAlpha = 0.95;
          ctx.beginPath();
          ctx.moveTo(tip.x, tip.y);
          ctx.lineTo(tip.x - Math.cos(ang - 0.4) * 11, tip.y - Math.sin(ang - 0.4) * 11);
          ctx.lineTo(tip.x - Math.cos(ang + 0.4) * 11, tip.y - Math.sin(ang + 0.4) * 11);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
      }

      // Model-route labels: the line alone cannot say "foundry" vs "claude-max",
      // and these edges all converge on two boxes.
      ctx.save();
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      for (const e of flows) {
        if ((e.kind !== 'uses-model' && e.kind !== 'allowlisted-egress') || !e.label) continue;
        if (focusEdges && !focusEdges.has(e.index)) continue;
        const isTrunk = e.kind === 'allowlisted-egress';
        // Nodes are SVG above the canvas, so a caption at the midpoint of a long
        // edge disappears behind whichever card happens to sit there. The trunk's
        // sits near the gate it belongs to, where the canvas is clear.
        const mid = pointOnPath(e.a, e.b, isTrunk ? 0.18 : 0.5, e.c);
        ctx.font = isTrunk
          ? '600 11px ui-sans-serif, system-ui, sans-serif'
          : '10px ui-sans-serif, system-ui, sans-serif';
        // The trunk's caption sits exactly where the egress lines bundle, so
        // plain text on top of it is unreadable. Give it a plate to sit on.
        if (isTrunk) {
          const w = ctx.measureText(e.label).width;
          ctx.globalAlpha = 0.92;
          ctx.fillStyle = T.bg;
          const bx = mid.x - w / 2 - 7, by = mid.y - 18, bw = w + 14, bh = 17;
          ctx.beginPath();
          ctx.roundRect ? ctx.roundRect(bx, by, bw, bh, 5) : ctx.rect(bx, by, bw, bh);
          ctx.fill();
          ctx.globalAlpha = 0.9;
          ctx.strokeStyle = T.reach2;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        ctx.fillStyle = isTrunk ? T.reach2 : T.ink2;
        ctx.globalAlpha = isTrunk ? 1 : (focusEdges ? 0.95 : 0.55);
        ctx.fillText(e.label, mid.x, mid.y - 5);
      }
      ctx.restore();
      ctx.globalAlpha = 1;

      if (!reduced) {
        for (const p of particles) {
          p.t += p.speed;
          // A denied request never reaches the far end: it dies at the gate.
          const limit = p.denied ? 0.72 : 1;
          if (p.t > limit) p.t = 0;
          const pos = pointOnPath(p.edge.a, p.edge.b, Math.min(p.t, limit), p.edge.c);
          const fade = p.denied ? Math.max(0, 1 - (p.t / limit) ** 6) : 1;
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, p.denied ? 2.6 : 2, 0, Math.PI * 2);
          ctx.fillStyle = p.denied ? T.critical : T.flow;
          ctx.globalAlpha = 0.9 * fade;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }
      // ── embers, over the links ────────────────────────────────────────────
      // Only for a node burning more than one full core: the thing the operator
      // would otherwise have to read a number to notice.
      if (!reduced) {
        for (const e of embers) {
          e.t += e.speed;
          if (e.t > 1) e.t = 0;
          const rise = e.t;
          const x = e.h.box.x + e.h.box.w * (0.2 + 0.6 * ((e.drift + 3) / 6))
            + e.drift * 14 * rise + Math.sin((frame / 16) + e.t * 7) * 3.5;
          const y = e.h.box.y - 2 - rise * (e.h.box.h * 1.25);
          const [r, g, bl] = heatColor(Math.min(1.6, e.h.cpu));
          const alpha = Math.max(0, (1 - rise) ** 1.3);
          ctx.beginPath();
          ctx.arc(x, y, e.size * (1 - rise * 0.5), 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${r},${g},${bl},${alpha})`;
          ctx.fill();
          // A faint halo makes the spark read as light rather than a dot.
          ctx.beginPath();
          ctx.arc(x, y, e.size * 3.2 * (1 - rise * 0.4), 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${r},${g},${bl},${alpha * 0.22})`;
          ctx.fill();
        }
      }

      frame++;
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [flows, width, height, focusEdges, boxes, topology]);

  // Fit once, when the first payload arrives: a graph parked in the top-left of
  // a 1700px window reads as "nothing here".
  useEffect(() => {
    if (fitted.current || !width || !wrapRef.current) return;
    const el = wrapRef.current.getBoundingClientRect();
    if (!el.width) return;
    const k = Math.min(1.35, Math.max(0.5, Math.min((el.width - 80) / width, (el.height - 80) / height)));
    setView({ k, x: (el.width - width * k) / 2, y: (el.height - height * k) / 2 });
    fitted.current = true;
  }, [width, height]);

  // ── pan & zoom ────────────────────────────────────────────────────────────
  const onPointerDown = (e) => {
    // Deliberately NOT capturing the pointer here. A capture on the wrapper
    // retargets every later event — including the click — to the wrapper, so
    // nodes become unclickable. Capture only once this is actually a drag.
    dragRef.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: 0, captured: false, id: e.pointerId };
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.moved = Math.max(d.moved, Math.abs(dx) + Math.abs(dy));
    if (!d.captured && d.moved > 6) {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      d.captured = true;
    }
    if (d.captured) setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
  };
  const onPointerUp = (e) => {
    const d = dragRef.current;
    if (d?.captured) e.currentTarget.releasePointerCapture?.(d.id);
    // Keep the drag record for one tick so the click handler can tell a pan
    // from a tap, then clear it.
    const moved = d?.moved || 0;
    dragRef.current = moved > 6 ? { moved } : null;
    setTimeout(() => { dragRef.current = null; }, 0);
  };
  // React 19 registers onWheel as a passive listener, so preventDefault() is
  // ignored and the dashboard scrolls behind the graph on every zoom. A native
  // listener with passive:false is the only way to actually claim the wheel.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      setView((v) => ({ ...v, k: Math.min(2.5, Math.max(0.4, v.k * (e.deltaY < 0 ? 1.1 : 0.9))) }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  /** Pointer position in graph coordinates, undoing pan and zoom. */
  const toGraph = (e) => {
    const r = wrapRef.current.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k };
  };

  // Dragging a node moves just that node; the pan handler must not also run.
  const nodeHandlers = (node) => ({
    onPointerDown: (e) => {
      e.stopPropagation();
      const b = boxes.get(node.id);
      if (!b) return;
      const p = toGraph(e);
      // Remember where the press started: a click is judged by DISTANCE, not by
      // how many pointermove events the mouse happened to emit.
      nodeDrag.current = { id: node.id, dx: p.x - b.cx, dy: p.y - b.cy, ox: e.clientX, oy: e.clientY, moved: 0 };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    onPointerMove: (e) => {
      const d = nodeDrag.current;
      if (!d || d.id !== node.id) return;
      e.stopPropagation();
      const p = toGraph(e);
      d.moved = Math.max(d.moved, Math.abs(e.clientX - d.ox) + Math.abs(e.clientY - d.oy));
      if (d.moved > 4) persist({ ...positions, [node.id]: { x: p.x - d.dx, y: p.y - d.dy } });
    },
    onPointerUp: (e) => {
      const d = nodeDrag.current;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      nodeDrag.current = null;
      // A press that stayed put is a selection, not an arrangement.
      if (d && d.moved <= 4) setSelected(node);
    },
    // The background clears the selection on click; without stopping the click
    // here, selecting a node immediately deselects it again.
    onClick: (e) => e.stopPropagation(),
    style: { cursor: 'grab' },
  });


  if (loading && !topology) {
    return <div className="p-8 text-sm text-gray-500">Mapping the fleet…</div>;
  }
  if (!topology) return null;

  const fleet = topology.fleet || {};

  return (
    <div className="flex h-full">
      <div className="flex-1 flex flex-col min-w-0">
        {/* The glance answer, before any graph-reading is required. */}
        <div className="px-4 py-2 border-b border-gray-800 flex items-center gap-3 text-xs">
          <span
            className="inline-flex items-center gap-1.5 font-medium"
            style={{ color: fleet.ok ? 'var(--cm-good)' : 'var(--cm-critical)' }}
          >
            <span aria-hidden="true">{fleet.ok ? '▶' : '✕'}</span>
            {fleet.ok ? 'All clear' : `${fleet.problems?.length || 0} problem${fleet.problems?.length === 1 ? '' : 's'}`}
          </span>
          <span className="text-gray-500 truncate">{fleet.verdict}</span>
          {Object.keys(positions).length > 0 && (
            <button
              onClick={() => persist({})}
              className="text-gray-500 hover:text-gray-300 underline decoration-dotted"
              title="Forget the positions you dragged and go back to the computed layout"
            >
              reset layout
            </button>
          )}
          <span className="ml-auto text-gray-600">
            {fleet.counts?.running}/{fleet.counts?.instances} running · {fleet.counts?.hosts} host{fleet.counts?.hosts === 1 ? '' : 's'}
          </span>
        </div>

        <div
          ref={wrapRef}
          className="relative flex-1 overflow-hidden cursor-grab active:cursor-grabbing"
          style={{ background: 'var(--cm-bg)' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          onClick={() => {
            // A drag that moved more than a few pixels is a pan, not a click:
            // it must not throw away the selection the user is looking at.
            if ((dragRef.current?.moved || 0) > 6) return;
            setSelected(null);
          }}
        >
          <div
            className="absolute origin-top-left"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
          >
            <canvas ref={canvasRef} style={{ width, height, position: 'absolute', inset: 0 }} />
            <svg width={width} height={height} viewBox={viewBox} style={{ position: 'relative' }}>
              <defs>
                <pattern id="cm-hatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
                  <line x1="0" y1="0" x2="0" y2="6" stroke="var(--cm-line-hi)" strokeWidth="1" />
                </pattern>
              </defs>

              {/* Hosts are hubs: their instances ring them rather than sitting in a tray. */}
              {topology.nodes.filter((n) => n.type === 'host').map((n) => {
                const b = boxes.get(n.id);
                if (!b) return null;
                const st = STATUS[n.status] || STATUS.ok;
                const load = n.load;
                const sel = selected?.id === n.id;
                return (
                  <g key={n.id} {...nodeHandlers(n)} opacity={nodeDim(n.id)}>
                    <rect
                      x={b.x} y={b.y} width={b.w} height={b.h} rx="12"
                      fill={n.detail?.acceptsInstances ? 'var(--cm-panel)' : 'url(#cm-hatch)'}
                      stroke={sel ? 'var(--cm-select)' : 'var(--cm-line-hi)'}
                      strokeWidth={sel ? 2 : 1.5}
                    />
                    {/* CPU as a ring segment along the top edge: magnitude, so length. */}
                    {load?.cpu != null && (
                      <>
                        <rect x={b.x} y={b.y} width={b.w} height="5" rx="2.5" fill="var(--cm-line)" />
                        <rect
                          x={b.x} y={b.y}
                          width={Math.max(5, b.w * Math.min(1, load.cpu))} height="5" rx="2.5"
                          fill={load.cpu > 0.85 ? 'var(--cm-warn)' : 'var(--cm-reach-3)'}
                        />
                        {/* Memory on the bottom edge, so a host that is full of RAM
                            but idle still reads as full. */}
                        <rect x={b.x} y={b.y + b.h - 5} width={b.w} height="5" rx="2.5" fill="var(--cm-line)" />
                        <rect
                          x={b.x} y={b.y + b.h - 5}
                          width={Math.max(5, b.w * Math.min(1, load.mem || 0))} height="5" rx="2.5"
                          fill="var(--cm-ink-4)"
                        />
                      </>
                    )}
                    <text x={b.cx} y={b.y + 26} textAnchor="middle" fill="var(--cm-ink-1)" fontSize="14" fontWeight="600">
                      {n.label}
                    </text>
                    <text x={b.cx} y={b.y + 43} textAnchor="middle" fontSize="10" fill="var(--cm-ink-3)">
                      <tspan fill={st.color}>{st.glyph}</tspan> {st.word}
                      {load?.cpuLabel ? ` · ${load.cpuLabel}` : ''}
                    </text>
                    <text x={b.cx} y={b.y + 57} textAnchor="middle" fontSize="9.5" fill="var(--cm-ink-4)">
                      {[load?.memLabel, load?.diskLabel].filter(Boolean).join(' · ')}
                      {load?.cpuTemp != null && (
                        <tspan fill={load.cpuTemp >= 75 ? 'var(--cm-warn)' : 'var(--cm-ink-4)'}>
                          {` · ${Math.round(load.cpuTemp)}°C`}
                        </tspan>
                      )}
                      {load?.uptime ? ` · ${load.uptime}` : ''}
                    </text>
                  </g>
                );
              })}

              {/* Instance chips, ringed around their host. */}
              {topology.nodes.filter((n) => n.type === 'instance').map((n) => {
                const b = boxes.get(n.id);
                if (!b) return null;
                const st = STATUS[n.status] || STATUS.stopped;
                const reach = reachToken(n.detail?.policy);
                const sel = selected?.id === n.id;
                const live = statusFromUsage({
                  lastEvent: n.detail?.lastEvent,
                  statusMessage: n.detail?.statusMessage,
                  updatedAt: n.detail?.usageUpdatedAt,
                });
                // topology.js reports a running container as 'ok', not 'running'
                // — the STATUS map above is the vocabulary. Both badges share one
                // gate so they cannot drift apart again.
                const alive = n.status === 'ok';
                const waiting = alive && live?.kind === 'waiting';
                // The top-right badges and the name share one line, so the name's
                // budget is whatever the badges leave. A fixed truncation ran
                // "doc-anthropic-strict" straight into "⏸ needs input".
                const badges = [
                  waiting && '⏸ needs input ',
                  alive && !waiting && live?.kind === 'working' && '▶ working ',
                  n.detail?.dockerSocket && '⊘ socket ',
                  n.flags?.scanAlert && '✕ scan ',
                  n.flags?.pendingRequests > 0 && `◷ ${n.flags.pendingRequests} req `,
                  n.flags?.updateAvailable && '↑ update',
                ].filter(Boolean).join('');
                // Rough advance widths: 9.5px badge text, 12.5px semibold name.
                const nameRoom = b.w - 24 - badges.length * 5.1;
                const maxName = Math.max(6, Math.floor(nameRoom / 6.9));
                const label = n.label?.length > maxName ? `${n.label.slice(0, maxName - 1)}…` : n.label;
                return (
                  <g key={n.id} {...nodeHandlers(n)} opacity={nodeDim(n.id)}>
                    {waiting && (
                      <rect
                        className="cm-attention-ring"
                        x={b.x - 3} y={b.y - 3} width={b.w + 6} height={b.h + 6} rx="12"
                        fill="none" stroke="var(--cm-warn)"
                      />
                    )}
                    <rect
                      x={b.x} y={b.y} width={b.w} height={b.h} rx="9"
                      fill="var(--cm-bg)"
                      stroke={sel ? 'var(--cm-select)' : waiting ? 'var(--cm-warn)' : 'var(--cm-line-hi)'}
                      strokeWidth={sel ? 2 : 1}
                    />
                    {/* Reach is the one hue axis: a bar, always beside its label. */}
                    <rect x={b.x} y={b.y} width="4" height={b.h} rx="2" fill={reach} />
                    <text x={b.x + 14} y={b.y + 22} fill="var(--cm-ink-1)" fontSize="12.5" fontWeight="500">
                      {label}
                      <title>{n.label}</title>
                    </text>
                    <text x={b.x + 14} y={b.y + 36} fontSize="10" fill="var(--cm-ink-3)">
                      <tspan fill={st.color}>{st.glyph}</tspan> {n.detail?.policy}
                      <tspan fill="var(--cm-ink-4)"> · </tspan>
                      <tspan fill="var(--cm-ink-2)">{n.detail?.backend}</tspan>
                    </text>
                    {/* Load, where it can actually be seen: CPU fills the bottom
                        edge, memory climbs the right edge. A busy instance should be
                        obvious across the room, not a 2px hint inside the card. */}
                    {n.load?.cpu != null && (
                      <>
                        <rect x={b.x} y={b.y + b.h - 4} width={b.w} height="4" rx="2" fill="var(--cm-line)" />
                        <rect
                          x={b.x} y={b.y + b.h - 4}
                          width={Math.max(3, b.w * Math.min(1, n.load.cpu))}
                          height="4" rx="2"
                          fill={n.load.cpu > 0.85 ? 'var(--cm-warn)' : 'var(--cm-reach-3)'}
                        />
                      </>
                    )}
                    {n.load?.mem != null && (
                      <rect
                        x={b.x + b.w - 4} y={b.y + b.h - 4 - (b.h - 8) * Math.min(1, n.load.mem)}
                        width="4" height={Math.max(3, (b.h - 8) * Math.min(1, n.load.mem))}
                        rx="2" fill="var(--cm-ink-4)"
                      />
                    )}
                    {/* The number, once there is one worth reading. */}
                    {n.load?.cpu > 0.08 && (
                      <text
                        x={b.x + 14} y={b.y + 52} fontSize="10.5" fontWeight="600"
                        fill={n.load.cpu > 0.85 ? 'var(--cm-warn)' : 'var(--cm-ink-2)'}
                      >
                        {Math.round(n.load.cpu * 100)}% cpu · {n.load.memLabel}
                      </text>
                    )}
                    {/* Badges, right-aligned: each is a fact worth noticing without
                        opening the drawer. Glyph + text, never colour alone. */}
                    <text x={b.x + b.w - 10} y={b.y + 20} textAnchor="end" fontSize="9.5">
                      {waiting && <tspan fill="var(--cm-warn)">⏸ needs input </tspan>}
                      {alive && !waiting && live?.kind === 'working' && <tspan fill="var(--cm-reach-3)">▶ working </tspan>}
                      {n.detail?.dockerSocket && <tspan fill="var(--cm-warn)">⊘ socket </tspan>}
                      {n.flags?.scanAlert && <tspan fill="var(--cm-critical)">✕ scan </tspan>}
                      {n.flags?.pendingRequests > 0 && (
                        <tspan fill="var(--cm-warn)">◷ {n.flags.pendingRequests} req </tspan>
                      )}
                      {n.flags?.updateAvailable && <tspan fill="var(--cm-ink-3)">↑ update</tspan>}
                    </text>
                    {n.traffic && (
                      <text x={b.x + b.w - 10} y={b.y + 52} textAnchor="end" fontSize="9.5" fill="var(--cm-ink-3)">
                        {n.traffic.allowed}/min
                        {n.traffic.denied ? <tspan fill="var(--cm-critical)"> · {n.traffic.denied} denied</tspan> : null}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* Gates, backends and the outside world. */}
              {topology.nodes.filter((n) => ['proxy', 'backend', 'internet', 'provider'].includes(n.type)).map((n) => {
                const b = boxes.get(n.id);
                if (!b) return null;
                const sel = selected?.id === n.id;
                const isNet = n.type === 'internet';
                return (
                  <g key={n.id} {...nodeHandlers(n)} opacity={nodeDim(n.id)}>
                    <rect
                      x={b.x} y={b.y} width={b.w} height={b.h}
                      rx={isNet ? 43 : n.type === 'proxy' ? 10 : 8}
                      fill="var(--cm-panel)"
                      stroke={sel ? 'var(--cm-select)' : 'var(--cm-line-hi)'}
                      strokeWidth={sel ? 2 : 1}
                    />
                    <text
                      x={b.cx} y={b.cy + 4} textAnchor="middle"
                      fill="var(--cm-ink-1)" fontSize="12.5" fontWeight="500"
                    >
                      {n.label}
                    </text>
                    <text x={b.cx} y={b.cy + 20} textAnchor="middle" fill="var(--cm-ink-3)" fontSize="10">
                      {n.type === 'proxy' ? 'allowlist gate'
                        : n.type === 'backend' ? (n.detail?.modelCount ? `${n.detail.modelCount} models` : 'model route')
                        : n.type === 'provider' ? `${n.detail?.models?.length || 0} models`
                        : 'outside'}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>

          {/* Legend: identity is never colour alone, so it is always on screen. */}
          <div className="absolute bottom-3 left-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-gray-500 bg-gray-900/80 backdrop-blur px-3 py-2 rounded-lg border border-gray-800">
            <span>reach:</span>
            {[['claude-only', 1], ['claude-github', 2], ['claude-full-dev', 3], ['unrestricted', 4]].map(([label, step]) => (
              <span key={label} className="inline-flex items-center gap-1">
                <span className="w-3 h-2 rounded-sm inline-block" style={{ background: `var(--cm-reach-${step})` }} />
                {label}
              </span>
            ))}
            <span className="ml-2">· dots = requests/min through the proxy · red dots die at the gate = denied</span>
            <span className="inline-flex items-center gap-1">
              <svg width="22" height="8"><line x1="0" y1="4" x2="14" y2="4" stroke="#c9d2dd" strokeWidth="2" /><polygon points="14,1 21,4 14,7" fill="#c9d2dd" /></svg>
              model route
            </span>
          </div>
        </div>
      </div>

      {selected && <GraphDetail node={selected} topology={topology} onClose={() => setSelected(null)} />}
    </div>
  );
}
