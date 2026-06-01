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
    secrets: s.secrets, verifiedSecrets: s.verified_secrets, error: s.error, scannedAt: s.scanned_at,
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

// TruffleHog exclude-paths regex (one per line) — mirrors the Trivy skip-dirs.
const TH_EXCLUDE_PATTERNS = [
  '(^|/)\\.git/',
  '(^|/)node_modules/',
  'data/claude-home/projects/',
  'data/claude-home/sessions/',
  'data/claude-home/file-history/',
  'data/claude-home/paste-cache/',
  '\\.claude/projects/',
];
let _thExcludeHostPath = null;

/**
 * Write the exclude-paths file to the manager's /data dir and return its HOST
 * path (the trufflehog sibling container needs a host bind source, not a
 * manager-container path). Resolved once from the manager's own /data mount.
 */
async function ensureTruffleHogExcludes() {
  if (_thExcludeHostPath !== null) return _thExcludeHostPath || null;
  try {
    const fs = await import('fs');
    fs.writeFileSync(`${config.DATA_DIR}/.th-exclude.txt`, TH_EXCLUDE_PATTERNS.join('\n') + '\n');
    // Resolve manager's /data bind source (host path) by inspecting self.
    const hostname = (await import('os')).hostname();
    const inspect = await docker.getContainer(hostname).inspect();
    const dataMount = (inspect.Mounts || []).find((m) => m.Destination === config.DATA_DIR);
    _thExcludeHostPath = dataMount?.Source ? `${dataMount.Source}/.th-exclude.txt` : '';
  } catch {
    _thExcludeHostPath = '';
  }
  return _thExcludeHostPath || null;
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
    // Skip noise that isn't the instance's own source: VCS internals, deps, and
    // Claude session transcripts (gitignored runtime state that echoes tokens in
    // command output — they dominated scans as false-positive "secrets").
    Cmd: ['fs', '--quiet', '--scanners', 'vuln,secret',
      '--severity', 'CRITICAL,HIGH,MEDIUM', '--format', 'json',
      '--skip-dirs', '**/.git',
      '--skip-dirs', '**/node_modules',
      '--skip-dirs', '**/data/claude-home/projects',
      '--skip-dirs', '**/data/claude-home/sessions',
      '--skip-dirs', '**/data/claude-home/file-history',
      '--skip-dirs', '**/data/claude-home/paste-cache',
      '--skip-dirs', '**/.claude/projects',
      '/scan'],
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

/**
 * TruffleHog pass — verifies whether secrets are LIVE by calling the provider.
 * Returns { verified: N, findings: [...] }. Best-effort: returns 0 on any error
 * (the Trivy secret scan already ran; this just adds the "is it live" signal).
 */
async function runTruffleHog(volume, log) {
  if (!config.TRUFFLEHOG_IMAGE) return { verified: 0, findings: [] };
  try { await docker.getImage(config.TRUFFLEHOG_IMAGE).inspect(); }
  catch {
    try {
      const s = await docker.pull(config.TRUFFLEHOG_IMAGE);
      await new Promise((res, rej) => docker.modem.followProgress(s, (e) => (e ? rej(e) : res())));
    } catch (e) { log?.warn({ err: e.message }, 'trufflehog pull failed'); return { verified: 0, findings: [] }; }
  }

  // Exclude the same noise Trivy skips (VCS internals + Claude session
  // transcripts) so the verified-secret signal reflects the instance's own code,
  // not gitignored runtime logs. TruffleHog takes a regex-per-line file; write it
  // into the manager-local DATA_DIR and mount it read-only into the scan.
  const excludeHostPath = await ensureTruffleHogExcludes();

  const binds = [`${volume}:/scan:ro`];
  const cmd = ['filesystem', '/scan', '--results=verified', '--json', '--no-update'];
  if (excludeHostPath) {
    binds.push(`${excludeHostPath}:/th-exclude.txt:ro`);
    cmd.push('--exclude-paths=/th-exclude.txt');
  }

  const container = await docker.createContainer({
    Image: config.TRUFFLEHOG_IMAGE,
    // --results=verified → only secrets confirmed live against their provider.
    // NetworkMode bridge so verification can reach the internet (read-only mount).
    Cmd: cmd,
    Tty: false,
    HostConfig: { Binds: binds, NetworkMode: 'bridge', AutoRemove: false },
  });
  await container.start();
  try {
    await Promise.race([
      container.wait(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('trufflehog timed out')), SCAN_TIMEOUT_MS)),
    ]);
  } catch (e) {
    try { await container.remove({ force: true }); } catch { /* best effort */ }
    log?.warn({ err: e.message }, 'trufflehog wait failed'); return { verified: 0, findings: [] };
  }
  let out = '';
  try { out = demuxBuffer(await container.logs({ stdout: true, stderr: false, follow: false })).stdout; }
  catch { /* ignore */ }
  try { await container.remove({ force: true }); } catch { /* best effort */ }

  // TruffleHog emits one JSON object per line (NDJSON), only verified results.
  const findings = [];
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const r = JSON.parse(t);
      if (!r.DetectorName) continue;
      const sm = r.SourceMetadata?.Data?.Filesystem?.file || '';
      findings.push({ type: 'verified-secret', severity: 'CRITICAL', verified: true,
        id: r.DetectorName, title: `Verified live ${r.DetectorName} secret`,
        target: sm.replace(/^\/scan\//, ''), line: r.SourceMetadata?.Data?.Filesystem?.line || null });
    } catch { /* skip non-result lines */ }
  }
  return { verified: findings.length, findings };
}

