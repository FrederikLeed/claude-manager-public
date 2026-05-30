// Scheduled Trivy security scans of each instance's /workspace.
//
// Runs Trivy (vuln + secret scanners) in a throwaway container against each
// running instance's workspace volume (read-only), parses the JSON report, and
// stores per-instance severity counts + findings. Entirely server-side over the
// Docker socket — no GitHub Actions / CI. A cached DB volume keeps repeat scans
// fast. Daily by default + on demand. Only NEW CRITICAL findings raise an alert.
import Docker from 'dockerode';
import { config } from './config.js';
import {
  setInstanceScan, getInstanceScan, getAllInstanceScans,
} from './db.js';
import { listManagedContainers } from './docker.js';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const CACHE_VOLUME = 'cm-trivy-cache';
const SCAN_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_FINDINGS = 200;
const SEV_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNKNOWN: 4 };

const state = { scanning: false, lastRunAt: null, current: null, imageReady: false };
let _broadcast = () => {};
export function setScanBroadcaster(fn) { _broadcast = fn || (() => {}); }

export function getScanStatus() {
  return {
    scanning: state.scanning,
    lastRunAt: state.lastRunAt,
    current: state.current,
    enabled: config.SECURITY_SCAN_INTERVAL_HOURS > 0,
  };
}

/** Latest scan summary for one instance (for the API/badge). */
export function getScanForInstance(instanceId) {
  const s = getInstanceScan(instanceId);
  if (!s) return null;
  return {
    critical: s.critical, high: s.high, medium: s.medium, low: s.low,
    secrets: s.secrets, error: s.error, scannedAt: s.scanned_at,
  };
}

async function ensureTrivyImage(log) {
  if (state.imageReady) return;
  try {
    await docker.getImage(config.TRIVY_IMAGE).inspect();
  } catch {
    log?.info(`Pulling ${config.TRIVY_IMAGE} for security scans…`);
    const stream = await docker.pull(config.TRIVY_IMAGE);
    await new Promise((resolve, reject) =>
      docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve())));
  }
  try { await docker.createVolume({ Name: CACHE_VOLUME }); } catch { /* exists */ }
  state.imageReady = true;
}

/** Split a non-TTY Docker log buffer into stdout/stderr (8-byte frame headers). */
function demuxBuffer(buf) {
  let stdout = '', stderr = '';
  let i = 0;
  while (i + 8 <= buf.length) {
    const type = buf[i];
    const len = buf.readUInt32BE(i + 4);
    const payload = buf.slice(i + 8, i + 8 + len).toString('utf8');
    if (type === 2) stderr += payload; else stdout += payload;
    i += 8 + len;
  }
  // Fallback: if framing wasn't present (rare), treat the whole thing as stdout
  if (!stdout && !stderr) stdout = buf.toString('utf8');
  return { stdout, stderr };
}

/** Resolve the workspace volume name for an instance's container. */
async function getWorkspaceVolume(dockerId) {
  const inspect = await docker.getContainer(dockerId).inspect();
  const m = (inspect.Mounts || []).find((x) => x.Destination === '/workspace');
  return m?.Name || m?.Source || null;
}

