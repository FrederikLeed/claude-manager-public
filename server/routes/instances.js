import {
  listManagedContainers,
  listManagedContainersByHost,
  getContainer,
  createInstance,
  startInstance,
  stopInstance,
  removeInstance,
  recreateInstance,
  getEventStream,
  discoverContainers,
  adoptContainer,
  execInContainer,
} from '../docker.js';
import {
  upsertInstance,
  DEFAULT_HOST_ID,
  getInstance,
  getAllInstances,
  updateInstance,
  deleteInstance,
  logActivity,
  deleteGrantsForInstance,
  getGrantsForInstance,
  getAccessRequestsForInstance,
  setInstanceUsage,
  getAllInstanceUsage,
  deleteInstanceUsage,
  setInstanceClaudeVersion,
  deleteInstanceScan,
  getHosts,
  getHost,
} from '../db.js';
import { WS_EVENTS, NETWORK_POLICIES, INSTANCE_EVENTS } from '../../shared/constants.js';
import { hashToken } from '../auth.js';
import { getCurrentImageVersion } from '../workspace-image.js';
import { getAllScanSummaries } from '../security-scan.js';
import { createGrantsForInstance } from '../grants.js';
import { isAvailable as litellmAvailable, createVirtualKey, deleteVirtualKey } from '../litellm.js';
import { writeContainerACL, removeContainerACL, syncAllACLs } from '../proxy.js';

const connectedClients = new Set();
// One event stream per host. A single stream only ever watched the manager's
// own daemon, so an instance on any other host never updated in the dashboard —
// it just looked frozen.
const eventStreams = new Map();   // hostId -> stream
let streamReconcile = null;

