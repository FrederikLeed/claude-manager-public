import Docker from 'dockerode';
import crypto from 'crypto';
import { mkdirSync } from 'fs';
import { config } from './config.js';
import { getAllInstances } from './db.js';
import { LABELS, CONTAINER_PREFIX, VOLUME_PREFIX } from '../shared/constants.js';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Cached bind mount template learned from existing containers
let _mountTemplate = null;

/**
 * Learn bind mounts from an existing container to replicate for new ones.
 * Searches (in order): managed containers, adopted containers (SQLite),
 * and unmanaged claude-workspace containers (same image/name pattern).
 * Skips: /workspace (per-instance), Docker socket, /data (manager-only).
 */
async function learnMountTemplate() {
  if (_mountTemplate) return _mountTemplate;

  const seenIds = new Set();
  const allCandidates = [];

  // 1. Managed containers (labeled)
  try {
    const managed = await docker.listContainers({
      all: true,
      filters: { label: [`${LABELS.MANAGED}=true`] },
    });
    for (const c of managed) {
      seenIds.add(c.Id);
      allCandidates.push(c.Id);
    }
  } catch { /* Docker may be temporarily unavailable */ }

  // 2. Adopted containers from SQLite
  try {
    const dbInstances = getAllInstances();
    for (const dbInst of dbInstances) {
      if (!dbInst.docker_id || seenIds.has(dbInst.docker_id)) continue;
      seenIds.add(dbInst.docker_id);
      allCandidates.push(dbInst.docker_id);
    }
  } catch { /* DB may not be ready */ }

  // 3. Unmanaged claude-workspace containers (same image or name pattern)
  try {
    const claudeImage = config.CLAUDE_IMAGE.split(':')[0];
    const allContainers = await docker.listContainers({ all: true });
    for (const c of allContainers) {
      if (seenIds.has(c.Id)) continue;
      const imageName = c.Image?.split(':')[0] || '';
      const name = c.Names?.[0]?.replace('/', '') || '';
      const isClaudeWorkspace =
        imageName === claudeImage ||
        imageName.endsWith('/claude-workspace') ||
        (name.startsWith('claude-') && name !== 'claude-manager');
      if (isClaudeWorkspace) {
        seenIds.add(c.Id);
        allCandidates.push(c.Id);
      }
    }
  } catch { /* Docker query failed */ }

  // Inspect each candidate and extract shared bind mounts
  for (const id of allCandidates) {
    try {
      const container = docker.getContainer(id);
      const inspect = await container.inspect();
      const containerName = inspect.Name?.replace('/', '') || id.slice(0, 12);
      const mounts = inspect.Mounts || [];

      const sharedBinds = mounts
        .filter((m) => m.Type === 'bind')
        .filter((m) => {
          const dest = m.Destination;
          if (dest === '/workspace') return false;
          if (dest.includes('docker.sock')) return false;
          if (dest === '/data') return false;
          return true;
        })
        .map((m) => `${m.Source}:${m.Destination}${m.RW === false ? ':ro' : ''}`);

      if (sharedBinds.length > 0) {
        _mountTemplate = sharedBinds;
        console.log(`[mount-learning] Learned ${sharedBinds.length} bind mounts from "${containerName}": ${sharedBinds.join(', ')}`);
        return _mountTemplate;
      }
    } catch { /* container may be gone */ }
  }

  console.log(`[mount-learning] No shared bind mounts found across ${allCandidates.length} candidate containers`);
  return [];
}

/** Clear cached template (call on container changes) */
export function clearMountTemplate() {
  _mountTemplate = null;
}

/**
 * Ensure the manager network exists, creating it if needed.
 */
export async function ensureNetwork() {
  const networks = await docker.listNetworks({
    filters: { name: [config.CLAUDE_NETWORK] },
  });
  const exists = networks.some((n) => n.Name === config.CLAUDE_NETWORK);
  if (!exists) {
    await docker.createNetwork({
      Name: config.CLAUDE_NETWORK,
      Driver: 'bridge',
    });
  }
}