/** Scan a single instance; store + return its summary. */
export async function scanInstance(instance, log) {
  await ensureTrivyImage(log);
  const prev = getInstanceScan(instance.id);
  try {
    const volume = await getWorkspaceVolume(instance.dockerId);
    if (!volume) throw new Error('No /workspace volume found');
    const { counts, findings } = await runTrivy(volume);
    // Verified-live secret pass (best-effort; never fails the scan)
    const th = await runTruffleHog(volume, log);
    // Surface verified secrets first — they're the actionable ones.
    const allFindings = [...th.findings, ...findings].slice(0, MAX_FINDINGS);
    setInstanceScan(instance.id, { ...counts, verifiedSecrets: th.verified, findings: allFindings, error: null });
    const newCritical = counts.critical > (prev?.critical || 0);
    const newVerified = th.verified > (prev?.verified_secrets || 0);
    return { id: instance.id, name: instance.name, ...counts, verifiedSecrets: th.verified, newCritical, newVerified };
  } catch (err) {
    log?.warn({ err: err.message, instance: instance.id }, 'Trivy scan failed');
    setInstanceScan(instance.id, { critical: prev?.critical || 0, high: prev?.high || 0,
      medium: prev?.medium || 0, low: prev?.low || 0, secrets: prev?.secrets || 0,
      verifiedSecrets: prev?.verified_secrets || 0,
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

    const alertInstances = [];
    for (const inst of targets) {
      state.current = inst.name;
      _broadcast({ type: 'security_scan', status: getScanStatus() });
      const r = await scanInstance(inst, log);
      // Alert on new CRITICAL vulns OR new VERIFIED-LIVE secrets (both actionable)
      if (r.newCritical || r.newVerified) alertInstances.push(r);
    }

    state.lastRunAt = new Date().toISOString();
    state.current = null;

    for (const r of alertInstances) {
      _broadcast({ type: 'security_scan', alert: true,
        instanceId: r.id, name: r.name, critical: r.critical, verifiedSecrets: r.verifiedSecrets });
    }
    log?.info(`Security scan complete — ${targets.length} instances, ${alertInstances.length} alerting (new CRITICAL or verified secret)`);
    return { started: true, scanned: targets.length, alerting: alertInstances.length };
  } finally {
    state.scanning = false;
    _broadcast({ type: 'security_scan', status: getScanStatus() });
  }
}

/** Summary map for merging into GET /api/instances. */
export function getAllScanSummaries() {
  return new Map(getAllInstanceScans().map((s) => [s.instance_id, s]));
}
