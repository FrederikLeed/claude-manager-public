/**
 * Diagnostics & logging regressions (2026-09-16) — pure unit tests, no server needed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { parseSquidLine } from '../server/proxy-log.js';
import { instanceHostname, INSTANCE_LOG_CONFIG } from '../server/docker.js';
import { isLifecycleAction } from '../server/routes/instances.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('Docker event filter (refetch storm)', () => {
  // Every `docker exec` emits exec_create/exec_start/exec_die. Broadcasting them
  // made each open terminal trigger ~6 instance-list refetches per second.
  it('ignores exec events', () => {
    for (const a of ['exec_create: cat /tmp/.tmux-clipboard', 'exec_start: bash', 'exec_die', 'attach', 'resize', 'top']) {
      assert.equal(isLifecycleAction(a), false, a);
    }
  });
  it('keeps lifecycle events (negative control)', () => {
    for (const a of ['create', 'start', 'die', 'stop', 'destroy', 'oom', 'health_status: healthy']) {
      assert.equal(isLifecycleAction(a), true, a);
    }
  });
});

describe('squid access-log parsing', () => {
  it('parses a denied CONNECT and strips the port', () => {
    const e = parseSquidLine('1789561532.458 cm 172.27.0.9 TCP_DENIED/403 CONNECT example.com:443');
    assert.deepEqual(
      { ip: e.ip, denied: e.denied, host: e.host, status: e.status, method: e.method },
      { ip: '172.27.0.9', denied: true, host: 'example.com', status: 403, method: 'CONNECT' },
    );
  });
  it('parses a denied plain-HTTP request to its hostname', () => {
    const e = parseSquidLine('1789561532.458 cm 172.27.0.9 TCP_DENIED/403 GET http://evil.test/x?y=1');
    assert.equal(e.host, 'evil.test');
    assert.equal(e.denied, true);
  });
  it('marks allowed requests as not denied (negative control)', () => {
    const e = parseSquidLine('1789561532.458 cm 172.27.0.9 TCP_TUNNEL/200 CONNECT api.anthropic.com:443');
    assert.equal(e.denied, false);
  });
  it('ignores non-access-log lines', () => {
    assert.equal(parseSquidLine('[proxy] Watching /etc/squid/acl for changes...'), null);
  });
  it('squid.conf emits the format the parser expects, streamed to docker logs', () => {
    const conf = read('proxy/squid.conf');
    assert.match(conf, /^logformat cm .*\bcm %>a %Ss\/%03>Hs %rm %ru$/m);
    assert.match(conf, /^access_log \/var\/log\/squid\/access\.log cm$/m);
    // squid runs as 'proxy' and cannot open /dev/stdout — that crashed it on start
    assert.doesNotMatch(conf, /stdio:\/dev\/std/);
    assert.match(read('proxy/watch-acls.sh'), /tail -n0 -F \/var\/log\/squid\/access\.log/);
  });
});

describe('cm-proxy restart', () => {
  // A stale /run/squid.pid made squid refuse to start → proxy down for 4 weeks.
  it('removes the stale pid file before starting squid', () => {
    const sh = read('proxy/watch-acls.sh');
    const rm = sh.indexOf('rm -f /run/squid.pid');
    const start = sh.indexOf('squid -f /etc/squid/squid.conf');
    assert.ok(rm > -1, 'pid cleanup missing');
    assert.ok(rm < start, 'pid cleanup must run before squid starts');
  });

  // ACL changes made while squid was starting were missed → stale allow rule.
  it('starts the ACL watcher before squid and reloads once after start', () => {
    const sh = read('proxy/watch-acls.sh');
    const watch = sh.indexOf('inotifywait');
    const start = sh.indexOf('squid -f /etc/squid/squid.conf');
    const reload = sh.indexOf('squid -k reconfigure', sh.indexOf('sleep 2'));
    assert.ok(watch > -1 && watch < start, 'watcher must start before squid');
    assert.ok(reload > start, 'missing post-start reconfigure');
  });
});

describe('instance container config', () => {
  it('hostname is the slug (Remote Control session names)', () => {
    assert.equal(instanceHostname('cm-dbu-stats-f3b66ca2', 'f3b66ca2'), 'dbu-stats');
    assert.equal(instanceHostname('/cm-clever-e4fee1a8', 'e4fee1a8'), 'clever');
  });
  it('hostname falls back to the id when there is no slug', () => {
    assert.equal(instanceHostname('', 'abcd1234'), 'abcd1234');
  });
  it('instance logs are size-capped', () => {
    assert.equal(INSTANCE_LOG_CONFIG.Type, 'json-file');
    assert.ok(INSTANCE_LOG_CONFIG.Config['max-size']);
    assert.ok(INSTANCE_LOG_CONFIG.Config['max-file']);
  });
  it('compose caps log size for every long-running service', () => {
    const compose = read('docker-compose.yml');
    for (const svc of ['claude-manager', 'cm-proxy', 'cm-litellm', 'cm-ollama', 'cm-litellm-db']) {
      const block = compose.split(new RegExp(`^  ${svc}:$`, 'm'))[1]?.split(/^  \S/m)[0] || '';
      assert.match(block, /logging: \*default-logging/, `${svc} has no log rotation`);
    }
  });
});

describe('Claude autostart + session resume', () => {
  it('SessionStart hook records the session id', () => {
    const settings = JSON.parse(read('workspace/config/managed-settings.json'));
    const cmds = (settings.hooks.SessionStart || []).flatMap((h) => h.hooks.map((x) => x.command));
    assert.ok(cmds.includes('/usr/local/bin/cm-session-track'));
  });
  it('headless runs never replace the tracked session', () => {
    assert.match(read('workspace/scripts/cm-session-track'), /CLAUDE_CODE_ENTRYPOINT:-\}" = "cli" \] \|\| exit 0/);
  });
  it('autostart uses the same tmux socket/session the web terminal attaches to', () => {
    const entry = read('workspace/scripts/entrypoint.sh');
    const pty = read('server/docker.js');
    assert.match(pty, /tmux -L cm -f \/home\/claude\/.tmux.conf new-session -A -s main/);
    assert.match(entry, /tmux -L cm -f "\$HOME\/.tmux.conf" new-session -d -s main/);
    assert.match(entry, /send-keys -t main 'cm-autostart' Enter/);
  });
  // /workspace/.claude is a root-owned host bind on most instances — not writable
  it('stores the session id on the writable workspace volume, not /workspace/.claude', () => {
    assert.match(read('workspace/scripts/cm-session-track'), /> \/workspace\/\.cm-last-session/);
    assert.match(read('workspace/scripts/cm-autostart'), /LAST_FILE=\/workspace\/\.cm-last-session/);
    assert.doesNotMatch(read('workspace/scripts/cm-session-track'), /\/workspace\/\.claude\/\.cm-last-session/);
  });
  it('only resumes when the transcript exists (negative control: fresh start otherwise)', () => {
    const sh = read('workspace/scripts/cm-autostart');
    assert.match(sh, /if \[ -n "\$id" \] && \[ -f "\$HOME\/.claude\/projects\/-workspace\/\$id.jsonl" \]/);
  });
  it('the connectivity probe bypasses the entrypoint (no autostarted session)', () => {
    assert.match(read('server/connectivity-check.js'), /Entrypoint: \['sleep'\]/);
  });
});

describe('1Password integration', () => {
  it('instance API responses mask secret env values', async () => {
    const { redactEnv } = await import('../server/docker.js');
    const out = redactEnv([
      'OP_SERVICE_ACCOUNT_TOKEN=ops_abc', 'ANTHROPIC_API_KEY=sk-1', 'DB_PASSWORD=x',
      'CM_INSTANCE_ID=a1b2', 'TZ=Europe/Copenhagen', 'EMPTY_TOKEN=',
    ]);
    assert.deepEqual(out, [
      'OP_SERVICE_ACCOUNT_TOKEN=***', 'ANTHROPIC_API_KEY=***', 'DB_PASSWORD=***',
      'CM_INSTANCE_ID=a1b2', 'TZ=Europe/Copenhagen', 'EMPTY_TOKEN=',
    ]);
  });
  it('the token is re-injected on recreate (rotation) and not duplicated', () => {
    const src = read('server/docker.js');
    assert.match(src, /MANAGED_SECRET_PREFIXES\.some\(p => e\.startsWith\(p\)\)/);
    assert.match(src, /`CM_NETWORK_POLICY=\$\{newNetworkPolicy\}`, \.\.\.managedSecretEnv\(\),/);
  });
  it('the image ships op and the managed instructions', () => {
    const df = read('workspace/Dockerfile');
    assert.match(df, /apt-get install -y 1password-cli/);
    assert.match(df, /COPY config\/CLAUDE\.md \/etc\/claude-code\/CLAUDE\.md/);
    const md = read('workspace/config/CLAUDE.md');
    assert.match(md, /op run --env-file/);
    // The Claude vault is the exchange point in both directions
    assert.match(md, /op item create --vault Claude/);
    assert.match(md, /op read 'op:\/\/Claude\//);
    assert.match(md, /No secrets on local disk/);
  });
  it('compose passes the token to the manager', () => {
    assert.match(read('docker-compose.yml'), /OP_SERVICE_ACCOUNT_TOKEN=\$\{OP_SERVICE_ACCOUNT_TOKEN:-\}/);
  });
});

describe('idle stop', async () => {
  const { decide, parseSqliteUtc } = await import('../server/idle-stop.js');
  const day = 86_400_000;
  const base = { now: 10 * day, idleMs: 3 * day, saveTimeoutMs: 15 * 60_000, terminalOpen: false, pendingAskedAt: 0, lastEvent: 'Stop', eventAtMs: 0 };
  it('leaves recently active instances alone', () => {
    assert.equal(decide({ ...base, lastActivityMs: 9 * day, claudeRunning: true }), 'active');
  });
  it('never stops an instance with an open terminal (negative control)', () => {
    assert.equal(decide({ ...base, lastActivityMs: 0, terminalOpen: true, claudeRunning: true }), 'active');
    assert.equal(decide({ ...base, lastActivityMs: 0, terminalOpen: true, pendingAskedAt: base.now - day }), 'active');
  });
  it('asks Claude to save memory before stopping', () => {
    assert.equal(decide({ ...base, lastActivityMs: 1 * day, claudeRunning: true }), 'ask');
  });
  it('stops directly when no Claude session is running', () => {
    assert.equal(decide({ ...base, lastActivityMs: 1 * day, claudeRunning: false }), 'stop');
  });
  it('waits for the save, then stops on the Stop event', () => {
    const asked = base.now - 60_000;
    assert.equal(decide({ ...base, lastActivityMs: 0, pendingAskedAt: asked, lastEvent: 'Stop', eventAtMs: asked - 1 }), 'wait');
    assert.equal(decide({ ...base, lastActivityMs: 0, pendingAskedAt: asked, lastEvent: 'Notification', eventAtMs: asked + 1 }), 'wait');
    assert.equal(decide({ ...base, lastActivityMs: 0, pendingAskedAt: asked, lastEvent: 'Stop', eventAtMs: asked + 1 }), 'stop');
  });
  it('accepts a Stop event in the same second as the request', () => {
    const asked = base.now - 60_000 + 400;
    assert.equal(decide({ ...base, lastActivityMs: 0, pendingAskedAt: asked, lastEvent: 'Stop', eventAtMs: asked - 400 }), 'stop');
  });
  it('stops after the save timeout', () => {
    assert.equal(decide({ ...base, lastActivityMs: 0, pendingAskedAt: base.now - 16 * 60_000, eventAtMs: 0 }), 'stop');
  });
  it('parses SQLite UTC timestamps', () => {
    assert.equal(parseSqliteUtc('2026-09-16 12:00:00'), Date.UTC(2026, 8, 16, 12));
    assert.equal(parseSqliteUtc(null), 0);
  });
});

describe('1Password egress on restricted policies', () => {
  for (const p of ['claude-only', 'claude-github', 'claude-full-dev']) {
    it(`${p} allowlists 1Password`, () => {
      for (const dir of ['policies', 'workspace/policies']) {
        assert.match(read(`${dir}/${p}.yaml`), /^  - \.1password\.com$/m, `${dir}/${p}`);
      }
    });
  }
});

describe('idle stop scheduling', () => {
  // Overlapping ticks typed the save prompt twice into one message.
  it('guards against overlapping ticks', () => {
    const src = read('server/idle-stop.js');
    assert.match(src, /if \(tickInProgress\) return;/);
    assert.match(src, /finally \{ tickInProgress = false; \}/);
  });
  // A "system notice" wording tripped the model safeguards and paused the session.
  it('save prompt reads as a plain user request', async () => {
    const { SAVE_PROMPT } = await import('../server/idle-stop.js');
    assert.doesNotMatch(SAVE_PROMPT, /^Claude Manager:/);
    assert.match(SAVE_PROMPT, /memory/);
  });
});

describe('policy parsing', () => {
  // A "# heading" comment inside allowed_hosts ended the list: claude-full-dev
  // silently allowed only the 4 Anthropic hosts (no GitHub/npm/PyPI).
  it('keeps hosts after comment lines', async () => {
    // config is frozen at first import, so read the policies in a fresh process
    const { execFileSync } = await import('child_process');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e',
      "const { listPolicies } = await import('./server/docker.js'); console.log(JSON.stringify(listPolicies()));"],
      { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, POLICIES_DIR: 'policies' } });
    const byId = Object.fromEntries(JSON.parse(out).map((p) => [p.id, p.allowedHosts]));
    for (const h of ['github.com', 'registry.npmjs.org', 'pypi.org', '.1password.com']) {
      assert.ok(byId['claude-full-dev'].includes(h), `claude-full-dev missing ${h}`);
    }
    assert.ok(byId['claude-only'].includes('.1password.com'));
    // negative control: nothing leaks in from comments
    assert.ok(!Object.values(byId).flat().some((h) => h.startsWith('#')));
  });
});

describe('recreate / image regressions', () => {
  // Older instances had no CM_INSTANCE_ID → autostart and hooks silently off.
  it('recreate re-asserts instance identity env', () => {
    const src = read('server/docker.js');
    assert.match(src, /`CM_INSTANCE_ID=\$\{instanceId\}`, `CM_MANAGER_URL=\$\{MANAGER_URL\}`/);
  });
  // The 1Password package grabbed gid 1001 → claude became 1002, breaking volume ownership.
  it('claude user is created with fixed ids before other packages', () => {
    const df = read('workspace/Dockerfile');
    const user = df.indexOf('useradd -m -u 1001 -g 1001');
    assert.ok(user > -1 && user < df.indexOf('1password-cli'), 'claude user must precede 1password-cli');
    assert.match(df, /test "\$\(id -u claude\):\$\(id -g claude\)" = "1001:1001"/);
  });
});

describe('knowledge library', () => {
  // Managed settings reject http:// MCP URLs ("must use a valid https:// url"),
  // and managed-mcp.json would take exclusive control of MCP servers.
  it('is registered per container at boot (user scope), not via managed config', () => {
    const settings = JSON.parse(read('workspace/config/managed-settings.json'));
    assert.equal(settings.managedMcpServers, undefined);
    assert.throws(() => read('workspace/config/managed-mcp.json'));
    const entry = read('workspace/scripts/entrypoint.sh');
    assert.match(entry, /KURL="\$\{CM_KNOWLEDGE_URL-http:\/\/cm-knowledge:8765\/mcp\}"/);
    assert.match(entry, /\.mcpServers\.knowledge = \{type: "http", url: \$u\}/);
  });
  it('bypasses the proxy and is described to agents', () => {
    assert.match(read('server/docker.js'), /NO_PROXY=localhost,127\.0\.0\.1,claude-manager,cm-proxy,cm-litellm,cm-knowledge,/);
    assert.match(read('workspace/config/CLAUDE.md'), /Search it before WebSearch\/WebFetch/);
  });
  it('compose runs cm-knowledge with its data on a docker volume', () => {
    const compose = read('docker-compose.yml');
    assert.match(compose, /container_name: cm-knowledge/);
    assert.match(compose, /\$\{KNOWLEDGE_DATA:-knowledge-data\}:\/data/);
    assert.match(compose, /^  knowledge-data:$/m);
    assert.match(compose, /"127\.0\.0\.1:8765:8765"/);
  });
});

describe('idle stop pane safety', async () => {
  const { paneState } = await import('../server/idle-stop.js');
  const rule = '\u2500'.repeat(40);
  it('reads an empty input as ready', () => {
    assert.deepEqual(paneState(`done\n${rule}\n\u276f\u00a0\n${rule}\n  \u23f5\u23f5 bypass permissions on (shift+tab to cycle)\n`), { state: 'ready', draft: '' });
  });
  // The save request used to be typed straight after an unsent draft and sent with it.
  it('extracts an unsent draft', () => {
    assert.deepEqual(paneState(`x\n${rule}\n\u276f\u00a0do it with the 10+ club split\n${rule}\n  \u23f5\u23f5 bypass permissions on`), { state: 'ready', draft: 'do it with the 10+ club split' });
  });
  // An open review/picker dialog has no input line: typing would land in the dialog.
  it('detects an open dialog', () => {
    const dialog = '\u2502 1 to review \u00b7 2 to send \u00b7 0 to dismiss \u2502\n\u2570' + rule + '\u256f\n\n        new task? /clear to save 337.9k tokens\n' + rule;
    assert.equal(paneState(dialog).state, 'dialog');
  });
  it('detects a running turn', () => {
    assert.equal(paneState(`\u273b Working\u2026 (esc to interrupt)\n\u276f\u00a0\n`).state, 'busy');
  });
  it('autostart retypes a saved draft without sending it', () => {
    const sh = read('workspace/scripts/cm-autostart');
    assert.match(sh, /tmux send-keys \$\{pane:\+-t "\$pane"\} -l "\$\(cat "\$DRAFT_FILE"\)"/);
    assert.doesNotMatch(sh, /DRAFT_FILE.*Enter/);
  });
});

describe('review fixes (2026-06-10 review, fixed 2026-09-16)', async () => {
  const { isValidAclHost } = await import('../shared/constants.js');
  const { buildDstdomains } = await import('../server/proxy.js');

  // C4: request-access hosts were written verbatim into a squid include.
  it('C4: rejects hostnames that could inject squid directives', () => {
    for (const bad of ['evil.com\nhttp_access allow all', 'evil.com http_access', 'a/b.com', 'evil.com:22', '', 'localhost', '-x.com', '..com', 'x'.repeat(64) + '.com']) {
      assert.equal(isValidAclHost(bad), false, JSON.stringify(bad));
    }
  });
  it('C4: accepts normal and wildcard hostnames (negative control)', () => {
    for (const ok of ['example.com', 'www.dr.dk', '.1password.com', '*.sentry.io', 'objects.githubusercontent.com']) {
      assert.equal(isValidAclHost(ok), true, ok);
    }
  });
  it('C4: request-access validates hosts before storing', () => {
    assert.match(read('server/routes/access-requests.js'), /hosts\.filter\(\(h\) => !isValidAclHost\(h\)\)/);
  });

  // C6: every host used to be written as ".host" (all subdomains).
  it('C6: exact hosts stay exact; wildcards are explicit', () => {
    assert.deepEqual(buildDstdomains(['api.anthropic.com', 'sentry.io']), ['api.anthropic.com', 'sentry.io']);
    assert.deepEqual(buildDstdomains(['*.1password.com', 'my.1password.com', '1password.com']), ['.1password.com']);
    assert.deepEqual(buildDstdomains(['.dr.dk', '.www.dr.dk', 'dr.dk']), ['.dr.dk']);
    assert.deepEqual(buildDstdomains(['Example.COM', 'example.com']), ['example.com']);
  });
  it('C6: drops invalid entries and reports them', () => {
    let reported = null;
    assert.deepEqual(buildDstdomains(['ok.com', 'bad\nhttp_access allow all'], (b) => { reported = b; }), ['ok.com']);
    assert.deepEqual(reported, ['bad\nhttp_access allow all']);
  });
  it('C6: squid only tunnels to 443, denies before per-instance allows', () => {
    const conf = read('proxy/squid.conf');
    const deny = conf.indexOf('http_access deny CONNECT !SSL_ports');
    assert.ok(deny > -1 && deny < conf.indexOf('include /etc/squid/acl/*.acl'));
    assert.match(conf, /^http_access deny !Safe_ports$/m);
  });

  // S2: broadcasters were decorated inside encapsulated plugins → undefined at root.
  it('S2: dashboard broadcasts are wired directly', () => {
    const idx = read('server/index.js');
    for (const fn of ['setImageBroadcaster', 'setScanBroadcaster', 'setConnectivityBroadcaster']) {
      assert.match(idx, new RegExp(`${fn}\\(broadcast\\);`));
    }
    assert.doesNotMatch(idx, /wire\w+Broadcaster/);
    assert.match(read('server/routes/access-requests.js'), /import \{ broadcast \} from '\.\/instances\.js';/);
  });

  // S4: recreate removed the old container before creating the new one.
  it('S4: recreate parks the old container and restores it on failure', () => {
    const src = read('server/docker.js');
    const park = src.indexOf('await container.rename({ name: parkedName });');
    const create = src.indexOf('newContainer = await docker.createContainer({');
    const remove = src.indexOf('await container.remove({ force: true });', create);
    assert.ok(park > -1 && park < create && create < remove);
    assert.match(src, /await container\.rename\(\{ name: oldName \}\)/);
  });

  // S5: LiteLLM/Ollama were published on every interface.
  it('S5: LLM ports are published on localhost only', () => {
    const compose = read('docker-compose.yml');
    assert.match(compose, /"127\.0\.0\.1:4000:4000"/);
    assert.match(compose, /"127\.0\.0\.1:11434:11434"/);
    assert.doesNotMatch(compose, /^\s*- "(4000|11434):/m);
  });

  // T3: a fixed test token became a standing admin credential.
  it('T3: no committed device token in tests', () => {
    assert.doesNotMatch(read('tests/helpers.js') + read('tests/01-auth.test.js'), /first-device-token-for-testing/);
  });

  // F1: rejected terminals reconnected ~1/s forever.
  it('F1: rejected terminals close with final codes the client honours', async () => {
    const { TERMINAL_CLOSE } = await import('../server/routes/terminal.js');
    assert.deepEqual(TERMINAL_CLOSE, { NOT_FOUND: 4404, NOT_RUNNING: 4409 });
    const tab = read('src/components/TerminalTab.jsx');
    assert.match(tab, /event\.code === 4404 \|\| event\.code === 4409/);
    assert.doesNotMatch(tab, /ws\.onopen = \(\) => \{\s*reconnectDelay\.current = 1000;/);
  });

  // F3: the poll fallback pushed an old clipboard on every (re)connect.
  it('F3: clipboard fallback is primed and skipped on the new image', () => {
    const src = read('server/routes/terminal.js');
    assert.match(src, /let lastClip = clean\(clipState/);
    assert.match(src, /const clipPoll = usesOsc52 \? null :/);
  });
});

describe('connectivity smoke test evidence', async () => {
  const { STARTED_RE } = await import('../server/connectivity-check.js');
  // An empty capture used to be reported as ok (false pass).
  it('recognises the startup screen, including cursor-stripped text', () => {
    assert.ok(STARTED_RE.test('Welcometo Claude Code'));
    assert.ok(STARTED_RE.test('Claude Code v2.1.273'));
  });
  it('does not treat empty or unrelated output as started (negative control)', () => {
    assert.equal(STARTED_RE.test(''), false);
    assert.equal(STARTED_RE.test('bash: claude: command not found'), false);
  });
  it('requires positive evidence for ok', () => {
    assert.match(read('server/connectivity-check.js'), /ok: started && !blocked,/);
  });
  // Negative control 2026-09-16: platform.claude.com denied by squid, but claude
  // printed no "Failed to connect" and the check passed. Blocks now come from squid.
  it('treats a squid denial of a required host as blocked', () => {
    const src = read('server/connectivity-check.js');
    assert.match(src, /const denied = await deniedHostsFor\(ip, runStartedAt\);/);
    assert.match(src, /const blocked = deniedRequired\.length > 0 \|\| CONNECT_FAIL_RE\.test\(out\);/);
  });
});
