/**
 * Instances on remote hosts could not prove their callbacks (2026-10-13): the
 * remote host's image carried a hook that never sent its token, and instances
 * created before tokens had none, while the address fallback cannot work across
 * hosts. Docker-free.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
process.env.DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'cm-callback-'));
const db = await import('../server/db.js');
db.initDb();
const { hashToken } = await import('../server/auth.js');

describe('callback tokens in the database', () => {
  it('setEventToken stores the digest auth checks against, never the token', () => {
    db.upsertInstance({ id: 'tok00001', name: 'token test', image: 'x', hostId: 'local' });
    assert.equal(db.eventTokenMatches('tok00001', 'anything'), false, 'no token on record matches nothing');
    db.setEventToken('tok00001', 'example-callback-token');
    assert.equal(db.getInstance('tok00001').event_token, hashToken('example-callback-token'));
    assert.ok(!JSON.stringify(db.getInstance('tok00001')).includes('example-callback-token'));
    assert.equal(db.eventTokenMatches('tok00001', 'example-callback-token'), true);
    assert.equal(db.eventTokenMatches('tok00001', 'wrong'), false);
    assert.equal(db.eventTokenMatches('tok00001', null), false);
  });
});

describe('recreate gives every instance a token it can present', () => {
  const src = read('server/docker.js');
  const fn = src.slice(src.indexOf('export async function recreateInstance'), src.indexOf('// --- Internal helpers ---'));

  it('drops the old token from the env and sets exactly one', () => {
    assert.match(fn, /identityPrefixes = \[[^\]]*'CM_EVENT_TOKEN='/);
    assert.equal(fn.match(/`CM_EVENT_TOKEN=\$\{eventToken\}`/g)?.length, 1);
  });
  it('keeps a matching token and issues one otherwise', () => {
    assert.match(fn, /const keepToken = eventTokenMatches\(instanceId, envToken\)/);
    assert.match(fn, /keepToken \? envToken : crypto\.randomBytes\(32\)/);
  });
  it('records a new token only after the replacement is up', () => {
    const iCreate = fn.indexOf('await client.createContainer(');
    const iRestore = fn.indexOf("'recreate failed; restoring the previous container'");
    const iSet = fn.indexOf('if (!keepToken) setEventToken(instanceId, eventToken)');
    assert.ok(iCreate > 0 && iRestore > iCreate && iSet > iRestore, 'set after the create/restore block');
  });
});

describe('the image every host runs comes from the current source', () => {
  it('the hook presents the token', () => {
    assert.match(read('workspace/scripts/cm-notify'), /Authorization: Bearer \$\{CM_EVENT_TOKEN\}/);
    assert.match(read('workspace/scripts/cm-access'), /Authorization: Bearer \$\{CM_EVENT_TOKEN\}/);
  });
  it('a rebuild builds on every enabled remote host after the local build, without failing on one', () => {
    const src = read('server/workspace-image.js');
    const build = src.slice(src.indexOf('export async function buildWorkspaceImage'), src.indexOf('async function buildOn('));
    assert.ok(build.indexOf('await buildOn(docker, log)') < build.indexOf('await buildOnRemoteHosts(log)'));
    const remote = src.slice(src.indexOf('async function buildOnRemoteHosts'));
    assert.match(remote, /getHosts\(\{ enabledOnly: true \}\)\.filter\(\(h\) => h\.kind !== 'local'\)/);
    assert.match(remote, /catch \(err\) \{\s*state\.hosts\[host\.id\]/);
  });
});
