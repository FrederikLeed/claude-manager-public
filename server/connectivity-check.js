// Connectivity guard for restricted network policies.
//
// Two layers, both aimed at one failure mode: a restricted policy's squid
// allowlist going stale so Claude Code can't reach Anthropic (squid 403 ->
// "Failed to connect ... ERR_BAD_REQUEST"), which is otherwise only noticed
// when a human sees it in a terminal.
//
//  1. lintPolicies()  — static: every restricted claude-* policy must allowlist
//     REQUIRED_CLAUDE_HOSTS. Cheap, runs at startup + in the test suite; catches
//     bad policy edits / dropped hosts.
//  2. runSmokeTest()  — live: spin a throwaway instance on a restricted policy,
//     run the REAL `claude` binary through squid, and confirm it reaches
//     Anthropic instead of erroring. Triggered right after a workspace-image
//     rebuild (the moment Claude Code — and thus its endpoints — can change), so
//     endpoint drift is caught at the upgrade, not by a user. Because it runs the
//     real CLI, it catches drift even to endpoints not in REQUIRED_CLAUDE_HOSTS.
import Docker from 'dockerode';
import { config } from './config.js';
import { listPolicies, resolveHostPath } from './docker.js';
import { writeContainerACL, removeContainerACL } from './proxy.js';
import { getMeta, setMeta } from './db.js';
import { REQUIRED_CLAUDE_HOSTS } from '../shared/constants.js';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const META_KEY = 'connectivity_check';
// How long to let `claude` run before killing it — the startup connectivity
// preflight (and any failure) prints within the first few seconds.
const CLAUDE_RUN_SECONDS = 12;
const SMOKE_READ_TIMEOUT_MS = 40_000;
// Claude Code's connectivity-failure signatures (stable user-facing strings).
// IMPORTANT: this is the INTERACTIVE startup preflight's wording. `claude -p`
// (headless) does NOT hit platform.claude.com and tolerates it being blocked,
// so the smoke test must run interactive `claude`, not `-p`.
const CONNECT_FAIL_RE = /Failed to connect to|ERR_BAD_REQUEST|Unable to connect to Anthropic|check your internet connection/i;
// Startup screen markers (cursor-movement codes are stripped, so spaces may vanish)
export const STARTED_RE = /Welcome\s*to\s*Claude|Claude\s*Code\s*v\d|bypass\s*permissions/i;
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');

const state = { running: false, last: null };
let _broadcast = () => {};
export function setConnectivityBroadcaster(fn) { _broadcast = fn || (() => {}); }

function loadLast() {
  if (state.last) return state.last;
  try { state.last = JSON.parse(getMeta(META_KEY) || 'null'); } catch { state.last = null; }
  return state.last;
}

export function getConnectivityStatus() {
  return { running: state.running, last: loadLast() };
}

/** True if `host` is allowlisted directly or covered by a parent domain. */
function isCovered(host, allowed) {
  return allowed.some((a) => host === a || host.endsWith(`.${a}`));
}

/**
 * Static lint: every restricted policy that targets Claude (i.e. already
 * allowlists api.anthropic.com) must allowlist all REQUIRED_CLAUDE_HOSTS.
 * Returns { ok, violations: [{ policy, missing: [...] }] }.
 */
export function lintPolicies() {
  const violations = [];
  for (const p of listPolicies()) {
    if (p.unrestricted) continue;
    const allowed = p.allowedHosts || [];
    // Only lint policies that are meant to reach Claude at all.
    if (!isCovered('api.anthropic.com', allowed)) continue;
    const missing = REQUIRED_CLAUDE_HOSTS.filter((h) => !isCovered(h, allowed));
    if (missing.length) violations.push({ policy: p.id, missing });
  }
  return { ok: violations.length === 0, violations };
}

/** Collect a (possibly TTY-raw) exec stream into a string, bounded by timeout. */
function collectStream(stream, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    const done = (reason) => { clearTimeout(t); try { stream.destroy(); } catch { /* */ } resolve({ out, reason }); };
    const t = setTimeout(() => done('timeout'), timeoutMs);
    stream.on('data', (d) => { out += d.toString('utf8'); if (out.length > 64_000) done('overflow'); });
    stream.on('end', () => done('end'));
    stream.on('error', () => done('error'));
  });
}

