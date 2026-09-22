/**
 * Network-policy lint — static checks on workspace/policies/*.yaml.
 * Runs WITHOUT Docker. Guards against the failure mode where a restricted
 * policy's squid allowlist goes stale and silently breaks Claude Code
 * (squid 403 -> ERR_BAD_REQUEST), e.g. the v2.1.x move to platform.claude.com.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_CLAUDE_HOSTS } from '../shared/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');
// Two policy copies must stay in sync: policies/ is baked into the manager image
// (POLICIES_DIR=/app/policies — what the manager reads to generate squid ACLs);
// workspace/policies/ is bind-mounted into instances + used by the image rebuild.
const POLICY_DIRS = { 'policies': path.join(REPO, 'policies'), 'workspace/policies': path.join(REPO, 'workspace', 'policies') };

/** Parse `allowed_hosts:` list from a policy YAML (mirrors docker.js listPolicies). */
function parsePolicy(dir, file) {
  const content = readFileSync(path.join(dir, file), 'utf-8');
  const unrestricted = /^unrestricted:\s*true$/m.test(content);
  const hosts = [];
  let inHosts = false;
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (t === 'allowed_hosts:') { inHosts = true; continue; }
    if (inHosts) {
      if (!t.startsWith('-')) { inHosts = false; continue; }
      const h = t.replace(/^-\s*/, '');
      if (h && !h.startsWith('#')) hosts.push(h);
    }
  }
  return { id: file.replace('.yaml', ''), unrestricted, hosts };
}

const isCovered = (host, allowed) => allowed.some((a) => host === a || host.endsWith(`.${a}`));

describe('Network policy lint', () => {
  // Required-hosts check on BOTH dirs (the manager reads policies/, but both
  // must be correct since either can be the live source).
  for (const [label, dir] of Object.entries(POLICY_DIRS)) {
    const policies = readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => parsePolicy(dir, f));

    it(`${label}: finds policy files`, () => {
      assert.ok(policies.length > 0, `no policy YAMLs found in ${label}`);
    });

    // Every restricted policy that targets Claude (already allowlists
    // api.anthropic.com) must allowlist all hosts Claude Code requires.
    for (const p of policies.filter((p) => !p.unrestricted && isCovered('api.anthropic.com', p.hosts))) {
      for (const required of REQUIRED_CLAUDE_HOSTS) {
        it(`${label}: policy "${p.id}" allowlists required Claude host ${required}`, () => {
          assert.ok(
            isCovered(required, p.hosts),
            `policy "${p.id}" in ${label} is missing ${required} — Claude Code will fail (squid 403 -> ERR_BAD_REQUEST). Add it to ${label}/${p.id}.yaml`
          );
        });
      }
    }
  }

  // The two copies must be byte-identical, or the manager (policies/) and
  // instances (workspace/policies/) will diverge — exactly how platform.claude.com
  // got fixed in one and not the other.
  it('policies/ and workspace/policies/ are in sync', () => {
    const files = readdirSync(POLICY_DIRS['policies']).filter((f) => f.endsWith('.yaml'));
    for (const f of files) {
      const a = readFileSync(path.join(POLICY_DIRS['policies'], f), 'utf-8');
      const b = readFileSync(path.join(POLICY_DIRS['workspace/policies'], f), 'utf-8');
      assert.equal(a, b, `policy ${f} differs between policies/ and workspace/policies/ — keep them in sync`);
    }
  });
});