/**
 * List all containers managed by claude-manager.
 * Includes both labeled containers and adopted containers tracked in SQLite.
 */
export async function listManagedContainers() {
  // Get containers with managed label
  const labeledContainers = await docker.listContainers({
    all: true,
    filters: { label: [`${LABELS.MANAGED}=true`] },
  });
  const results = labeledContainers.map(formatContainerInfo);
  const seenDockerIds = new Set(results.map((c) => c.dockerId));

  // Also include adopted containers tracked by docker_id in SQLite
  try {
    const dbInstances = getAllInstances();
    for (const dbInst of dbInstances) {
      if (!dbInst.docker_id || seenDockerIds.has(dbInst.docker_id)) continue;
      try {
        const container = docker.getContainer(dbInst.docker_id);
        const inspect = await container.inspect();
        results.push({
          id: dbInst.id,
          dockerId: inspect.Id,
          name: dbInst.name,
          image: inspect.Config?.Image,
          state: inspect.State?.Status,
          status: inspect.State?.Status === 'running'
            ? `Up ${formatUptime(inspect.State.StartedAt)}`
            : `Exited (${inspect.State?.ExitCode})`,
          created: Math.floor(new Date(inspect.Created).getTime() / 1000),
          ports: [],
          dockerSocket: hasDockerSocket(inspect.Mounts),
        });
      } catch {
        // Container may have been removed externally
      }
    }
  } catch {
    // DB may not be initialized yet during startup
  }

  return results;
}

/**
 * Get detailed info for a single container.
 */
