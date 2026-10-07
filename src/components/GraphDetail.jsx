/**
 * What a graph node actually is, once you click it.
 *
 * Per type, because the useful facts differ: an instance's policy and grants, a
 * host's capacity and heat, a gate's job. The drawer also states what the graph
 * does NOT know, so a confident picture is not mistaken for a complete one.
 */

import { statusFromUsage, contextSplit } from '../lib/instance-status.js';

function Row({ label, value, tone }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="flex gap-3 py-1.5 border-b border-gray-800/60 last:border-0">
      <span className="w-32 shrink-0 text-xs text-gray-500">{label}</span>
      <span className="text-xs break-words" style={{ color: tone || 'var(--cm-ink-1)' }}>{value}</span>
    </div>
  );
}

export default function GraphDetail({ node, topology, onClose }) {
  const d = node.detail || {};
  // Same derivation the dashboard uses, so the two views cannot disagree about
  // which instances are waiting on a human.
  // Same gate the chip uses (topology reports a running container as 'ok'):
  // a stopped instance is not "working", whatever its last event said.
  const status = node.type === 'instance' && node.status === 'ok'
    ? statusFromUsage({ lastEvent: d.lastEvent, statusMessage: d.statusMessage, updatedAt: d.usageUpdatedAt })
    : null;
  const split = contextSplit({ split: d.contextSplit });
  const edges = (topology?.edges || []).filter((e) => e.source === node.id || e.target === node.id);
  // Connections name the thing, not its row id.
  const labelOf = (id) =>
    topology?.nodes?.find((n) => n.id === id)?.label
    || id.replace(/^(instance|host|proxy|backend):/, '');

  return (
    <aside className="w-80 shrink-0 border-l border-gray-800 bg-gray-900 overflow-y-auto">
      <div className="sticky top-0 bg-gray-900 border-b border-gray-800 px-4 py-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-100 truncate">{node.label}</div>
          <div className="text-[11px] text-gray-500 capitalize">{node.type}</div>
        </div>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">×</button>
      </div>

      <div className="px-4 py-3">
        {node.type === 'instance' && (
          <>
            <Row label="State" value={d.state} />
            <Row label="Host" value={d.host} />
            <Row
              label="Network policy"
              value={d.allowedHosts != null ? `${d.policy} — ${d.allowedHosts} hosts allowed` : d.policy}
            />
            <Row label="Model backend" value={d.backend} />
            <Row label="Claude Code" value={d.claudeVersion} />
            <Row label="Context" value={d.contextTokens ? `${(d.contextTokens / 1000).toFixed(1)}k tokens` : null} />
            {/* The parts, because the cache ratio is what says whether a long
                session is cheap or thrashing. A total alone cannot. */}
            <Row
              label="…fresh input"
              value={split ? `${split.input.toLocaleString()} tokens` : null}
            />
            <Row
              label="…from cache"
              value={split ? `${split.cacheRead.toLocaleString()} (${Math.round(split.cachedFraction * 100)}%)` : null}
            />
            <Row
              label="…cache written"
              value={split ? `${split.cacheCreation.toLocaleString()} tokens` : null}
            />
            <Row
              label="…split"
              value={!split && d.contextTokens ? 'not reported — older hook' : null}
              tone="var(--cm-ink-3)"
            />
            <Row
              label="Status"
              value={status ? `${status.glyph} ${status.word}${status.age ? ` · ${status.age}` : ''}` : null}
              tone={status?.tone}
            />
            <Row label="Last said" value={status?.message} />
            <Row label="Last event" value={d.lastEvent} />
            <Row
              label="Docker socket"
              value={d.dockerSocket ? 'granted — controls this host’s daemon' : null}
              tone="var(--cm-warn)"
            />
            {node.load && (
              <>
                <Row label="CPU" value={node.load.cpuLabel} />
                <Row label="Memory" value={node.load.memLabel} />
              </>
            )}
            {node.traffic && (
              <Row
                label="Traffic"
                value={`${node.traffic.allowed} allowed${node.traffic.denied ? `, ${node.traffic.denied} denied` : ''} / min`}
                tone={node.traffic.denied ? 'var(--cm-warn)' : undefined}
              />
            )}
            {d.scan && (
              <Row
                label="Last scan"
                value={`${d.scan.critical} critical · ${d.scan.high} high${d.scan.secrets ? ` · ${d.scan.secrets} verified secrets` : ''}`}
                tone={d.scan.critical || d.scan.secrets ? 'var(--cm-critical)' : undefined}
              />
            )}
            {!!d.grants?.length && (
              <Row label="Grants" value={d.grants.map((g) => `${g.capability} (expires ${g.expires})`).join(', ')} />
            )}
            <Row
              label="Claude version"
              value={d.updateAvailable ? `${d.claudeVersion} — image now has ${d.imageVersion}` : null}
              tone="var(--cm-warn)"
            />
            <Row
              label="Access requests"
              value={d.pendingRequests ? `${d.pendingRequests} awaiting approval` : null}
              tone="var(--cm-warn)"
            />
            {!!d.deniedHosts?.length && (
              <Row
                label="Blocked hosts"
                value={d.deniedHosts.join(', ')}
                tone="var(--cm-critical)"
              />
            )}
          </>
        )}

        {node.type === 'host' && (
          <>
            <Row label="Kind" value={d.kind === 'local' ? 'the manager runs here' : `remote — ${d.kind}`} />
            <Row label="Address" value={d.address} />
            <Row
              label="Accepts instances"
              value={d.acceptsInstances ? 'yes' : 'no — registered but never scheduled onto'}
              tone={d.acceptsInstances ? undefined : 'var(--cm-ink-2)'}
            />
            <Row label="Instances" value={`${d.running} running of ${d.instances}`} />
            <Row label="Data root" value={d.dataRoot} />
            <Row label="Manager URL" value={d.managerUrl} />
            <Row label="Docker" value={d.dockerStatus} />
            <Row
              label="Workspace image"
              value={d.workspaceImage ? `Claude Code ${d.workspaceImage}${d.imageUpdateAvailable ? ' — newer available' : ''}` : null}
              tone={d.imageUpdateAvailable ? 'var(--cm-warn)' : undefined}
            />
            {node.load && (
              <>
                <Row label="CPU" value={node.load.cpuLabel} />
                <Row label="Memory" value={node.load.memLabel} />
                <Row
                  label="CPU temp"
                  value={node.load.cpuTemp != null ? `${node.load.cpuTemp.toFixed(1)} °C` : null}
                  tone={node.load.cpuTemp > 80 ? 'var(--cm-warn)' : undefined}
                />
                <Row
                  label="Disk temp"
                  value={node.load.diskTemp != null ? `${node.load.diskTemp.toFixed(1)} °C` : null}
                />
                <Row label="Disk" value={node.load.diskLabel} />
                <Row label="Uptime" value={node.load.uptime} />
              </>
            )}
          </>
        )}

        {node.type === 'proxy' && (
          <>
            <Row label="Role" value={d.role} />
            <Row label="Host" value={d.host} />
            <Row label="Container" value={d.container} />
            <Row
              label="What it does"
              value="Restricted instances reach the internet only through here; anything not on the policy’s allowlist is denied."
            />
          </>
        )}

        {node.type === 'backend' && (
          <>
            <Row label="Endpoint" value={d.endpoint || d.via} />
            <Row label="Routing" value={d.routing} />
            <Row
              label="Health"
              value={d.healthy === undefined ? null : d.healthy ? '▶ answering' : '◷ not responding'}
              tone={d.healthy === false ? 'var(--cm-warn)' : 'var(--cm-good)'}
            />
            {!!d.models?.length && <Row label="Models" value={d.models.join(', ')} />}
          </>
        )}

        {node.type === 'provider' && (
          <>
            <Row label="Reached via" value={d.via} />
            <Row label="Models" value={d.models?.join(', ')} />
            <Row label="Note" value={d.note} />
          </>
        )}

        {node.type === 'internet' && <Row label="Role" value={d.role} />}

        {/* Connections, with the evidence grade spelled out in words. */}
        {!!edges.length && (
          <div className="mt-4">
            <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Connections</div>
            {edges.map((e, i) => (
              <div key={i} className="py-1.5 border-b border-gray-800/60 last:border-0">
                <div className="text-xs text-gray-300">
                  {e.source === node.id ? '→ ' : '← '}
                  {labelOf(e.source === node.id ? e.target : e.source)}
                  <span className="text-gray-600"> · {e.kind}</span>
                </div>
                {e.because && (
                  <div
                    className="text-[11px] mt-0.5"
                    style={{
                      color: e.grade === 'unenforceable' || e.grade === 'broken'
                        ? 'var(--cm-critical)'
                        : 'var(--cm-ink-3)',
                    }}
                  >
                    {e.grade === 'unenforceable' ? '✕ ' : e.grade === 'broken' ? '⊘ ' : ''}
                    {e.because}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Blind spots travel with the claims. */}
        {!!topology?.notShown?.length && (
          <div className="mt-4">
            <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Not shown</div>
            {topology.notShown.map((n, i) => (
              <div key={i} className="text-[11px] text-gray-500 py-1">
                <span className="text-gray-400">{n.relation}</span> — {n.reason}
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
