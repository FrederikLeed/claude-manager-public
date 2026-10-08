import { useMemo, useState } from 'react';
import { C, MONO, DISPLAY, useWidth, Stat, HostCard } from './map-parts.jsx';
import {
  LANES, LANE_BY_ID, POLICY_SHORT, layoutFleetMap, ribbonPath, modelShort, instanceState,
} from '../lib/fleet-map.js';

// The fleet map: every instance a tile, every path to a model a ribbon.
// Circle = open network, square = behind the allowlist proxy.
// Solid = running, hollow = stopped, amber ring = waiting for you.

function Tile({ t, dim, hot, onEnter, onLeave, onClick, selected }) {
  const n = t.node;
  const state = instanceState(n);
  const open = n.egress !== 'proxied';
  const s = t.size;
  const filled = state !== 'stopped';
  const common = {
    fill: filled ? t.color : 'transparent',
    stroke: t.color,
    strokeWidth: filled ? 0 : 1.6,
  };
  const busy = !!n.traffic?.requests;
  return (
    <g
      transform={`translate(${t.x},${t.y})`}
      opacity={dim ? 0.16 : 1}
      style={{ cursor: 'pointer', transition: 'opacity 160ms' }}
      onMouseEnter={(e) => onEnter(t, e)}
      onMouseMove={(e) => onEnter(t, e)}
      onMouseLeave={onLeave}
      onClick={() => onClick(t)}
      role="button"
      aria-label={`${n.label}: ${n.detail?.model || n.detail?.backend}, ${POLICY_SHORT[n.detail?.policy] || n.detail?.policy}, ${state}`}
    >
      <rect x={-3} y={-3} width={s + 6} height={s + 6} fill="transparent" />
      {busy && <circle cx={s / 2} cy={s / 2} r={s * 0.9} fill={t.color} opacity="0.18" className="fm-pulse" />}
      {open
        ? <circle cx={s / 2} cy={s / 2} r={s / 2 - (filled ? 0 : 0.8)} {...common} />
        : <rect x={filled ? 0 : 0.8} y={filled ? 0 : 0.8} width={s - (filled ? 0 : 1.6)} height={s - (filled ? 0 : 1.6)} rx={3.5} {...common} />}
      {state === 'attention' && (
        <circle cx={s / 2} cy={s / 2} r={s / 2 + 3.5} fill="none" stroke={C.attention} strokeWidth="1.8" className="fm-pulse" />
      )}
      {(hot || selected) && (
        <rect x={-3} y={-3} width={s + 6} height={s + 6} rx={6} fill="none" stroke={C.fg} strokeWidth="1.4" />
      )}
    </g>
  );
}

function Detail({ node, onClose, onOpenTerminal }) {
  if (!node) return null;
  const d = node.detail || {};
  const lane = LANE_BY_ID[d.backend] || LANES[0];
  const rows = [
    ['Host', d.host],
    ['Agent', d.backend === 'github-copilot' ? 'GitHub Copilot CLI' : 'Claude Code'],
    ['Model', d.model || (d.backend === 'claude-max' ? 'Claude Max default' : 'backend default')],
    ['Route', lane.via === 'router' ? 'LiteLLM router' : 'direct'],
    ['Network', `${d.policy}${node.egress === 'proxied' ? ` · ${d.allowedHosts ?? '?'} hosts via proxy` : ' · no firewall'}`],
    ['State', d.uptime || d.state],
    ['Context', d.contextTokens ? `${Math.round(d.contextTokens / 1000)}k tokens` : '—'],
  ];
  return (
    <div
      className="absolute right-4 top-4 w-[320px] max-w-[calc(100%-2rem)] z-20 flex flex-col gap-3"
      style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 16, padding: 16, boxShadow: '0 20px 60px rgba(0,0,0,.45)' }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider" style={{ color: lane.color }}>{lane.label}</div>
          <div style={{ fontFamily: DISPLAY, color: C.fg }} className="text-lg font-extrabold leading-tight break-words">{node.label}</div>
        </div>
        <button onClick={onClose} className="text-sm px-1.5" style={{ color: C.muted }} aria-label="Close detail">✕</button>
      </div>
      <dl className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-1.5 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt style={{ color: C.faint }}>{k}</dt>
            <dd className="break-words" style={{ color: C.fg, fontFamily: k === 'Model' ? MONO : undefined }}>{v}</dd>
          </div>
        ))}
      </dl>
      {d.deniedHosts?.length > 0 && (
        <div className="text-[11px]" style={{ color: C.attention }}>Recently denied: {d.deniedHosts.join(', ')}</div>
      )}
      {onOpenTerminal && node.status === 'ok' && (
        <button
          onClick={() => onOpenTerminal(node.id.replace(/^instance:/, ''))}
          className="text-sm font-semibold rounded-lg py-2"
          style={{ background: lane.color, color: '#0a0d14' }}
        >
          Open terminal
        </button>
      )}
    </div>
  );
}

