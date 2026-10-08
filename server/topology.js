/**
 * The fleet as a graph.
 *
 * Every edge here is derived from something the manager actually knows. An edge
 * that merely looks plausible is worse than a missing one: a topology view is
 * read as a statement of fact about what can reach what.
 */
import { getHosts, getAllInstances, getGrantsForInstance, DEFAULT_HOST_ID } from './db.js';
import { listManagedContainersByHost, listPolicies } from './docker.js';
import { getAllScanSummaries } from './security-scan.js';
import { getAllInstanceUsage } from './db.js';
import { config } from './config.js';
import { getHealthReport } from './health.js';
import { hostMetrics, instanceMetrics } from './metrics.js';
import { getTrafficRates, getRecentDenials } from './proxy-log.js';
import { getModelList, getHealth as litellmHealth, isAvailable as litellmAvailable } from './litellm.js';
import { getImageStatus, getCurrentImageVersion } from './workspace-image.js';
import { getAccessRequestsForInstance } from './db.js';

/** Hosts whose policy lets an instance reach the internet only through squid. */
const RESTRICTED = (policy) => policy && policy !== 'unrestricted';

export async function buildTopology() {
  const nodes = [];
  const edges = [];

  const hosts = getHosts();
  const dbInstances = new Map(getAllInstances().map((i) => [i.id, i]));
  const { containers, polledHosts } = await listManagedContainersByHost();
  const usage = new Map(getAllInstanceUsage().map((u) => [u.instance_id, u]));
  const scans = getAllScanSummaries();
  const policies = listPolicies();
  // Policies are keyed by file id ('claude-github'); the display name may differ.
  const policyByName = new Map();
  for (const p of policies) { policyByName.set(p.id, p); policyByName.set(p.name, p); }
  const health = (() => { try { return getHealthReport(); } catch { return null; } })();

  // ── the outside world ────────────────────────────────────────────────────
  nodes.push({
    id: 'internet',
    type: 'internet',
    label: 'Internet',
    detail: { role: 'Everything outside the fleet' },
  });

  // ── hosts ────────────────────────────────────────────────────────────────
  const traffic = getTrafficRates();
  const imageStatusSafe = (() => { try { return getImageStatus(); } catch { return null; } })();
  const loadByHost = Object.fromEntries(await Promise.all(
    hosts.map(async (h) => [h.id, polledHosts.includes(h.id) ? await hostMetrics(h) : null]),
  ));
  const loadByContainer = Object.assign({}, ...await Promise.all(
    polledHosts.map((hid) => instanceMetrics(
      hid,
      containers.filter((c) => (c.hostId || DEFAULT_HOST_ID) === hid && c.state === 'running').map((c) => c.dockerId),
    )),
  ));

  for (const host of hosts) {
    const reachable = polledHosts.includes(host.id);
    const mine = containers.filter((c) => (c.hostId || DEFAULT_HOST_ID) === host.id);
    const load = loadByHost[host.id];
    nodes.push({
      id: `host:${host.id}`,
      type: 'host',
      label: host.name || host.id,
      status: !host.enabled ? 'disabled' : reachable ? 'ok' : 'unreachable',
      detail: {
        kind: host.kind,
        address: host.address || 'local socket',
        acceptsInstances: host.acceptsInstances,
        dataRoot: host.data_root,
        managerUrl: host.manager_url,
        dockerStatus: host.status_detail,
        lastSeen: host.last_seen,
        instances: mine.length,
        running: mine.filter((c) => c.state === 'running').length,
        labels: host.labels,
        workspaceImage: imageStatusSafe?.currentVersion || null,
        imageUpdateAvailable: !!imageStatusSafe?.updateAvailable,
      },
      // What the machine is actually doing right now.
      load: load ? {
        cpu: load.cpuLoad,
        cpuLabel: load.load1 !== null ? `load ${load.load1.toFixed(2)} / ${load.cores} cores` : null,
        mem: load.memPercent,
        memLabel: load.memTotal ? `${(load.memUsed / 1e9).toFixed(1)} / ${(load.memTotal / 1e9).toFixed(0)} GB` : null,
        cpuTemp: load.cpuTemp,
        diskTemp: load.diskTemp,
        disk: load.diskPercent,
        diskLabel: load.diskTotal
          ? `${(load.diskFree / 1e9).toFixed(0)} GB free of ${(load.diskTotal / 1e9).toFixed(0)}`
          : null,
        uptime: load.uptimeSeconds
          ? `up ${Math.floor(load.uptimeSeconds / 86400)}d ${Math.floor((load.uptimeSeconds % 86400) / 3600)}h`
          : null,
      } : null,
    });

    // A host that may not run instances is a fact worth seeing, not a footnote.
    if (!host.acceptsInstances) continue;

    // Each host that can run instances has its own egress proxy.
    const proxyId = `proxy:${host.id}`;
    nodes.push({
      id: proxyId,
      type: 'proxy',
      label: `${host.proxy_container || config.PROXY_CONTAINER}`,
      status: health?.problems?.some((p) => String(p.key || '').includes('proxy')) ? 'warning' : 'ok',
      detail: {
        host: host.name || host.id,
        role: 'Allowlist enforcement for restricted instances',
        container: host.proxy_container || config.PROXY_CONTAINER,
      },
    });
    edges.push({ source: proxyId, target: `host:${host.id}`, kind: 'runs-on' });
    // The proxy is the only thing a restricted instance can reach the internet through.
    // Labelled and graded: this is the claim "everything restricted on this host
    // leaves only through here", and it should read as strongly as it matters.
    edges.push({
      source: proxyId, target: 'internet', kind: 'allowlisted-egress',
      grade: 'enforced', label: 'allowlisted egress',
      because: 'every restricted instance on this host reaches the internet only through this gate',
    });
  }

  // ── model backends ───────────────────────────────────────────────────────
  // Only claude-max is reachable without LiteLLM; the rest route through it.
  nodes.push({
    id: 'backend:claude-max',
    type: 'backend',
    label: 'Claude Max',
    detail: { via: 'api.anthropic.com', routing: 'direct from the instance' },
  });
  edges.push({ source: 'backend:claude-max', target: 'internet', kind: 'reaches' });
  nodes.push({
    id: 'backend:github-copilot',
    type: 'backend',
    label: 'GitHub Copilot',
    detail: { via: 'api.githubcopilot.com', routing: 'copilot CLI, direct from the instance' },
  });
  edges.push({ source: 'backend:github-copilot', target: 'internet', kind: 'reaches' });

  if (config.LITELLM_API_BASE) {
    // Ask the router what it is actually serving, rather than describing it.
    const [models, health] = await Promise.all([
      litellmAvailable() ? getModelList().catch(() => null) : null,
      litellmAvailable() ? litellmHealth().catch(() => null) : null,
    ]);
    const modelIds = (models || []).map((m) => m.id || m.model_name).filter(Boolean);
    nodes.push({
      id: 'backend:litellm',
      type: 'backend',
      label: 'LiteLLM',
      status: health ? 'ok' : 'warning',
      detail: {
        endpoint: config.LITELLM_API_BASE,
        routing: 'the router in front of every non-Anthropic model',
        models: modelIds,
        modelCount: modelIds.length,
        healthy: !!health,
      },
    });
    edges.push({ source: 'backend:litellm', target: 'internet', kind: 'reaches' });

    // Each distinct provider behind the router, derived from the model names.
    const providers = new Map();
    for (const id of modelIds) {
      // Everything that is not Foundry or the lab-gpu box is served by the
      // workstation's Ollama — including the claude-* aliases, which exist so
      // the local-llm backend can answer Anthropic model names.
      const provider = id.startsWith('lab-gpu') ? 'lab-gpu (Ollama, dual 3090)'
        : id.startsWith('gpt') ? 'Azure AI Foundry'
        : 'workstation GPU (RTX 3090)';
      if (!providers.has(provider)) providers.set(provider, []);
      providers.get(provider).push(id);
    }
    for (const [provider, ids] of providers) {
      const pid = `provider:${provider.split(' ')[0].toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      nodes.push({
        id: pid, type: 'provider', label: provider.split(' (')[0],
        detail: {
          models: ids,
          via: 'LiteLLM',
          note: provider.includes('lab-gpu') ? 'a GPU box on the LAN; off most of the time'
            : provider.includes('workstation') ? 'Ollama on the workstation RTX 3090, over the LAN'
            : 'cloud endpoint',
        },
      });
      edges.push({ source: 'backend:litellm', target: pid, kind: 'routes-to', label: `${ids.length} model${ids.length === 1 ? '' : 's'}` });
    }
  }

  // ── instances ────────────────────────────────────────────────────────────
  const denials = getRecentDenials() || [];
  const imageVersion = getCurrentImageVersion();
  const imageStatus = (() => { try { return getImageStatus(); } catch { return null; } })();

  for (const c of containers) {
    const db = dbInstances.get(c.id);
    const myDenials = denials.filter((d) => d.instanceId === c.id);
    const deniedHosts = [...new Set(myDenials.map((d) => d.host))].slice(0, 6);
    const requests = (() => { try { return getAccessRequestsForInstance(c.id) || []; } catch { return []; } })();
    const pending = requests.filter((r) => r.status === 'pending').length;
    const hostId = c.hostId || db?.host_id || DEFAULT_HOST_ID;
    const policy = c.networkPolicy || db?.network_policy || 'unrestricted';
    const backend = c.llmBackend || 'claude-max';
    const scan = scans?.[c.id];
    const grants = getGrantsForInstance(c.id).filter((g) => g.active);
    const use = usage.get(c.id);
    const id = `instance:${c.id}`;

    nodes.push({
      id,
      type: 'instance',
      label: c.name,
      status: c.state === 'running' ? 'ok' : 'stopped',
      // Reachability is the one thing colour is allowed to carry here.
      egress: RESTRICTED(policy) ? 'proxied' : 'direct',
      load: (() => {
        const m = loadByContainer[c.dockerId];
        if (!m) return null;
        return {
          cpu: m.cpuPercent,                                        // in cores
          cpuLabel: m.cpuPercent !== null ? `${(m.cpuPercent * 100).toFixed(0)}% of a core` : null,
          mem: m.memLimit ? m.memUsed / m.memLimit : null,
          memLabel: m.memUsed ? `${(m.memUsed / 1e9).toFixed(2)} GB` : null,
        };
      })(),
      // Requests through the proxy in the last minute: what makes the edge move.
      traffic: traffic[c.id] || null,
      detail: {
        state: c.status,
        host: hosts.find((h) => h.id === hostId)?.name || hostId,
        hostId,
        policy,
        allowedHosts: policyByName.get(policy)?.allowedHosts?.length ?? null,
        backend,
        dockerSocket: !!c.dockerSocket,
        grants: grants.map((g) => ({ capability: g.capability_name, expires: g.expires_at })),
        contextTokens: use?.context_tokens ?? null,
        // The split, or null — an instance last seen by a hook that reported
        // only a total has an unknown cache ratio, which is not a 0% one.
        contextSplit: (use?.input_tokens || use?.cache_read_tokens || use?.cache_creation_tokens)
          ? {
            input: use.input_tokens,
            cacheRead: use.cache_read_tokens,
            cacheCreation: use.cache_creation_tokens,
          }
          : null,
        lastEvent: use?.last_event ?? null,
        statusMessage: use?.status_message ?? null,
        usageUpdatedAt: use?.updated_at ?? null,
        claudeVersion: db?.claude_version ?? null,
        scan: scan ? { critical: scan.critical, high: scan.high, secrets: scan.verified_secrets } : null,
        created: c.created,
        uptime: c.status,
        // Drift: this instance launched on a different Claude Code than the
        // image now carries, so a recreate would move it.
        imageVersion,
        updateAvailable: !!(db?.claude_version && imageVersion && db.claude_version !== imageVersion),
        pendingRequests: pending,
        // What this instance was actually blocked from reaching, by name. The
        // allowed destinations are not recorded, only the refused ones.
        deniedHosts,
      },
      flags: {
        updateAvailable: !!(db?.claude_version && imageVersion && db.claude_version !== imageVersion),
        pendingRequests: pending,
        dockerSocket: !!c.dockerSocket,
        scanAlert: !!(scan && (scan.critical || scan.verified_secrets)),
        denied: myDenials.length,
      },
    });

    edges.push({ source: id, target: `host:${hostId}`, kind: 'runs-on' });

    // Egress, graded by what the manager can actually VERIFY — not by what the
    // instance was labelled with. A policy name is an intention; an ACL on the
    // proxy that serves this host is enforcement.
    if (RESTRICTED(policy)) {
      const host = hosts.find((h) => h.id === hostId);
      let grade = 'enforced';
      let because = 'ACL written to this host’s proxy and HTTPS_PROXY set';
      if (host && host.kind !== 'local') {
        // server/proxy.js builds its own local Docker client and writes ACL
        // files into a local bind; HTTPS_PROXY is the single global PROXY_URL.
        // So on any host the manager does not itself run on, nothing writes the
        // ACL and nothing points the instance at a proxy it can reach.
        grade = 'unenforceable';
        because = 'the ACL writer and proxy URL are manager-host-only, so this policy is not enforced here';
      } else if (health?.problems?.some((p) => p.instanceId === c.id && String(p.key || '').includes('acl'))) {
        grade = 'broken';
        because = 'health reports a missing or stale ACL for this instance';
      }
      edges.push({
        source: id, target: `proxy:${hostId}`, kind: 'egress-via',
        label: policy, grade, because,
      });
    } else {
      edges.push({
        source: id, target: 'internet', kind: 'direct-egress',
        label: 'unrestricted', grade: 'open',
        because: 'no firewall: this instance reaches any host it likes',
      });
    }

    // Which model it talks to, and how it gets there.
    const backendNode = backend === 'claude-max' || backend === 'github-copilot' ? `backend:${backend}` : 'backend:litellm';
    if (nodes.some((n) => n.id === backendNode)) {
      edges.push({ source: id, target: backendNode, kind: 'uses-model', label: backend });
    }

    // The Docker socket is control of the host's daemon, not a mere mount.
    if (c.dockerSocket) {
      edges.push({ source: id, target: `host:${hostId}`, kind: 'controls-daemon' });
    }
  }

  // The fleet's own verdict, so the view answers "is anything wrong?" before
  // the operator has to read the graph.
  const problems = (health?.problems || []).map((p) => ({
    key: p.key, severity: p.severity || 'warn', instanceId: p.instanceId || null, message: p.message,
  }));
  const unenforceable = edges.filter((e) => e.grade === 'unenforceable');
  for (const e of unenforceable) {
    problems.push({
      key: `egress:${e.source}`, severity: 'error', instanceId: e.source.replace('instance:', ''),
      message: `${e.label} is not enforced on a remote host — ${e.because}`,
    });
  }

  return {
    nodes,
    edges,
    fleet: {
      ok: problems.length === 0,
      verdict: problems.length ? problems.map((p) => p.message).join(' · ') : 'all clear',
      problems,
      counts: {
        hosts: hosts.length,
        instances: containers.length,
        running: containers.filter((c) => c.state === 'running').length,
        restricted: containers.filter((c) => RESTRICTED(c.networkPolicy)).length,
      },
    },
    // What this view deliberately does NOT claim to know. A topology chart is
    // read as a statement of fact, so its blind spots belong in the same payload.
    notShown: [
      { relation: 'which external host an instance reached',
        reason: 'the proxy log keeps destinations only for DENIED requests; allowed traffic is counted, not attributed' },
      { relation: 'the in-container iptables lock',
        reason: 'entrypoint.sh applies it and continues on failure; no API reports whether it took' },
      { relation: 'per-instance LLM cost',
        reason: 'instances are injected with a per-backend shared key, so per-instance virtual-key spend reads as zero' },
    ],
    meta: {
      hosts: hosts.length,
      instances: containers.length,
      unreachableHosts: hosts.filter((h) => h.enabled && !polledHosts.includes(h.id)).map((h) => h.id),
      // Honesty: say which hosts could not be polled, so a sparse graph is not
      // mistaken for an idle fleet.
      polledHosts,
    },
  };
}
