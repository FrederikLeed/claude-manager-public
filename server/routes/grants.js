import {
  getGrantsForInstance,
  getGrantById,
  renewGrant as dbRenewGrant,
  deactivateGrant,
  createGrant,
  logActivity,
  getInstance,
} from '../db.js';
import { startInstance } from '../docker.js';
import { recreateWithoutCapability } from '../grants.js';
import { DEFAULT_EXPIRY_MS } from '../../shared/constants.js';

export default async function grantRoutes(fastify) {
  // List grants for an instance
  fastify.get('/api/instances/:id/grants', async (request) => {
    const { id } = request.params;
    return getGrantsForInstance(id);
  });

  // Create a grant manually
  fastify.post('/api/instances/:id/grants', {
    schema: {
      body: {
        type: 'object',
        required: ['capabilityName'],
        properties: {
          capabilityName: { type: 'string' },
          expiryHours: { type: 'number', minimum: 1, default: 24 },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { capabilityName, expiryHours } = request.body;
    const expiresAt = new Date(Date.now() + (expiryHours || 24) * 3600000).toISOString();
    createGrant({ instanceId: id, capabilityName, expiresAt, source: 'manual' });
    logActivity('grant_created', id, null, `${capabilityName} expires at ${expiresAt}`);
    reply.code(201);
    return { ok: true };
  });

  // Renew a grant
  fastify.post('/api/grants/:grantId/renew', {
    schema: {
      body: {
        type: 'object',
        properties: {
          durationHours: { type: 'number', minimum: 1, default: 24 },
        },
      },
    },
  }, async (request) => {
    const { grantId } = request.params;
    const { durationHours } = request.body || {};
    const grant = getGrantById(parseInt(grantId));
    if (!grant) {
      const err = new Error('Grant not found');
      err.statusCode = 404;
      throw err;
    }

    const newExpiresAt = new Date(Date.now() + (durationHours || 24) * 3600000).toISOString();
    dbRenewGrant(grant.id, newExpiresAt);

    // Restart the container if it was stopped by expiry
    try {
      await startInstance(grant.instance_id);
    } catch {
      // May already be running
    }

    logActivity('grant_renewed', grant.instance_id, null, `${grant.capability_name} renewed until ${newExpiresAt}`);
    return { ok: true, expiresAt: newExpiresAt };
  });

  // Recreate without capability
  fastify.post('/api/grants/:grantId/recreate', async (request) => {
    const { grantId } = request.params;
    const grant = getGrantById(parseInt(grantId));
    if (!grant) {
      const err = new Error('Grant not found');
      err.statusCode = 404;
      throw err;
    }

    const result = await recreateWithoutCapability(grant.instance_id, grant.capability_name);
    deactivateGrant(grant.id);
    logActivity('grant_recreated', grant.instance_id, null, `Recreated without ${grant.capability_name}`);
    return result;
  });

  // Deactivate a grant
  fastify.delete('/api/grants/:grantId', async (request) => {
    const { grantId } = request.params;
    deactivateGrant(parseInt(grantId));
    return { ok: true };
  });
}
