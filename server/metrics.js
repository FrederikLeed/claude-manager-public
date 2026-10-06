/**
 * Load for the fleet graph: CPU, memory and temperature, per host and per instance.
 *
 * Two different sources, because they measure different things:
 *   host     → node-exporter on that host (the machine's own view: load, RAM, sensors)
 *   instance → Docker stats for its container (what this workload is using)
 *
 * Everything is cached briefly and fails soft: a graph that renders without a
 * temperature is fine, a graph that blocks on a dead exporter is not.
 */
import { readFileSync } from 'fs';
import { dockerFor } from './hosts.js';
import { moduleLogger } from './logger.js';

const log = moduleLogger('metrics');

const TTL_MS = 10_000;
const SCRAPE_TIMEOUT_MS = 2_500;
const cache = new Map();

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await fn().catch((err) => {
    log.debug({ key, err: err.message }, 'metric collection failed');
    return null;
  });
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Sum the samples of one metric, optionally filtered by a label substring. */
function sumSeries(text, metric, labelFilter = null) {
  let total = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith(metric)) continue;
    if (labelFilter && !line.includes(labelFilter)) continue;
    const value = Number(line.slice(line.lastIndexOf(' ') + 1));
    if (Number.isFinite(value)) total = (total ?? 0) + value;
  }
  return total;
}

/** How many series match — node_cpu_seconds_total has one per core. */
function countSeries(text, metric, labelFilter = null) {
  let n = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith(metric)) continue;
    if (labelFilter && !line.includes(labelFilter)) continue;
    n++;
  }
  return n || null;
}

function maxSeries(text, metric, labelFilter = null) {
  let max = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith(metric)) continue;
    if (labelFilter && !line.includes(labelFilter)) continue;
    const value = Number(line.slice(line.lastIndexOf(' ') + 1));
    if (Number.isFinite(value)) max = max === null ? value : Math.max(max, value);
  }
  return max;
}

/**
 * Candidate addresses for a host's node-exporter, best first.
 *
 * For the manager's own host, 127.0.0.1 is the CONTAINER's loopback — the
 * exporter lives in the host's network namespace, so the route out is the
 * bridge gateway (or Docker Desktop's alias). Whichever answers first is
 * remembered, so the fallbacks cost one round trip, once.
 */
const workingAddress = new Map();

function defaultGateway() {
  try {
    const routes = readFileSync('/proc/net/route', 'utf8').split('\n').slice(1);
    for (const line of routes) {
      const [, dest, gw] = line.split(/\s+/);
      if (dest === '00000000' && gw) {
        // little-endian hex
        const b = gw.match(/../g).reverse().map((h) => parseInt(h, 16));
        return b.join('.');
      }
    }
  } catch { /* not on Linux, or no /proc */ }
  return null;
}

function candidatesFor(host) {
  if (host.kind !== 'local') return host.address ? [host.address] : [];
  return [host.address, 'host.docker.internal', defaultGateway(), '127.0.0.1'].filter(Boolean);
}

export async function hostMetrics(host) {
  if (!host) return null;
  const candidates = workingAddress.has(host.id) ? [workingAddress.get(host.id)] : candidatesFor(host);
  if (!candidates.length) return null;

  return cached(`host:${host.id}`, async () => {
    for (const candidate of candidates) {
      const text = await scrape(candidate);
      if (text) { workingAddress.set(host.id, candidate); return parseNodeExporter(text); }
    }
    workingAddress.delete(host.id);
    return null;
  });
}

async function scrape(address) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SCRAPE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://${address}:9100/metrics`, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseNodeExporter(text) {
  const load1 = sumSeries(text, 'node_load1 ');
  // COUNT the idle series (one per core) — summing them would add up seconds of
  // idle time, which is a large number that is not a core count.
  const cpus = countSeries(text, 'node_cpu_seconds_total{', 'mode="idle"');
  const memTotal = sumSeries(text, 'node_memory_MemTotal_bytes');
  const memAvail = sumSeries(text, 'node_memory_MemAvailable_bytes');
  // Package temperature, not the per-core sensors: one number per machine.
  const cpuTemp = maxSeries(text, 'node_hwmon_temp_celsius{', 'coretemp');
  const diskTemp = maxSeries(text, 'node_hwmon_temp_celsius{', 'nvme');
  // Free space where instance volumes actually land, falling back to root.
  const fleetAvail = sumSeries(text, 'node_filesystem_avail_bytes{', 'mountpoint="/mnt/fleetdata"')
    ?? sumSeries(text, 'node_filesystem_avail_bytes{', 'mountpoint="/"');
  const fleetSize = sumSeries(text, 'node_filesystem_size_bytes{', 'mountpoint="/mnt/fleetdata"')
    ?? sumSeries(text, 'node_filesystem_size_bytes{', 'mountpoint="/"');
  const uptimeSeconds = (() => {
    const boot = sumSeries(text, 'node_boot_time_seconds');
    return boot ? Math.floor(Date.now() / 1000 - boot) : null;
  })();

  return {
    cpuLoad: load1 !== null && cpus ? Math.min(load1 / cpus, 1) : null,  // 0..1 of capacity
    load1,
    cores: cpus || null,
    memUsed: memTotal !== null && memAvail !== null ? memTotal - memAvail : null,
    memTotal,
    memPercent: memTotal && memAvail !== null ? 1 - memAvail / memTotal : null,
    cpuTemp,
    diskTemp,
    diskFree: fleetAvail,
    diskTotal: fleetSize,
    diskPercent: fleetSize && fleetAvail !== null ? 1 - fleetAvail / fleetSize : null,
    uptimeSeconds,
  };
}

/**
 * Per-container CPU and memory for every running instance on a host.
 * Returns { [containerId]: { cpuPercent, memUsed, memLimit } }.
 */
export async function instanceMetrics(hostId, containerIds) {
  if (!containerIds?.length) return {};
  return (await cached(`instances:${hostId}`, async () => {
    const docker = await dockerFor(hostId);
    const out = {};
    // One snapshot each, in parallel. stream:false still returns precpu_stats,
    // so a single call is enough to compute a percentage.
    await Promise.all(containerIds.map(async (cid) => {
      try {
        const stats = await docker.getContainer(cid).stats({ stream: false });
        const cpuDelta = stats.cpu_stats?.cpu_usage?.total_usage - stats.precpu_stats?.cpu_usage?.total_usage;
        const sysDelta = stats.cpu_stats?.system_cpu_usage - stats.precpu_stats?.system_cpu_usage;
        const cores = stats.cpu_stats?.online_cpus || stats.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
        const cpuPercent = sysDelta > 0 && cpuDelta >= 0 ? (cpuDelta / sysDelta) * cores : null;
        // cache is page cache, not the workload's own footprint.
        const memUsed = (stats.memory_stats?.usage ?? 0) - (stats.memory_stats?.stats?.inactive_file ?? 0);
        out[cid] = {
          cpuPercent,                                  // 0..cores (1 = one full core)
          memUsed: memUsed > 0 ? memUsed : null,
          memLimit: stats.memory_stats?.limit ?? null,
        };
      } catch { /* a container that stopped mid-collection is not an error */ }
    }));
    return out;
  })) || {};
}
