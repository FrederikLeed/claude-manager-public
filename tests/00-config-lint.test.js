/**
 * Configuration lint tests — static checks on workspace config files.
 * These run WITHOUT Docker and catch misconfigurations before image build.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIR = path.join(__dirname, '..', 'workspace');

describe('Workspace config lint', () => {
  describe('tmux.conf', () => {
    const tmuxConfRaw = readFileSync(path.join(WORKSPACE_DIR, 'config', 'tmux.conf'));
    const tmuxConf = tmuxConfRaw.toString('utf-8');

    it('should use LF line endings, not CRLF (breaks tmux on Linux)', () => {
      assert.ok(
        !tmuxConfRaw.includes(0x0d),
        'tmux.conf contains \\r (CRLF) — tmux will fail with "unknown command". Fix: git checkout with LF or add .gitattributes'
      );
    });

    it('should not disable alternate screen (smcup@/rmcup@)', () => {
      // smcup@/rmcup@ cancels alternate screen capability, breaking TUI apps
      // like Claude Code, vim, htop — they render garbage without alt screen
      assert.ok(
        !tmuxConf.includes('smcup@'),
        'tmux.conf must not contain smcup@ — it disables alternate screen enter, breaking TUI rendering'
      );
      assert.ok(
        !tmuxConf.includes('rmcup@'),
        'tmux.conf must not contain rmcup@ — it disables alternate screen exit, breaking TUI rendering'
      );
    });

    it('should not disable line drawing mode (smacs@/rmacs@)', () => {
      assert.ok(!tmuxConf.includes('smacs@'), 'tmux.conf must not disable line drawing enter (smacs@)');
      assert.ok(!tmuxConf.includes('rmacs@'), 'tmux.conf must not disable line drawing exit (rmacs@)');
    });

    it('should set a 256color default-terminal', () => {
      const match = tmuxConf.match(/set\s+-g\s+default-terminal\s+"([^"]+)"/);
      assert.ok(match, 'tmux.conf must set default-terminal');
      assert.ok(
        match[1].includes('256color'),
        `default-terminal should be a 256color type, got: ${match[1]}`
      );
    });

    it('should enable mouse support', () => {
      assert.ok(
        /set\s+-g\s+mouse\s+on/.test(tmuxConf),
        'tmux.conf should enable mouse support (set -g mouse on)'
      );
    });

    it('should have a reasonable history limit', () => {
      const match = tmuxConf.match(/set\s+-g\s+history-limit\s+(\d+)/);
      assert.ok(match, 'tmux.conf should set history-limit');
      const limit = parseInt(match[1]);
      assert.ok(limit >= 10000, `history-limit should be at least 10000, got: ${limit}`);
    });

    it('should set escape-time to 0 for fast key processing', () => {
      assert.ok(
        /set\s+-s\s+escape-time\s+0/.test(tmuxConf),
        'tmux.conf should set escape-time 0 for responsive input'
      );
    });
  });

  describe('entrypoint.sh', () => {
    const entrypoint = readFileSync(path.join(WORKSPACE_DIR, 'scripts', 'entrypoint.sh'));

    it('should use LF line endings, not CRLF (breaks bash on Linux)', () => {
      assert.ok(
        !entrypoint.includes(0x0d),
        'entrypoint.sh contains \\r (CRLF) — bash will fail. Fix: git checkout with LF or add .gitattributes'
      );
    });
  });

  describe('cm-notify hook', () => {
    const raw = readFileSync(path.join(WORKSPACE_DIR, 'scripts', 'cm-notify'));
    const script = raw.toString('utf-8');

    it('should use LF line endings, not CRLF (breaks bash on Linux)', () => {
      assert.ok(!raw.includes(0x0d), 'cm-notify contains \\r (CRLF) — bash will fail');
    });

    it('should be a no-op when CM_MANAGER_URL / CM_INSTANCE_ID are unset', () => {
      assert.ok(
        /CM_MANAGER_URL/.test(script) && /CM_INSTANCE_ID/.test(script) && /exit 0/.test(script),
        'cm-notify must guard on the manager env vars and exit 0 for legacy/unmanaged containers'
      );
    });

    it('should POST to the instance event endpoint', () => {
      assert.ok(
        /\/api\/instances\/.*\/event/.test(script),
        'cm-notify must POST to /api/instances/<id>/event'
      );
    });

    it('should bound the curl call so it never blocks Claude', () => {
      assert.ok(/curl[^\n]*-m\s*\d+/.test(script), 'cm-notify curl must use a timeout (-m)');
    });
  });

  describe('managed-settings.json', () => {
    const raw = readFileSync(path.join(WORKSPACE_DIR, 'config', 'managed-settings.json'), 'utf-8');
    const settings = JSON.parse(raw);

    it('should register cm-notify for Stop and Notification hooks', () => {
      for (const evt of ['Stop', 'Notification']) {
        const blocks = settings.hooks?.[evt];
        assert.ok(Array.isArray(blocks) && blocks.length > 0, `Missing ${evt} hook`);
        const cmds = blocks.flatMap((b) => (b.hooks || []).map((h) => h.command));
        assert.ok(
          cmds.includes('/usr/local/bin/cm-notify'),
          `${evt} hook must invoke /usr/local/bin/cm-notify`
        );
      }
    });
  });
});

describe('Compose / deploy config', () => {
  const ROOT = path.join(__dirname, '..');
  const base = readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf-8');

  it('base compose should NOT pin cm-ollama to a GPU (must boot on any host)', () => {
    // The nvidia reservation lives in the opt-in docker-compose.gpu.yml overlay
    assert.ok(
      !/driver:\s*nvidia/.test(base),
      'docker-compose.yml must not hardcode an nvidia GPU reservation — move it to docker-compose.gpu.yml'
    );
  });

  it('gpu overlay should add the nvidia reservation for cm-ollama', () => {
    const gpu = readFileSync(path.join(ROOT, 'docker-compose.gpu.yml'), 'utf-8');
    assert.ok(/cm-ollama/.test(gpu), 'gpu overlay must target cm-ollama');
    assert.ok(/driver:\s*nvidia/.test(gpu), 'gpu overlay must declare the nvidia driver reservation');
  });

  it('manager service should propagate TZ for timezone sync', () => {
    assert.ok(/TZ=\$\{TZ:-/.test(base), 'manager service must pass TZ through (TZ=${TZ:-...})');
  });

  it('manager should mount the workspace build context for image rebuilds', () => {
    assert.ok(
      /\.\/workspace:\/workspace-src/.test(base),
      'manager must bind ./workspace:/workspace-src so it can rebuild claude-workspace'
    );
    assert.ok(/WORKSPACE_SRC_DIR=\/workspace-src/.test(base), 'manager must set WORKSPACE_SRC_DIR=/workspace-src');
  });
});
