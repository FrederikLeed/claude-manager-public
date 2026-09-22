import {
  getConnectivityStatus, runSmokeTest, lintPolicies,
} from '../connectivity-check.js';

export default async function connectivityCheckRoutes(fastify) {
  // Last smoke-test result + whether one is running.
  fastify.get('/api/connectivity-check', async () => getConnectivityStatus());

  // Static policy lint (every restricted claude-* policy allowlists required hosts).
  fastify.get('/api/connectivity-check/lint', async () => lintPolicies());

  // Trigger a smoke test on demand (admin) — background.
  fastify.post('/api/connectivity-check/run', async (request, reply) => {
    if (!request.device?.is_admin) { reply.code(403); return { error: 'Admin only' }; }
    if (getConnectivityStatus().running) { reply.code(409); return { error: 'Check already running' }; }
    const policy = request.body?.policy;
    runSmokeTest(fastify.log, { reason: 'manual', ...(policy ? { policy } : {}) })
      .catch((err) => fastify.log.error({ err }, 'connectivity check run failed'));
    reply.code(202);
    return { ok: true, ...getConnectivityStatus() };
  });

}
