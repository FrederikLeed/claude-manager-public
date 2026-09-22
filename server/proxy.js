/**
 * Proxy ACL manager — generates per-container squid ACL files.
 *
 * Each container gets an ACL file at /proxy-acl/<instance-id>.acl with:
 *   acl src_<id> src <container-ip>
 *   acl hosts_<id> dstdomain <host1> <host2> ...
 *   http_access allow src_<id> hosts_<id>
 *
 * For unrestricted containers:
 *   acl src_<id> src <container-ip>
 *   http_access allow src_<id>
 *
 * The proxy container watches this directory with inotifywait and runs
 * `squid -k reconfigure` on any change.
 */

import { writeFileSync, unlinkSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import Docker from 'dockerode';
import { config } from './config.js';
import { listPolicies } from './docker.js';
import { moduleLogger } from './logger.js';
import { isValidAclHost } from '../shared/constants.js';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const log = moduleLogger('proxy');
const ACL_DIR = config.PROXY_ACL_DIR || '/proxy-acl';

/**
 * Get the container's IP address on the manager network.
 */
async function getContainerIP(instanceId) {
  const { LABELS } = await import('../shared/constants.js');
  const containers = await docker.listContainers({
    all: false,
    filters: { label: [`${LABELS.MANAGED}=true`, `${LABELS.ID}=${instanceId}`] },
  });
  if (containers.length === 0) return null;

  const container = docker.getContainer(containers[0].Id);
  const inspect = await container.inspect();
  const networks = inspect.NetworkSettings?.Networks || {};
  const net = networks[config.CLAUDE_NETWORK];
  return net?.IPAddress || null;
}

/**
 * Get allowed hosts for a policy by name.
 */
function getPolicyHosts(policyName) {
  if (!policyName || policyName === 'unrestricted') return null; // null = allow all
  const policies = listPolicies();
  const policy = policies.find(p => p.id === policyName);
  if (!policy) return null;
  if (policy.unrestricted) return null;
  return policy.allowedHosts || [];
}

/**
 * Turn policy/approved hosts into squid dstdomain values. Pure — exported for tests.
 *  - "example.com"                   → exact host only
 *  - ".example.com" / "*.example.com" → example.com and all subdomains
 * Hosts were all written as ".host" before, so an allowlisted host silently
 * allowed every subdomain (e.g. attacker-controlled *.sentry.io projects).
 * Invalid values are dropped (they'd be written verbatim into squid config).
 * Entries covered by a wildcard are removed: squid 6 rejects "x" next to ".x".
 */
export function buildDstdomains(hosts, onInvalid = () => {}) {
  const bad = [];
  const norm = [];
  for (const raw of hosts || []) {
    if (!isValidAclHost(raw)) { bad.push(raw); continue; }
    const h = String(raw).toLowerCase().replace(/^\*\./, '.');
    if (!norm.includes(h)) norm.push(h);
  }
  if (bad.length) onInvalid(bad);
  const wild = norm.filter((h) => h.startsWith('.')).map((h) => h.slice(1));
  const coveredBy = (name, self) => wild.some((w) => w !== self && (name === w || name.endsWith(`.${w}`)));
  return norm.filter((h) => (h.startsWith('.') ? !coveredBy(h.slice(1), h.slice(1)) : !coveredBy(h, null)));
}

/**
 * Write an ACL file for a container.
 * Returns true if written successfully.
 */
export async function writeContainerACL(instanceId, { networkPolicy, extraHosts = [], ip: ipOverride = null }) {
  // ipOverride lets callers (e.g. the ephemeral connectivity smoke-test container,
  // which deliberately lacks managed labels) supply the IP directly instead of
  // resolving it from container labels.
  const ip = ipOverride || await getContainerIP(instanceId);
  if (!ip) {
    log.warn({ instanceId, networkPolicy }, 'cannot write ACL: no IP found (container may not be running)');
    return false;
  }

  const safeId = instanceId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const baseHosts = getPolicyHosts(networkPolicy);
  const isUnrestricted = baseHosts === null;

  let acl = `# ACL for instance ${instanceId} (policy: ${networkPolicy || 'unrestricted'})\n`;
  acl += `acl src_${safeId} src ${ip}/32\n`;

  if (isUnrestricted) {
    acl += `http_access allow src_${safeId}\n`;
  } else {
    const deduped = buildDstdomains([...baseHosts, ...extraHosts], (bad) =>
      log.warn({ instanceId, bad }, 'dropped invalid host from ACL'));
    if (deduped.length > 0) {
      acl += `acl hosts_${safeId} dstdomain ${deduped.join(' ')}\n`;
      acl += `http_access allow src_${safeId} hosts_${safeId}\n`;
    }
    // Deny is handled by the default rule in squid.conf
  }

  const aclPath = path.join(ACL_DIR, `${safeId}.acl`);
  writeFileSync(aclPath, acl);
  log.info({ instanceId, ip, networkPolicy: networkPolicy || 'unrestricted', hosts: isUnrestricted ? 'all' : (baseHosts?.length || 0) + extraHosts.length }, 'wrote ACL');
  return true;
}

/**
 * Add extra hosts to an existing container's ACL (for approved access requests).
 * Reads the current ACL, merges new hosts, rewrites.
 */
export async function addHostsToACL(instanceId, newHosts) {
  // Rebuild from the source of truth (policy label + approved requests) rather
  // than parsing the ACL file back, which lost the exact/wildcard distinction.
  const { LABELS } = await import('../shared/constants.js');
  const containers = await docker.listContainers({
    filters: { label: [`${LABELS.MANAGED}=true`, `${LABELS.ID}=${instanceId}`] },
  });
  const networkPolicy = containers[0]?.Labels?.[LABELS.NETWORK_POLICY] || 'unrestricted';
  const extras = await approvedExtraHosts();
  return writeContainerACL(instanceId, {
    networkPolicy,
    extraHosts: [...new Set([...(extras[instanceId] || []), ...newHosts])],
  });
}

async function approvedExtraHosts() {
  const approved = {};
  try {
    const { getDb } = await import('./db.js');
    const rows = getDb().prepare("SELECT instance_id, requested_hosts FROM access_requests WHERE status = 'approved' AND requested_hosts IS NOT NULL").all();
    for (const row of rows) {
      (approved[row.instance_id] ||= []).push(...JSON.parse(row.requested_hosts));
    }
  } catch (err) { log.warn({ err: err.message }, 'could not load approved extras from DB'); }
  return approved;
}

/**
 * Remove a container's ACL file (on container removal).
 */
export function removeContainerACL(instanceId) {
  const safeId = instanceId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const aclPath = path.join(ACL_DIR, `${safeId}.acl`);
  try {
    unlinkSync(aclPath);
    log.info({ instanceId }, 'removed ACL');
  } catch {
    // File may not exist
  }
}

/**
 * Sync ACLs for all running managed containers.
 * Called on manager startup to ensure proxy state matches reality.
 */
export async function syncAllACLs() {
  const { LABELS } = await import('../shared/constants.js');
  try {
    const approvedExtras = await approvedExtraHosts();

    const containers = await docker.listContainers({
      filters: { label: [`${LABELS.MANAGED}=true`] },
    });

    const activeIds = new Set();
    for (const c of containers) {
      const id = c.Labels?.[LABELS.ID];
      const policy = c.Labels?.[LABELS.NETWORK_POLICY] || 'unrestricted';
      if (id) {
        activeIds.add(id.replace(/[^a-zA-Z0-9_-]/g, '_'));
        const extraHosts = [...new Set(approvedExtras[id] || [])];
        await writeContainerACL(id, { networkPolicy: policy, extraHosts });
      }
    }

    // Clean up stale ACL files
    try {
      const files = readdirSync(ACL_DIR).filter(f => f.endsWith('.acl'));
      for (const f of files) {
        const id = f.replace('.acl', '');
        if (id !== 'default' && !activeIds.has(id)) {
          unlinkSync(path.join(ACL_DIR, f));
          log.info({ file: f }, 'removed stale ACL');
        }
      }
    } catch { /* dir may not exist yet */ }

    log.info({ count: activeIds.size }, 'synced ACLs for running containers');
  } catch (err) {
    log.error({ err }, 'failed to sync ACLs');
  }
}
