/**
 * Host filesystem paths for instance binds.
 *
 * A bind mount is resolved by the daemon that runs the container, so every path
 * in a container spec must exist on THAT host. The manager can see its own
 * filesystem through its mounts; on any other host it cannot, so directories are
 * created by running a throwaway container there with the data root bound.
 */
import { mkdirSync, chownSync } from 'fs';
import { Writable } from 'node:stream';
import { config } from './config.js';
import { DEFAULT_HOST_ID } from './db.js';
import { dockerFor } from './hosts.js';
import { moduleLogger } from './logger.js';

const log = moduleLogger('host-fs');

// The uid/gid the workspace image runs Claude as. A root-owned bind leaves the
// agent unable to write its own memory.
export const CLAUDE_UID = 1001;
export const CLAUDE_GID = 1001;

const HELPER_IMAGE = 'alpine:3';

/**
 * Where this host keeps the fleet directories.
 *
 * The local host keeps using the explicit INSTANCE_* env vars so a single-host
 * deployment behaves exactly as before. A remote host derives everything from
 * its registered data_root, because the manager's env says nothing about it.
 */
export function hostPaths(host) {
  if (!host || host.kind === 'local') {
    return {
      shared: config.INSTANCE_SHARED_DIR || null,
      claudeHome: config.INSTANCE_CLAUDE_DIR || null,
      projectMemory: config.INSTANCE_MEMORY_DIR || null,
      memoryBase: config.INSTANCE_MEMORY_BASE_DIR || null,
    };
  }
  const root = host.data_root;
  if (!root) {
    const err = new Error(`host ${host.id} has no data_root; run POST /api/hosts/${host.id}/bootstrap`);
    err.statusCode = 409;
    err.code = 'host_not_bootstrapped';
    throw err;
  }
  return {
    shared: `${root}/shared`,
    claudeHome: `${root}/claude-home`,
    projectMemory: null,
    memoryBase: `${root}/instance-memory`,
  };
}

/**
 * Create <memoryBase>/<slug>/memory owned by the Claude user, on whichever host
 * will run the instance.
 *
 * Failing this is fatal for a remote host: Docker would otherwise create the
 * bind source as a root-owned directory, and the agent could not write memory
 * into it — a failure that only shows up later as silently lost memory.
 */
export async function ensureInstanceMemoryDir(host, slug) {
  const paths = hostPaths(host);
  if (!paths.memoryBase) return null;
  const target = `${paths.memoryBase}/${slug}`;

  if (!host || host.kind === 'local') {
    // The manager mounts the base dir at /instance-memory, so it can do this directly.
    try {
      mkdirSync(`/instance-memory/${slug}/memory`, { recursive: true });
      chownSync(`/instance-memory/${slug}`, CLAUDE_UID, CLAUDE_GID);
      chownSync(`/instance-memory/${slug}/memory`, CLAUDE_UID, CLAUDE_GID);
    } catch (err) {
      log.warn({ err: err.message, slug }, 'could not prepare per-instance memory directory');
    }
    return target;
  }

  const docker = await dockerFor(host.id);
  const script = `set -e
mkdir -p /root/instance-memory/${slug}/memory
chown -R ${CLAUDE_UID}:${CLAUDE_GID} /root/instance-memory/${slug}`;
  await runOnHost(docker, host, script);
  log.info({ hostId: host.id, slug, target }, 'prepared per-instance memory directory on remote host');
  return target;
}

/**
 * Run a throwaway helper container on a host and collect its output.
 *
 * dockerode's run() treats the stream argument as a real stream — it calls
 * .on() on it. A plain { write, end } object fails with "dest.on is not a
 * function", which is exactly how the bootstrap route and this module both
 * broke on the first remote host. Two streams let dockerode demux stdout from
 * stderr instead of handing back framed bytes.
 */
export async function runOnHost(docker, host, script) {
  await ensureHelperImage(docker);
  const out = [];
  const sink = () => new Writable({
    write(chunk, _enc, cb) { out.push(chunk.toString()); cb(); },
  });
  // No AutoRemove: docker.run() creates, starts and then *waits*. A helper
  // that finishes before the wait call arrives (fast script, slow SSH round
  // trip under load) was already deleted, and the wait failed the whole create
  // with "no such container". Remove it ourselves once the wait has returned.
  const [result, container] = await docker.run(HELPER_IMAGE, ['sh', '-c', script], [sink(), sink()], {
    HostConfig: { Binds: [`${host.data_root}:/root`] },
  });
  await container?.remove({ force: true }).catch(() => {});
  if (result?.StatusCode) {
    throw new Error(`helper on ${host.name || host.id} exited ${result.StatusCode}: ${out.join('').slice(-300)}`);
  }
  return out.join('');
}

async function ensureHelperImage(docker) {
  try {
    await docker.getImage(HELPER_IMAGE).inspect();
  } catch {
    await new Promise((resolve, reject) => {
      docker.pull(HELPER_IMAGE, (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve()));
      });
    });
  }
}

/** What an instance on this host should call back to. */
export function managerUrlFor(host, fallback) {
  if (!host || host.kind === 'local') return fallback;
  if (!host.manager_url) {
    const err = new Error(
      `host ${host.id} has no manager_url; instances there could not report events back`,
    );
    err.statusCode = 409;
    err.code = 'host_missing_manager_url';
    throw err;
  }
  return host.manager_url;
}

export { DEFAULT_HOST_ID };