export default function FleetMap({ topology, loading, onOpenTerminal }) {
  const [width, setWrapEl, wrapEl] = useWidth();
  const [query, setQuery] = useState('');
  const [backends, setBackends] = useState(new Set());
  const [egress, setEgress] = useState('all');
  const [runningOnly, setRunningOnly] = useState(false);
  const [hover, setHover] = useState(null);       // { tile, x, y }
  const [focusLane, setFocusLane] = useState(null);
  const [selected, setSelected] = useState(null);

  const filters = useMemo(() => ({ query, backends, egress, runningOnly }), [query, backends, egress, runningOnly]);
  const L = useMemo(() => layoutFleetMap(topology, filters, width), [topology, filters, width]);

  const presentLanes = useMemo(() => {
    const ids = new Set((topology?.nodes || []).filter((n) => n.type === 'instance').map((n) => n.detail?.backend || 'claude-max'));
    return LANES.filter((l) => ids.has(l.id));
  }, [topology]);

  const activeLane = hover ? hover.tile.lane : focusLane;
  const activeProvider = activeLane ? L.lanes.find((l) => l.key === activeLane)?.def.provider : null;
  const selectedNode = selected ? (topology?.nodes || []).find((n) => n.id === selected) : null;

  const toggleBackend = (id) => setBackends((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  if (!topology) {
    return <div className="h-full grid place-items-center text-sm" style={{ color: C.muted, background: C.bg }}>{loading ? 'Reading the fleet…' : 'No topology yet.'}</div>;
  }

  const ribbonActive = (r) => !activeLane || r.lane === activeLane || (r.fromRouter && r.provider === activeProvider);

  return (
    <div className="h-full flex flex-col" style={{ background: C.bg, color: C.fg }}>
      <style>{`
        @keyframes fmPulse { 0%,100% { opacity: .25 } 50% { opacity: .9 } }
        .fm-pulse { animation: fmPulse 1.8s ease-in-out infinite }
        @keyframes fmFlow { to { stroke-dashoffset: -28 } }
        .fm-flow { animation: fmFlow 1.4s linear infinite }
        @media (prefers-reduced-motion: reduce) { .fm-pulse, .fm-flow { animation: none } }
      `}</style>

      {/* Summary + controls */}
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3 px-5 pt-4 pb-3" style={{ borderBottom: `1px solid ${C.line}` }}>
        <div className="flex flex-wrap gap-x-7 gap-y-2">
          <Stat value={L.stats.instances} label="instances" />
          <Stat value={L.stats.running} label="running" tone="#3ccf98" />
          <Stat value={L.stats.models} label="model routes in use" />
          <Stat value={L.stats.hosts} label="hosts" />
          <Stat value={L.stats.proxied} label="behind the proxy" />
        </div>
        <div className="flex flex-wrap items-center gap-2 ml-auto">
          {presentLanes.map((l) => {
            const on = !backends.size || backends.has(l.id);
            return (
              <button
                key={l.id}
                onClick={() => toggleBackend(l.id)}
                onMouseEnter={() => setFocusLane(null)}
                className="text-xs rounded-full px-2.5 py-1 flex items-center gap-1.5"
                style={{ border: `1px solid ${on ? l.color : C.line}`, color: on ? C.fg : C.faint, background: on ? `${l.color}1f` : 'transparent' }}
                aria-pressed={backends.has(l.id)}
              >
                <span className="inline-block w-2 h-2 rounded-full" style={{ background: l.color, opacity: on ? 1 : 0.4 }} />
                {l.label}
              </button>
            );
          })}
          <div className="flex rounded-full overflow-hidden text-xs" style={{ border: `1px solid ${C.line}` }}>
            {[['all', 'All'], ['open', '● Open'], ['proxied', '■ Proxied']].map(([k, label]) => (
              <button key={k} onClick={() => setEgress(k)} className="px-2.5 py-1"
                style={{ background: egress === k ? C.panel2 : 'transparent', color: egress === k ? C.fg : C.muted }}>{label}</button>
            ))}
          </div>
          <label className="text-xs flex items-center gap-1.5" style={{ color: C.muted }}>
            <input id="fm-running" type="checkbox" checked={runningOnly} onChange={(e) => setRunningOnly(e.target.checked)} />
            running only
          </label>
          <input
            id="fm-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find instance or model"
            className="text-xs rounded-full px-3 py-1.5 w-48 focus:outline-none"
            style={{ background: C.panel, border: `1px solid ${C.line}`, color: C.fg }}
          />
        </div>
      </div>

      {/* The map */}
      <div ref={setWrapEl} className="flex-1 min-h-0 overflow-auto relative">
        <svg width={L.width} height={L.height} viewBox={`0 0 ${L.width} ${L.height}`} style={{ display: 'block' }}>
          <defs>
            {L.ribbons.map((r) => (
              <linearGradient key={`g-${r.key}`} id={`g-${r.key.replace(/[^a-z0-9]/gi, '_')}`} x1="0" x2="1" y1="0" y2="0">
                <stop offset="0" stopColor={r.color} stopOpacity="0.55" />
                <stop offset="1" stopColor={L.providers.find((p) => p.id === r.provider)?.color || r.color} stopOpacity="0.55" />
              </linearGradient>
            ))}
          </defs>

          {/* host bands */}
          {L.hosts.map((h) => (
            <rect key={`band-${h.id}`} x={h.x - 8} y={h.y - 8} width={L.lanes.length ? L.lanes[0].x + L.lanes[0].w - h.x + 22 : h.w + 16} height={h.h + 8}
              rx={18} fill="none" stroke={C.line} strokeDasharray="2 6" />
          ))}

          {/* ribbons under everything */}
          {L.ribbons.map((r) => (
            <path key={r.key} d={ribbonPath(r)} fill={`url(#g-${r.key.replace(/[^a-z0-9]/gi, '_')})`}
              opacity={ribbonActive(r) ? 1 : 0.12} style={{ transition: 'opacity 160ms' }} />
          ))}
          {/* a moving dash along each ribbon carrying running instances */}
          {L.ribbons.filter((r) => ribbonActive(r)).map((r) => {
            const mx = (r.x0 + r.x1) / 2;
            return <path key={`f-${r.key}`} d={`M${r.x0},${r.y0} C${mx},${r.y0} ${mx},${r.y1} ${r.x1},${r.y1}`} fill="none"
              stroke="#ffffff" strokeOpacity="0.28" strokeWidth="1.2" strokeDasharray="2 12" className="fm-flow" />;
          })}

          {/* hosts */}
          {L.hosts.map((h) => <HostCard key={h.id} h={h} />)}

          {/* lanes */}
          {L.lanes.map((l) => {
            const on = !activeLane || activeLane === l.key;
            return (
              <g key={l.key} opacity={on ? 1 : 0.35} style={{ transition: 'opacity 160ms' }}
                onMouseEnter={() => setFocusLane(l.key)} onMouseLeave={() => setFocusLane(null)}>
                <rect x={l.x - 10} y={l.y} width={l.w + 20} height={l.h} rx={12} fill={C.panel} stroke={C.line} />
                <rect x={l.x - 10} y={l.y + 12} width={3} height={18} rx={1.5} fill={l.def.color} />
                <text x={l.x + 2} y={l.y + 20} fontFamily={DISPLAY} fontWeight="800" fontSize="13" fill={C.fg}>{l.def.label}</text>
                <text x={l.x + 2 + l.def.label.length * 7.6 + 8} y={l.y + 20} fontSize="10.5" fill={C.muted}>{l.def.sub}</text>
                <text x={l.x + l.w + 4} y={l.y + 20} textAnchor="end" fontFamily={MONO} fontSize="11" fill={C.muted}>
                  {l.running}/{l.count}
                </text>
              </g>
            );
          })}

          {/* model group labels */}
          {L.labels.map((lb) => (
            <text key={`${lb.lane}-${lb.model}-${lb.x}-${lb.y}`} x={lb.x} y={lb.y} fontFamily={MONO} fontSize="9.5"
              fill={!activeLane || activeLane === lb.lane ? C.muted : C.faint}>{lb.text}</text>
          ))}

          {/* tiles */}
          {L.tiles.map((t) => (
            <Tile
              key={t.id}
              t={t}
              dim={activeLane && t.lane !== activeLane}
              hot={hover?.tile.id === t.id}
              selected={selected === t.id}
              onEnter={(tile, e) => {
                const r = wrapEl.getBoundingClientRect();
                setHover({ tile, x: e.clientX - r.left + wrapEl.scrollLeft, y: e.clientY - r.top + wrapEl.scrollTop });
              }}
              onLeave={() => setHover(null)}
              onClick={(tile) => setSelected(tile.id)}
            />
          ))}

          {/* router */}
          {L.router.count > 0 && (
            <g>
              <rect x={L.router.x} y={L.router.y} width={L.router.w} height={L.router.h} rx={16} fill={C.panel2} stroke={C.router} strokeOpacity="0.5" />
              <text x={L.router.x + L.router.w / 2} y={L.router.y + 26} textAnchor="middle" fontFamily={DISPLAY} fontWeight="800" fontSize="15" fill={C.fg}>LiteLLM</text>
              <text x={L.router.x + L.router.w / 2} y={L.router.y + 42} textAnchor="middle" fontSize="10.5" fill={C.muted}>router · scoped keys</text>
              {L.router.split.map((s, i) => (
                <g key={s.id} transform={`translate(${L.router.x + 16},${L.router.y + 66 + i * 22})`}>
                  <rect width={8} height={8} y={-7} rx={2} fill={s.color} />
                  <text x={14} fontSize="11" fill={C.fg}>{s.label}</text>
                  <text x={L.router.w - 32} textAnchor="end" fontFamily={MONO} fontSize="11" fill={C.muted}>{s.count}</text>
                </g>
              ))}
              <text x={L.router.x + L.router.w / 2} y={L.router.y + L.router.h - 16} textAnchor="middle" fontFamily={MONO} fontSize="11" fill={C.muted}>
                {L.router.count} instances
              </text>
            </g>
          )}

          {/* providers */}
          {L.providers.map((p) => {
            const on = !activeProvider || activeProvider === p.id;
            return (
              <g key={p.id} opacity={on ? 1 : 0.35} style={{ transition: 'opacity 160ms' }}>
                <rect x={p.x} y={p.y} width={p.w} height={p.h} rx={14} fill={C.panel} stroke={p.color} strokeOpacity="0.55" />
                <rect x={p.x} y={p.y} width={5} height={p.h} rx={2.5} fill={p.color} />
                <text x={p.x + 18} y={p.y + p.h / 2 - 4} fontFamily={DISPLAY} fontWeight="800" fontSize="14" fill={C.fg}>{p.label}</text>
                <text x={p.x + 18} y={p.y + p.h / 2 + 13} fontSize="10.5" fill={C.muted}>{p.sub}</text>
                <text x={p.x + p.w - 12} y={p.y + p.h / 2 + 5} textAnchor="end" fontFamily={DISPLAY} fontWeight="800" fontSize="20" fill={p.color}>{p.count}</text>
              </g>
            );
          })}
        </svg>

        {hover && (
          <div
            className="absolute pointer-events-none z-10 text-xs rounded-lg px-3 py-2"
            style={{ left: hover.x + 14, top: hover.y + 12, background: C.panel2, border: `1px solid ${C.line}`, color: C.fg, maxWidth: 280 }}
          >
            <div className="font-semibold">{hover.tile.node.label}</div>
            <div style={{ color: C.muted, fontFamily: MONO }}>{modelShort(hover.tile.node.detail?.model)}</div>
            <div style={{ color: C.muted }}>
              {hover.tile.node.detail?.host} · {POLICY_SHORT[hover.tile.node.detail?.policy] || hover.tile.node.detail?.policy} · {instanceState(hover.tile.node)}
            </div>
          </div>
        )}
        <Detail node={selectedNode} onClose={() => setSelected(null)} onOpenTerminal={onOpenTerminal} />
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-5 py-2 text-[11px]" style={{ borderTop: `1px solid ${C.line}`, color: C.muted }}>
        <span className="flex items-center gap-1.5"><svg width="12" height="12"><circle cx="6" cy="6" r="6" fill={C.muted} /></svg>open network</span>
        <span className="flex items-center gap-1.5"><svg width="12" height="12"><rect width="12" height="12" rx="3" fill={C.muted} /></svg>behind the allowlist proxy</span>
        <span className="flex items-center gap-1.5"><svg width="12" height="12"><rect x="1" y="1" width="10" height="10" rx="3" fill="none" stroke={C.muted} strokeWidth="1.5" /></svg>stopped</span>
        <span className="flex items-center gap-1.5"><svg width="14" height="14"><circle cx="7" cy="7" r="6" fill="none" stroke={C.attention} strokeWidth="1.6" /></svg>waiting for input</span>
        <span>ribbon width = instances on that path</span>
        <span className="ml-auto">{L.stats.shown} of {L.stats.instances} shown · hover to trace · click for detail</span>
      </div>
    </div>
  );
}
