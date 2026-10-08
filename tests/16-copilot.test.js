/**
 * github-copilot backend: the instance runs GitHub's Copilot CLI, the token is
 * resolved inside the instance from 1Password, and placement refuses a network
 * policy that would block Copilot's endpoint. Docker-free.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

let assertBackendFitsPolicy, listPolicies, topologySource;
before(async () => {
  process.env.DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'cm-copilot-'));
  process.env.POLICIES_DIR ||= path.join(ROOT, 'policies');
  ({ assertBackendFitsPolicy, listPolicies } = await import('../server/docker.js'));
  topologySource = read('server/topology.js');
});

describe('github-copilot backend', () => {
  it('is an accepted backend in the create route', () => {
    assert.match(read('server/routes/instances.js'), /enum: \[[^\]]*'github-copilot'[^\]]*\]/);
  });

  it('never routes through LiteLLM and hands the instance only a vault reference', () => {
    const src = read('server/docker.js');
    assert.match(src, /NON_LITELLM_BACKENDS = new Set\(\['claude-max', 'github-copilot'\]\)/);
    assert.match(src, /CM_COPILOT_TOKEN_REF=\$\{config\.COPILOT_TOKEN_REF\}/);
    assert.doesNotMatch(src, /COPILOT_GITHUB_TOKEN=/, 'the token itself must never be put in container env');
    assert.match(read('server/config.js'), /COPILOT_TOKEN_REF: process\.env\.COPILOT_TOKEN_REF \|\| 'op:\/\/Claude\/github-copilot\/credential'/);
  });

  it('the wrapper resolves the reference at run time and leaves GH_TOKEN alone', () => {
    const w = read('workspace/scripts/copilot');
    assert.match(w, /op read "\$CM_COPILOT_TOKEN_REF"/);
    assert.match(w, /export COPILOT_GITHUB_TOKEN=/);
    assert.match(w, /exec \/usr\/bin\/copilot "\$@"/);
    assert.doesNotMatch(w, /^\s*export GH_TOKEN/m);
    assert.doesNotMatch(w, /echo[^\n]*\$tok/, 'never echo the token');
    const df = read('workspace/Dockerfile');
    assert.match(df, /npm install -g @github\/copilot@latest/);
    assert.match(df, /COPY scripts\/copilot \/usr\/local\/bin\/copilot/);
    assert.match(df, /"trustedFolders": \["\/workspace"\]/, 'autostart must not stop at the trust dialog');
  });

  it('autostart launches copilot, not claude, on this backend', () => {
    const a = read('workspace/scripts/cm-autostart');
    const i = a.indexOf('"${CM_LLM_BACKEND:-}" = "github-copilot"');
    assert.ok(i > 0 && i < a.indexOf('claude "${args[@]}"'));
  });

  it('policies that allow GitHub also allow Copilot; claude-only does not', () => {
    const byId = Object.fromEntries(listPolicies().map((p) => [p.id, p]));
    for (const id of ['claude-github', 'claude-full-dev']) {
      assert.ok(byId[id].allowedHosts.includes('.githubcopilot.com'), id);
    }
    assert.ok(!byId['claude-only'].allowedHosts.includes('.githubcopilot.com'));
  });

  it('placement refuses a policy that blocks Copilot, with a typed code', () => {
    const policies = listPolicies();
    for (const ok of ['unrestricted', 'claude-github', 'claude-full-dev']) {
      assert.doesNotThrow(() => assertBackendFitsPolicy('github-copilot', ok, policies), ok);
    }
    assert.throws(() => assertBackendFitsPolicy('github-copilot', 'claude-only', policies),
      (e) => e.statusCode === 409 && e.code === 'policy_blocks_backend');
    // Other backends are not this check's business.
    assert.doesNotThrow(() => assertBackendFitsPolicy('claude-max', 'claude-only', policies));
    // Recreate re-checks with the backend from the container label.
    assert.match(read('server/docker.js'), /assertBackendFitsPolicy\(oldLabels\[LABELS\.LLM_BACKEND\], newNetworkPolicy\)/);
  });

  it('the fleet graph draws it to its own backend, not to LiteLLM', () => {
    assert.match(topologySource, /id: 'backend:github-copilot'/);
    assert.match(topologySource, /backend === 'github-copilot' \? `backend:\$\{backend\}`/);
  });
});