export async function getContainer(id) {
  // Try by manager ID label first
  const containers = await docker.listContainers({
    all: true,
    filters: { label: [`${LABELS.MANAGED}=true`, `${LABELS.ID}=${id}`] },
  });

  if (containers.length > 0) {
    const container = docker.getContainer(containers[0].Id);
    const inspect = await container.inspect();
    return formatInspectInfo(inspect);
  }

  // Try by SQLite docker_id mapping (adopted containers)
  try {
    const { getInstance } = await import('./db.js');
    const dbInst = getInstance(id);
    if (dbInst?.docker_id) {
      const container = docker.getContainer(dbInst.docker_id);
      const inspect = await container.inspect();
      return formatInspectInfo(inspect);
    }
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }

  // Fall back to name lookup
  const containerName = id.startsWith(CONTAINER_PREFIX) ? id : `${CONTAINER_PREFIX}${id}`;
  try {
    const container = docker.getContainer(containerName);
    const inspect = await container.inspect();
    return formatInspectInfo(inspect);
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

/**
 * Create a new managed container instance.
 */
export async function createInstance({ name, image, env = [], autoStart = false, dockerSocket = false }) {
  const id = crypto.randomUUID().slice(0, 8);
  const slug = name
    ? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
    : id;
  const containerName = `cm-${slug}-${id}`;
  const volumeName = `cmv-${slug}-${id}`;

  // Check instance limit
  const existing = await listManagedContainers();
  if (existing.length >= config.MAX_INSTANCES) {
    const err = new Error(`Maximum instance limit (${config.MAX_INSTANCES}) reached`);
    err.statusCode = 409;
    throw err;
  }

  // Idempotent: check if container with this name exists
  try {
    const existing = docker.getContainer(containerName);
    const inspect = await existing.inspect();
    return formatInspectInfo(inspect);
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }

  // Ensure image is available locally (pull if needed)
  const imageName = image || config.CLAUDE_IMAGE;
  try {
    await ensureImage(imageName);
  } catch (err) {
    const error = new Error(`Failed to pull image "${imageName}": ${err.message}`);
    error.statusCode = err.statusCode || 500;
    throw error;
  }

  // Ensure network exists
  try {
    await ensureNetwork();
  } catch (err) {
    const error = new Error(`Failed to ensure network "${config.CLAUDE_NETWORK}": ${err.message}`);
    error.statusCode = 500;
    throw error;
  }

  // Create the workspace volume
  try {
    await docker.createVolume({ Name: volumeName });
  } catch (err) {
    if (err.statusCode !== 409) { // 409 = volume already exists
      const error = new Error(`Failed to create volume "${volumeName}": ${err.message}`);
      error.statusCode = err.statusCode || 500;
      throw error;
    }
  }

  // Learn bind mounts from existing containers (shared dirs, .claude config, etc.)
  let templateBinds = [];
  try {
    templateBinds = await learnMountTemplate();
  } catch {
    // Fall back to config-based mounts if learning fails
  }

  // Build final bind list: workspace volume + learned template + config overrides
  const binds = [`${volumeName}:/workspace`];

  if (templateBinds.length > 0) {
    // Use learned mounts, but skip any that conflict with explicit config
    const configDests = new Set();
    if (config.INSTANCE_SHARED_DIR) configDests.add('/shared');
    if (config.INSTANCE_MEMORY_DIR) configDests.add('/project-memory');
    if (config.INSTANCE_CLAUDE_DIR) configDests.add('/home/claude/.claude');
    if (config.INSTANCE_MEMORY_BASE_DIR) configDests.add('/workspace/.claude');

    for (const bind of templateBinds) {
      const dest = bind.split(':')[1];
      if (dest === '/workspace') continue; // already added per-instance
      if (configDests.has(dest)) continue; // explicit config takes precedence
      binds.push(bind);
    }
  }

  // Add explicit config-based mounts (override learned ones)
  if (config.INSTANCE_SHARED_DIR) binds.push(`${config.INSTANCE_SHARED_DIR}:/shared`);
  if (config.INSTANCE_MEMORY_DIR) binds.push(`${config.INSTANCE_MEMORY_DIR}:/project-memory`);
  if (config.INSTANCE_CLAUDE_DIR) binds.push(`${config.INSTANCE_CLAUDE_DIR}:/home/claude/.claude`);

  // Per-instance project memory: <base>/<slug>/ → /workspace/.claude
  if (config.INSTANCE_MEMORY_BASE_DIR) {
    // Pre-create the directory via the manager's own mount (/instance-memory)
    try {
      mkdirSync(`/instance-memory/${slug}`, { recursive: true });
    } catch { /* may already exist */ }
    const instanceMemoryPath = `${config.INSTANCE_MEMORY_BASE_DIR}/${slug}`;
    binds.push(`${instanceMemoryPath}:/workspace/.claude`);
    console.log(`[create-instance] Per-instance memory: ${instanceMemoryPath}`);
  }

  // Optionally mount Docker socket for container management access
  if (dockerSocket) {
    binds.push('/var/run/docker.sock:/var/run/docker.sock');
  }

  console.log(`[create-instance] "${containerName}" binds: ${binds.join(', ')}`);

  // Create the container
  let container;
  try {
    container = await docker.createContainer({
      name: containerName,
      Image: imageName,
      Env: [
        `PROJECT_NAME=${name || 'unnamed'}`,
        `PROJECT_SLUG=${slug}`,
        ...env,
      ],
      Labels: {
        [LABELS.MANAGED]: 'true',
        [LABELS.ID]: id,
        [LABELS.NAME]: name,
      },
      Tty: true,
      OpenStdin: true,
      HostConfig: {
        Binds: binds,
        NetworkMode: config.CLAUDE_NETWORK,
        RestartPolicy: { Name: 'unless-stopped' },
      },
    });
  } catch (err) {
    const error = new Error(`Failed to create container: ${err.message}`);
    error.statusCode = err.statusCode || 500;
    throw error;
  }

  if (autoStart) {
    try {
      await container.start();
    } catch (err) {
      const error = new Error(`Container created but failed to start: ${err.message}`);
      error.statusCode = err.statusCode || 500;
      throw error;
    }
  }

  const inspect = await container.inspect();
  return formatInspectInfo(inspect);
}

/**
 * Start a stopped container.
 */
export async function startInstance(id) {
  const container = await resolveContainer(id);
  try {
    await container.start();
  } catch (err) {
    if (err.statusCode === 304) return; // already running
    throw err;
  }
}

/**
 * Stop a running container.
 */
export async function stopInstance(id, timeoutSeconds = 10) {
  const container = await resolveContainer(id);
  try {
    await container.stop({ t: timeoutSeconds });
  } catch (err) {
    if (err.statusCode === 304) return; // already stopped
    throw err;
  }
}

/**
 * Remove a container and optionally its workspace volume.
 */
export async function removeInstance(id, { removeVolume = false } = {}) {
  const container = await resolveContainer(id);

  // Stop first if running
  try {
    await container.stop({ t: 5 });
  } catch (err) {
    if (err.statusCode !== 304 && err.statusCode !== 404) throw err;
  }

  await container.remove({ force: true });

  if (removeVolume) {
    const volumeName = `${VOLUME_PREFIX}${id}`;
    try {
      const volume = docker.getVolume(volumeName);
      await volume.remove();
    } catch (err) {
      // Volume may not exist, that's fine
      if (err.statusCode !== 404) throw err;
    }
  }
}

/**
 * Execute a command inside a container.
 */
export async function execInContainer(id, cmd) {
  const container = await resolveContainer(id);
  const exec = await container.exec({
    Cmd: Array.isArray(cmd) ? cmd : ['/bin/sh', '-c', cmd],
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({ Tty: false });
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString()));
    stream.on('error', reject);
  });
}

