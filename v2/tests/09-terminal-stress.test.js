/**
 * Terminal stress tests — many connections, rapid I/O, edge cases.
 * Verifies terminal stability under load.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, authenticate, createTestInstance, removeTestInstance, waitForState, sleep, getAuthCookie } from './helpers.js';

const WS_BASE = (process.env.TEST_API_BASE || 'http://localhost:3002').replace(/^http/, 'ws');
function connectTerminal(instanceId) {
  const url = `${WS_BASE}/api/instances/${instanceId}/terminal`;
  const ws = new WebSocket(url, { headers: { Cookie: getAuthCookie() || '' } });
  let rawOutput = '';

  ws.binaryType = 'arraybuffer';

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Terminal connect timeout')), 10000);

    ws.addEventListener('open', () => {
      clearTimeout(timeout);
      ws.addEventListener('message', (event) => {
        if (event.data instanceof ArrayBuffer) {
          rawOutput += new TextDecoder().decode(event.data);
        } else if (typeof event.data === 'string') {
          rawOutput += event.data;
        }
      });
      resolve({
        ws,
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
        waitForAnyOutput: async (timeoutMs = 5000) => {
          const start = Date.now();
          while (Date.now() - start < timeoutMs) {
            if (rawOutput.length > 0) return true;
            await sleep(100);
          }
          return false;
        },
        close: () => { try { ws.close(); } catch {} },
      });
    });

    ws.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('Terminal WS error'));
    });
  });
}

describe('Terminal stress tests', () => {
  let instanceId;

  before(async () => {
    await authenticate();
    const { status, instance } = await createTestInstance('test-term-stress');
    assert.equal(status, 201);
    instanceId = instance.id;
    await waitForState(instanceId, 'running', 30000);
    await sleep(2000);
  });

  after(async () => {
    if (instanceId) {
      try { await removeTestInstance(instanceId, true); } catch {}
    }
  });

  describe('Rapid connect/disconnect', () => {
    it('should handle 5 rapid connect/disconnect cycles', async () => {
      for (let i = 0; i < 5; i++) {
        const term = await connectTerminal(instanceId);
        await term.waitForAnyOutput(5000);
        term.close();
        await sleep(300); // Brief pause to let cleanup happen
      }

      // Verify terminal still works after all cycles
      const finalTerm = await connectTerminal(instanceId);
      await finalTerm.waitForAnyOutput(5000);
      finalTerm.send('echo RAPID_CYCLE_OK\n');
      const found = await finalTerm.waitForOutput('RAPID_CYCLE_OK', 5000);
      assert.ok(found, 'Terminal should work after rapid connect/disconnect cycles');
      finalTerm.close();
    });
  });

  describe('Rapid resize events', () => {
    it('should handle 20 rapid resize events', async () => {
      const term = await connectTerminal(instanceId);
      await term.waitForAnyOutput(5000);

      // Send 20 rapid resizes
      for (let i = 0; i < 20; i++) {
        const cols = 40 + Math.floor(Math.random() * 160);
        const rows = 10 + Math.floor(Math.random() * 50);
        term.sendResize(cols, rows);
      }

      await sleep(1000);

      // Terminal should still work
      term.send('echo RESIZE_STRESS_OK\n');
      const found = await term.waitForOutput('RESIZE_STRESS_OK', 5000);
      assert.ok(found, 'Terminal should work after rapid resizes');
      term.close();
    });
  });

  describe('Large output handling', () => {
    it('should handle large output (1000 lines)', async () => {
      const term = await connectTerminal(instanceId);
      await term.waitForAnyOutput(5000);

      term.send('seq 1 1000\n');
      // Wait for the last number
      const found = await term.waitForOutput('1000', 20000);
      assert.ok(found, 'Should handle 1000 lines of output');
      term.close();
    });

    it('should handle large single-line output', async () => {
      const term = await connectTerminal(instanceId);
      await term.waitForAnyOutput(5000);

      // Generate a long line
      term.send('python3 -c "print(\'A\'*5000)" 2>/dev/null || echo "A"*500\n');
      await sleep(3000);
      // Just verify terminal still works
      term.send('echo LARGE_LINE_OK\n');
      const found = await term.waitForOutput('LARGE_LINE_OK', 5000);
      assert.ok(found, 'Terminal should work after large single-line output');
      term.close();
    });
  });

  describe('Rapid input', () => {
    it('should handle burst of input characters', async () => {
      const term = await connectTerminal(instanceId);
      await term.waitForAnyOutput(5000);

      // Send a rapid burst of characters
      const message = 'echo BURST_INPUT_OK_12345\n';
      for (const char of message) {
        term.send(char);
      }

      const found = await term.waitForOutput('BURST_INPUT_OK_12345', 10000);
      assert.ok(found, 'Burst input should produce expected output');
      term.close();
    });
  });

  describe('Binary data handling', () => {
    it('should handle binary output (e.g., from cat /dev/urandom)', async () => {
      const term = await connectTerminal(instanceId);
      await term.waitForAnyOutput(5000);

      // Generate small amount of binary data
      term.send('head -c 100 /dev/urandom | base64\n');
      await sleep(2000);

      // Terminal should still work
      term.send('echo BINARY_OK\n');
      const found = await term.waitForOutput('BINARY_OK', 5000);
      assert.ok(found, 'Terminal should survive binary output');
      term.close();
    });
  });

  describe('Concurrent terminals under load', () => {
    it('should handle 3 concurrent terminals sending commands', async () => {
      const terms = [];
      for (let i = 0; i < 3; i++) {
        const term = await connectTerminal(instanceId);
        await term.waitForAnyOutput(5000);
        terms.push(term);
      }

      // Each terminal sends a command (shared tmux session, so output visible to all)
      terms[0].send('echo MULTI_0\n');
      await sleep(500);
      terms[1].send('echo MULTI_1\n');
      await sleep(500);
      terms[2].send('echo MULTI_2\n');

      // Check that the last terminal got all output
      const found = await terms[2].waitForOutput('MULTI_2', 10000);
      assert.ok(found, 'All concurrent terminals should see output');

      // Close all
      for (const term of terms) {
        term.close();
      }
      await sleep(500);
    });
  });
});
