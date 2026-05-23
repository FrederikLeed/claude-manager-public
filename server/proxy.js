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

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
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
 * Write an ACL file for a container.
 * Returns true if written successfully.
 */
export async function writeContainerACL(instanceId, { networkPolicy, extraHosts = [] }) {
  const ip = await getContainerIP(instanceId);
  if (!ip) {
    console.log(`[proxy] Cannot write ACL for ${instanceId}: no IP found (container may not be running)`);
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
    const allHosts = [...new Set([...baseHosts, ...extraHosts])];
    // Deduplicate subdomains: if dr.dk is in the list, remove www.dr.dk (since .dr.dk covers it)
    const deduped = allHosts.filter(h => {
      const parts = h.split('.');
      for (let i = 1; i < parts.length - 1; i++) {
        const parent = parts.slice(i).join('.');
        if (allHosts.includes(parent)) return false; // parent domain already covers this
      }
      return true;
    });
    if (deduped.length > 0) {
      // Use .domain to match domain + all subdomains (squid 6 doesn't allow both .x and x)
      acl += `acl hosts_${safeId} dstdomain ${deduped.map(h => `.${h}`).join(' ')}\n`;
      acl += `http_access allow src_${safeId} hosts_${safeId}\n`;
    }
    // Deny is handled by the default rule in squid.conf
  }

  const aclPath = path.join(ACL_DIR, `${safeId}.acl`);
  writeFileSync(aclPath, acl);
  console.log(`[proxy] Wrote ACL for ${instanceId} (${ip}): ${isUnrestricted ? 'unrestricted' : `${(baseHosts?.length || 0) + extraHosts.length} hosts`}`);
  return true;
}

/**
 * Add extra hosts to an existing container's ACL (for approved access requests).
 * Reads the current ACL, merges new hosts, rewrites.
 */
export async function addHostsToACL(instanceId, newHosts) {
  const safeId = instanceId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const aclPath = path.join(ACL_DIR, `${safeId}.acl`);

  let existingHosts = [];
  let networkPolicy = 'unrestricted';
  try {
    const content = readFileSync(aclPath, 'utf8');
    // Extract policy from comment
    const policyMatch = content.match(/policy: ([^\s)]+)/);
    if (policyMatch) networkPolicy = policyMatch[1];

    // Extract existing dstdomain hosts (strip leading . from .domain format)
    const hostMatch = content.match(/dstdomain\s+(.+)/);
    if (hostMatch) {
      existingHosts = hostMatch[1].split(/\s+/).map(h => h.replace(/^\./, '')).filter(Boolean);
    }
  } catch {
    // No existing ACL — will create fresh
  }

  const allExtra = [...new Set([...existingHosts, ...newHosts])];
  // Get base policy hosts to filter them out of "extra"
  const baseHosts = getPolicyHosts(networkPolicy) || [];
  const extraOnly = allExtra.filter(h => !baseHosts.includes(h));

  return writeContainerACL(instanceId, { networkPolicy, extraHosts: [...new Set([...extraOnly, ...newHosts])] });
}

/**
 * Remove a container's ACL file (on container removal).
 */
export function removeContainerACL(instanceId) {
  const safeId = instanceId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const aclPath = path.join(ACL_DIR, `${safeId}.acl`);
  try {
    unlinkSync(aclPath);
    console.log(`[proxy] Removed ACL for ${instanceId}`);
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
    // Load approved extra hosts from DB
    const { getDb } = await import('./db.js');
    const approvedExtras = {};
    try {
      const db = getDb();
      const rows = db.prepare("SELECT instance_id, requested_hosts FROM access_requests WHERE status = 'approved' AND requested_hosts IS NOT NULL").all();
      for (const row of rows) {
        const hosts = JSON.parse(row.requested_hosts);
        if (!approvedExtras[row.instance_id]) approvedExtras[row.instance_id] = [];
        approvedExtras[row.instance_id].push(...hosts);
      }
    } catch (err) { console.log(`[proxy] Could not load approved extras from DB: ${err.message}`); }

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
          console.log(`[proxy] Cleaned stale ACL: ${f}`);
        }
      }
    } catch { /* dir may not exist yet */ }

    console.log(`[proxy] Synced ACLs for ${activeIds.size} running containers`);
  } catch (err) {
    console.error(`[proxy] Failed to sync ACLs: ${err.message}`);
  }
}
