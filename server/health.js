/**
 * Health monitor — periodic self-diagnosis so breakage shows up in the logs
 * instead of being discovered weeks later (cm-proxy sat crashed for 4 weeks,
 * unnoticed, in Aug–Sep 2026).
 *
 * Checks:
 *  - sidecars (squid proxy, LiteLLM) are running
 *  - every running RESTRICTED instance has a squid ACL whose IP matches the
 *    container's current IP (Docker can reassign IPs on restart → the policy
 *    silently over-blocks or leaks) and has HTTPS_PROXY set
 *
 * Findings are logged on change only (new problem → warn, resolved → info),
 * so a persistent problem doesn't flood the log. GET /api/system/health
 * returns the latest report.
 */
import { readFileSync } from 'fs';
import path from 'path';
import Docker from 'dockerode';
import { config } from './config.js';
import { LABELS } from '../shared/constants.js';
import { moduleLogger } from './logger.js';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const log = moduleLogger('health');

let timer = null;
let lastReport = { checkedAt: null, ok: true, problems: [] };
let activeKeys = new Map(); // key -> problem, for change-only logging

async function checkContainerRunning(name, why) {
  try {
    const info = await docker.getContainer(name).inspect();
    if (info.State?.Running) return null;
    return {
      key: `sidecar:${name}`,
      severity: 'error',
      message: `${name} is not running (${info.State?.Status}, exit ${info.State?.ExitCode}, since ${info.State?.FinishedAt}) — ${why}`,
    };
  } catch (err) {
    if (err.statusCode === 404) {
      return { key: `sidecar:${name}`, severity: 'error', message: `${name} container does not exist — ${why}` };
    }
    return { key: `sidecar:${name}`, severity: 'warn', message: `could not inspect ${name}: ${err.message}` };
  }
}

function readAclIp(instanceId) {
  const safeId = instanceId.replace(/[^a-zA-Z0-9_-]/g, '_');
  try {
    const content = readFileSync(path.join(config.PROXY_ACL_DIR, `${safeId}.acl`), 'utf8');
    return content.match(/\bsrc\s+([\d.]+)/)?.[1] || '';
  } catch {
    return null; // no ACL file
  }
}

async function checkRestrictedInstances() {
  const problems = [];
  const containers = await docker.listContainers({ filters: { label: [`${LABELS.MANAGED}=true`] } });
  for (const c of containers) {
    const policy = c.Labels?.[LABELS.NETWORK_POLICY] || 'unrestricted';
    if (policy === 'unrestricted') continue;
    const id = c.Labels?.[LABELS.ID];
    const name = c.Labels?.[LABELS.NAME] || c.Names?.[0];
    if (!id) continue;
    const ip = c.NetworkSettings?.Networks?.[config.CLAUDE_NETWORK]?.IPAddress;
    const aclIp = readAclIp(id);
    if (aclIp === null) {
      problems.push({ key: `acl-missing:${id}`, severity: 'error', instanceId: id,
        message: `restricted instance "${name}" (${policy}) has no squid ACL — all its egress will be denied` });
    } else if (ip && aclIp !== ip) {
      problems.push({ key: `acl-ip:${id}`, severity: 'error', instanceId: id,
        message: `restricted instance "${name}" ACL is for ${aclIp} but the container now has ${ip} — policy is not applied to it` });
    }
    try {
      const env = (await docker.getContainer(c.Id).inspect()).Config?.Env || [];
      if (!env.some((e) => e.startsWith('HTTPS_PROXY='))) {
        problems.push({ key: `no-proxy-env:${id}`, severity: 'warn', instanceId: id,
          message: `restricted instance "${name}" (${policy}) has no HTTPS_PROXY — recreate it to apply the policy` });
      }
    } catch { /* container vanished mid-check */ }
  }
  return { problems, restrictedCount: containers.filter((c) => (c.Labels?.[LABELS.NETWORK_POLICY] || 'unrestricted') !== 'unrestricted').length };
}

export async function runHealthCheck() {
  const problems = [];
  let restrictedCount = 0;
  try {
    const r = await checkRestrictedInstances();
    problems.push(...r.problems);
    restrictedCount = r.restrictedCount;
  } catch (err) {
    problems.push({ key: 'docker', severity: 'error', message: `Docker API unavailable: ${err.message}` });
  }

  // The proxy only matters when something depends on it, but a dead proxy is
  // still worth surfacing: every new restricted instance would be offline.
  const proxy = await checkContainerRunning(config.PROXY_CONTAINER,
    restrictedCount > 0 ? `${restrictedCount} restricted instance(s) have NO network` : 'new restricted instances will have no network');
  if (proxy) {
    if (restrictedCount === 0) proxy.severity = 'warn';
    problems.push(proxy);
  }
  if (config.LITELLM_API_BASE) {
    const litellm = await checkContainerRunning(config.LITELLM_CONTAINER, 'instances on non-Claude-Max LLM backends cannot reach a model');
    if (litellm) { litellm.severity = 'warn'; problems.push(litellm); }
  }

  // Change-only logging
  const next = new Map(problems.map((p) => [p.key, p]));
  for (const [key, p] of next) {
    const prev = activeKeys.get(key);
    if (!prev || prev.message !== p.message) log[p.severity === 'error' ? 'error' : 'warn']({ check: key, instanceId: p.instanceId }, p.message);
  }
  for (const [key, p] of activeKeys) {
    if (!next.has(key)) log.info({ check: key, instanceId: p.instanceId }, `resolved: ${p.message}`);
  }
  activeKeys = next;

  lastReport = { checkedAt: new Date().toISOString(), ok: problems.length === 0, problems };
  return lastReport;
}

export function getHealthReport() {
  return lastReport;
}

export function startHealthMonitor() {
  if (config.HEALTH_CHECK_INTERVAL_SECONDS <= 0) return;
  const tick = () => runHealthCheck().catch((err) => log.error({ err }, 'health check crashed'));
  // Small delay so startup ACL sync finishes first
  setTimeout(tick, 15_000).unref?.();
  timer = setInterval(tick, config.HEALTH_CHECK_INTERVAL_SECONDS * 1000);
  timer.unref?.();
  log.info(`health monitor every ${config.HEALTH_CHECK_INTERVAL_SECONDS}s`);
}

export function stopHealthMonitor() {
  if (timer) clearInterval(timer);
  timer = null;
}