/** Run Trivy against a volume, return { counts, findings } or throw. */
async function runTrivy(volume) {
  // Start → wait → fetch logs (NOT a live attach). Attaching to an AutoRemove
  // container over the Docker Desktop proxy socket races — the container exits
  // and is reaped before the stream flushes, yielding 0 bytes. Reading logs
  // after wait() is the robust pattern docker.js uses elsewhere.
  const container = await docker.createContainer({
    Image: config.TRIVY_IMAGE,
    Cmd: ['fs', '--quiet', '--scanners', 'vuln,secret',
      '--severity', 'CRITICAL,HIGH,MEDIUM', '--format', 'json', '/scan'],
    Tty: false,
    HostConfig: {
      Binds: [`${volume}:/scan:ro`, `${CACHE_VOLUME}:/root/.cache`],
      NetworkMode: 'bridge',
      AutoRemove: false,
    },
  });

  await container.start();

  // Wait for completion (bounded), then pull the buffered logs.
  let exitCode = 0;
  try {
    const waitResult = await Promise.race([
      container.wait(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('scan timed out')), SCAN_TIMEOUT_MS)),
    ]);
    exitCode = waitResult.StatusCode;
  } catch (err) {
    try { await container.remove({ force: true }); } catch { /* best effort */ }
    throw err;
  }

  let out = '', err = '';
  try {
    const logBuf = await container.logs({ stdout: true, stderr: true, follow: false });
    // Demux the multiplexed log buffer (8-byte frame headers)
    const { stdout, stderr } = demuxBuffer(logBuf);
    out = stdout; err = stderr;
  } catch (e) {
    try { await container.remove({ force: true }); } catch { /* best effort */ }
    throw new Error(`Could not read Trivy logs: ${e.message}`);
  }
  try { await container.remove({ force: true }); } catch { /* best effort */ }

  if (!out.trim()) throw new Error(err.trim().slice(0, 300) || `Trivy exited ${exitCode} with no output`);

  let report;
  try { report = JSON.parse(out); }
  catch { throw new Error('Could not parse Trivy output'); }

  const counts = { critical: 0, high: 0, medium: 0, low: 0, secrets: 0 };
  const findings = [];
  for (const res of report.Results || []) {
    for (const v of res.Vulnerabilities || []) {
      const sev = (v.Severity || 'UNKNOWN').toLowerCase();
      if (counts[sev] !== undefined) counts[sev]++;
      findings.push({ type: 'vuln', severity: v.Severity, id: v.VulnerabilityID,
        pkg: v.PkgName, installed: v.InstalledVersion, fixed: v.FixedVersion || '',
        title: (v.Title || '').slice(0, 160), target: res.Target });
    }
    for (const s of res.Secrets || []) {
      counts.secrets++;
      const sev = (s.Severity || 'UNKNOWN').toLowerCase();
      if (counts[sev] !== undefined) counts[sev]++;
      findings.push({ type: 'secret', severity: s.Severity, id: s.RuleID,
        title: (s.Title || '').slice(0, 160), target: res.Target, line: s.StartLine });
    }
  }
  findings.sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9));
  return { counts, findings: findings.slice(0, MAX_FINDINGS) };
}

/** Scan a single instance; store + return its summary. */
export async function scanInstance(instance, log) {
  await ensureTrivyImage(log);
  const prev = getInstanceScan(instance.id);
  try {
    const volume = await getWorkspaceVolume(instance.dockerId);
    if (!volume) throw new Error('No /workspace volume found');
    const { counts, findings } = await runTrivy(volume);
    setInstanceScan(instance.id, { ...counts, findings, error: null });
    const newCritical = counts.critical > (prev?.critical || 0);
    return { id: instance.id, name: instance.name, ...counts, newCritical };
  } catch (err) {
    log?.warn({ err: err.message, instance: instance.id }, 'Trivy scan failed');
    setInstanceScan(instance.id, { critical: prev?.critical || 0, high: prev?.high || 0,
      medium: prev?.medium || 0, low: prev?.low || 0, secrets: prev?.secrets || 0,
      findings: prev?.findings || null, error: err.message.slice(0, 200) });
    return { id: instance.id, name: instance.name, error: err.message };
  }
}

/** Scan all running instances sequentially; alert on new CRITICAL. */
export async function scanAll(log, { only = null } = {}) {
  if (state.scanning) return { started: false, reason: 'already scanning' };
  state.scanning = true;
  state.current = null;
  _broadcast({ type: 'security_scan', status: getScanStatus() });
  try {
    const containers = await listManagedContainers();
    let targets = containers.filter((c) => c.state === 'running');
    if (only) targets = targets.filter((c) => c.id === only);

    const newCriticalInstances = [];
    for (const inst of targets) {
      state.current = inst.name;
      _broadcast({ type: 'security_scan', status: getScanStatus() });
      const r = await scanInstance(inst, log);
      if (r.newCritical) newCriticalInstances.push(r);
    }

    state.lastRunAt = new Date().toISOString();
    state.current = null;

    // Alert ONLY on new critical findings (per user preference)
    for (const r of newCriticalInstances) {
      _broadcast({ type: 'security_scan', alert: true,
        instanceId: r.id, name: r.name, critical: r.critical });
    }
    log?.info(`Security scan complete — ${targets.length} instances, ${newCriticalInstances.length} with new CRITICAL`);
    return { started: true, scanned: targets.length, newCritical: newCriticalInstances.length };
  } finally {
    state.scanning = false;
    _broadcast({ type: 'security_scan', status: getScanStatus() });
  }
}

/** Summary map for merging into GET /api/instances. */
export function getAllScanSummaries() {
  return new Map(getAllInstanceScans().map((s) => [s.instance_id, s]));
}