/**
 * Create a PTY exec session for terminal access.
 * Returns { stream, exec } for bidirectional piping.
 */
export async function createPTY(id, { cols = 80, rows = 24, name } = {}) {
  const container = await resolveContainer(id);

  const promptName = name || id;
  // Use tmux for shared sessions across clients, fall back to bash
  // Separate socket (-L cm) avoids conflicts with user's tmux and its .tmux.conf
  const tmuxCmd = [
    '/bin/sh', '-c',
    'tmux -L cm -f /home/claude/.tmux.conf new-session -A -s main \\; set-option -g window-size latest 2>/dev/null || exec /bin/bash',
  ];
  const exec = await container.exec({
    Cmd: tmuxCmd,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    Env: [
      'TERM=xterm-256color',
      `PS1=\\[\\e[1;34m\\]${promptName}\\[\\e[0m\\]:\\[\\e[1;32m\\]\\w\\[\\e[0m\\]\\$ `,
    ],
  });

  const stream = await exec.start({
    hijack: true,
    stdin: true,
    Tty: true,
  });

  // Set initial terminal size
  try {
    await exec.resize({ h: rows, w: cols });
  } catch {
    // Resize may fail briefly after start, non-critical
  }

  return { stream, exec };
}

/**
 * Get Docker host system information.
 */
export async function getDockerInfo() {
  const info = await docker.info();
  const version = await docker.version();
  return {
    dockerVersion: version.Version,
    apiVersion: version.ApiVersion,
    os: info.OperatingSystem,
    arch: info.Architecture,
    cpus: info.NCPU,
    totalMemoryGB: Math.round(info.MemTotal / 1073741824 * 10) / 10,
    containers: info.Containers,
    containersRunning: info.ContainersRunning,
    containersStopped: info.ContainersStopped,
  };
}

/**
 * Get Docker event stream filtered to managed containers.
 */
export async function getEventStream() {
  const stream = await docker.getEvents({
    filters: {
      label: [`${LABELS.MANAGED}=true`],
      type: ['container'],
    },
  });
  return stream;
}

/**
 * Discover existing containers that could be adopted.
 * Finds containers matching the claude-workspace image (or name pattern)
 * that don't already have the managed label.
 */
