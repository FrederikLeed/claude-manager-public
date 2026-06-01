import { getScanStatus, scanAll, setScanBroadcaster } from '../security-scan.js';
import { getInstanceScan } from '../db.js';

export default async function securityScanRoutes(fastify) {
  // Scan status (running? last run? enabled?)
  fastify.get('/api/security-scan', async () => getScanStatus());

  // Trigger a scan of all running instances (admin) — runs in background
  fastify.post('/api/security-scan/run', async (request, reply) => {
    if (!request.device?.is_admin) { reply.code(403); return { error: 'Admin only' }; }
    if (getScanStatus().scanning) { reply.code(409); return { error: 'Scan already in progress' }; }
    scanAll(fastify.log).catch((err) => fastify.log.error({ err }, 'security scan run failed'));
    reply.code(202);
    return { ok: true, ...getScanStatus() };
  });

  // Scan a single instance (admin) — background
  fastify.post('/api/instances/:id/scan', async (request, reply) => {
    if (!request.device?.is_admin) { reply.code(403); return { error: 'Admin only' }; }
    if (getScanStatus().scanning) { reply.code(409); return { error: 'Scan already in progress' }; }
    scanAll(fastify.log, { only: request.params.id })
      .catch((err) => fastify.log.error({ err }, 'instance scan failed'));
    reply.code(202);
    return { ok: true };
  });

  // Full findings for one instance (for the details modal)
  fastify.get('/api/instances/:id/scan', async (request) => {
    const s = getInstanceScan(request.params.id);
    if (!s) return { findings: [], scannedAt: null };
    return {
      critical: s.critical, high: s.high, medium: s.medium, low: s.low,
      secrets: s.secrets, verifiedSecrets: s.verified_secrets, error: s.error, scannedAt: s.scanned_at, findings: s.findings,
    };
  });

  fastify.decorate('wireScanBroadcaster', (fn) => setScanBroadcaster(fn));
}
