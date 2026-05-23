import { isAvailable, getModelList, getKeyInfo, rotateVirtualKey, getHealth } from '../litellm.js';
import { getLiteLLMKey, setLiteLLMKey, clearLiteLLMKey, getInstance } from '../db.js';

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

  // Instance LiteLLM key info + spend
  fastify.get('/api/instances/:id/litellm', async (request, reply) => {
    const { id } = request.params;
    if (!isAvailable()) {
      return { available: false };
    }

    const key = getLiteLLMKey(id);
    if (!key) {
      return { available: true, key: null };
    }

    const info = await getKeyInfo(key);
    return {
      available: true,
      key: key.slice(0, 8) + '...',
      spend: info?.info?.spend || info?.spend || 0,
      maxBudget: info?.info?.max_budget || info?.max_budget || null,
      models: info?.info?.models || info?.models || [],
    };
  });

  // Rotate instance key
  fastify.post('/api/instances/:id/litellm/rotate', async (request) => {
    const { id } = request.params;
    if (!isAvailable()) {
      const err = new Error('LiteLLM not configured');
      err.statusCode = 503;
      throw err;
    }

    const oldKey = getLiteLLMKey(id);
    const dbData = getInstance(id);
    const instanceName = dbData?.name || id;

    const result = await rotateVirtualKey(oldKey, id, instanceName);
    if (result?.key) {
      setLiteLLMKey(id, result.key);
    }

    return { ok: true, key: result?.key?.slice(0, 8) + '...' };
  });
}
