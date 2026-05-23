import { getDockerInfo, listManagedContainers } from '../docker.js';
import { config } from '../config.js';
import { getActivityLog } from '../db.js';

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
}
