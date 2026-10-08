import { useEffect, useMemo, useState } from 'react';
import { C, MONO, DISPLAY, useWidth, Stat, HostCard } from './map-parts.jsx';
import {
  POLICY_LANES, DESTINATIONS, laneDef, destOf, layoutNetworkMap, ribbonPath,
} from '../lib/network-map.js';
import { LANE_BY_ID, modelShort } from '../lib/fleet-map.js';

// The network map: where each instance's traffic is allowed to go.
// Colour = network policy (warmer = more reach). Allowlisted lanes pass their
// host's proxy gate; open lanes skip it. Red marks are what the proxy refused.

const GATE = '#c9d2e6';
const DANGER = '#ef5b5b';

function usePoll(url, ms) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => fetch(url).then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive && d) setData(d); }).catch(() => {});
    load();
    const t = setInterval(load, ms);
    return () => { alive = false; clearInterval(t); };
  }, [url, ms]);
  return data;
}

function NetTile({ t, dim, hot, selected, onEnter, onLeave, onClick }) {
  const n = t.node;
  const d = n.detail || {};
  const s = t.size;
  const running = n.status === 'ok';
  return (
    <g transform={`translate(${t.x},${t.y})`} opacity={dim ? 0.16 : 1} style={{ cursor: 'pointer', transition: 'opacity 160ms' }}
      onMouseEnter={(e) => onEnter(t, e)} onMouseMove={(e) => onEnter(t, e)} onMouseLeave={onLeave} onClick={() => onClick(t)}
      role="button" aria-label={`${n.label}: ${d.policy}, ${running ? 'running' : 'stopped'}${d.dockerSocket ? ', Docker socket' : ''}${t.denied ? ', blocked recently' : ''}`}>
      <rect x={-3} y={-3} width={s + 6} height={s + 6} fill="transparent" />
      <rect x={running ? 0 : 0.8} y={running ? 0 : 0.8} width={s - (running ? 0 : 1.6)} height={s - (running ? 0 : 1.6)} rx={3.5}
        fill={running ? t.color : 'transparent'} stroke={t.color} strokeWidth={running ? 0 : 1.6} />
      {d.dockerSocket && (
        <>
          <rect x={-3} y={-3} width={s + 6} height={s + 6} rx={6} fill="none" stroke={DANGER} strokeWidth="2" strokeDasharray="3 2" />
          <path d={`M${s - 8},0 L${s},0 L${s},8 Z`} fill="#ffffff" />
        </>
      )}
      {t.denied && <circle cx={s} cy={s} r={3.6} fill={DANGER} stroke={C.panel} strokeWidth="1.5" className="fm-pulse" />}
      {d.pendingRequests > 0 && <rect x={-3.5} y={-3.5} width={s + 7} height={s + 7} rx={6} fill="none" stroke={C.attention} strokeWidth="1.8" className="fm-pulse" />}
      {(hot || selected) && <rect x={-3} y={-3} width={s + 6} height={s + 6} rx={6} fill="none" stroke={C.fg} strokeWidth="1.4" />}
    </g>
  );
}

