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

// Resolve the path the router actually matched, NOT the raw URL.
// Fastify/find-my-way percent-decodes the path for routing, but request.url
// stays raw — so a guard on request.url ("/api"...) is bypassable with
// "/%61pi/..." which still routes to the /api handler. Always decode first.
export function normalizePath(rawUrl) {
  const rawPath = rawUrl.split('?')[0];
  let decoded = rawPath;
  // Decode until stable (defends against multi-encoded "/%2561pi/...").
  for (let i = 0; i < 3; i++) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      // Malformed escape — treat as a non-matching path so auth still applies.
      return decoded;
    }
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

export function registerAuthHooks(fastify) {
  fastify.addHook('onRequest', async (request, reply) => {
    const urlPath = normalizePath(request.url);

    // Skip non-API routes (static files / SPA)
    if (!urlPath.startsWith('/api')) return;

    // Skip auth endpoints
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
