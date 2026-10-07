/**
 * Configuration lint tests — static checks on workspace config files.
 * These run WITHOUT Docker and catch misconfigurations before image build.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
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

    it('should never write to stdout — a UserPromptSubmit hook\'s stdout is injected into the prompt', () => {
      // Claude Code prepends a UserPromptSubmit hook's stdout to the user's
      // prompt as context. Anything this script prints would silently end up in
      // every conversation, so every command that could speak must be captured
      // in a variable or redirected.
      const lines = script
        // Join backslash continuations first: a multi-line curl carries its
        // redirect on the last line, and checking line-by-line misreads it.
        .replace(/\\\n/g, ' ')
        .split('\n')
        .map((l) => l.replace(/#.*$/, '').trim())
        .filter(Boolean);
      const speaks = lines.filter((l) =>
        /^(echo|printf|cat|jq|curl)\b/.test(l)
        && !/>\s*\/dev\/null/.test(l)
        && !/>&?\s*2/.test(l));
      assert.deepEqual(speaks, [], `these lines can reach stdout: ${speaks.join(' | ')}`);
    });

    it('should always exit 0 — a non-zero UserPromptSubmit hook blocks the prompt', () => {
      assert.ok(/\nexit 0\n*$/.test(script), 'cm-notify must end with an unconditional exit 0');
    });
  });

  describe('managed-settings.json', () => {
    const raw = readFileSync(path.join(WORKSPACE_DIR, 'config', 'managed-settings.json'), 'utf-8');
    const settings = JSON.parse(raw);

    it('should register cm-notify for the Stop, Notification and UserPromptSubmit hooks', () => {
      // UserPromptSubmit is what separates "waiting on a human" from "the human
      // answered and Claude is working"; without it a permission prompt the user
      // already answered reads as still waiting until the turn ends.
      for (const evt of ['Stop', 'Notification', 'UserPromptSubmit']) {
        const blocks = settings.hooks?.[evt];
        assert.ok(Array.isArray(blocks) && blocks.length > 0, `Missing ${evt} hook`);
        const cmds = blocks.flatMap((b) => (b.hooks || []).map((h) => h.command));
        assert.ok(
          cmds.includes('/usr/local/bin/cm-notify'),
          `${evt} hook must invoke /usr/local/bin/cm-notify`
        );
      }
    });

    it('should point auto memory at the per-instance mount', () => {
      // Without this, Claude derives its memory directory from the startup
      // directory inside the SHARED claude-home, so every instance reads and
      // writes one memory folder (and each other's transcripts).
      assert.equal(
        settings.autoMemoryDirectory,
        '/workspace/.claude/memory',
        'autoMemoryDirectory must be the per-instance /workspace/.claude mount'
      );
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

// These files are copied by hand onto the monitoring host, so nothing runs
// them here. Prometheus parses each scrape.d file as a document with a
// scrape_configs key -- a bare list is rejected and the whole reload fails,
// which took one round trip to learn. The public repository does not ship
// scripts/, so the suite skips there instead of failing at describe time
// (which node:test reports as "not ok" without counting it as a failure).
const MONITORING_DIR = path.join(__dirname, '..', 'scripts', 'host-monitoring');
describe('Host-monitoring drop-ins', { skip: existsSync(MONITORING_DIR) ? false : 'scripts/host-monitoring is not in this checkout' }, () => {
  const dir = MONITORING_DIR;
  const scrapeFiles = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.scrape.yml')) : [];

  it('ships at least the host-a, workstation and llm-backends scrape files', () => {
    for (const want of ['host-a.scrape.yml', 'workstation.scrape.yml', 'llm-backends.scrape.yml']) {
      assert.ok(scrapeFiles.includes(want), `${want} missing`);
    }
  });

  it('every scrape file is a scrape_configs document with unique, host-prefixed job names', () => {
    const seen = new Map();
    for (const f of scrapeFiles) {
      const text = readFileSync(path.join(dir, f), 'utf8');
      assert.match(text, /^scrape_configs:\s*$/m, `${f}: top-level scrape_configs key`);
      assert.match(text, /^# Drop into host-b: /m, `${f}: says where it goes`);
      const jobs = [...text.matchAll(/^\s*- job_name:\s*(\S+)/gm)].map((m) => m[1]);
      assert.ok(jobs.length > 0, `${f}: declares a job`);
      const prefix = f.replace('.scrape.yml', '');
      for (const j of jobs) {
        assert.ok(j.startsWith(prefix), `${f}: job ${j} should be prefixed ${prefix}- (the base node/cadvisor jobs belong to the monitoring host)`);
        assert.ok(!seen.has(j), `job ${j} declared in both ${seen.get(j)} and ${f}`);
        seen.set(j, f);
      }
    }
  });

  it('dashboards are valid JSON with a stable uid and no leftover host name', () => {
    const gdir = path.join(dir, 'grafana');
    for (const f of readdirSync(gdir).filter((x) => x.endsWith('.json'))) {
      const d = JSON.parse(readFileSync(path.join(gdir, f), 'utf8'));
      assert.equal(typeof d.uid, 'string', `${f}: uid`);
      assert.equal(d.uid, f.replace('.json', ''), `${f}: file name is the uid`);
      assert.ok(Array.isArray(d.panels) && d.panels.length > 0, `${f}: panels`);
      if (f === 'workstation.json') assert.ok(!JSON.stringify(d).includes('host-a'), 'workstation.json copied from host-a still mentions it');
    }
  });

  it('the LiteLLM datasource never carries a literal password', () => {
    const text = readFileSync(path.join(dir, 'grafana', 'litellm-datasource.yml'), 'utf8');
    assert.match(text, /password:\s*\$LITELLM_RO_PASSWORD\s*$/m);
  });
});
