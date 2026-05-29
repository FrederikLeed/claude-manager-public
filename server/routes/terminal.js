import { createPTY, getContainer, execInContainer } from '../docker.js';

// Active terminal sessions — tracked for cleanup on shutdown
const activeSessions = new Map();

// Heartbeat interval (30s) and idle timeout (30 min)
const HEARTBEAT_INTERVAL_MS = 30_000;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

// Resize debounce (150ms to prevent resize storms)
let resizeTimers = new WeakMap();

/**
 * Get count of active terminal sessions (for monitoring).
 */
export function getActiveSessionCount() {
  return activeSessions.size;
}

/**
 * Close all active terminal sessions (for graceful shutdown).
 */
export function closeAllSessions() {
  for (const [sessionId, session] of activeSessions) {
    try {
      clearInterval(session.clipPoll);
      clearInterval(session.heartbeat);
      clearTimeout(session.idleTimer);
      session.stream.destroy();
      session.socket.close();
    } catch { /* best effort */ }
    activeSessions.delete(sessionId);
  }
}

export default async function terminalRoutes(fastify) {
  fastify.get('/api/instances/:id/terminal', { websocket: true }, async (socket, request) => {
    const { id } = request.params;
    const sessionId = `${id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Verify container exists and is running
    const container = await getContainer(id);
    if (!container) {
      socket.send(JSON.stringify({ error: 'Instance not found' }));
      socket.close();
      return;
    }

    if (container.state !== 'running') {
      socket.send(JSON.stringify({ error: 'Instance is not running' }));
      socket.close();
      return;
    }

    let pty;
    try {
      pty = await createPTY(id, { name: container.name });
    } catch (err) {
      socket.send(JSON.stringify({ error: `Failed to create terminal: ${err.message}` }));
      socket.close();
      return;
    }

    const { stream, exec } = pty;

    // --- Idle timeout: close session after 30 min of no input ---
    let idleTimer = setTimeout(() => cleanupSession('idle timeout'), IDLE_TIMEOUT_MS);

    function resetIdleTimer() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => cleanupSession('idle timeout'), IDLE_TIMEOUT_MS);
    }

    // --- Heartbeat: detect dead WebSocket connections ---
    let isAlive = true;
    const heartbeat = setInterval(() => {
      if (!isAlive) {
        // No pong received since last ping — connection is dead
        fastify.log.warn({ sessionId, instanceId: id }, 'Terminal heartbeat failed, closing');
        cleanupSession('heartbeat failed');
        return;
      }
      isAlive = false;
      try {
        socket.ping();
      } catch {
        cleanupSession('ping failed');
      }
    }, HEARTBEAT_INTERVAL_MS);

    socket.on('pong', () => { isAlive = true; });

    // --- Track session for shutdown cleanup ---
    const session = { socket, stream, exec, clipPoll: null, heartbeat, idleTimer, instanceId: id };
    activeSessions.set(sessionId, session);

    // --- Clipboard ---
    // Preferred path: tmux `set-clipboard on` (new workspace image) emits OSC 52
    // over this stream; the client decodes it. No polling involved.
    // Fallback for instances still on the OLD image (set-clipboard off + copy-pipe
    // to /tmp/.tmux-clipboard): poll that file and forward it. Instances on the new
    // image never write the file, so this is a no-op for them. Remove once all
    // instances are recreated onto the new image.
    let lastClip = '';
    const clipPoll = setInterval(async () => {
      if (socket.readyState !== 1) return;
      try {
        const raw = await execInContainer(id, 'cat /tmp/.tmux-clipboard 2>/dev/null');
        const text = raw.replace(/[\x00-\x08\x0e-\x1f]/g, '').replace(/^\s+/, '').replace(/\s+$/, '');
        if (text && text !== lastClip) {
          lastClip = text;
          socket.send(JSON.stringify({ type: 'clipboard', data: text }));
        }
      } catch { /* container may have stopped */ }
    }, 500);
    session.clipPoll = clipPoll;

    // --- Container output -> WebSocket (with backpressure) ---
    stream.on('data', (data) => {
      try {
        if (socket.readyState === 1) {
          // Backpressure: if WebSocket buffer exceeds 1MB, pause Docker stream
          if (socket.bufferedAmount > 1024 * 1024) {
            stream.pause();
            // Resume when buffer drains
            const drainCheck = setInterval(() => {
              if (socket.bufferedAmount < 256 * 1024) {
                clearInterval(drainCheck);
                try { stream.resume(); } catch { /* stream may be gone */ }
              }
            }, 100);
            // Safety: don't let drain check run forever
            setTimeout(() => clearInterval(drainCheck), 10000);
          }
          socket.send(data);
        }
      } catch {
        // Socket may have closed
      }
    });

    stream.on('end', () => {
      cleanupSession('stream ended');
    });

    stream.on('error', (err) => {
      fastify.log.warn({ sessionId, err: err.message }, 'Terminal stream error');
      cleanupSession('stream error');
    });

    // --- WebSocket input -> Container ---
    socket.on('message', (data) => {
      resetIdleTimer();
      const message = data.toString();

      // Check for control messages (resize) — debounced
      if (message.startsWith('{"type":"resize"')) {
        try {
          const ctrl = JSON.parse(message);
          if (ctrl.cols && ctrl.rows) {
            // Debounce resize events (150ms)
            const existing = resizeTimers.get(socket);
            if (existing) clearTimeout(existing);
            resizeTimers.set(socket, setTimeout(() => {
              exec.resize({ w: ctrl.cols, h: ctrl.rows }).catch(() => {
                // Resize may fail if PTY has exited — non-critical
              });
            }, 150));
            return;
          }
        } catch {
          // Not valid JSON, treat as regular input
        }
      }

      // Regular stdin input
      try {
        stream.write(data);
      } catch {
        // Stream may have closed
      }
    });

    // --- Unified cleanup function ---
    let cleaned = false;
    function cleanupSession(reason) {
      if (cleaned) return;
      cleaned = true;

      fastify.log.info({ sessionId, instanceId: id, reason }, 'Terminal session cleanup');

      clearInterval(clipPoll);
      clearInterval(heartbeat);
      clearTimeout(idleTimer);
      const resizeTimer = resizeTimers.get(socket);
      if (resizeTimer) { clearTimeout(resizeTimer); resizeTimers.delete(socket); }

      activeSessions.delete(sessionId);

      try {
        // Send tmux detach key sequence (Ctrl-a d) to cleanly detach
        // Prefix is Ctrl-a (\x01) per tmux.conf, not default Ctrl-b (\x02)
        stream.write('\x01d');
        setTimeout(() => { try { stream.destroy(); } catch { /* ignore */ } }, 200);
      } catch { /* ignore */ }

      try { socket.close(); } catch { /* ignore */ }
    }

    // --- Cleanup on WebSocket close ---
    socket.on('close', () => cleanupSession('client disconnected'));
    socket.on('error', (err) => {
      fastify.log.warn({ sessionId, err: err.message }, 'Terminal WebSocket error');
      cleanupSession('socket error');
    });
  });
}
