import crypto from 'crypto';
import { config } from '../config.js';
import { hashToken } from '../auth.js';
import {
  createDevice,
  getDeviceByTokenHash,
  getAllDevices,
  approveDevice,
  revokeDevice,
  updateDeviceName,
} from '../db.js';

const COOKIE_NAME = 'cm_device_token';
const COOKIE_MAX_AGE = 10 * 365 * 24 * 60 * 60; // 10 years in seconds

function parseUserAgent(ua) {
  if (!ua) return 'Unknown device';
  if (ua.includes('iPhone')) return 'iPhone';
  if (ua.includes('iPad')) return 'iPad';
  if (ua.includes('Android')) return 'Android';
  if (ua.includes('Windows')) return 'Windows';
  if (ua.includes('Mac')) return 'Mac';
  if (ua.includes('Linux')) return 'Linux';
  return 'Unknown device';
}

export default async function authRoutes(fastify) {
  // Register device (first device auto-approved as admin)
  fastify.post('/api/auth/register', async (request, reply) => {
    const { token, name } = request.body || {};

    if (!token || typeof token !== 'string' || token.length < 16) {
      return reply.code(400).send({ error: 'Invalid token' });
    }

    const tokenHash = hashToken(token);

    // Check if device already exists (idempotent)
    const existing = getDeviceByTokenHash(tokenHash);
    if (existing) {
      reply.setCookie(COOKIE_NAME, token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: COOKIE_MAX_AGE,
      });
      return {
        deviceId: existing.id,
        approved: !!existing.approved,
        isAdmin: !!existing.is_admin,
      };
    }

    // Check for admin reset token (emergency recovery)
    const resetToken = request.query?.reset_token;
    const forceAdmin = !!(
      resetToken &&
      config.ADMIN_RESET_TOKEN &&
      resetToken === config.ADMIN_RESET_TOKEN
    );

    const deviceId = crypto.randomUUID().slice(0, 8);
    const ua = request.headers['user-agent'] || '';
    const deviceName = name || parseUserAgent(ua);

    const result = createDevice({
      id: deviceId,
      tokenHash,
      name: forceAdmin ? `${deviceName} (reset)` : deviceName,
      userAgent: ua.slice(0, 500),
      forceAdmin,
    });

    if (forceAdmin) {
      console.log(`[auth] Admin reset used for device "${deviceId}" from ${request.ip}`);
    }

    reply.setCookie(COOKIE_NAME, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: COOKIE_MAX_AGE,
    });

    return {
      deviceId,
      approved: !!result.approved,
      isAdmin: !!result.isAdmin,
    };
  });

  // Check current device status
  fastify.get('/api/auth/status', async (request, reply) => {
    const token = request.cookies?.[COOKIE_NAME];
    if (!token) {
      return { status: 'unknown' };
    }

    const device = getDeviceByTokenHash(hashToken(token));
    if (!device) {
      reply.clearCookie(COOKIE_NAME, { path: '/' });
      return { status: 'unknown' };
    }

    return {
      status: device.approved ? 'approved' : 'pending',
      deviceId: device.id,
      isAdmin: !!device.is_admin,
      name: device.name,
    };
  });

  // List all devices (admin only)
  fastify.get('/api/auth/devices', async (request, reply) => {
    if (!request.device?.is_admin) {
      return reply.code(403).send({ error: 'Admin access required' });
    }
    return getAllDevices();
  });

  // Approve a device (admin only)
  fastify.post('/api/auth/devices/:id/approve', async (request, reply) => {
    if (!request.device?.is_admin) {
      return reply.code(403).send({ error: 'Admin access required' });
    }
    approveDevice(request.params.id);
    return { ok: true };
  });

  // Revoke a device (admin only)
  fastify.delete('/api/auth/devices/:id', async (request, reply) => {
    if (!request.device?.is_admin) {
      return reply.code(403).send({ error: 'Admin access required' });
    }
    if (request.device.id === request.params.id) {
      return reply.code(400).send({ error: 'Cannot revoke your own device' });
    }
    revokeDevice(request.params.id);
    return { ok: true };
  });

  // Rename a device (admin only)
  fastify.patch('/api/auth/devices/:id', async (request, reply) => {
    if (!request.device?.is_admin) {
      return reply.code(403).send({ error: 'Admin access required' });
    }
    const { name } = request.body || {};
    if (!name) {
      return reply.code(400).send({ error: 'Name required' });
    }
    updateDeviceName(request.params.id, name);
    return { ok: true };
  });
}
