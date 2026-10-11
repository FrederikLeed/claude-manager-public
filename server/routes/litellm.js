import { isAvailable, getModelList, getKeyInfo, getHealth, litellmFetch, deleteVirtualKey } from '../litellm.js';
import { recreateInstance } from '../docker.js';
import { getLiteLLMKeyHash, hashKey } from '../db.js';
import { BACKENDS, listRoutes, routesForBackend } from '../llm-routing.js';

export default async function litellmRoutes(fastify) {
  // LiteLLM availability
  fastify.get('/api/litellm/status', async () => {
    const available = isAvailable();
    const healthy = available ? await getHealth() : false;
    return { available, healthy };
  });

  // Available models
  fastify.get('/api/litellm/models', async () => {
    if (!isAvailable()) return [];
    return getModelList();
  });

  // Backends and the models each one can pin, for the New Instance dialog.
  fastify.get('/api/llm/backends', async () => {
    const routes = isAvailable() ? await listRoutes().catch(() => []) : [];
    const copilotModels = routes.filter((r) => r.startsWith('ghcopilot/')).map((r) => r.slice('ghcopilot/'.length));
    return Object.entries(BACKENDS).map(([id, b]) => ({
      id,
      label: b.label,
      agent: b.agent,
      paid: !!b.paid,
      routed: !!b.routed,
      defaultModel: b.defaultModel || null,
      models: b.cliModels ? copilotModels : routesForBackend(id, routes),
      available: !b.retired && (!b.routed || routesForBackend(id, routes).length > 0),
    }));
  });

  // Instance LiteLLM key info + spend
  fastify.get('/api/instances/:id/litellm', async (request, reply) => {
    const { id } = request.params;
    if (!isAvailable()) {
      return { available: false };
    }

    const keyHash = getLiteLLMKeyHash(id);
    if (!keyHash) {
      return { available: true, key: null };
    }

    const info = await getKeyInfo(keyHash);
    return {
      available: true,
      // The manager keeps only the hash; show the alias, never key material.
      key: info?.info?.key_alias || `cm-${id}`,
      spend: info?.info?.spend || 0,
      maxBudget: info?.info?.max_budget || null,
      models: info?.info?.models || [],
    };
  });

  // Rotate instance key: a replacement with the same scope, budget and spend so
  // far goes into a recreated container; only then is the old key revoked. It
  // used to change only the database, leaving the instance on a deleted key.
  fastify.post('/api/instances/:id/litellm/rotate', async (request, reply) => {
    const { id } = request.params;
    if (!isAvailable()) {
      const err = new Error('LiteLLM not configured');
      err.statusCode = 503;
      throw err;
    }
    const oldHash = getLiteLLMKeyHash(id);
    if (!oldHash) return reply.code(409).send({ error: 'This instance has no LiteLLM key of its own', code: 'no_instance_key' });
    const info = (await getKeyInfo(oldHash))?.info;
    if (!info?.models?.length) return reply.code(409).send({ error: 'The current key has no model scope to copy', code: 'key_scope_unknown' });

    const fresh = await litellmFetch('/key/generate', {
      method: 'POST',
      body: {
        key_alias: `cm-${id}-rotating`,
        models: info.models,
        max_budget: info.max_budget ?? null,
        spend: info.spend || 0,
        metadata: info.metadata || {},
      },
    });
    try {
      await recreateInstance(id, { litellmKey: fresh.key });
    } catch (err) {
      await deleteVirtualKey(fresh.key).catch(() => {});
      throw err;
    }
    await deleteVirtualKey(oldHash).catch(() => {});
    await litellmFetch('/key/update', { method: 'POST', body: { key: hashKey(fresh.key), key_alias: `cm-${id}` } }).catch(() => {});
    return { ok: true, key: `cm-${id}` };
  });
}