function Detail({ node, policies, denials, onClose, onOpenTerminal }) {
  if (!node) return null;
  const d = node.detail || {};
  const def = laneDef(d.policy);
  const id = node.id.replace(/^instance:/, '');
  const pol = policies?.find((p) => p.id === d.policy);
  const groups = {};
  for (const h of pol?.allowedHosts || []) (groups[destOf(h)] ||= []).push(h);
  const mine = (denials || []).filter((x) => x.instanceId === id);
  const blocked = [...new Set(mine.map((x) => x.host))];
  return (
    <div className="absolute right-4 top-4 w-[340px] max-w-[calc(100%-2rem)] max-h-[calc(100%-2rem)] overflow-auto z-20 flex flex-col gap-3"
      style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 16, padding: 16, boxShadow: '0 20px 60px rgba(0,0,0,.45)' }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider" style={{ color: def.color }}>{def.label} · {d.policy}</div>
          <div style={{ fontFamily: DISPLAY, color: C.fg }} className="text-lg font-extrabold leading-tight break-words">{node.label}</div>
          <div className="text-[11px] mt-0.5" style={{ color: C.muted }}>{d.host} · {LANE_BY_ID[d.backend]?.label || d.backend}{d.model ? ` · ${modelShort(d.model)}` : ''}</div>
        </div>
        <button onClick={onClose} className="text-sm px-1.5" style={{ color: C.muted }} aria-label="Close detail">✕</button>
      </div>

      <div className="text-xs" style={{ color: C.fg }}>
        {node.egress === 'proxied'
          ? <>Leaves through <b>cm-proxy</b> on {d.host}; anything not on the list below is refused.</>
          : <>No firewall: this instance reaches any host directly.</>}
      </div>

      {node.egress === 'proxied' && (
        <div className="flex flex-col gap-2">
          {DESTINATIONS.filter((g) => groups[g.id]).map((g) => (
            <div key={g.id}>
              <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: g.color }}>{g.label}</div>
              <div className="flex flex-wrap gap-1">
                {groups[g.id].map((h) => (
                  <span key={h} className="text-[10.5px] px-1.5 py-0.5 rounded" style={{ background: C.panel, color: C.muted, fontFamily: MONO }}>{h}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {blocked.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: DANGER }}>Blocked recently</div>
          <div className="flex flex-wrap gap-1">
            {blocked.map((h) => <span key={h} className="text-[10.5px] px-1.5 py-0.5 rounded" style={{ background: '#3a1c22', color: '#ffb3b3', fontFamily: MONO }}>{h}</span>)}
          </div>
        </div>
      )}

      <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1.5 text-xs">
        <dt style={{ color: C.faint }}>Docker socket</dt>
        <dd style={{ color: d.dockerSocket ? DANGER : C.fg }}>{d.dockerSocket ? 'yes: controls its host\'s daemon' : 'no'}</dd>
        <dt style={{ color: C.faint }}>Grants</dt>
        <dd style={{ color: C.fg }}>{d.grants?.length ? d.grants.map((g) => `${g.capability.replace('_', ' ')}${g.expires ? ` until ${new Date(g.expires).toLocaleString()}` : ''}`).join(', ') : 'none'}</dd>
        <dt style={{ color: C.faint }}>Access requests</dt>
        <dd style={{ color: d.pendingRequests ? C.attention : C.fg }}>{d.pendingRequests ? `${d.pendingRequests} waiting for you` : 'none pending'}</dd>
        <dt style={{ color: C.faint }}>State</dt>
        <dd style={{ color: C.fg }}>{d.uptime || d.state}</dd>
      </dl>

      {onOpenTerminal && node.status === 'ok' && (
        <button onClick={() => onOpenTerminal(id)} className="text-sm font-semibold rounded-lg py-2" style={{ background: def.color, color: '#0a0d14' }}>
          Open terminal
        </button>
      )}
    </div>
  );
}

export default function NetworkMap({ topology, loading, onOpenTerminal }) {
  const [width, setWrapEl, wrapEl] = useWidth();
  const policies = usePoll('/api/policies', 60_000);
  const denials = usePoll('/api/system/egress-denials', 15_000);
  const [query, setQuery] = useState('');
  const [pols, setPols] = useState(new Set());
  const [runningOnly, setRunningOnly] = useState(false);
  const [flagged, setFlagged] = useState(false);
  const [hover, setHover] = useState(null);
  const [focus, setFocus] = useState(null);     // { lane } | { gate } | { dest }
  const [selected, setSelected] = useState(null);

  const filters = useMemo(() => ({ query, policies: pols, runningOnly, flagged }), [query, pols, runningOnly, flagged]);
  const L = useMemo(
    () => layoutNetworkMap(topology, { policies: policies || [], denials: Array.isArray(denials) ? denials : [] }, filters, width),
    [topology, policies, denials, filters, width],
  );

  const present = useMemo(() => {
    const ids = new Set((topology?.nodes || []).filter((n) => n.type === 'instance').map((n) => n.detail?.policy));
    return [...POLICY_LANES.filter((l) => ids.has(l.id)), ...[...ids].filter((p) => p && !POLICY_LANES.some((l) => l.id === p)).map(laneDef)];
  }, [topology]);

  if (!topology) {
    return <div className="h-full grid place-items-center text-sm" style={{ color: C.muted, background: C.bg }}>{loading ? 'Reading the fleet…' : 'No topology yet.'}</div>;
  }

  // What the pointer is tracing: a lane (and its gate + that gate's outflows
  // that lane's policy reaches), a gate, or a destination.
  const activeLane = hover ? hover.tile.lane : focus?.lane || null;
  const laneObj = activeLane ? L.lanes.find((l) => l.key === activeLane) : null;
  const activeGate = laneObj?.proxied ? `gate:${laneObj.hostId}` : focus?.gate || null;
  const reachDests = laneObj ? new Set(Object.keys(laneObj.reach)) : null;
  const activeDest = focus?.dest || null;
  const tracing = !!(activeLane || focus);

  const ribbonOn = (r) => {
    if (!tracing) return true;
    if (activeLane) return r.lane === activeLane || (r.gate === activeGate && !r.lane && (reachDests.has(r.dest) || (r.blocked && hover?.tile.denied)));
    if (focus?.gate) return r.gate === focus.gate;
    if (activeDest) return r.dest === activeDest || (r.lane && L.ribbons.some((x) => x.dest === activeDest && x.gate === r.gate && !x.lane));
    return true;
  };
  const laneOn = (l) => !tracing || l.key === activeLane || (focus?.gate && `gate:${l.hostId}` === focus.gate && l.proxied)
    || (activeDest && (l.reach[activeDest] || (activeDest === 'blocked' && l.proxied)));
  const destOn = (d) => !tracing || d.id === activeDest || (laneObj ? reachDests.has(d.id) || (d.id === 'blocked' && hover?.tile.denied) : focus?.gate ? L.ribbons.some((r) => r.gate === focus.gate && r.dest === d.id) : false);
  const gateOn = (g) => !tracing || g.id === activeGate || g.id === focus?.gate || (activeDest && L.ribbons.some((r) => r.gate === g.id && r.dest === activeDest));
  const selectedNode = selected ? (topology?.nodes || []).find((n) => n.id === selected) : null;

  const togglePol = (id) => setPols((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const gid = (k) => `ng-${k.replace(/[^a-z0-9]/gi, '_')}`;

  return (
    <div className="h-full flex flex-col" style={{ background: C.bg, color: C.fg }}>
      <style>{`
        @keyframes fmPulse { 0%,100% { opacity: .35 } 50% { opacity: 1 } }
        .fm-pulse { animation: fmPulse 1.8s ease-in-out infinite }
        @keyframes fmFlow { to { stroke-dashoffset: -28 } }
        .fm-flow { animation: fmFlow 1.4s linear infinite }
        @media (prefers-reduced-motion: reduce) { .fm-pulse, .fm-flow { animation: none } }
      `}</style>

      <div className="flex flex-wrap items-end gap-x-8 gap-y-3 px-5 pt-4 pb-3" style={{ borderBottom: `1px solid ${C.line}` }}>
        <div className="flex flex-wrap gap-x-7 gap-y-2">
          <Stat value={L.stats.proxied} label="behind an allowlist" tone="#3ccf98" />
          <Stat value={L.stats.open} label="open to anywhere" tone="#ff7d6b" />
          <Stat value={L.gates.length} label={L.gates.length === 1 ? 'proxy gate' : 'proxy gates'} />
          <Stat value={L.stats.blocked} label="requests blocked lately" tone={L.stats.blocked ? DANGER : undefined} />
          <Stat value={L.stats.socket} label="with Docker socket" tone={L.stats.socket ? DANGER : undefined} />
        </div>
        <div className="flex flex-wrap items-center gap-2 ml-auto">
          {present.map((l) => {
            const on = !pols.size || pols.has(l.id);
            return (
              <button key={l.id} onClick={() => togglePol(l.id)} aria-pressed={pols.has(l.id)}
                className="text-xs rounded-full px-2.5 py-1 flex items-center gap-1.5"
                style={{ border: `1px solid ${on ? l.color : C.line}`, color: on ? C.fg : C.faint, background: on ? `${l.color}1f` : 'transparent' }}>
                <span className="inline-block w-2 h-2 rounded-sm" style={{ background: l.color, opacity: on ? 1 : 0.4 }} />{l.label}
              </button>
            );
          })}
          <label className="text-xs flex items-center gap-1.5" style={{ color: C.muted }}>
            <input id="nm-flagged" type="checkbox" checked={flagged} onChange={(e) => setFlagged(e.target.checked)} />
            needs a look
          </label>
          <label className="text-xs flex items-center gap-1.5" style={{ color: C.muted }}>
            <input id="nm-running" type="checkbox" checked={runningOnly} onChange={(e) => setRunningOnly(e.target.checked)} />
            running only
          </label>
          <input id="nm-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find instance or policy"
            className="text-xs rounded-full px-3 py-1.5 w-48 focus:outline-none" style={{ background: C.panel, border: `1px solid ${C.line}`, color: C.fg }} />
        </div>
      </div>

      <div ref={setWrapEl} className="flex-1 min-h-0 overflow-auto relative">
        <svg width={L.width} height={L.height} viewBox={`0 0 ${L.width} ${L.height}`} style={{ display: 'block' }}>
          <defs>
            {L.ribbons.map((r) => (
              <linearGradient key={gid(r.key)} id={gid(r.key)} x1="0" x2="1" y1="0" y2="0">
                <stop offset="0" stopColor={r.color} stopOpacity={r.bypass ? 0.7 : 0.5} />
                <stop offset="1" stopColor={r.toColor} stopOpacity={r.blocked ? 0.75 : 0.55} />
              </linearGradient>
            ))}
            <pattern id="nm-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill={DANGER} fillOpacity="0.18" />
              <line x1="0" y1="0" x2="0" y2="6" stroke={DANGER} strokeOpacity="0.55" strokeWidth="2" />
            </pattern>
          </defs>

          {L.hosts.map((h) => (
            <rect key={`band-${h.id}`} x={h.x - 8} y={h.y - 8} width={(L.lanes[0]?.x || 0) + (L.lanes[0]?.w || 0) - h.x + 22} height={h.h + 8}
              rx={18} fill="none" stroke={C.line} strokeDasharray="2 6" />
          ))}

          {L.ribbons.map((r) => (
            <path key={r.key} d={ribbonPath(r)} fill={r.blocked ? 'url(#nm-hatch)' : `url(#${gid(r.key)})`}
              opacity={ribbonOn(r) ? 1 : 0.1} style={{ transition: 'opacity 160ms' }} />
          ))}
          {L.ribbons.filter(ribbonOn).filter((r) => !r.blocked).map((r) => {
            const mx = (r.x0 + r.x1) / 2;
            return <path key={`f-${r.key}`} d={`M${r.x0},${r.y0} C${mx},${r.y0} ${mx},${r.y1} ${r.x1},${r.y1}`} fill="none"
              stroke="#ffffff" strokeOpacity={r.bypass ? 0.4 : 0.25} strokeWidth="1.2" strokeDasharray={r.bypass ? '6 8' : '2 12'} className="fm-flow" />;
          })}

          {L.hosts.map((h) => <HostCard key={h.id} h={h} />)}

          {L.lanes.map((l) => (
            <g key={l.key} opacity={laneOn(l) ? 1 : 0.35} style={{ transition: 'opacity 160ms' }}
              onMouseEnter={() => setFocus({ lane: l.key })} onMouseLeave={() => setFocus(null)}>
              <rect x={l.x - 10} y={l.y} width={l.w + 20} height={l.h} rx={12} fill={C.panel} stroke={C.line} />
              <rect x={l.x - 10} y={l.y + 12} width={3} height={18} rx={1.5} fill={l.def.color} />
              <text x={l.x + 2} y={l.y + 20} fontFamily={DISPLAY} fontWeight="800" fontSize="13" fill={C.fg}>{l.def.label}</text>
              <text x={l.x + 2 + l.def.label.length * 7.6 + 8} y={l.y + 20} fontSize="10.5" fill={C.muted}>
                {l.def.sub}{l.allowedHosts ? ` · ${l.allowedHosts} hosts` : ''}
              </text>
              <text x={l.x + l.w + 4} y={l.y + 20} textAnchor="end" fontFamily={MONO} fontSize="11" fill={C.muted}>{l.running}/{l.count}</text>
            </g>
          ))}
          {L.labels.map((lb) => (
            <text key={`${lb.lane}-${lb.model}-${lb.x}-${lb.y}`} x={lb.x} y={lb.y} fontFamily={MONO} fontSize="9.5"
              fill={!activeLane || activeLane === lb.lane ? C.muted : C.faint}>{lb.text}</text>
          ))}
          {L.tiles.map((t) => (
            <NetTile key={t.id} t={t} dim={tracing && !laneOn(L.lanes.find((l) => l.key === t.lane))} hot={hover?.tile.id === t.id} selected={selected === t.id}
              onEnter={(tile, e) => {
                const r = wrapEl.getBoundingClientRect();
                setHover({ tile, x: e.clientX - r.left + wrapEl.scrollLeft, y: e.clientY - r.top + wrapEl.scrollTop });
              }}
              onLeave={() => setHover(null)} onClick={(tile) => setSelected(tile.id)} />
          ))}

          {/* gates */}
          {L.gates.map((g) => (
            <g key={g.id} opacity={gateOn(g) ? 1 : 0.35} style={{ transition: 'opacity 160ms', cursor: 'default' }}
              onMouseEnter={() => setFocus({ gate: g.id })} onMouseLeave={() => setFocus(null)}>
              <rect x={g.x} y={g.y} width={g.w} height={g.h} rx={16} fill={C.panel2} stroke={g.enforced ? GATE : C.attention} strokeOpacity="0.6" />
              <rect x={g.x + g.w / 2 - 22} y={g.y + 14} width={44} height={6} rx={3} fill={g.enforced ? '#3ccf98' : C.attention} />
              <text x={g.x + g.w / 2} y={g.y + 42} textAnchor="middle" fontFamily={DISPLAY} fontWeight="800" fontSize="15" fill={C.fg}>cm-proxy</text>
              <text x={g.x + g.w / 2} y={g.y + 58} textAnchor="middle" fontSize="10.5" fill={C.muted}>{g.hostLabel} · allowlist</text>
              {g.lanes.map((l, i) => (
                <g key={l.key} transform={`translate(${g.x + 16},${g.y + 84 + i * 21})`}>
                  <rect width={8} height={8} y={-7} rx={2} fill={l.def.color} />
                  <text x={14} fontSize="11" fill={C.fg}>{l.def.label}</text>
                  <text x={g.w - 32} textAnchor="end" fontFamily={MONO} fontSize="11" fill={C.muted}>{l.count}</text>
                </g>
              ))}
              <text x={g.x + g.w / 2} y={g.y + g.h - 32} textAnchor="middle" fontFamily={MONO} fontSize="11" fill={g.enforced ? '#3ccf98' : C.attention}>
                {g.enforced ? 'enforced' : 'not enforceable here'}
              </text>
              <text x={g.x + g.w / 2} y={g.y + g.h - 14} textAnchor="middle" fontFamily={MONO} fontSize="11" fill={C.muted}>
                {g.count} instances
                {g.denied ? <tspan fill={DANGER}>{` · ${g.denied} blocked`}</tspan> : null}
              </text>
            </g>
          ))}

          {/* the bypass, labelled where open ribbons cross the gate column */}
          {L.ribbons.some((r) => r.bypass) && L.gates[0] && (
            <text x={L.gates[0].x + L.gates[0].w / 2} y={Math.min(L.height - 10, Math.max(...L.gates.map((g) => g.y + g.h)) + 26)} textAnchor="middle"
              fontSize="10.5" fill="#ff7d6b">open instances bypass the gate</text>
          )}

          {/* destinations */}
          {L.dests.map((d) => (
            <g key={d.id} opacity={destOn(d) ? 1 : 0.35} style={{ transition: 'opacity 160ms' }}
              onMouseEnter={() => setFocus({ dest: d.id })} onMouseLeave={() => setFocus(null)}>
              <rect x={d.x} y={d.y} width={d.w} height={d.h} rx={14} fill={d.id === 'blocked' ? '#2a1518' : C.panel} stroke={d.color} strokeOpacity="0.55" />
              <rect x={d.x} y={d.y} width={5} height={d.h} rx={2.5} fill={d.color} />
              <text x={d.x + 18} y={d.y + 22} fontFamily={DISPLAY} fontWeight="800" fontSize="14" fill={C.fg}>{d.label}</text>
              <text x={d.x + d.w - 12} y={d.y + 24} textAnchor="end" fontFamily={DISPLAY} fontWeight="800" fontSize="20" fill={d.color}>{d.count}</text>
              {d.list.map((line, i) => (
                <text key={line} x={d.x + 18} y={d.y + 40 + i * 14} fontFamily={MONO} fontSize="10" fill={d.id === 'blocked' ? '#ffb3b3' : C.muted}>
                  {line.length > 34 ? `${line.slice(0, 33)}…` : line}
                </text>
              ))}
              {d.more > 0 && <text x={d.x + 18} y={d.y + 40 + d.list.length * 14} fontSize="10" fill={C.faint}>+{d.more} more</text>}
            </g>
          ))}
        </svg>

        {hover && (
          <div className="absolute pointer-events-none z-10 text-xs rounded-lg px-3 py-2"
            style={{ left: hover.x + 14, top: hover.y + 12, background: C.panel2, border: `1px solid ${C.line}`, color: C.fg, maxWidth: 300 }}>
            <div className="font-semibold">{hover.tile.node.label}</div>
            <div style={{ color: C.muted }}>{hover.tile.node.detail?.policy} · {hover.tile.node.egress === 'proxied' ? 'via proxy' : 'no firewall'}</div>
            {hover.tile.node.detail?.dockerSocket && <div style={{ color: DANGER }}>Docker socket mounted</div>}
            {hover.tile.denied && <div style={{ color: DANGER }}>blocked recently</div>}
          </div>
        )}
        <Detail node={selectedNode} policies={policies} denials={Array.isArray(denials) ? denials : []}
          onClose={() => setSelected(null)} onOpenTerminal={onOpenTerminal} />
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-5 py-2 text-[11px]" style={{ borderTop: `1px solid ${C.line}`, color: C.muted }}>
        <span>colour = network policy, warmer reaches more</span>
        <span className="flex items-center gap-1.5"><svg width="12" height="12"><rect x="1" y="1" width="10" height="10" rx="3" fill="none" stroke={C.muted} strokeWidth="1.5" /></svg>stopped</span>
        <span className="flex items-center gap-1.5"><svg width="16" height="16"><rect x="2" y="2" width="12" height="12" rx="3" fill={C.muted} /><rect x="0.5" y="0.5" width="15" height="15" rx="4" fill="none" stroke={DANGER} strokeWidth="1.5" strokeDasharray="3 2" /><path d="M8,2 L14,2 L14,8 Z" fill="#ffffff" /></svg>Docker socket</span>
        <span className="flex items-center gap-1.5"><svg width="12" height="12"><circle cx="6" cy="6" r="4" fill={DANGER} /></svg>blocked recently</span>
        <span className="flex items-center gap-1.5"><svg width="14" height="14"><rect x="1" y="1" width="12" height="12" rx="3" fill="none" stroke={C.attention} strokeWidth="1.6" /></svg>access request</span>
        <span className="ml-auto">{L.stats.shown} of {L.stats.instances} shown · hover a lane, gate or destination to trace it</span>
      </div>
    </div>
  );
}
