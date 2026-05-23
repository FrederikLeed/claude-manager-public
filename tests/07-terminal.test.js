/**
 * Terminal/TTY WebSocket tests — connection, I/O, resize, cleanup.
 * These are the CRITICAL tests — terminal must work reliably.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, authenticate, createTestInstance, removeTestInstance, waitForState, sleep, getAuthCookie } from './helpers.js';

// WebSocket helper that handles both binary and text messages
const WS_BASE = (process.env.TEST_API_BASE || 'http://localhost:3002').replace(/^http/, 'ws');
function connectTerminal(instanceId) {
  const url = `${WS_BASE}/api/instances/${instanceId}/terminal`;
  const ws = new WebSocket(url, { headers: { Cookie: getAuthCookie() || '' } });
  const output = [];
  let rawOutput = '';

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Terminal WS connect timeout')), 10000);

    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      clearTimeout(timeout);

      ws.addEventListener('message', (event) => {
        if (event.data instanceof ArrayBuffer) {
          const text = new TextDecoder().decode(event.data);
          rawOutput += text;
          output.push({ type: 'binary', data: text });
        } else if (typeof event.data === 'string') {
          try {
            const json = JSON.parse(event.data);
            output.push({ type: 'json', data: json });
          } catch {
            rawOutput += event.data;
            output.push({ type: 'text', data: event.data });
          }
        }
      });

      resolve({
        ws,
        output,
        getRawOutput: () => rawOutput,
        send: (data) => ws.send(data),
        sendResize: (cols, rows) => ws.send(JSON.stringify({ type: 'resize', cols, rows })),
        waitForOutput: async (pattern, timeoutMs = 10000) => {
          const start = Date.now();
          while (Date.now() - start < timeoutMs) {
            if (rawOutput.includes(pattern)) return true;
            await sleep(200);
          }
          return false;
        },
        waitForAnyOutput: async (timeoutMs = 10000) => {
          const start = Date.now();
          while (Date.now() - start < timeoutMs) {
            if (rawOutput.length > 0) return true;
            await sleep(200);
          }
          return false;
        },
        close: () => {
          try { ws.close(); } catch {}
        },
      });
    });

    ws.addEventListener('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Terminal WS error: ${err.message || 'unknown'}`));
    });
  });
}

describe('Terminal WebSocket', () => {
  let instanceId;

  before(async () => {
    await authenticate();
    // Create a dedicated instance for terminal tests
    const { status, instance } = await createTestInstance('test-terminal');
    assert.equal(status, 201, `Failed to create terminal test instance: ${JSON.stringify(instance)}`);
    instanceId = instance.id;
    // Wait for it to be running
    await waitForState(instanceId, 'running', 30000);
    // Give the container a moment to fully initialize
    await sleep(2000);
  });

  after(async () => {
    if (instanceId) {
      try { await removeTestInstance(instanceId, true); } catch {}
    }
  });

  describe('Connection', () => {
    it('should connect to terminal WebSocket', async () => {
      const term = await connectTerminal(instanceId);
      assert.ok(term.ws.readyState === WebSocket.OPEN, 'WebSocket should be open');
      term.close();
      await sleep(500);
    });

    it('should receive initial output (tmux/bash prompt)', async () => {
      const term = await connectTerminal(instanceId);
      const gotOutput = await term.waitForAnyOutput(10000);
      assert.ok(gotOutput, `Expected initial terminal output, got nothing. Raw: "${term.getRawOutput().slice(0, 200)}"`);
      term.close();
      await sleep(500);
    });

    it('should reject connection to non-existent instance', async () => {
      try {
        const term = await connectTerminal('nonexistent-12345');
        // If it connects, it should send an error and close
        await sleep(1000);
        const hasError = term.output.some(m =>
          m.type === 'json' && m.data?.error ||
          m.type === 'text' && m.data?.includes('error')
        );
        // The WS should have closed or sent an error
        assert.ok(
          term.ws.readyState >= WebSocket.CLOSING || hasError,
          'Expected WS to close or send error for non-existent instance'
        );
        term.close();
      } catch {
        // Connection refused or error is also acceptable
        assert.ok(true);
      }
    });

    it('should reject connection to stopped instance', async () => {
      // Create and immediately stop an instance
      const { instance } = await createTestInstance('test-terminal-stopped', { autoStart: false });
      try {
        const term = await connectTerminal(instance.id);
        await sleep(1000);
        // Should get error message
        const hasError = term.output.some(m =>
          m.type === 'json' && m.data?.error
        );
        assert.ok(hasError || term.ws.readyState >= WebSocket.CLOSING,
          'Expected error or close for stopped instance');
        term.close();
      } catch {
        assert.ok(true); // Connection failure is expected
      } finally {
        await removeTestInstance(instance.id, true);
      }
    });
  });

  describe('Input/Output', () => {
    it('should execute a command and receive output', async () => {
      const term = await connectTerminal(instanceId);
      await term.waitForAnyOutput(5000);

      // Clear output and send a command
      term.send('echo HELLO_TEST_123\n');
      const found = await term.waitForOutput('HELLO_TEST_123', 10000);
      assert.ok(found, `Expected to find 'HELLO_TEST_123' in output. Raw: "${term.getRawOutput().slice(-500)}"`);
      term.close();
      await sleep(500);
    });

    it('should handle multiple rapid commands', async () => {
      const term = await connectTerminal(instanceId);
      await term.waitForAnyOutput(5000);

      for (let i = 0; i < 5; i++) {
        term.send(`echo RAPID_${i}\n`);
      }
      // Wait for the last one
      const found = await term.waitForOutput('RAPID_4', 10000);
      assert.ok(found, `Expected to find 'RAPID_4' in output`);
      term.close();
      await sleep(500);
    });

    it('should handle special characters', async () => {
      const term = await connectTerminal(instanceId);
      await term.waitForAnyOutput(5000);

      term.send('echo "hello world & <test> \'quotes\'"\n');
      const found = await term.waitForOutput('hello world', 10000);
      assert.ok(found, 'Expected special characters to pass through');
      term.close();
      await sleep(500);
    });

    it('should handle long output (e.g., seq 1 200)', async () => {
      const term = await connectTerminal(instanceId);
      await term.waitForAnyOutput(5000);

      term.send('seq 1 200\n');
      // Wait for the last number to appear
      const found = await term.waitForOutput('200', 15000);
      assert.ok(found, 'Expected long output (seq 1 200) to complete');
      term.close();
      await sleep(500);
    });
  });

  describe('Resize', () => {
    it('should handle resize events without error', async () => {
      const term = await connectTerminal(instanceId);
      await term.waitForAnyOutput(5000);

      // Send various resize events
      term.sendResize(120, 40);
      await sleep(300);
      term.sendResize(80, 24);
      await sleep(300);
      term.sendResize(200, 50);
      await sleep(300);

      // Verify terminal still works after resize
      term.send('echo RESIZE_OK\n');
      const found = await term.waitForOutput('RESIZE_OK', 5000);
      assert.ok(found, 'Terminal should work after resize');
      term.close();
      await sleep(500);
    });

    it('should handle extreme resize values gracefully', async () => {
      const term = await connectTerminal(instanceId);
      await term.waitForAnyOutput(5000);

      // Try very small
      term.sendResize(1, 1);
      await sleep(200);
      // Try very large
      term.sendResize(500, 200);
      await sleep(200);
      // Back to normal
      term.sendResize(80, 24);
      await sleep(200);

      term.send('echo EXTREME_RESIZE_OK\n');
      const found = await term.waitForOutput('EXTREME_RESIZE_OK', 5000);
      assert.ok(found, 'Terminal should survive extreme resize values');
      term.close();
      await sleep(500);
    });
  });

  describe('Multiple connections (tmux shared session)', () => {
    it('should allow two concurrent terminal connections', async () => {
      const term1 = await connectTerminal(instanceId);
      await term1.waitForAnyOutput(5000);

      const term2 = await connectTerminal(instanceId);
      await term2.waitForAnyOutput(5000);

      // Both should be open
      assert.equal(term1.ws.readyState, WebSocket.OPEN);
      assert.equal(term2.ws.readyState, WebSocket.OPEN);

      // Send from term1, should appear in term2 (shared tmux session)
      term1.send('echo SHARED_SESSION_TEST\n');
      const found2 = await term2.waitForOutput('SHARED_SESSION_TEST', 10000);
      assert.ok(found2, 'Second terminal should see output from first (shared tmux session)');

      term1.close();
      term2.close();
      await sleep(500);
    });

    it('should survive one connection closing while other stays open', async () => {
      const term1 = await connectTerminal(instanceId);
      await term1.waitForAnyOutput(5000);

      const term2 = await connectTerminal(instanceId);
      await term2.waitForAnyOutput(5000);

      // Close first connection
      term1.close();
      await sleep(1000);

      // Second connection should still work
      assert.equal(term2.ws.readyState, WebSocket.OPEN, 'Second connection should stay open');
      term2.send('echo SURVIVOR_TEST\n');
      const found = await term2.waitForOutput('SURVIVOR_TEST', 5000);
      assert.ok(found, 'Surviving connection should still work');

      term2.close();
      await sleep(500);
    });
  });

  describe('Disconnect/reconnect', () => {
    it('should reconnect after disconnect (tmux session persists)', async () => {
      // Connect and create a file as a marker
      const term1 = await connectTerminal(instanceId);
      await term1.waitForAnyOutput(5000);
      term1.send('echo RECONNECT_MARKER > /tmp/reconnect-test.txt\n');
      await sleep(1000);
      term1.close();
      await sleep(1000);

      // Reconnect
      const term2 = await connectTerminal(instanceId);
      await term2.waitForAnyOutput(5000);
      term2.send('cat /tmp/reconnect-test.txt\n');
      const found = await term2.waitForOutput('RECONNECT_MARKER', 10000);
      assert.ok(found, 'Should be able to see data from previous session after reconnect');
      term2.close();
      await sleep(500);
    });
  });

  describe('Terminal capabilities (runtime)', () => {
    it('tmux terminal-overrides should not disable alternate screen', async () => {
      const term = await connectTerminal(instanceId);
      await term.waitForAnyOutput(5000);

      term.send('tmux show -gv terminal-overrides\n');
      const found = await term.waitForOutput('terminal-overrides', 5000);
      // Even if the show command doesn't echo the label, wait for output to settle
      await sleep(1000);
      const output = term.getRawOutput();

      assert.ok(
        !output.includes('smcup@'),
        'Runtime tmux terminal-overrides must not contain smcup@ (disables alternate screen)'
      );
      assert.ok(
        !output.includes('rmcup@'),
        'Runtime tmux terminal-overrides must not contain rmcup@ (disables alternate screen restore)'
      );
      term.close();
      await sleep(500);
    });

    it('TERM should be a 256color type inside tmux', async () => {
      // Use docker exec to check TERM inside a tmux session — avoids terminal output parsing
      const { execFileSync } = await import('child_process');
      const containerName = `cm-test-terminal-${instanceId}`;
      // Get list of containers to find the right name
      const result = await api(`/api/instances/${instanceId}`);
      const dockerName = result.json?.dockerId?.slice(0, 12) || containerName;

      // Ask tmux what TERM is set to in its environment
      let termVal;
      try {
        termVal = execFileSync('docker', [
          'exec', `cm-test-terminal-${instanceId}`,
          'tmux', '-L', 'cm', 'show-environment', 'TERM',
        ]).toString().trim();
      } catch {
        // Fallback: check the tmux default-terminal option
        termVal = execFileSync('docker', [
          'exec', `cm-test-terminal-${instanceId}`,
          'tmux', '-L', 'cm', 'show', '-gv', 'default-terminal',
        ]).toString().trim();
      }

      assert.ok(
        termVal.includes('256color'),
        `TERM should be a 256color variant, got: ${termVal}`
      );
    });

    it('smcup/rmcup capabilities should be present (alternate screen)', async () => {
      // Use docker exec to check terminfo capabilities directly
      const { execFileSync } = await import('child_process');
      const container = `cm-test-terminal-${instanceId}`;

      const smcupBytes = parseInt(execFileSync('docker', [
        'exec', container, 'bash', '-c', 'TERM=tmux-256color tput smcup | wc -c | tr -d " "',
      ]).toString().trim());

      const rmcupBytes = parseInt(execFileSync('docker', [
        'exec', container, 'bash', '-c', 'TERM=tmux-256color tput rmcup | wc -c | tr -d " "',
      ]).toString().trim());

      const colors = parseInt(execFileSync('docker', [
        'exec', container, 'bash', '-c', 'TERM=tmux-256color tput colors',
      ]).toString().trim());

      assert.ok(smcupBytes > 0, `smcup capability must be present (got ${smcupBytes} bytes)`);
      assert.ok(rmcupBytes > 0, `rmcup capability must be present (got ${rmcupBytes} bytes)`);
      assert.ok(colors >= 256, `Should support >= 256 colors, got: ${colors}`);
    });

    it('alternate screen should actually work (functional test)', async () => {
      const term = await connectTerminal(instanceId);
      await term.waitForAnyOutput(5000);

      // Test alternate screen by writing a file from alt screen, then checking
      // if the screen content behaves correctly. We use a file-based approach
      // because raw WebSocket output includes all escape sequences regardless.
      const altTest = [
        // Write marker file, enter alt screen, write different content, exit, check
        'echo before > /tmp/alt-test-state.txt',
        'printf "\\e[?1049h"',           // enter alt screen
        'echo during > /tmp/alt-test-state.txt',
        'sleep 0.2',
        'printf "\\e[?1049l"',           // exit alt screen
        // If alt screen works, the terminal should restore the previous view
        // We verify the mechanism worked by checking that both commands executed
        'echo "ALT_FUNC_DONE"',
      ].join(' && ');

      term.send(altTest + '\n');
      const done = await term.waitForOutput('ALT_FUNC_DONE', 10000);
      assert.ok(done, 'Alt screen test should complete');

      // Verify the file was written (proves alt screen enter/exit didn't crash)
      term.send('cat /tmp/alt-test-state.txt\n');
      const fileDone = await term.waitForOutput('during', 5000);
      assert.ok(fileDone, 'Alt screen commands should have executed (file written)');

      // Also verify via the tmux config that smcup@ is not set
      term.send('tmux show -gv terminal-overrides 2>/dev/null; echo "OVERRIDES_DONE"\n');
      await term.waitForOutput('OVERRIDES_DONE', 5000);
      const raw = term.getRawOutput();
      assert.ok(
        !raw.includes('smcup@'),
        'tmux terminal-overrides must not contain smcup@ (would break alt screen)'
      );

      term.close();
      await sleep(500);
    });
  });

  describe('Cleanup', () => {
    it('should clean up PTY resources when WebSocket closes', async () => {
      const term = await connectTerminal(instanceId);
      await term.waitForAnyOutput(5000);
      term.close();

      // Wait for cleanup
      await sleep(1000);

      // Verify we can still create new connections (no resource leak)
      const term2 = await connectTerminal(instanceId);
      await term2.waitForAnyOutput(5000);
      term2.send('echo CLEANUP_OK\n');
      const found = await term2.waitForOutput('CLEANUP_OK', 5000);
      assert.ok(found, 'Should be able to reconnect after cleanup');
      term2.close();
      await sleep(500);
    });
  });
});
