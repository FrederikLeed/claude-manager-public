import { useEffect, useState } from 'react';

// Shared by the model map and the network map: palette, faces, host cards.

export const C = {
  bg: '#0a0d14',
  panel: '#121725',
  panel2: '#171d2d',
  line: '#232b3f',
  fg: '#e8ebf3',
  muted: '#94a0b8',
  faint: '#5d6780',
  attention: '#f5b13d',
  router: '#c9d2e6',
};
export const MONO = '"JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, monospace';
export const DISPLAY = '"Bricolage Grotesque", "Segoe UI", system-ui, sans-serif';

// A callback ref, not useRef: the map's container only exists once the
// topology has loaded, and an effect keyed on a ref object never re-runs.
export function useWidth() {
  const [el, setEl] = useState(null);
  const [w, setW] = useState(1400);
  useEffect(() => {
    if (!el) return undefined;
    setW(Math.floor(el.clientWidth));
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [w, setEl, el];
}

export function Stat({ value, label, tone }) {
  return (
    <div className="flex flex-col">
      <span style={{ fontFamily: DISPLAY, color: tone || C.fg }} className="text-2xl font-extrabold leading-none tabular-nums">{value}</span>
      <span className="text-[11px] mt-1" style={{ color: C.muted }}>{label}</span>
    </div>
  );
}

export function HostCard({ h }) {
  const n = h.node;
  const load = n.load || {};
  const bars = [
    ['CPU', load.cpu, load.cpuLabel],
    ['RAM', load.mem, load.memLabel],
  ].filter(([, v]) => typeof v === 'number');
  return (
    <foreignObject x={h.x} y={h.y} width={h.w} height={Math.max(150, Math.min(h.h, 220))}>
      <div
        style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: '14px 14px 12px', color: C.fg, height: '100%' }}
        className="flex flex-col gap-2"
      >
        <div className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full" style={{ background: n.status === 'ok' ? '#3ccf98' : '#ef5b5b', boxShadow: '0 0 0 3px rgba(60,207,152,.15)' }} />
          <span style={{ fontFamily: DISPLAY }} className="text-lg font-extrabold leading-none">{n.label}</span>
        </div>
        <div className="text-[11px]" style={{ color: C.muted, fontFamily: MONO }}>
          {n.detail?.kind === 'local' ? 'manager host · local socket' : `${n.detail?.address || ''} · over SSH`}
        </div>
        <div className="flex items-baseline gap-1.5">
          <span style={{ fontFamily: DISPLAY }} className="text-3xl font-extrabold tabular-nums leading-none">{h.running}</span>
          <span className="text-xs" style={{ color: C.muted }}>running of {h.count}</span>
        </div>
        {bars.map(([k, v, lbl]) => (
          <div key={k} className="flex flex-col gap-0.5">
            <div className="flex justify-between text-[10px]" style={{ color: C.faint, fontFamily: MONO }}>
              <span>{k}</span><span>{lbl}</span>
            </div>
            <div style={{ height: 5, background: C.line, borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${Math.min(100, Math.round(v * 100))}%`, height: '100%', background: v > 0.85 ? '#ef5b5b' : v > 0.6 ? C.attention : '#3ccf98' }} />
            </div>
          </div>
        ))}
      </div>
    </foreignObject>
  );
}

