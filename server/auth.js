import crypto from 'crypto';
import { getDeviceByTokenHash, getInstance } from './db.js';
import { instanceForIp } from './proxy-log.js';
import { moduleLogger } from './logger.js';

const log = moduleLogger('auth');

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

/**
 * Does this request really come from the instance named in its path?
 *
 * Two independent proofs, either of which is sufficient:
 *  - the per-instance token injected as CM_EVENT_TOKEN at create time, or
 *  - the source address resolving to that same instance's container.
 *
 * The address check carries instances created before the token existed; they
 * can still only speak for themselves, because the IP is their own.
 */
async function callerIsInstance(request, claimedId) {
  if (!claimedId) return false;

  const row = (() => { try { return getInstance(claimedId); } catch { return null; } })();

  const presented = (request.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (row?.event_token && presented) {
    const expected = Buffer.from(row.event_token);
    const actual = Buffer.from(hashToken(presented));
    if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) return true;
  }

  // No token on record: this instance predates the scheme. Fall back to the
  // address, which is what the proxy log already uses to attribute denials.
  const byIp = await instanceForIp(request.ip).catch(() => null);
  if (byIp?.id && byIp.id === claimedId) return true;

  // A token exists but was wrong or missing, and the address does not match.
  return false;
}

export function registerAuthHooks(fastify) {
  fastify.addHook('onRequest', async (request, reply) => {
    const urlPath = normalizePath(request.url);

    // Skip non-API routes (static files / SPA)
    if (!urlPath.startsWith('/api')) return;

    // Skip auth endpoints
    if (AUTH_EXEMPT.includes(urlPath)) return;

    // Container callbacks are exempt from DEVICE auth, but not from proving who
    // they are. The instance id comes from the URL, so without this check any
    // container on the network — or anything on the LAN that reaches the
    // manager — could file an access request as a different instance, and an
    // admin approving it would widen THAT instance's allowlist.
    const callback = AUTH_EXEMPT_PATTERNS.find((p) => p.test(urlPath));
    if (callback) {
      const claimed = urlPath.split('/')[3];
      const ok = await callerIsInstance(request, claimed);
      if (!ok) {
        log.warn(
          { claimed, ip: request.ip, path: urlPath },
          'rejected container callback: caller could not prove it is this instance',
        );
        reply.code(403).send({ error: 'Caller is not this instance' });
        return;
      }
      return;
    }

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
