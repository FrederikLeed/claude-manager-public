import {
  listManagedContainers,
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
  getInstance,
  getAllInstances,
  updateInstance,
  deleteInstance,
  logActivity,
  deleteGrantsForInstance,
  getGrantsForInstance,
  getAccessRequestsForInstance,
} from '../db.js';
import { WS_EVENTS, NETWORK_POLICIES } from '../../shared/constants.js';
import { createGrantsForInstance } from '../grants.js';
import { isAvailable as litellmAvailable, createVirtualKey, deleteVirtualKey } from '../litellm.js';
import { writeContainerACL, removeContainerACL } from '../proxy.js';

const connectedClients = new Set();
let eventStream = null;

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

  // Expose broadcast for access requests route
  fastify.decorate('accessRequestBroadcast', (data) => broadcast(data));

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
    const dockerContainers = await listManagedContainers();
    const dbInstances = getAllInstances();
    return mergeInstances(dockerContainers, dbInstances);
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
        },
      },
    },
  }, async (request, reply) => {
    const { name, image, notes, tags, autoStart, dockerSocket, networkPolicy, llmBackend, expiryHours } = request.body;

    const instance = await createInstance({ name, image, autoStart, dockerSocket, networkPolicy: networkPolicy || 'unrestricted', llmBackend: llmBackend || 'claude-max' });
    upsertInstance({
      id: instance.id,
      name,
      image: instance.image,
      notes,
      tags,
    });

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
  }, async (request) => {
    const { id } = request.params;
    const { dockerSocket, networkPolicy } = request.body;
    const dbData = getInstance(id);
    const result = await recreateInstance(id, { dockerSocket, networkPolicy });

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
    deleteInstance(id);
    logActivity('removed', id, instanceName, removeVolume ? 'Volume removed' : 'Volume kept');
    return { ok: true };
  });
}

function mergeInstances(dockerContainers, dbInstances) {
  const dbMap = new Map(dbInstances.map((i) => [i.id, i]));

  return dockerContainers.map((container) => {
    const dbData = dbMap.get(container.id);
    const grants = getGrantsForInstance(container.id);
    const accessRequests = getAccessRequestsForInstance(container.id);
    const pendingRequests = accessRequests.filter(r => r.status === 'pending').length;
    const hasCustomHosts = accessRequests.some(r => r.status === 'approved' && r.requested_hosts?.length > 0);
    return {
      ...container,
      name: dbData?.name || container.name,
      notes: dbData?.notes || null,
      tags: dbData?.tags || [],
      grants,
      pendingRequests,
      hasCustomHosts,
    };
  });
}

function broadcast(data) {
  const message = typeof data === 'string' ? data : JSON.stringify(data);
  for (const client of connectedClients) {
    try {
      client.send(message);
    } catch {
      connectedClients.delete(client);
    }
  }
}

async function startEventStream(log) {
  try {
    eventStream = await getEventStream();

    eventStream.on('data', (chunk) => {
      try {
        const event = JSON.parse(chunk.toString());
        const managerId = event.Actor?.Attributes?.['claude-manager.id'];
        if (!managerId) return;

        const action = event.Action;
        let type;
        if (action === 'create') type = WS_EVENTS.INSTANCE_CREATED;
        else if (action === 'destroy') type = WS_EVENTS.INSTANCE_REMOVED;
        else type = WS_EVENTS.INSTANCE_UPDATED;

        broadcast({ type, id: managerId, action, timestamp: event.time });
      } catch {
        // Ignore malformed events
      }
    });

    eventStream.on('error', (err) => {
      log.error({ err }, 'Docker event stream error, reconnecting...');
      setTimeout(() => startEventStream(log), 3000);
    });

    eventStream.on('end', () => {
      log.warn('Docker event stream ended, reconnecting...');
      setTimeout(() => startEventStream(log), 3000);
    });
  } catch (err) {
    log.error({ err }, 'Failed to start Docker event stream, retrying...');
    setTimeout(() => startEventStream(log), 5000);
  }
}

export function stopEventStream() {
  if (eventStream) {
    eventStream.destroy();
    eventStream = null;
  }
}