export default async function instanceRoutes(fastify) {
  // --- WebSocket: real-time state events ---
  // MUST be registered before :id routes so "events" isn't matched as a param
  fastify.get('/api/instances/events', { websocket: true }, (socket) => {
    connectedClients.add(socket);
    socket.on('close', () => connectedClients.delete(socket));
    socket.on('error', () => connectedClients.delete(socket));
  });

  // Start Docker event stream on plugin load
  startEventStream(fastify.log);


  // --- REST endpoints ---

  // Discover adoptable containers (before :id routes)
  fastify.get('/api/instances/discover', async () => {
    return discoverContainers();
  });

  // Adopt an existing container
  fastify.post('/api/instances/adopt', {
    schema: {
      body: {
        type: 'object',
        required: ['dockerId'],
        properties: {
          dockerId: { type: 'string' },
          name: { type: 'string', maxLength: 100 },
        },
      },
    },
  }, async (request, reply) => {
    const { dockerId, name } = request.body;
    const result = await adoptContainer(dockerId, { name });

    upsertInstance({
      id: result.id,
      dockerId: result.dockerId,
      name: result.name,
      image: result.image,
    });

    logActivity('adopted', result.id, result.name, `Adopted from Docker ID ${dockerId}`);

    reply.code(201);
    return result;
  });

  // List all managed instances
  fastify.get('/api/instances', async () => {
    const { containers } = await listManagedContainersByHost();
    const dbInstances = getAllInstances();
    return mergeInstances(containers, dbInstances);
  });

  // Create new instance
  fastify.post('/api/instances', {
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-zA-Z0-9_\\- ]+$' },
          image: { type: 'string' },
          notes: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          autoStart: { type: 'boolean', default: true },
          dockerSocket: { type: 'boolean', default: false },
          networkPolicy: { type: 'string', enum: NETWORK_POLICIES, default: 'unrestricted' },
          llmBackend: { type: 'string', enum: ['claude-max', 'local-llm', 'foundry', 'foundry-latest'], default: 'claude-max' },
          expiryHours: { type: 'number', minimum: 0 },
          hostId: { type: 'string', minLength: 1, maxLength: 32 },
        },
      },
    },
  }, async (request, reply) => {
    const { name, image, notes, tags, autoStart, dockerSocket, networkPolicy, llmBackend, expiryHours, hostId } = request.body;

    let instance;
    try {
      instance = await createInstance({
        name, image, autoStart, dockerSocket,
        networkPolicy: networkPolicy || 'unrestricted',
        llmBackend: llmBackend || 'claude-max',
        hostId: hostId || DEFAULT_HOST_ID,
      });
    } catch (err) {
      // Placement refusals carry their own status and a machine-readable code.
      if (err.statusCode && err.code) return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      throw err;
    }
    upsertInstance({
      id: instance.id,
      name,
      image: instance.image,
      notes,
      tags,
      hostId: hostId || DEFAULT_HOST_ID,
      // Store the digest only. The instance keeps the token in its env and
      // presents it on every callback.
      eventToken: instance.eventToken ? hashToken(instance.eventToken) : null,
    });

    // Stamp the Claude Code version this instance launched on (for update badge)
    setInstanceClaudeVersion(instance.id, getCurrentImageVersion());

    // Create capability grants for high-risk capabilities
    createGrantsForInstance(instance.id, { dockerSocket, networkPolicy, expiryHours });

    // Create LiteLLM virtual key if available
    if (litellmAvailable()) {
      try {
        const keyResult = await createVirtualKey(instance.id, name);
        if (keyResult?.key) {
          const { setLiteLLMKey } = await import('../db.js');
          setLiteLLMKey(instance.id, keyResult.key);
        }
      } catch (err) {
        // LiteLLM key creation is non-fatal
        fastify.log.warn({ err: err.message }, 'Failed to create LiteLLM key');
      }
    }

    // Write proxy ACL for this container
    if (autoStart) {
      try {
        await writeContainerACL(instance.id, { networkPolicy: networkPolicy || 'unrestricted' });
      } catch (err) {
        fastify.log.warn({ err: err.message }, 'Failed to write proxy ACL');
      }
    }

    logActivity('created', instance.id, name, `Image: ${instance.image}, Policy: ${networkPolicy || 'unrestricted'}, LLM: ${llmBackend || 'claude-max'}`);

    reply.code(201);
    return { ...instance, name, notes, tags: tags || [] };
  });

  // Get single instance
  fastify.get('/api/instances/:id', async (request, reply) => {
    const { id } = request.params;
    const container = await getContainer(id);
    if (!container) {
      reply.code(404);
      return { error: 'Instance not found' };
    }

    const dbData = getInstance(id);
    return {
      ...container,
      name: dbData?.name || container.name,
      notes: dbData?.notes || null,
      tags: dbData?.tags || [],
    };
  });

  // Start instance
  fastify.post('/api/instances/:id/start', async (request) => {
    const { id } = request.params;
    await startInstance(id);
    const dbData = getInstance(id);
    // Write proxy ACL now that container has an IP
    try {
      const container = await getContainer(id);
      await writeContainerACL(id, { networkPolicy: container?.networkPolicy || 'unrestricted' });
    } catch { /* best effort */ }
    logActivity('started', id, dbData?.name || id);
    return { ok: true };
  });

  // Stop instance
  fastify.post('/api/instances/:id/stop', async (request) => {
    const { id } = request.params;
    await stopInstance(id);
    const dbData = getInstance(id);
    logActivity('stopped', id, dbData?.name || id);
    return { ok: true };
  });

  // Report a Claude Code lifecycle event + token usage (called from INSIDE
  // containers by the Stop/Notification hook — no device auth, see auth.js).
  fastify.post('/api/instances/:id/event', {
    schema: {
      body: {
        type: 'object',
        properties: {
          event: { type: 'string' },
          contextTokens: { type: 'number', minimum: 0, default: 0 },
          outputTokens: { type: 'number', minimum: 0, default: 0 },
          // The three parts of the context window, reported separately since
          // workspace image 2026-10. An older hook sends only contextTokens.
          inputTokens: { type: 'number', minimum: 0, default: 0 },
          cacheReadTokens: { type: 'number', minimum: 0, default: 0 },
          cacheCreationTokens: { type: 'number', minimum: 0, default: 0 },
          model: { type: 'string' },
          message: { type: 'string', maxLength: 500 },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const {
      event, contextTokens = 0, outputTokens = 0, model, message,
      inputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0,
    } = request.body || {};

    // Only persist usage for known lifecycle events; ignore unknown noise.
    const known = INSTANCE_EVENTS.includes(event);
    if (known) {
      setInstanceUsage(id, {
        // An old hook reports only the total; a new one reports the parts and
        // the total. Prefer whichever is actually populated over trusting one.
        contextTokens: contextTokens || (inputTokens + cacheReadTokens + cacheCreationTokens),
        outputTokens, inputTokens, cacheReadTokens, cacheCreationTokens,
        statusMessage: message, model, event,
      });
    }

    const dbData = getInstance(id);
    broadcast({
      type: WS_EVENTS.INSTANCE_NOTIFY,
      id,
      name: dbData?.name || id,
      event: event || 'Stop',
      message: message || null,
      usage: {
        contextTokens: contextTokens || (inputTokens + cacheReadTokens + cacheCreationTokens),
        outputTokens,
        split: (inputTokens || cacheReadTokens || cacheCreationTokens)
          ? { input: inputTokens, cacheRead: cacheReadTokens, cacheCreation: cacheCreationTokens }
          : null,
        model: model || null,
      },
      timestamp: Date.now(),
    });

    reply.code(202);
    return { ok: true };
  });

  // Update instance metadata
  fastify.patch('/api/instances/:id', {
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          notes: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request) => {
    updateInstance(request.params.id, request.body);
    return { ok: true };
  });

  // Recreate instance (toggle docker socket, network policy, etc.)
  fastify.post('/api/instances/:id/recreate', {
    schema: {
      body: {
        type: 'object',
        properties: {
          dockerSocket: { type: 'boolean' },
          networkPolicy: { type: 'string', enum: NETWORK_POLICIES },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { dockerSocket, networkPolicy } = request.body;
    const dbData = getInstance(id);
    let result;
    try {
      result = await recreateInstance(id, { dockerSocket, networkPolicy });
    } catch (err) {
      // A placement refusal is a decision, not a failure: hand the code back.
      if (err.statusCode && err.code) return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      throw err;
    }

    // Update SQLite with new docker ID if it changed
    if (dbData && result.dockerId !== dbData.docker_id) {
      upsertInstance({
        id,
        dockerId: result.dockerId,
        name: dbData.name,
        image: dbData.image,
      });
    }

    // Update proxy ACL with new policy
    try {
      await writeContainerACL(id, { networkPolicy: networkPolicy || result.networkPolicy || 'unrestricted' });
    } catch { /* best effort */ }

    const details = [];
    if (dockerSocket !== undefined) details.push(`Docker socket: ${dockerSocket ? 'enabled' : 'disabled'}`);
    if (networkPolicy !== undefined) details.push(`Policy: ${networkPolicy}`);
    logActivity('recreated', id, dbData?.name || id, details.join(', ') || 'Settings changed');
    return result;
  });

  // Update an instance to the latest workspace image (latest Claude Code).
  // Recreates the container preserving the workspace volume + all binds — data
  // is retained; only the image (and thus the Claude Code version) changes.
  fastify.post('/api/instances/:id/update-claude', async (request, reply) => {
    const { id } = request.params;
    const dbData = getInstance(id);
    let result;
    try {
      result = await recreateInstance(id, { updateImage: true });
    } catch (err) {
      reply.code(err.statusCode || 500);
      return err.code ? { error: err.message, code: err.code } : { error: err.message };
    }

    if (dbData && result.dockerId !== dbData.docker_id) {
      upsertInstance({ id, dockerId: result.dockerId, name: dbData.name, image: result.image });
    }
    setInstanceClaudeVersion(id, getCurrentImageVersion());

    // Re-assert proxy ACLs for the freshly created container (full sync keeps
    // approved extra hosts, which a bare writeContainerACL would drop)
    try {
      await syncAllACLs();
    } catch { /* best effort */ }

    logActivity('updated', id, dbData?.name || id, `Claude Code → ${getCurrentImageVersion() || 'latest'}`);
    return result;
  });

  // Execute command in instance (for testing/admin)
  fastify.post('/api/instances/:id/exec', {
    schema: {
      body: {
        type: 'object',
        required: ['cmd'],
        properties: {
          cmd: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { cmd } = request.body;
    try {
      const output = await execInContainer(id, cmd);
      return { output };
    } catch (err) {
      reply.code(err.statusCode || 500);
      return { error: err.message };
    }
  });

  // Remove instance
  fastify.delete('/api/instances/:id', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          removeVolume: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request) => {
    const { id } = request.params;
    const { removeVolume } = request.query;
    const dbData = getInstance(id);
    const instanceName = dbData?.name || id;

    // Clean up LiteLLM key
    if (litellmAvailable()) {
      try {
        const { getLiteLLMKey } = await import('../db.js');
        const key = getLiteLLMKey(id);
        if (key) await deleteVirtualKey(key);
      } catch { /* best effort */ }
    }

    await removeInstance(id, { removeVolume });
    deleteGrantsForInstance(id);
    removeContainerACL(id);
    deleteInstanceUsage(id);
    deleteInstanceScan(id);
    deleteInstance(id);
    logActivity('removed', id, instanceName, removeVolume ? 'Volume removed' : 'Volume kept');
    return { ok: true };
  });
}

function mergeInstances(dockerContainers, dbInstances) {
  const dbMap = new Map(dbInstances.map((i) => [i.id, i]));
  const usageMap = new Map(getAllInstanceUsage().map((u) => [u.instance_id, u]));
  const scanMap = getAllScanSummaries();
  const currentImageVersion = getCurrentImageVersion();

  return dockerContainers.map((container) => {
    const dbData = dbMap.get(container.id);
    const grants = getGrantsForInstance(container.id);
    const accessRequests = getAccessRequestsForInstance(container.id);
    const pendingRequests = accessRequests.filter(r => r.status === 'pending').length;
    const hasCustomHosts = accessRequests.some(r => r.status === 'approved' && r.requested_hosts?.length > 0);
    const usageRow = usageMap.get(container.id);
    return {
      ...container,
      // Which host runs this instance. Docker does not know; the registry does.
      hostId: container.hostId || dbData?.host_id || DEFAULT_HOST_ID,
      name: dbData?.name || container.name,
      notes: dbData?.notes || null,
      tags: dbData?.tags || [],
      grants,
      pendingRequests,
      hasCustomHosts,
      claudeVersion: dbData?.claude_version || null,
      updateAvailable: !!(dbData?.claude_version && currentImageVersion && dbData.claude_version !== currentImageVersion),
      usage: usageRow ? {
        contextTokens: usageRow.context_tokens,
        outputTokens: usageRow.output_tokens,
        // null, not zeros: an instance last seen by an older hook has a total
        // but no split, and "0 cached" would be a different claim from "unknown".
        split: (usageRow.input_tokens || usageRow.cache_read_tokens || usageRow.cache_creation_tokens)
          ? {
            input: usageRow.input_tokens,
            cacheRead: usageRow.cache_read_tokens,
            cacheCreation: usageRow.cache_creation_tokens,
          }
          : null,
        statusMessage: usageRow.status_message || null,
        model: usageRow.model,
        lastEvent: usageRow.last_event,
        updatedAt: usageRow.updated_at,
      } : null,
      scan: (() => {
        const s = scanMap.get(container.id);
        return s ? {
          critical: s.critical, high: s.high, medium: s.medium, low: s.low,
          secrets: s.secrets, verifiedSecrets: s.verified_secrets, error: s.error, scannedAt: s.scanned_at,
        } : null;
      })(),
    };
  });
}

// Push an event to every dashboard WebSocket. Exported so other modules can use
// it directly: decorators set inside these (encapsulated) route plugins are not
// visible at the root, so the old decorate/wire hand-off silently did nothing.
export function broadcast(data) {
  const message = typeof data === 'string' ? data : JSON.stringify(data);
  for (const client of connectedClients) {
    try {
      client.send(message);
    } catch {
      connectedClients.delete(client);
    }
  }
}

// Docker container events that change what the dashboard shows. Everything
// else is ignored — in particular exec_create/exec_start/exec_die, which fire
// for every `docker exec` (terminal clipboard poll, scans, cm-notify reads).
// Broadcasting those made each open terminal trigger ~6 full instance-list
// refetches per second in every browser tab.
const LIFECYCLE_ACTIONS = new Set([
  'create', 'start', 'restart', 'stop', 'die', 'kill', 'oom',
  'pause', 'unpause', 'destroy', 'rename', 'update', 'health_status',
]);

export function isLifecycleAction(action) {
  return LIFECYCLE_ACTIONS.has(String(action || '').split(':')[0]);
}

let aclResyncTimer = null;
function scheduleAclResync(log) {
  // A (re)started container may have a new IP and a stopped one frees its IP
  // for reuse — keep squid ACLs keyed to the IPs that are live right now.
  clearTimeout(aclResyncTimer);
  aclResyncTimer = setTimeout(() => {
    syncAllACLs().catch((err) => log.error({ err }, 'ACL resync after container event failed'));
  }, 1500);
}

const CONNECTING = Symbol('connecting');
const streamBackoff = new Map();   // hostId -> ms until the next attempt is allowed

async function startHostEventStream(log, hostId) {
  // The sentinel is the fix for duplicate events. Without it the map was empty
  // for the whole of the await below — up to 20s for a dead SSH host — so the
  // retry and the reconcile both started attempts, each one set the map on
  // success, the last won, and the orphans kept broadcasting: every container
  // event delivered N times.
  if (eventStreams.has(hostId)) return;
  if (!getHost(hostId)?.enabled) return;
  eventStreams.set(hostId, CONNECTING);
  try {
    const stream = await getEventStream(hostId);
    if (eventStreams.get(hostId) !== CONNECTING) {
      // Something else won the race after all; this one is surplus.
      try { stream.destroy(); } catch { /* ignore */ }
      return;
    }
    eventStreams.set(hostId, stream);
    streamBackoff.delete(hostId);
    log.info({ hostId }, 'Docker event stream connected');

    let pending = '';
    stream.on('data', (chunk) => {
      // Events are newline-delimited JSON; a chunk may hold several or a partial one
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        const attrs = event.Actor?.Attributes || {};
        const managerId = attrs['claude-manager.id'];
        if (!managerId) continue;

        if (!isLifecycleAction(event.Action)) continue;
        const action = String(event.Action).split(':')[0];

        const ctx = { instanceId: managerId, instance: attrs['claude-manager.name'] || attrs.name, action };
        if (action === 'die') {
          ctx.exitCode = Number(attrs.exitCode);
          // 0 = clean, 137 = SIGKILL (docker stop timeout / OOM / external kill), 143 = SIGTERM
          log[ctx.exitCode === 0 || ctx.exitCode === 143 ? 'info' : 'warn'](ctx, `instance exited with code ${attrs.exitCode}`);
        } else if (action === 'oom') {
          log.error(ctx, 'instance hit its memory limit (OOM)');
        } else if (action === 'kill') {
          ctx.signal = attrs.signal;
          log.info(ctx, `instance sent signal ${attrs.signal}`);
        } else if (action === 'health_status') {
          log.debug(ctx, event.Action);
        } else {
          log.info(ctx, `instance ${action}`);
        }

        if (action === 'start' || action === 'die') scheduleAclResync(log);

        let type;
        if (action === 'create') type = WS_EVENTS.INSTANCE_CREATED;
        else if (action === 'destroy') type = WS_EVENTS.INSTANCE_REMOVED;
        else type = WS_EVENTS.INSTANCE_UPDATED;

        broadcast({ type, id: managerId, action, timestamp: event.time });
      }
    });

    // 'error' and 'end' both fire on a dropped stream; the identity check keeps
    // that from starting two reconnect chains for the same host.
    // 'error' and 'end' both fire on a dropped stream; the identity check keeps
    // that from tearing down a replacement. Reconnection is NOT scheduled here
    // — the reconcile is the only scheduler, so there is exactly one attempt
    // chain per host, with back-off.
    const dropped = (why) => {
      if (eventStreams.get(hostId) !== stream) return;
      eventStreams.delete(hostId);
      try { stream.destroy(); } catch { /* already gone */ }
      log.warn({ hostId }, `Docker event stream ${why}; the reconcile will reconnect`);
    };
    stream.on('error', (err) => { log.error({ err, hostId }, 'Docker event stream error'); dropped('errored'); });
    stream.on('end', () => dropped('ended'));
  } catch (err) {
    if (eventStreams.get(hostId) === CONNECTING) eventStreams.delete(hostId);
    const prev = streamBackoff.get(hostId) || 0;
    const next = Math.min(60_000, Math.max(5_000, prev * 2));
    streamBackoff.set(hostId, next);
    // Log on first failure and when the back-off grows, not every attempt.
    if (next !== prev) log.error({ err: err.message, hostId, retryInMs: next }, 'Failed to start Docker event stream');
  }
}

/** Tear down one host's stream — a disabled, deleted or re-addressed host. */
export function stopHostEventStream(hostId) {
  const s = eventStreams.get(hostId);
  eventStreams.delete(hostId);
  streamBackoff.delete(hostId);
  if (s && s !== CONNECTING) { try { s.destroy(); } catch { /* ignore */ } }
}

/** After a PATCH that may have changed address/port/key: drop and let the reconcile reconnect. */
export function restartHostEventStream(hostId) {
  stopHostEventStream(hostId);
  lastAttempt.delete(hostId);
}

/**
 * Watch every enabled host, and keep watching: hosts can be registered at
 * runtime, and a host that was unreachable at boot must not stay unwatched.
 */
const lastAttempt = new Map();     // hostId -> timestamp of the last connect attempt

function startEventStream(log) {
  // The one scheduler. Runs every 5s but a host is only retried once its
  // back-off has elapsed, so a dead host costs one attempt per minute at most,
  // a live host reconnects within seconds, and a host registered or re-enabled
  // at runtime is picked up without a restart. Streams for hosts that are no
  // longer enabled are torn down here too.
  const reconcile = () => {
    let hosts;
    try { hosts = getHosts(); } catch { return; }
    const now = Date.now();
    for (const h of hosts) {
      if (!h.enabled) { if (eventStreams.has(h.id)) stopHostEventStream(h.id); continue; }
      if (eventStreams.has(h.id)) continue;
      const wait = streamBackoff.get(h.id) || 0;
      if (now - (lastAttempt.get(h.id) || 0) < wait) continue;
      lastAttempt.set(h.id, now);
      startHostEventStream(log, h.id);
    }
    for (const id of [...eventStreams.keys()]) {
      if (!hosts.some((h) => h.id === id)) stopHostEventStream(id);
    }
  };
  reconcile();
  streamReconcile = setInterval(reconcile, 5_000);
  streamReconcile.unref?.();
}

export function stopEventStream() {
  if (streamReconcile) { clearInterval(streamReconcile); streamReconcile = null; }
  for (const hostId of [...eventStreams.keys()]) stopHostEventStream(hostId);
}