export async function discoverContainers() {
  const allContainers = await docker.listContainers({ all: true });

  // Get already-adopted Docker IDs from SQLite
  let adoptedDockerIds = new Set();
  try {
    const dbInstances = getAllInstances();
    adoptedDockerIds = new Set(dbInstances.filter((i) => i.docker_id).map((i) => i.docker_id));
  } catch {
    // DB may not be ready
  }

  // Match containers by image name or container name pattern
  const claudeImage = config.CLAUDE_IMAGE.split(':')[0]; // strip tag
  const candidates = allContainers.filter((c) => {
    // Skip already-managed containers (labeled)
    if (c.Labels?.[LABELS.MANAGED] === 'true') return false;

    // Skip already-adopted containers (tracked in SQLite)
    if (adoptedDockerIds.has(c.Id)) return false;

    // Match by image name (with or without tag)
    const imageName = c.Image?.split(':')[0] || '';
    if (imageName === claudeImage || imageName.endsWith('/claude-workspace')) return true;

    // Match by container name pattern (claude-*)
    const name = c.Names?.[0]?.replace('/', '') || '';
    if (name.startsWith('claude-') && name !== 'claude-manager') return true;

    return false;
  });

  return candidates.map((c) => ({
    dockerId: c.Id,
    name: c.Names?.[0]?.replace('/', '') || 'unknown',
    image: c.Image,
    state: c.State,
    status: c.Status,
    created: c.Created,
    mounts: c.Mounts || [],
    dockerSocket: hasDockerSocket(c.Mounts),
  }));
}

/**
 * Adopt an existing container by adding managed labels.
 * Cannot modify labels on a running container — we store in SQLite
 * and resolve by Docker ID instead.
 */
export async function adoptContainer(dockerId, { name }) {
  const container = docker.getContainer(dockerId);
  const inspect = await container.inspect();

  // Invalidate mount template cache — adopted container may have useful mounts
  _mountTemplate = null;

  // Generate a manager ID for this container
  const id = crypto.randomUUID().slice(0, 8);

  return {
    id,
    dockerId: inspect.Id,
    name: name || inspect.Name?.replace('/', '') || 'adopted',
    image: inspect.Config?.Image,
    state: inspect.State?.Status,
    status: inspect.State?.Status === 'running'
      ? `Up ${formatUptime(inspect.State.StartedAt)}`
      : `Exited (${inspect.State?.ExitCode})`,
    created: Math.floor(new Date(inspect.Created).getTime() / 1000),
    startedAt: inspect.State?.StartedAt,
    finishedAt: inspect.State?.FinishedAt,
    mounts: inspect.Mounts || [],
  };
}

/**
 * Recreate a container with modified settings (e.g. toggling Docker socket).
 * Preserves: image, env, labels, mounts, network, restart policy.
 * Returns the new container info.
 */
export async function recreateInstance(id, { dockerSocket }) {
  const container = await resolveContainer(id);
  const inspect = await container.inspect();

  const wasRunning = inspect.State?.Status === 'running';
  const oldName = inspect.Name?.replace('/', '');
  const oldConfig = inspect.Config || {};
  const oldHostConfig = inspect.HostConfig || {};

  // Build new bind list: keep existing binds, add/remove docker socket
  const existingBinds = (oldHostConfig.Binds || []).filter(
    (b) => !b.includes('docker.sock')
  );
  const newBinds = [...existingBinds];
  if (dockerSocket) {
    newBinds.push('/var/run/docker.sock:/var/run/docker.sock');
  }

  // Stop and remove old container
  if (wasRunning) {
    try { await container.stop({ t: 5 }); } catch (err) {
      if (err.statusCode !== 304) throw err;
    }
  }
  await container.remove({ force: true });

  // Create replacement container with same config
  const newContainer = await docker.createContainer({
    name: oldName,
    Image: oldConfig.Image,
    Env: oldConfig.Env || [],
    Labels: oldConfig.Labels || {},
    Tty: oldConfig.Tty ?? true,
    OpenStdin: oldConfig.OpenStdin ?? true,
    HostConfig: {
      Binds: newBinds,
      NetworkMode: oldHostConfig.NetworkMode || config.CLAUDE_NETWORK,
      RestartPolicy: oldHostConfig.RestartPolicy || { Name: 'unless-stopped' },
    },
  });

  // Restart if it was running before
  if (wasRunning) {
    await newContainer.start();
  }

  const newInspect = await newContainer.inspect();
  return formatInspectInfo(newInspect);
}

