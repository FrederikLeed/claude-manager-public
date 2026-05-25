import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import path from 'path';
import { getDockerInfo, listManagedContainers } from '../docker.js';
import { config } from '../config.js';
import { getActivityLog } from '../db.js';

const SOUND_CANDIDATES = [
  'notification-sound.mp3',
  'notification-sound.wav',
  'notification-sound.ogg',
  'notification-sound.aiff',
  'notification-sound.aif',
];

const SOUND_CONTENT_TYPES = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
};

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

  fastify.get('/api/system/notification-sound', async (request, reply) => {
    for (const candidate of SOUND_CANDIDATES) {
      const filePath = path.join(config.CLAUDE_HOME_DIR, candidate);
      try {
        const info = await stat(filePath);
        if (!info.isFile()) continue;

        const ext = path.extname(candidate).toLowerCase();
        if (SOUND_CONTENT_TYPES[ext]) {
          reply.type(SOUND_CONTENT_TYPES[ext]);
        }
        return reply.send(createReadStream(filePath));
      } catch {
        // Try next candidate.
      }
    }

    return reply.code(404).send({ error: 'Notification sound not found' });
  });
}
