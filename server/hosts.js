/**
 * Managed Docker hosts.
 *
 * Every module that talks to Docker goes through dockerFor(hostId) instead of
 * constructing its own client, so an instance can live on any host in the fleet.
 * The manager's own daemon is the row 'local' and uses the mounted socket; other
 * hosts are reached over SSH (dockerode speaks it natively via ssh2), which keeps
 * the Docker API off the LAN and needs no TLS material.
 *
 * SSH keys are read from the 1Password Claude vault at connect time and held in
 * memory only — hosts.ssh_key_ref stores an op:// reference, never a key.
 */
import Docker from 'dockerode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { config } from './config.js';
import { DEFAULT_HOST_ID, getHost, getHosts, setHostStatus, setHostIdentity, getHostByEngineId } from './db.js';
import { moduleLogger } from './logger.js';

const log = moduleLogger('hosts');

const execFileAsync = promisify(execFile);

const clients = new Map();   // hostId -> { docker, signature }
const keyCache = new Map();  // op:// reference -> key material

/** Read a secret from the 1Password Claude vault. Never logged. */
export const FLEET_VAULT_PREFIX = 'op://Claude-Fleet/';

/**
 * A host key reference must live in the Claude-Fleet vault. The Claude vault is
 * readable by every instance through the token they are all injected with, so
 * a key there is root on that host from any instance shell — verified live.
 */
export function isFleetKeyRef(ref) {
  // 1Password resolves vault names case-insensitively (the vault is literally
  // "claude-fleet"), so the guard must too, or a correct lowercase reference
  // is refused while an uppercase one is accepted.
  return typeof ref === 'string' && ref.toLowerCase().startsWith(FLEET_VAULT_PREFIX.toLowerCase());
}

export function assertFleetKeyRef(ref) {
  if (!isFleetKeyRef(ref)) {
    const err = new Error(`host SSH key must be an ${FLEET_VAULT_PREFIX} reference; the Claude vault is readable by every instance`);
    err.statusCode = 400; err.code = 'key_outside_fleet_vault';
    throw err;
  }
  return ref;
}

async function readVaultSecret(ref) {
  assertFleetKeyRef(ref);
  if (keyCache.has(ref)) return keyCache.get(ref);
  const token = config.OP_FLEET_SERVICE_ACCOUNT_TOKEN;
  if (!token) {
    throw new Error('OP_FLEET_SERVICE_ACCOUNT_TOKEN is not set; host SSH keys are read from the Claude-Fleet vault with the manager-only token');
  }
  // op gets the FLEET token, scoped to that vault, never the instance-wide one.
  const { stdout } = await execFileAsync('op', ['read', ref], {
    maxBuffer: 1 << 20,
    env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: token },
  });
  const secret = stdout.replace(/\n$/, '') + '\n'; // keep exactly one trailing newline
  keyCache.set(ref, secret);
  return secret;
}

/**
 * Changing any of these means the cached client is stale.
 *
 * ssh_port belongs here: without it, moving a host to a different port kept the
 * old client alive. It happened to work only because routes/hosts.js calls
 * invalidateHost() explicitly on PATCH — any other write path would have served
 * a client pointed at the old port.
 */
function signatureOf(host) {
  return [host.kind, host.address, host.ssh_user, host.ssh_port, host.ssh_key_ref].join('|');
}

function localClient() {
  return new Docker({ socketPath: '/var/run/docker.sock' });
}

async function sshClient(host) {
  if (!host.address) throw new Error(`host ${host.id} has no address`);
  if (!host.ssh_key_ref) throw new Error(`host ${host.id} has no ssh_key_ref`);
  return new Docker({
    // Bare host, no ssh:// prefix: docker-modem builds an invalid URL otherwise
    // and Node warns about it (DEP0170).
    protocol: 'ssh',
    host: host.address,
    port: host.ssh_port || 22,
    username: host.ssh_user || 'claude',
    sshOptions: {
      privateKey: await readVaultSecret(host.ssh_key_ref),
      // Without a keepalive, a host that dies without FIN/RST (power loss, IP
      // change) leaves the event stream hung forever and the reconcile skips
      // it because the map entry exists. 3 missed probes at 15s = ~45s to notice.
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      // A dead host must fail fast, not hold a request open for the default 20s.
      readyTimeout: 10_000,
    },
  });
}

/**
 * Docker client for a host. Cached per host, rebuilt when its connection
 * details change.
 */
export async function dockerFor(hostId = DEFAULT_HOST_ID) {
  const id = hostId || DEFAULT_HOST_ID;
  const host = getHost(id);
  if (!host) throw new Error(`unknown host: ${id}`);
  if (!host.enabled) throw new Error(`host ${id} is disabled`);

  const signature = signatureOf(host);
  const cached = clients.get(id);
  if (cached && cached.signature === signature) return cached.docker;

  const docker = host.kind === 'local' ? localClient() : await sshClient(host);
  clients.set(id, { docker, signature });
  return docker;
}

/** Drop a cached client (after editing a host, or on connection failure). */
export function invalidateHost(hostId) {
  clients.delete(hostId);
}

/** Hosts that may run new instances. */
export function instanceHosts() {
  return getHosts({ enabledOnly: true }).filter((h) => h.acceptsInstances);
}

/**
 * Host-specific settings, falling back to the manager's own config so a
 * single-host deployment behaves exactly as before.
 */
export function hostSettings(host) {
  return {
    network: host.network || config.CLAUDE_NETWORK,
    proxyContainer: host.proxy_container || config.PROXY_CONTAINER,
    dataRoot: host.data_root || null,
    managerUrl: host.manager_url || null,
  };
}

/**
 * Probe a host and record the result. Returns { ok, version, detail }.
 *
 * Also learns the host's identity: the daemon knows its own hostname, which is
 * a far better label than whatever placeholder it was registered with, and its
 * engine id is what catches the same daemon being registered twice.
 */
export async function pingHost(hostId) {
  try {
    const docker = await dockerFor(hostId);
    const version = await docker.version();
    try {
      const info = await docker.info();
      const host = getHost(hostId);
      const twin = getHostByEngineId(info?.ID, hostId);
      if (twin) {
        setHostStatus(hostId, 'error', `same Docker engine as host "${twin.id}"`);
        log.warn({ hostId, twin: twin.id }, 'duplicate host: both point at the same daemon');
        return { ok: false, detail: `This is the same Docker engine as host "${twin.id}"` };
      }
      // Replace a placeholder name with what the machine calls itself.
      const placeholder = !host?.name || host.name === 'Local' || host.name === hostId;
      setHostIdentity(hostId, {
        name: placeholder && info?.Name ? info.Name : null,
        engineId: info?.ID || null,
      });
    } catch { /* identity is a nicety; a working daemon still counts as ok */ }
    setHostStatus(hostId, 'ok', `docker ${version.Version}`);
    return { ok: true, version: version.Version };
  } catch (err) {
    invalidateHost(hostId);
    setHostStatus(hostId, 'error', err.message);
    log.warn({ hostId, err: err.message }, 'host unreachable');
    return { ok: false, detail: err.message };
  }
}

/** Probe every enabled host; used at startup and by the health monitor. */
export async function pingAllHosts() {
  const results = {};
  for (const host of getHosts({ enabledOnly: true })) {
    results[host.id] = await pingHost(host.id);
  }
  return results;
}
