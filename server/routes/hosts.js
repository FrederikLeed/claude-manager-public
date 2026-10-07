/**
 * Managed hosts: register, probe, bootstrap.
 *
 * Registering a host does not give it work — `acceptsInstances: false` lets the
 * manager know about a machine (to watch it, or because it is production) while
 * never scheduling an instance onto it.
 */
import {
  getHosts, getHost, upsertHost, deleteHost, getInstancesByHost, DEFAULT_HOST_ID,
} from '../db.js';
import { dockerFor, invalidateHost, pingHost, FLEET_VAULT_PREFIX, isFleetKeyRef } from '../hosts.js';
import { runOnHost } from '../host-fs.js';
import { stopHostEventStream, restartHostEventStream } from './instances.js';
import { logActivity } from '../db.js';

const HOST_ID = /^[a-z0-9][a-z0-9-]{0,30}$/;

/** Everything the UI needs, without ever returning key material. */
function publicHost(host, counts = {}) {
  return {
    id: host.id,
    name: host.name,
    kind: host.kind,
    address: host.address,
    sshUser: host.ssh_user,
    sshPort: host.ssh_port,
    hasKey: !!host.ssh_key_ref,      // the reference itself is a map to the key; it stays server-side
    dataRoot: host.data_root,
    managerUrl: host.manager_url,
    network: host.network,
    proxyContainer: host.proxy_container,
    enabled: host.enabled,
    acceptsInstances: host.acceptsInstances,
    labels: host.labels,
    status: host.status,
    statusDetail: host.status_detail,
    lastSeen: host.last_seen,
    instanceCount: counts[host.id] ?? 0,
  };
}

export default async function hostRoutes(fastify) {
  fastify.get('/api/hosts', async () => {
    const hosts = getHosts();
    const counts = Object.fromEntries(
      hosts.map((h) => [h.id, getInstancesByHost(h.id).length]),
    );
    return { hosts: hosts.map((h) => publicHost(h, counts)) };
  });

  fastify.get('/api/hosts/:id', async (request, reply) => {
    const host = getHost(request.params.id);
    if (!host) return reply.code(404).send({ error: 'Host not found' });
    return publicHost(host, { [host.id]: getInstancesByHost(host.id).length });
  });

  fastify.post('/api/hosts', async (request, reply) => {
    const b = request.body || {};
    if (!HOST_ID.test(b.id || '')) {
      return reply.code(400).send({ error: 'id must be lowercase alphanumeric with dashes' });
    }
    if (getHost(b.id)) return reply.code(409).send({ error: `host ${b.id} already exists` });
    if (b.kind !== 'local') {
      if (!b.address) return reply.code(400).send({ error: 'address is required' });
      if (!isFleetKeyRef(b.sshKeyRef)) {
        // Keys live in the vault. Accepting inline key material here would put it
        // in the request log, the DB and every backup of it.
        return reply.code(400).send({ error: `sshKeyRef must be an ${FLEET_VAULT_PREFIX} reference`, code: 'key_outside_fleet_vault' });
      }
    }

    const host = upsertHost({
      id: b.id,
      name: b.name || b.id,
      kind: b.kind || 'ssh',
      address: b.address ?? null,
      sshUser: b.sshUser ?? null,
      sshPort: b.sshPort ?? 22,
      sshKeyRef: b.sshKeyRef ?? null,
      dataRoot: b.dataRoot ?? null,
      managerUrl: b.managerUrl ?? null,
      network: b.network ?? null,
      proxyContainer: b.proxyContainer || 'cm-proxy',
      enabled: b.enabled !== false,
      acceptsInstances: b.acceptsInstances !== false,
      labels: b.labels ?? null,
    });
    logActivity('host_registered', null, host.name, `${host.kind} ${host.address || 'local'}`);

    const probe = await pingHost(host.id);
    return reply.code(201).send({ host: publicHost(getHost(host.id)), probe });
  });

  fastify.patch('/api/hosts/:id', async (request, reply) => {
    const existing = getHost(request.params.id);
    if (!existing) return reply.code(404).send({ error: 'Host not found' });
    const b = request.body || {};
    if (b.sshKeyRef && !isFleetKeyRef(b.sshKeyRef)) {
      return reply.code(400).send({ error: `sshKeyRef must be an ${FLEET_VAULT_PREFIX} reference`, code: 'key_outside_fleet_vault' });
    }
    const host = upsertHost({
      id: existing.id,
      name: b.name ?? existing.name,
      kind: b.kind ?? existing.kind,
      address: b.address ?? existing.address,
      sshUser: b.sshUser ?? existing.ssh_user,
      sshPort: b.sshPort ?? existing.ssh_port,
      sshKeyRef: b.sshKeyRef ?? existing.ssh_key_ref,
      dataRoot: b.dataRoot ?? existing.data_root,
      managerUrl: b.managerUrl ?? existing.manager_url,
      network: b.network ?? existing.network,
      proxyContainer: b.proxyContainer ?? existing.proxy_container,
      enabled: b.enabled ?? existing.enabled,
      acceptsInstances: b.acceptsInstances ?? existing.acceptsInstances,
      labels: b.labels ?? existing.labels,
    });
    invalidateHost(host.id);   // connection details may have changed
    restartHostEventStream(host.id);   // and so may the stream's endpoint
    return { host: publicHost(getHost(host.id)) };
  });

  fastify.delete('/api/hosts/:id', async (request, reply) => {
    if (request.params.id === DEFAULT_HOST_ID) {
      return reply.code(400).send({ error: 'cannot remove the local host' });
    }
    if (!getHost(request.params.id)) return reply.code(404).send({ error: 'Host not found' });
    try {
      deleteHost(request.params.id);          // refuses while instances live there
    } catch (err) {
      return reply.code(409).send({ error: err.message });
    }
    invalidateHost(request.params.id);
    stopHostEventStream(request.params.id);
    logActivity('host_removed', null, request.params.id);
    return { ok: true };
  });

  fastify.post('/api/hosts/:id/ping', async (request, reply) => {
    if (!getHost(request.params.id)) return reply.code(404).send({ error: 'Host not found' });
    return pingHost(request.params.id);
  });

  /**
   * Create the fleet directories on a remote host.
   *
   * The manager cannot mkdir across SSH, but it can run a throwaway container
   * there with the data root bound — the same trick instances already rely on.
   */
  fastify.post('/api/hosts/:id/bootstrap', async (request, reply) => {
    const host = getHost(request.params.id);
    if (!host) return reply.code(404).send({ error: 'Host not found' });
    if (!host.data_root) return reply.code(400).send({ error: 'host has no dataRoot' });

    const client = await dockerFor(host.id);
    const script = [
      'set -e',
      'mkdir -p /root/claude-home /root/instance-memory /root/shared',
      'chown -R 1001:1001 /root/claude-home /root/instance-memory /root/shared',
      'ls -ld /root/claude-home /root/instance-memory /root/shared',
    ].join(' && ');

    // runOnHost also pulls the helper image if the host has never seen it —
    // this route assumed alpine:3 was already present, which is true only by luck.
    const output = await runOnHost(client, host, script);
    logActivity('host_bootstrapped', null, host.name, host.data_root);
    return { ok: true, dataRoot: host.data_root, output };
  });
}