// --- Internal helpers ---

/**
 * Check if an image exists locally, pull it if not.
 */
async function ensureImage(imageName) {
  try {
    const img = docker.getImage(imageName);
    await img.inspect();
    // Image exists locally
  } catch (err) {
    if (err.statusCode === 404) {
      // Pull the image
      const stream = await docker.pull(imageName);
      // Wait for pull to complete
      await new Promise((resolve, reject) => {
        docker.modem.followProgress(stream, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } else {
      throw err;
    }
  }
}

async function resolveContainer(id) {
  // Try by label first
  const containers = await docker.listContainers({
    all: true,
    filters: { label: [`${LABELS.MANAGED}=true`, `${LABELS.ID}=${id}`] },
  });

  if (containers.length > 0) {
    return docker.getContainer(containers[0].Id);
  }

  // Try by SQLite docker_id mapping (adopted containers)
  try {
    const { getInstance } = await import('./db.js');
    const dbInst = getInstance(id);
    if (dbInst?.docker_id) {
      const container = docker.getContainer(dbInst.docker_id);
      await container.inspect(); // verify it exists
      return container;
    }
  } catch (err) {
    if (err.statusCode === 404) {
      // Docker ID in DB but container gone — fall through
    } else if (err.statusCode) {
      throw err;
    }
    // DB not initialized or other non-Docker error — fall through
  }

  // Try by name
  const containerName = id.startsWith(CONTAINER_PREFIX) ? id : `${CONTAINER_PREFIX}${id}`;
  const container = docker.getContainer(containerName);

  // Verify it exists
  try {
    await container.inspect();
  } catch (err) {
    if (err.statusCode === 404) {
      const error = new Error(`Instance ${id} not found`);
      error.statusCode = 404;
      throw error;
    }
    throw err;
  }

  return container;
}

function hasDockerSocket(mounts) {
  return (mounts || []).some((m) =>
    (m.Destination || m.destination || '') === '/var/run/docker.sock' ||
    (m.Source || m.source || '').includes('docker.sock')
  );
}

function formatContainerInfo(container) {
  const labels = container.Labels || {};
  return {
    id: labels[LABELS.ID] || container.Id.slice(0, 12),
    dockerId: container.Id,
    name: labels[LABELS.NAME] || container.Names?.[0]?.replace('/', '') || 'unknown',
    image: container.Image,
    state: container.State,
    status: container.Status,
    created: container.Created,
    ports: container.Ports || [],
    dockerSocket: hasDockerSocket(container.Mounts),
  };
}

function formatInspectInfo(inspect) {
  const labels = inspect.Config?.Labels || {};
  return {
    id: labels[LABELS.ID] || inspect.Id.slice(0, 12),
    dockerId: inspect.Id,
    name: labels[LABELS.NAME] || inspect.Name?.replace('/', '') || 'unknown',
    image: inspect.Config?.Image,
    state: inspect.State?.Status,
    status: inspect.State?.Status === 'running'
      ? `Up ${formatUptime(inspect.State.StartedAt)}`
      : `Exited (${inspect.State?.ExitCode})`,
    created: Math.floor(new Date(inspect.Created).getTime() / 1000),
    startedAt: inspect.State?.StartedAt,
    finishedAt: inspect.State?.FinishedAt,
    env: inspect.Config?.Env || [],
    mounts: inspect.Mounts || [],
    networkSettings: inspect.NetworkSettings || {},
    dockerSocket: hasDockerSocket(inspect.Mounts),
  };
}

function formatUptime(startedAt) {
  const seconds = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
