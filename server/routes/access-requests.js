import {
  createAccessRequest,
  getPendingAccessRequests,
  getAccessRequestById,
  getAccessRequestsForInstance,
  resolveAccessRequest,
  logActivity,
  getInstance,
} from '../db.js';
import { recreateInstance, getContainer } from '../docker.js';
import { createGrantsForInstance } from '../grants.js';
import { writeContainerACL, addHostsToACL } from '../proxy.js';
import { NETWORK_POLICIES, isValidAclHost } from '../../shared/constants.js';
import { broadcast } from './instances.js';

async function currentPolicy(id) {
  try {
    return (await getContainer(id)).networkPolicy || 'unrestricted';
  } catch {
    return null; // unknown instance / Docker unavailable
  }
}

export default async function accessRequestRoutes(fastify) {
  // --- Called from INSIDE containers (no device auth) ---

  // Submit an access request
  fastify.post('/api/instances/:id/request-access', async (request, reply) => {
    const { id } = request.params;
    const { policy, hosts, reason } = request.body || {};

    if (!policy && (!hosts || hosts.length === 0)) {
      return reply.code(400).send({ error: 'Must specify policy or hosts' });
    }

    if (policy && !NETWORK_POLICIES.includes(policy)) {
      return reply.code(400).send({ error: `Invalid policy. Must be one of: ${NETWORK_POLICIES.join(', ')}` });
    }

    if (hosts !== undefined && hosts !== null) {
      const bad = !Array.isArray(hosts) || hosts.length > 50 ? ['(hosts must be an array of at most 50 hostnames)']
        : hosts.filter((h) => !isValidAclHost(h));
      if (bad.length) {
        request.log.warn({ instanceId: id, bad }, 'access request rejected: invalid hostnames');
        return reply.code(400).send({ error: `Invalid hostname(s): ${bad.map((h) => JSON.stringify(h)).join(', ')}. Use plain hostnames like "example.com" or ".example.com" for subdomains.` });
      }
    }

    // An unrestricted instance isn't behind the proxy, so approving would change
    // nothing. Agents did this when a site itself returned 403 (bot protection),
    // then waited up to 10 minutes for an approval that couldn't help.
    const current = await currentPolicy(id);
    if (current === 'unrestricted') {
      request.log.warn({ instanceId: id, hosts, policy, reason }, 'access request from unrestricted instance rejected: not a policy block');
      return reply.code(409).send({
        error: 'This instance is unrestricted — Claude Manager is not blocking any host. '
          + 'A 403/connection error here comes from the remote site or the network itself, not from a policy. '
          + 'Do not wait for approval; investigate the failure directly.',
        policy: current,
      });
    }

    const result = createAccessRequest({
      instanceId: id,
      requestedPolicy: policy || null,
      requestedHosts: hosts || null,
      reason: reason || null,
    });

    const dbInst = getInstance(id);
    request.log.info({ instanceId: id, instance: dbInst?.name, currentPolicy: current, requestedPolicy: policy, hosts, reason }, 'access requested');
    logActivity('access_requested', id, dbInst?.name, `Requested: ${policy || hosts?.join(', ')}${reason ? ` — ${reason}` : ''}`);

    // Broadcast to connected admin clients
    broadcastAccessRequest(fastify, {
      type: 'access_requested',
      request: result,
      instanceName: dbInst?.name || id,
    });

    return { id: result.id, status: 'pending' };
  });

  // Poll request status (called from inside containers)
  fastify.get('/api/instances/:id/request-access', async (request) => {
    const { id } = request.params;
    const requests = getAccessRequestsForInstance(id);
    return requests;
  });

  // Get effective access for an instance (policy + approved custom hosts)
  fastify.get('/api/instances/:id/access', async (request) => {
    const { id } = request.params;
    const requests = getAccessRequestsForInstance(id);
    const approvedHosts = requests
      .filter(r => r.status === 'approved' && r.requested_hosts)
      .flatMap(r => r.requested_hosts);
    const approvedPolicies = requests
      .filter(r => r.status === 'approved' && r.requested_policy)
      .map(r => r.requested_policy);
    const policy = await currentPolicy(id);
    return { policy, unrestricted: policy === 'unrestricted', approvedHosts, approvedPolicies, requests };
  });

  // --- Admin endpoints (device auth required via global hook) ---

  // List all pending requests
  fastify.get('/api/access-requests', async () => {
    return getPendingAccessRequests();
  });

  // Approve a request
  fastify.post('/api/access-requests/:requestId/approve', async (request, reply) => {
    const { requestId } = request.params;
    const { expiryHours } = request.body || {};
    const req = getAccessRequestById(parseInt(requestId));
    if (!req) {
      return reply.code(404).send({ error: 'Request not found' });
    }
    if (req.status !== 'pending') {
      return reply.code(409).send({ error: `Request already ${req.status}` });
    }

    const deviceName = request.device?.name || 'admin';
    resolveAccessRequest(req.id, 'approved', deviceName);

    // Apply the requested change
    if (req.requested_policy) {
      // Policy change → recreate container with new proxy env + update ACL
      try {
        await recreateInstance(req.instance_id, { networkPolicy: req.requested_policy });
        await writeContainerACL(req.instance_id, { networkPolicy: req.requested_policy });
        createGrantsForInstance(req.instance_id, {
          networkPolicy: req.requested_policy,
          expiryHours: expiryHours || 24,
        });
      } catch (err) {
        fastify.log.error({ err: err.message }, 'Failed to recreate instance for approved access request');
        return reply.code(500).send({ error: `Approved but recreate failed: ${err.message}` });
      }
    }

    if (req.requested_hosts && req.requested_hosts.length > 0) {
      // Custom hosts → update proxy ACL (no container recreation needed)
      try {
        const hosts = req.requested_hosts;
        await addHostsToACL(req.instance_id, hosts);
        fastify.log.info({ hosts }, 'Updated proxy ACL with additional hosts');
      } catch (err) {
        fastify.log.error({ err: err.message }, 'Failed to update proxy ACL');
        return reply.code(500).send({ error: `Approved but proxy update failed: ${err.message}` });
      }
    }

    const dbInst = getInstance(req.instance_id);
    logActivity('access_approved', req.instance_id, dbInst?.name,
      `Approved: ${req.requested_policy || req.requested_hosts?.join(', ')} by ${deviceName}`);

    broadcastAccessRequest(fastify, {
      type: 'access_resolved',
      requestId: req.id,
      instanceId: req.instance_id,
      status: 'approved',
    });

    return { ok: true, status: 'approved' };
  });

  // Deny a request
  fastify.post('/api/access-requests/:requestId/deny', async (request, reply) => {
    const { requestId } = request.params;
    const req = getAccessRequestById(parseInt(requestId));
    if (!req) {
      return reply.code(404).send({ error: 'Request not found' });
    }
    if (req.status !== 'pending') {
      return reply.code(409).send({ error: `Request already ${req.status}` });
    }

    const deviceName = request.device?.name || 'admin';
    resolveAccessRequest(req.id, 'denied', deviceName);

    const dbInst = getInstance(req.instance_id);
    logActivity('access_denied', req.instance_id, dbInst?.name,
      `Denied: ${req.requested_policy || req.requested_hosts?.join(', ')} by ${deviceName}`);

    broadcastAccessRequest(fastify, {
      type: 'access_resolved',
      requestId: req.id,
      instanceId: req.instance_id,
      status: 'denied',
    });

    return { ok: true, status: 'denied' };
  });
}

function broadcastAccessRequest(_fastify, data) {
  broadcast(data);
}
