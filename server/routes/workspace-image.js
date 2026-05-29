import {
  getImageStatus, buildWorkspaceImage, fetchLatestClaudeVersion, setImageBroadcaster,
} from '../workspace-image.js';

export default async function workspaceImageRoutes(fastify) {
  // Current vs latest Claude Code version + build state
  fastify.get('/api/workspace-image', async () => {
    return getImageStatus();
  });

  // Force a rebuild to pick up the latest Claude Code (admin only).
  // Returns immediately; the build runs in the background and broadcasts status.
  fastify.post('/api/workspace-image/rebuild', async (request, reply) => {
    if (!request.device?.is_admin) {
      reply.code(403);
      return { error: 'Admin only' };
    }
    const status = getImageStatus();
    if (!status.canRebuild) {
      reply.code(409);
      return { error: 'Workspace build context not available to the manager' };
    }
    if (status.building) {
      reply.code(409);
      return { error: 'A rebuild is already in progress' };
    }

    // Refresh the latest-version reading, then kick off the build async.
    try { await fetchLatestClaudeVersion(); } catch { /* best effort */ }
    buildWorkspaceImage(fastify.log, { reason: 'manual' }).catch(() => { /* state captures error */ });

    reply.code(202);
    return { ok: true, ...getImageStatus() };
  });

  // Wire the WS broadcaster so build status can be pushed to clients
  fastify.decorate('wireImageBroadcaster', (fn) => setImageBroadcaster(fn));
}
