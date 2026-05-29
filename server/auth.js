import crypto from 'crypto';
import { getDeviceByTokenHash } from './db.js';

const COOKIE_NAME = 'cm_device_token';
const AUTH_EXEMPT = ['/api/auth/register', '/api/auth/status', '/api/policies'];
// Patterns exempt from auth — called from inside containers
const AUTH_EXEMPT_PATTERNS = [
  /^\/api\/instances\/[^/]+\/request-access$/,
  /^\/api\/instances\/[^/]+\/access$/,
  // Reported from inside a container by the Claude Code Stop/Notification hook
  /^\/api\/instances\/[^/]+\/event$/,
];

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function registerAuthHooks(fastify) {
  fastify.addHook('onRequest', async (request, reply) => {
    // Skip non-API routes (static files / SPA)
    if (!request.url.startsWith('/api')) return;

    // Skip auth endpoints
    const urlPath = request.url.split('?')[0];
    if (AUTH_EXEMPT.includes(urlPath)) return;
    if (AUTH_EXEMPT_PATTERNS.some(p => p.test(urlPath))) return;

    const token = request.cookies?.[COOKIE_NAME];
    if (!token) {
      reply.code(401).send({ error: 'Device not registered' });
      return;
    }

    const tokenHash = hashToken(token);
    const device = getDeviceByTokenHash(tokenHash);

    if (!device) {
      reply.clearCookie(COOKIE_NAME, { path: '/' });
      reply.code(401).send({ error: 'Device not recognized' });
      return;
    }

    if (!device.approved) {
      reply.code(403).send({ error: 'Device pending approval', deviceId: device.id });
      return;
    }

    // Attach device to request for route handlers
    request.device = device;
  });
}
