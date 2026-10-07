/**
 * Host registry + multi-host safety. Pure unit tests against a temp SQLite DB,
 * no Docker and no server.
 *
 * The important one is "unreachable host keeps its instances": syncWithDocker
 * used to treat a single daemon's container list as the whole truth, so a host
 * that merely failed to answer looked like a host whose instances had all been
 * deleted.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-hosts-test-'));
process.env.DATA_DIR = tmpDir;

const db = await import('../server/db.js');

before(() => { db.initDb(); });
after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('host registry', () => {
  it('always has the local host, and it cannot be deleted', () => {
    const local = db.getHost(db.DEFAULT_HOST_ID);
    assert.ok(local, 'local host row must exist');
    assert.equal(local.kind, 'local');
    assert.equal(local.enabled, true);
    assert.throws(() => db.deleteHost(db.DEFAULT_HOST_ID), /cannot delete/);
  });

  it('stores an op:// reference for the SSH key, never key material', () => {
    const host = db.upsertHost({
      id: 'tiny2', name: 'Tiny 2', address: '198.51.100.21',
      sshUser: 'claude', sshKeyRef: 'op://Claude/ssh-tiny2/private key',
      dataRoot: '/srv/claude-manager', managerUrl: 'http://198.51.100.21:3000',
      labels: { ram_gb: 32 },
    });
    assert.equal(host.ssh_key_ref, 'op://Claude/ssh-tiny2/private key');
    assert.match(host.ssh_key_ref, /^op:\/\//);
    assert.equal(host.ssh_port, 22);
    assert.deepEqual(host.labels, { ram_gb: 32 });
  });

  it('refuses to delete a host that still runs instances', () => {
    db.upsertInstance({ id: 'aaaa1111', name: 'on-tiny', image: 'claude-workspace', hostId: 'tiny2' });
    assert.throws(() => db.deleteHost('tiny2'), /still runs 1 instance/);
    db.deleteInstance('aaaa1111');
    db.deleteHost('tiny2');
    assert.equal(db.getHost('tiny2'), null);
  });

  it('separates hosts that accept instances from ones that do not', () => {
    db.upsertHost({ id: 'host-b', name: 'host-b', address: '198.51.100.20', acceptsInstances: false });
    const hosts = db.getHosts({ enabledOnly: true });
    const prod = hosts.find((h) => h.id === 'host-b');
    assert.equal(prod.acceptsInstances, false);
    assert.equal(hosts.find((h) => h.id === db.DEFAULT_HOST_ID).acceptsInstances, true);
  });
});

describe('instances are host-scoped', () => {
  it('defaults existing instances to the local host', () => {
    db.upsertInstance({ id: 'bbbb2222', name: 'legacy', image: 'claude-workspace' });
    assert.equal(db.getInstance('bbbb2222').host_id, db.DEFAULT_HOST_ID);
  });

  it('looks up a container id within its own host', () => {
    // Same docker_id on two daemons: ids are only unique per daemon.
    db.upsertHost({ id: 'tiny3', name: 'Tiny 3', address: '198.51.100.22' });
    db.upsertInstance({ id: 'cccc3333', dockerId: 'deadbeef', name: 'here', image: 'i' });
    db.upsertInstance({ id: 'dddd4444', dockerId: 'deadbeef', name: 'there', image: 'i', hostId: 'tiny3' });
    assert.equal(db.getInstanceByDockerId('deadbeef', db.DEFAULT_HOST_ID).id, 'cccc3333');
    assert.equal(db.getInstanceByDockerId('deadbeef', 'tiny3').id, 'dddd4444');
  });

  it('lists instances per host', () => {
    assert.deepEqual(db.getInstancesByHost('tiny3').map((i) => i.id), ['dddd4444']);
  });
});

describe('syncWithDocker never reaps another host', () => {
  it('keeps instances of a host that was not polled', () => {
    // Poll only the local daemon, which no longer reports dddd4444's sibling.
    db.syncWithDocker([{ id: 'cccc3333', name: 'here', image: 'i' }], [db.DEFAULT_HOST_ID]);
    assert.ok(db.getInstance('dddd4444'), 'remote host instance must survive a local-only sync');
    assert.equal(db.getInstance('bbbb2222'), null, 'local orphan without docker_id is still reaped');
  });

  it('is a no-op when no host could be polled', () => {
    const before = db.getAllInstances().length;
    db.syncWithDocker([], []);
    assert.equal(db.getAllInstances().length, before, 'empty host scope must change nothing');
  });

  it('reaps a remote orphan when that host IS polled and reports containers', () => {
    // An empty report is no longer licence to reap — see the empty-poll guard —
    // so the host must report something for the orphan to be removed.
    db.upsertInstance({ id: 'eeee5555', name: 'ghost', image: 'i', hostId: 'tiny3' });
    db.syncWithDocker([{ id: 'dddd4444', name: 'there', image: 'i', hostId: 'tiny3' }], ['tiny3']);
    assert.equal(db.getInstance('eeee5555'), null);
    assert.ok(db.getInstance('dddd4444'), 'the reported container survives');
  });
});

describe('regressions found by the multi-host design review', () => {
  it('does not move a remote instance to the local host when hostId is omitted', () => {
    // recreate / update-claude / adopt all call upsertInstance without hostId.
    // With a 'local' JS default the UPDATE branch's COALESCE never fell through,
    // so each of those silently reassigned the instance to the manager's daemon.
    db.upsertHost({ id: 'tiny9', name: 'Tiny 9', address: '198.51.100.29' });
    db.upsertInstance({ id: 'ffff6666', name: 'remote', image: 'i', hostId: 'tiny9' });
    db.upsertInstance({ id: 'ffff6666', name: 'remote', image: 'i' });   // recreate-shaped call
    assert.equal(db.getInstance('ffff6666').host_id, 'tiny9');
  });

  it('still defaults a brand new instance to the local host', () => {
    db.upsertInstance({ id: 'aaaa7777', name: 'fresh', image: 'i' });
    assert.equal(db.getInstance('aaaa7777').host_id, db.DEFAULT_HOST_ID);
  });

  it('refuses to reap when a polled host reports zero but the DB holds rows', () => {
    // An empty list from a host is indistinguishable from a wiped data root.
    const before = db.getInstancesByHost('tiny9').length;
    const { reapSkipped } = db.syncWithDocker([], ['tiny9']);
    assert.equal(db.getInstancesByHost('tiny9').length, before, 'rows must survive an empty poll');
    assert.deepEqual(reapSkipped, [{ hostId: 'tiny9', rows: before }]);
  });

  it('still reaps an orphan when the host reports other containers', () => {
    db.upsertInstance({ id: 'bbbb8888', name: 'ghost', image: 'i', hostId: 'tiny9' });
    db.syncWithDocker([{ id: 'ffff6666', name: 'remote', image: 'i', hostId: 'tiny9' }], ['tiny9']);
    assert.equal(db.getInstance('bbbb8888'), null);
    assert.ok(db.getInstance('ffff6666'));
  });
})

describe('host identity', () => {
  it('replaces a placeholder name but keeps a name the user chose', () => {
    db.upsertHost({ id: 'tiny5', name: 'tiny5', address: '198.51.100.25' });   // name == id: placeholder
    db.setHostIdentity('tiny5', { name: 'kitchen-tiny', engineId: 'ENGINE-A' });
    assert.equal(db.getHost('tiny5').name, 'kitchen-tiny');
    assert.equal(db.getHost('tiny5').docker_engine_id, 'ENGINE-A');
  });

  it('spots the same daemon registered under two hosts', () => {
    db.upsertHost({ id: 'tiny6', name: 'Tiny 6', address: '198.51.100.26' });
    db.setHostIdentity('tiny6', { engineId: 'ENGINE-A' });
    const twin = db.getHostByEngineId('ENGINE-A', 'tiny6');
    assert.equal(twin.id, 'tiny5', 'the other host on the same engine must be found');
    assert.equal(db.getHostByEngineId('ENGINE-A', 'tiny5').id, 'tiny6');
    assert.equal(db.getHostByEngineId('ENGINE-UNUSED'), null);
  });
})

describe('container callbacks must prove who they are', () => {
  it('stores only the digest of an instance callback token', () => {
    // The raw token lives in the container's env; the DB keeps a hash, so a
    // read of manager.db does not hand over the ability to impersonate.
    const raw = 'test-token-value';
    const digest = createHash('sha256').update(raw).digest('hex');
    db.upsertInstance({ id: 'cccc9999', name: 'tokened', image: 'i', eventToken: digest });
    const row = db.getInstance('cccc9999');
    assert.equal(row.event_token, digest);
    assert.ok(!String(row.event_token).includes(raw), 'the raw token must never be stored');
  });

  it('keeps the token when a later upsert omits it', () => {
    // recreate and update-claude both call upsertInstance without the token.
    db.upsertInstance({ id: 'cccc9999', name: 'tokened', image: 'i' });
    assert.ok(db.getInstance('cccc9999').event_token, 'a recreate must not strip the credential');
  });
})

describe('placement refuses what it cannot enforce', () => {
  it('rejects a restricted policy on a remote host', async () => {
    const { admit } = await import('../server/placement.js');
    db.upsertHost({
      id: 'remote1', name: 'Remote 1', kind: 'ssh', address: '10.0.0.9',
      sshUser: 'root', sshKeyRef: 'op://Claude/ssh-remote1/credential',
      dataRoot: '/var/lib/cm-fleet', acceptsInstances: true,
    });
    await assert.rejects(
      () => admit({ hostId: 'remote1', networkPolicy: 'claude-github' }),
      (err) => err.code === 'policy_unenforceable_on_host' && err.statusCode === 409,
      'a policy with no proxy behind it must be refused, not silently created',
    );
  });

  it('still allows unrestricted on a remote host', async () => {
    const { admit } = await import('../server/placement.js');
    // Reaches the liveness probe, which is as far as this test can go without a
    // real daemon — the point is that it is NOT refused for the policy.
    await assert.rejects(
      () => admit({ hostId: 'remote1', networkPolicy: 'unrestricted' }),
      (err) => err.code !== 'policy_unenforceable_on_host',
      'unrestricted must get past the policy gate',
    );
  });

  it('leaves the local host free to use any policy', async () => {
    const { admit } = await import('../server/placement.js');
    const host = await admit({ hostId: db.DEFAULT_HOST_ID, networkPolicy: 'claude-only' });
    assert.equal(host.id, db.DEFAULT_HOST_ID);
  });
});

describe('client cache signature', () => {
  it('includes ssh_port, so a port change invalidates the cached client', () => {
    const src = readFileSync(new URL('../server/hosts.js', import.meta.url), 'utf8');
    const sig = src.match(/function signatureOf\(host\) \{\s*return \[([^\]]*)\]/);
    assert.ok(sig, 'signatureOf should return an array of fields');
    assert.match(sig[1], /ssh_port/, 'ssh_port must be part of the cache key');
  });
});

describe('recreate and remove happen on the instance\'s own host', () => {
  // These pin a bug class, in the same way 14-topology pins the status
  // vocabulary: resolveContainer was made host-aware, but recreateInstance kept
  // building the replacement with the module-level LOCAL client and
  // removeInstance deleted the volume through it. A remote instance that was
  // recreated ended up on the manager's daemon with its row still pointing at
  // the remote host; a removed one leaked its volume.
  const src = readFileSync(new URL('../server/docker.js', import.meta.url), 'utf8');
  const body = (name) => {
    const i = src.indexOf(`export async function ${name}(`);
    assert.ok(i >= 0, `${name} should exist`);
    const j = src.indexOf('\n}\n', i);
    return src.slice(i, j);
  };

  it('recreateInstance resolves the instance host client and creates on it', () => {
    const b = body('recreateInstance');
    assert.match(b, /await dockerForInstance\(id\)/, 'must resolve the client for this instance');
    assert.match(b, /client\.createContainer\(/, 'the replacement must be created on that client');
    assert.doesNotMatch(b, /\bdocker\.createContainer\(/, 'must not create on the module-level local client');
    assert.match(b, /ensureImage\(newImage, client\)/, 'the image must be ensured on that host');
    assert.match(b, /managerUrlFor\(host, MANAGER_URL\)/, 'the callback URL must be the one this host can reach');
  });

  it('recreateInstance passes through the same placement gate as create', () => {
    assert.match(body('recreateInstance'), /await admit\(\{[^}]*existing: true/, 'recreate must re-admit, flagged as an existing instance');
  });

  it('removeInstance deletes the volume through the instance host client', () => {
    const b = body('removeInstance');
    assert.match(b, /await dockerForInstance\(id\)/);
    assert.match(b, /client\.getVolume\(/);
    assert.doesNotMatch(b, /\bdocker\.getVolume\(/, 'a remote volume deleted via the local client is silently leaked');
  });

  it('admit() lets an existing instance re-admit on a full host, but not a new one', async () => {
    const { admit } = await import('../server/placement.js');
    const { config } = await import('../server/config.js');
    // config is frozen, so fill the host to its cap with rows instead.
    const have = db.getInstancesByHost(db.DEFAULT_HOST_ID).length;
    const filler = [];
    for (let n = have; n < config.MAX_INSTANCES; n++) {
      const id = `cap-${n.toString().padStart(4, '0')}`;
      db.upsertInstance({ id, dockerId: `d-${id}`, name: id, image: 'x', hostId: db.DEFAULT_HOST_ID });
      filler.push(id);
    }
    try {
      assert.equal(db.getInstancesByHost(db.DEFAULT_HOST_ID).length, config.MAX_INSTANCES, 'precondition: host is exactly full');
      await assert.rejects(() => admit({ hostId: db.DEFAULT_HOST_ID }), (e) => e.code === 'host_full', 'a new instance must be refused at the cap');
      const host = await admit({ hostId: db.DEFAULT_HOST_ID, existing: true });
      assert.equal(host.id, db.DEFAULT_HOST_ID, 'an existing instance already counts and must be allowed through');
    } finally {
      for (const id of filler) db.deleteInstance(id);
    }
  });
});
