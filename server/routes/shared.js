import { createReadStream, createWriteStream } from 'fs';
import { mkdir, stat } from 'fs/promises';
import path from 'path';
import { pipeline } from 'stream/promises';
import { config } from '../config.js';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

function sanitizeFilename(name) {
  // Strip path components and traversal characters
  const base = path.basename(name);
  // Remove any remaining dangerous characters
  return base.replace(/[^\w.\-() ]/g, '_');
}

export default async function sharedRoutes(fastify) {
  // Register multipart support scoped to this plugin
  await fastify.register((await import('@fastify/multipart')).default, {
    limits: {
      fileSize: MAX_FILE_SIZE,
    },
  });

  fastify.post('/api/shared/upload', async (request, reply) => {
    const data = await request.file();

    if (!data) {
      return reply.code(400).send({ error: 'No file provided' });
    }

    const filename = sanitizeFilename(data.filename);
    if (!filename) {
      return reply.code(400).send({ error: 'Invalid filename' });
    }

    // Ensure shared directory exists
    await mkdir(config.SHARED_DIR, { recursive: true });

    const destPath = path.join(config.SHARED_DIR, filename);
    const writeStream = createWriteStream(destPath);

    try {
      await pipeline(data.file, writeStream);
    } catch (err) {
      // Check if the file exceeded the size limit
      if (data.file.truncated) {
        return reply.code(413).send({
          error: `File exceeds maximum size of ${MAX_FILE_SIZE / 1024 / 1024}MB`,
        });
      }
      throw err;
    }

    // Check if the stream was truncated after pipeline completes
    if (data.file.truncated) {
      return reply.code(413).send({
        error: `File exceeds maximum size of ${MAX_FILE_SIZE / 1024 / 1024}MB`,
      });
    }

    const size = writeStream.bytesWritten;

    return { filename, size };
  });

  fastify.get('/api/shared/:filename', async (request, reply) => {
    const requested = request.params?.filename || '';
    const filename = sanitizeFilename(requested);

    if (!filename || filename !== requested) {
      return reply.code(400).send({ error: 'Invalid filename' });
    }

    const filePath = path.join(config.SHARED_DIR, filename);

    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        return reply.code(404).send({ error: 'File not found' });
      }
    } catch {
      return reply.code(404).send({ error: 'File not found' });
    }

    const ext = path.extname(filename).toLowerCase();
    const contentTypes = {
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.aiff': 'audio/aiff',
      '.aif': 'audio/aiff',
    };
    if (contentTypes[ext]) {
      reply.type(contentTypes[ext]);
    }

    return reply.send(createReadStream(filePath));
  });
}
