/**
 * Proxy denial watcher — follows the squid container's stdout access log and
 * logs every DENIED request with the instance it came from.
 *
 * Squid only knows the client IP, so we resolve IP → instance at the time of the
 * denial. Each (instance, host) pair is logged once per window so a retry loop
 * doesn't flood the log; the count of suppressed repeats is included next time.
 * The in-memory list backs GET /api/system/egress-denials.
 */
import Docker from 'dockerode';
import { config } from './config.js';
import { LABELS } from '../shared/constants.js';
import { logActivity } from './db.js';
import { moduleLogger } from './logger.js';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const log = moduleLogger('egress');

const WINDOW_MS = 10 * 60_000;
const MAX_RECENT = 200;

let stream = null;
let stopped = false;
let retryTimer = null;
const seen = new Map(); // `${instance}|${host}` -> { at, suppressed }
const recent = [];

let ipCache = { at: 0, map: new Map() };
/**
 * Which instance owns this container IP. Used for denial attribution, and to
 * check that a container claiming to be an instance is that instance.
 */
export async function instanceForIp(ip) {
  if (Date.now() - ipCache.at > 30_000) {
    const map = new Map();
    const containers = await docker.listContainers({ filters: { label: [`${LABELS.MANAGED}=true`] } });
    for (const c of containers) {
      const cip = c.NetworkSettings?.Networks?.[config.CLAUDE_NETWORK]?.IPAddress;
      if (cip) map.set(cip, {
        id: c.Labels?.[LABELS.ID],
        name: c.Labels?.[LABELS.NAME],
        policy: c.Labels?.[LABELS.NETWORK_POLICY] || 'unrestricted',
      });
    }
    ipCache = { at: Date.now(), map };
  }
  return ipCache.map.get(ip) || null;
}

/**
 * Parse one squid access-log line (the "cm" logformat in proxy/squid.conf):
 *   cm <client-ip> <status/code> <method> <host-or-url>
 * Exported for tests.
 */
export function parseSquidLine(line) {
  const m = line.match(/\bcm (\S+) (\S+?)\/(\d{3}) (\S+) (\S+)/);
  if (!m) return null;
  const [, ip, result, status, method, target] = m;
  let host = target;
  if (method !== 'CONNECT') {
    try { host = new URL(target).hostname; } catch { /* keep raw */ }
  } else {
    host = target.replace(/:\d+$/, '');
  }
  return { ip, result, status: Number(status), method, host, denied: result.includes('DENIED') };
}

// Rolling request rates per instance, in 10s buckets over one minute. The
// access log already streams past us for denial detection; counting what is
// ALLOWED too is free, and it is the only honest source of "this instance is
// actually talking to the internet right now".
const RATE_BUCKETS = 6;
const BUCKET_MS = 10_000;
const rates = new Map();   // key: instance id or ip → { buckets: [{allowed,denied}], at }

function bump(key, denied) {
  const now = Date.now();
  let r = rates.get(key);
  const slot = Math.floor(now / BUCKET_MS);
  if (!r) { r = { slot, buckets: Array.from({ length: RATE_BUCKETS }, () => ({ allowed: 0, denied: 0 })) }; rates.set(key, r); }
  // Advance and clear whatever time has passed, so a quiet instance decays to zero.
  const advance = Math.min(slot - r.slot, RATE_BUCKETS);
  for (let i = 0; i < advance; i++) {
    r.buckets.shift();
    r.buckets.push({ allowed: 0, denied: 0 });
  }
  r.slot = slot;
  const head = r.buckets[r.buckets.length - 1];
  if (denied) head.denied++; else head.allowed++;
}

/**
 * Requests per minute per instance over the last minute.
 * Returns { [instanceId]: { allowed, denied } } — counts, not estimates.
 */
export function getTrafficRates() {
  const out = {};
  const slot = Math.floor(Date.now() / BUCKET_MS);
  for (const [key, r] of rates) {
    // Anything older than the window contributes nothing.
    const stale = slot - r.slot;
    if (stale >= RATE_BUCKETS) { rates.delete(key); continue; }
    const live = stale > 0 ? r.buckets.slice(stale) : r.buckets;
    const allowed = live.reduce((n, b) => n + b.allowed, 0);
    const denied = live.reduce((n, b) => n + b.denied, 0);
    if (allowed || denied) out[key] = { allowed, denied };
  }
  return out;
}

async function handleLine(line) {
  const entry = parseSquidLine(line);
  if (!entry) return;
  // Count first: rates cover allowed traffic too, and the denial path below
  // deliberately suppresses repeats, which would skew a rate.
  const rateInst = await instanceForIp(entry.ip).catch(() => null);
  bump(rateInst?.id || entry.ip, entry.denied);
  if (!entry.denied) return;
  const inst = await instanceForIp(entry.ip).catch(() => null);
  const key = `${inst?.id || entry.ip}|${entry.host}`;
  const now = Date.now();
  const prev = seen.get(key);
  if (prev && now - prev.at < WINDOW_MS) {
    prev.suppressed++;
    return;
  }
  seen.set(key, { at: now, suppressed: 0 });
  const record = {
    at: new Date(now).toISOString(),
    instanceId: inst?.id || null,
    instanceName: inst?.name || null,
    policy: inst?.policy || null,
    ip: entry.ip,
    host: entry.host,
    method: entry.method,
    status: entry.status,
    repeatsSinceLast: prev?.suppressed || 0,
  };
  recent.unshift(record);
  recent.length = Math.min(recent.length, MAX_RECENT);
  log.warn(record, `egress denied: ${inst?.name || entry.ip} (${inst?.policy || 'unknown policy'}) → ${entry.host}`);
  if (inst?.id) {
    try { logActivity('egress_denied', inst.id, inst.name, `${entry.method} ${entry.host} blocked by policy ${inst.policy}`); } catch { /* db not ready */ }
  }
}

function scheduleRetry(ms) {
  if (stopped) return;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(follow, ms);
  retryTimer.unref?.();
}

async function follow() {
  if (stopped) return;
  try {
    const container = docker.getContainer(config.PROXY_CONTAINER);
    const info = await container.inspect();
    if (!info.State?.Running) {
      log.debug(`${config.PROXY_CONTAINER} not running; retrying in 60s`);
      return scheduleRetry(60_000);
    }
    stream = await container.logs({ follow: true, stdout: true, stderr: false, since: Math.floor(Date.now() / 1000), timestamps: false });
    let buf = '';
    // The squid container has no TTY, so the log stream is multiplexed.
    const { PassThrough } = await import('stream');
    const out = new PassThrough();
    docker.modem.demuxStream(stream, out, new PassThrough());
    out.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        handleLine(line).catch((err) => log.debug({ err }, 'failed to handle squid line'));
      }
    });
    stream.on('end', () => { log.info('proxy log stream ended; reattaching'); scheduleRetry(5_000); });
    stream.on('error', (err) => { log.warn({ err }, 'proxy log stream error; reattaching'); scheduleRetry(5_000); });
    log.info(`following ${config.PROXY_CONTAINER} access log for denials`);
  } catch (err) {
    log.debug({ err: err.message }, 'cannot follow proxy log; retrying in 60s');
    scheduleRetry(60_000);
  }
}

export function startProxyLogWatcher() {
  stopped = false;
  follow();
}

export function stopProxyLogWatcher() {
  stopped = true;
  clearTimeout(retryTimer);
  try { stream?.destroy?.(); } catch { /* ignore */ }
  stream = null;
}

export function getRecentDenials() {
  return recent;
}
