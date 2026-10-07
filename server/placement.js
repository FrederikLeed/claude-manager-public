/**
 * Where may this instance run?
 *
 * One place answers that question, so every caller gets the same typed refusal
 * instead of a raw Docker error surfacing from four different code paths.
 */
import { getHost, getInstancesByHost, DEFAULT_HOST_ID } from './db.js';
import { pingHost } from './hosts.js';
import { config } from './config.js';

function refuse(status, code, message) {
  const err = new Error(message);
  err.statusCode = status;
  err.code = code;
  return err;
}

/**
 * Resolve and validate the target host for a new instance.
 * Returns the host row; throws a typed error the route can pass straight through.
 */
export async function admit({ hostId, dockerSocket = false, networkPolicy = 'unrestricted', existing = false } = {}) {
  const id = hostId || DEFAULT_HOST_ID;
  const host = getHost(id);

  if (!host) throw refuse(404, 'unknown_host', `No such host: ${id}`);
  if (!host.enabled) throw refuse(409, 'host_disabled', `Host ${id} is disabled`);
  if (!host.acceptsInstances) {
    // This is the host-b case: a host the manager watches but must never
    // schedule work onto.
    throw refuse(409, 'host_not_accepting', `Host ${host.name} does not accept instances`);
  }

  // Docker socket access on the host that runs the manager is control of the
  // whole fleet, not just one daemon.
  if (dockerSocket && host.kind === 'local') {
    throw refuse(
      409,
      'socket_on_manager_host',
      'Docker socket access is not allowed on the host running the manager — it would give the instance control of the fleet',
    );
  }

  // A restricted policy on a remote host is a label with nothing behind it:
  // server/proxy.js writes squid ACLs through a local-only Docker client, and
  // HTTPS_PROXY points at this host's cm-proxy. Refuse it rather than create an
  // instance whose network policy is decoration — the fleet graph already grades
  // this 'unenforceable', and placement should decline to produce it.
  if (host.kind !== 'local' && networkPolicy && networkPolicy !== 'unrestricted') {
    throw refuse(
      409,
      'policy_unenforceable_on_host',
      `Network policy "${networkPolicy}" cannot be enforced on ${host.name}: the per-host proxy does not exist yet, so only "unrestricted" is honest there`,
    );
  }

  // A recreate re-admits an instance that is already counted; only a brand new
  // instance can push a host over its cap.
  const count = getInstancesByHost(id).length;
  if (!existing && count >= config.MAX_INSTANCES) {
    throw refuse(409, 'host_full', `Host ${host.name} is at the instance limit (${config.MAX_INSTANCES})`);
  }

  // Cheap liveness check: a remote host that cannot answer now will fail
  // halfway through create, leaving a half-built instance behind.
  if (host.kind !== 'local') {
    const probe = await pingHost(id);
    if (!probe.ok) {
      throw refuse(503, 'host_unreachable', `Host ${host.name} is unreachable: ${probe.detail}`);
    }
  }

  return host;
}
