import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import fastifyCookie from '@fastify/cookie';

import { config } from './config.js';
import { initDb, syncWithDocker, closeDb } from './db.js';
import { ensureNetwork, listManagedContainers } from './docker.js';
import { registerAuthHooks } from './auth.js';
import instanceRoutes, { stopEventStream } from './routes/instances.js';
import terminalRoutes, { closeAllSessions, getActiveSessionCount } from './routes/terminal.js';
import systemRoutes from './routes/system.js';
import sharedRoutes from './routes/shared.js';
import authRoutes from './routes/auth.js';
import grantRoutes from './routes/grants.js';
import litellmRoutes from './routes/litellm.js';
import policyRoutes from './routes/policies.js';
import accessRequestRoutes from './routes/access-requests.js';
import workspaceImageRoutes from './routes/workspace-image.js';
import { checkExpiredGrants } from './grants.js';
import { syncAllACLs } from './proxy.js';
import { initImageState, checkAndMaybeRebuild } from './workspace-image.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function start() {
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
  });

  // Register plugins
  await fastify.register(fastifyWebsocket);
  await fastify.register(fastifyCookie);
  await fastify.register(fastifyCors, {
    origin: config.NODE_ENV === 'development' ? true : false,
    credentials: true,
  });

  // Error handler — MUST be set before route registration in Fastify 5
  fastify.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode || error.status || 500;
    fastify.log.error({ err: error, url: request.url }, 'Request error');
    reply.code(statusCode).send({
      error: error.message || 'Internal server error',
    });
  });

  // SPA fallback — serve index.html for non-API routes
  fastify.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api')) {
      fastify.log.warn({ method: request.method, url: request.url }, 'API route not found');
      reply.code(404).send({ error: `Not found: ${request.method} ${request.url}` });
    } else {
      reply.sendFile('index.html');
    }
  });

  // Auth middleware — gates all /api routes except /api/auth/*
  registerAuthHooks(fastify);

  // Serve built frontend in production
  const distPath = path.join(__dirname, '..', 'dist');
  await fastify.register(fastifyStatic, {
    root: distPath,
    prefix: '/',
    wildcard: false,
    decorateReply: true,
  });

  // Register API routes
  await fastify.register(authRoutes);
  await fastify.register(instanceRoutes);
  await fastify.register(terminalRoutes);
  await fastify.register(systemRoutes);
  await fastify.register(sharedRoutes);
  await fastify.register(grantRoutes);
  await fastify.register(litellmRoutes);
  await fastify.register(policyRoutes);
  await fastify.register(accessRequestRoutes);
  await fastify.register(workspaceImageRoutes);

  // Let the workspace-image module push build status over the same WS channel
  fastify.wireImageBroadcaster?.(fastify.accessRequestBroadcast);

  // Start grant expiry checker (every 60s)
  const grantCheckInterval = setInterval(() => {
    checkExpiredGrants(null, fastify.log);
  }, 60_000);

  // Keep the workspace image current with the latest Claude Code
  let imageUpdateInterval = null;
  if (config.IMAGE_UPDATE_INTERVAL_HOURS > 0 && config.WORKSPACE_SRC_DIR) {
    imageUpdateInterval = setInterval(() => {
      checkAndMaybeRebuild(fastify.log);
    }, config.IMAGE_UPDATE_INTERVAL_HOURS * 3_600_000);
  }

  // Graceful shutdown — close terminal sessions, event stream, grant timer, DB
  fastify.addHook('onClose', () => {
    clearInterval(grantCheckInterval);
    if (imageUpdateInterval) clearInterval(imageUpdateInterval);
    const sessionCount = getActiveSessionCount();
    if (sessionCount > 0) {
      fastify.log.info(`Closing ${sessionCount} active terminal sessions...`);
    }
    closeAllSessions();
    stopEventStream();
    closeDb();
  });

  // Startup sequence
  try {
    // Initialize database
    initDb();
    fastify.log.info(`Database initialized at ${config.DATA_DIR}/manager.db`);

    // Ensure Docker network exists
    await ensureNetwork();
    fastify.log.info(`Docker network "${config.CLAUDE_NETWORK}" ready`);

    // Sync SQLite with Docker
    const containers = await listManagedContainers();
    syncWithDocker(containers);
    fastify.log.info(`Synced ${containers.length} managed containers`);

    // Sync proxy ACLs for all running containers
    await syncAllACLs();
    fastify.log.info('Proxy ACLs synced');

    // Determine current/latest Claude Code version, then run a catch-up check
    // (rebuilds in the background only if npm has a newer version).
    await initImageState(fastify.log);
    if (config.WORKSPACE_SRC_DIR) {
      checkAndMaybeRebuild(fastify.log);
    }
  } catch (err) {
    fastify.log.error({ err }, 'Startup initialization failed');
    // Continue anyway — Docker may not be available in dev without socket
  }

  // Print registered routes for debugging
  const routes = fastify.printRoutes({ commonPrefix: false });
  fastify.log.info(`Registered routes:\n${routes}`);

  // Start server
  const port = config.NODE_ENV === 'development' ? config.DEV_PORT : config.PORT;
  await fastify.listen({ port, host: '0.0.0.0' });
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
