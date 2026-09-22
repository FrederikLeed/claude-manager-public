import { getDockerInfo, listManagedContainers } from '../docker.js';
import { config } from '../config.js';
import { getActivityLog } from '../db.js';
import { getHealthReport, runHealthCheck } from '../health.js';
import { getRecentDenials } from '../proxy-log.js';

export default async function systemRoutes(fastify) {
  fastify.get('/api/system', async () => {
    const [dockerInfo, managed] = await Promise.all([
      getDockerInfo(),
      listManagedContainers(),
    ]);

    return {
      ...dockerInfo,
      managedInstances: managed.length,
      maxInstances: config.MAX_INSTANCES,
      defaultImage: config.CLAUDE_IMAGE,
      network: config.CLAUDE_NETWORK,
    };
  });

  fastify.get('/api/system/activity', async () => {
    return getActivityLog(50);
  });

  // Latest health-monitor report; ?refresh=1 runs the checks now
  fastify.get('/api/system/health', async (request) => {
    return request.query?.refresh ? runHealthCheck() : getHealthReport();
  });

  // Recent squid denials, attributed to instances (newest first)
  fastify.get('/api/system/egress-denials', async () => {
    return getRecentDenials();
  });
}