/** Hosts squid denied for `ip` since `sinceSec` (from the proxy's stdout access log). */
export async function deniedHostsFor(ip, sinceSec) {
  try {
    const { parseSquidLine } = await import('./proxy-log.js');
    const buf = await docker.getContainer(config.PROXY_CONTAINER).logs({ stdout: true, stderr: false, since: sinceSec, follow: false });
    const text = demuxToString(buf);
    const hosts = new Set();
    for (const line of text.split('\n')) {
      const e = parseSquidLine(line);
      if (e && e.denied && e.ip === ip) hosts.add(e.host);
    }
    return [...hosts];
  } catch {
    return [];
  }
}

// Docker multiplexed log buffer (8-byte frame headers) → text
function demuxToString(buf) {
  if (!Buffer.isBuffer(buf)) return String(buf || '');
  const parts = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4);
    parts.push(buf.subarray(i + 8, i + 8 + len).toString('utf8'));
    i += 8 + len;
  }
  return i === 0 ? buf.toString('utf8') : parts.join('');
}

/**
 * Live smoke test against a restricted policy. Creates an ephemeral
 * claude-workspace container (NOT a managed instance — custom label, so it never
 * shows in the UI or gets scanned), writes the restricted policy's squid ACL for
 * its IP, runs `claude` through the proxy, and classifies reachable vs blocked.
 */
export async function runSmokeTest(log, { policy = config.CONNECTIVITY_CHECK_POLICY, reason = 'manual' } = {}) {
  if (state.running) return { started: false, reason: 'already running' };
  state.running = true;
  _broadcast({ type: 'connectivity_check', status: getConnectivityStatus() });

  const id = `conncheck-${Date.now().toString(36)}`;
  const name = `cm-${id}`;
  const proxyUrl = config.PROXY_URL || 'http://cm-proxy:3128';
  let container = null;
  try {
    // Mount the shared Claude auth (data/claude-home) so the throwaway is
    // authenticated like a real instance — the startup connectivity preflight
    // to platform.claude.com only runs once past the login gate.
    const authBind = config.INSTANCE_CLAUDE_DIR || await resolveHostPath('/claude-home');
    const binds = authBind ? [`${authBind}:/home/claude/.claude`] : [];
    if (!authBind) log?.warn('connectivity check: could not resolve claude-home bind — running unauthenticated (may not reach the preflight)');

    container = await docker.createContainer({
      name,
      Image: config.CLAUDE_IMAGE,
      Labels: { 'claude-manager.ephemeral': 'conncheck' },
      // Override the firewall entrypoint — we only need the proxy path, not the
      // in-container iptables lock (which would need NET_ADMIN). squid still
      // enforces the allowlist by source IP via the ACL we write below.
      Entrypoint: ['sleep'],
      Cmd: ['120'],
      HostConfig: { NetworkMode: config.CLAUDE_NETWORK, AutoRemove: false, Binds: binds },
    });
    await container.start();

    const ip = (await container.inspect()).NetworkSettings?.Networks?.[config.CLAUDE_NETWORK]?.IPAddress;
    if (!ip) throw new Error('smoke container has no IP');

    // Write the restricted policy's real allowlist for this container's IP, then
    // give cm-proxy's inotify watcher a moment to `squid -k reconfigure`.
    await writeContainerACL(id, { networkPolicy: policy, ip });
    await new Promise((r) => setTimeout(r, 3500));

    // Run the REAL interactive `claude` through squid (NOT `-p` — headless mode
    // skips the platform.claude.com preflight and would pass even when it's
    // blocked). Tty gives claude a PTY so it runs its startup connectivity
    // check; an inner timeout makes it exit so the stream ends. NODE_OPTIONS
    // replicates the image's .bashrc proxy bootstrap — Claude Code's Node uses
    // undici, which ignores HTTPS_PROXY unless globalAgent is patched; without
    // it claude would bypass squid entirely (false pass).
    // `script` gives claude a real pty inside the container and records its
    // screen to a file we read back afterwards. The earlier hijacked-TTY stream
    // came back empty through Docker Desktop's socket proxy, and an empty
    // capture was classified as a pass (a false pass, found 2026-09-16).
    const claudeCmd = `claude --dangerously-skip-permissions --settings '{"remoteControlAtStartup":false}'`;
    const exec = await container.exec({
      Cmd: ['bash', '-c',
        `cd /workspace; timeout -s KILL ${CLAUDE_RUN_SECONDS} script -qfc "${claudeCmd.replace(/"/g, '\\"')}" /tmp/cc.out >/dev/null 2>&1 </dev/null; cat /tmp/cc.out 2>/dev/null`],
      Env: [
        `HTTP_PROXY=${proxyUrl}`, `HTTPS_PROXY=${proxyUrl}`,
        'NO_PROXY=localhost,127.0.0.1,claude-manager,cm-proxy,cm-litellm,cm-knowledge,.claude-manager-net',
        'NODE_PATH=/usr/lib/node_modules',
        'NODE_OPTIONS=-r /home/claude/.proxy-bootstrap.js',
      ],
      AttachStdout: true, AttachStderr: true, Tty: false,
    });
    const runStartedAt = Math.floor(Date.now() / 1000) - 1;
    const stream = await exec.start({ Tty: false });
    const { PassThrough } = await import('stream');
    const stdout = new PassThrough();
    docker.modem.demuxStream(stream, stdout, new PassThrough());
    stream.on('end', () => stdout.end());
    const { out: raw } = await collectStream(stdout, SMOKE_READ_TIMEOUT_MS);
    const out = stripAnsi(raw);

    // Ask squid what it denied for this container: current Claude Code no longer
    // prints "Failed to connect" when platform.claude.com is blocked, so the
    // screen text alone missed a real block (negative control, 2026-09-16).
    await new Promise((r) => setTimeout(r, 2000)); // tail -F flush
    const denied = await deniedHostsFor(ip, runStartedAt);
    const deniedRequired = REQUIRED_CLAUDE_HOSTS.filter((h) => denied.includes(h));
    const blocked = deniedRequired.length > 0 || CONNECT_FAIL_RE.test(out);
    // Positive evidence required: no startup screen means claude never ran
    // (or its output wasn't captured) — that is not a pass.
    const started = STARTED_RE.test(out);
    // Pull the failing host out of "Failed to connect to <host>:" if present.
    const hostMatch = out.match(/Failed to connect to ([^\s:]+)/i);
    const result = {
      ok: started && !blocked,
      inconclusive: !started && !blocked,
      policy,
      reason,
      blockedHost: blocked ? (deniedRequired[0] || hostMatch?.[1] || null) : null,
      deniedHosts: denied,
      requiredHosts: REQUIRED_CLAUDE_HOSTS,
      output: out.trim().slice(-600),
      checkedAt: new Date().toISOString(),
    };
    state.last = result;
    setMeta(META_KEY, JSON.stringify(result));

    if (blocked) {
      log?.error({ policy, blockedHost: result.blockedHost }, 'Connectivity smoke test FAILED — Claude Code cannot reach Anthropic');
      _broadcast({ type: 'connectivity_check', alert: true, ...result });
    } else if (!started) {
      log?.error({ policy, bytes: raw.length }, 'Connectivity smoke test INCONCLUSIVE — claude showed no startup screen');
      _broadcast({ type: 'connectivity_check', alert: true, ...result });
    } else {
      log?.info({ policy }, 'Connectivity smoke test passed');
    }
    return { started: true, ...result };
  } catch (err) {
    log?.warn({ err: err.message }, 'Connectivity smoke test errored');
    const result = { ok: null, policy, reason, error: err.message.slice(0, 200), checkedAt: new Date().toISOString() };
    state.last = result;
    setMeta(META_KEY, JSON.stringify(result));
    return { started: true, ...result };
  } finally {
    if (container) { try { await container.remove({ force: true }); } catch { /* best effort */ } }
    removeContainerACL(id);
    state.running = false;
    _broadcast({ type: 'connectivity_check', status: getConnectivityStatus() });
  }
}
