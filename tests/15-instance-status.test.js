/**
 * Instance status derivation — pure, no server, no Docker.
 *
 * This is the one place that decides which instances are "waiting on you", and
 * three views read it, so it is worth pinning down: the event→state mapping, the
 * UTC parsing SQLite's datetime() format invites you to get wrong, and the
 * unknown-is-not-zero rule for the context split.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  instanceStatus, needsInput, byAttention, contextSplit, parseSqliteUtc,
} from '../src/lib/instance-status.js';

const running = (usage) => ({ id: 'i', state: 'running', usage });

describe('instanceStatus', () => {
  it('maps each lifecycle event to a state', () => {
    assert.equal(instanceStatus(running({ lastEvent: 'Notification' })).kind, 'waiting');
    assert.equal(instanceStatus(running({ lastEvent: 'UserPromptSubmit' })).kind, 'working');
    assert.equal(instanceStatus(running({ lastEvent: 'Stop' })).kind, 'idle');
  });

  it('always carries a glyph and a word, never colour alone', () => {
    for (const event of ['Notification', 'UserPromptSubmit', 'Stop']) {
      const s = instanceStatus(running({ lastEvent: event }));
      assert.ok(s.glyph, `${event} should have a glyph`);
      assert.ok(s.word, `${event} should have a word`);
      assert.ok(s.tone, `${event} should have a tone`);
    }
  });

  it('says nothing for a stopped container, even one that reported before', () => {
    assert.equal(instanceStatus({ state: 'exited', usage: { lastEvent: 'Notification' } }), null);
  });

  it('says nothing when the hook has never reported — absence is not idle', () => {
    assert.equal(instanceStatus({ state: 'running' }), null);
    assert.equal(instanceStatus({ state: 'running', usage: {} }), null);
  });

  it('ignores an event it does not know rather than guessing a state', () => {
    assert.equal(instanceStatus(running({ lastEvent: 'SessionStart' })), null);
  });

  it('carries the status message through', () => {
    const s = instanceStatus(running({ lastEvent: 'Notification', statusMessage: 'needs permission to use Bash' }));
    assert.equal(s.message, 'needs permission to use Bash');
  });
});

describe('needsInput', () => {
  it('is true only for a running instance whose last event was a Notification', () => {
    assert.equal(needsInput(running({ lastEvent: 'Notification' })), true);
    assert.equal(needsInput(running({ lastEvent: 'UserPromptSubmit' })), false);
    assert.equal(needsInput(running({ lastEvent: 'Stop' })), false);
    assert.equal(needsInput({ state: 'exited', usage: { lastEvent: 'Notification' } }), false);
  });
});

describe('byAttention', () => {
  it('floats waiting instances to the top', () => {
    const list = [
      { id: 'a', state: 'running', usage: { lastEvent: 'Stop' } },
      { id: 'b', state: 'running', usage: { lastEvent: 'Notification' } },
      { id: 'c', state: 'running', usage: { lastEvent: 'UserPromptSubmit' } },
    ];
    // b is waiting and moves up; a (idle) and c (working) keep their order.
    // Working must NOT outrank idle, or rows jump on every turn boundary.
    assert.deepEqual(byAttention(list).map((i) => i.id), ['b', 'a', 'c']);
  });

  it('is stable — equal ranks keep their original order', () => {
    const list = ['a', 'b', 'c', 'd'].map((id) => ({ id, state: 'running', usage: { lastEvent: 'Stop' } }));
    assert.deepEqual(byAttention(list).map((i) => i.id), ['a', 'b', 'c', 'd']);
  });

  it('does not drop unmanaged containers that have no usage at all', () => {
    const list = [{ id: 'x' }, { id: 'y', state: 'running', usage: { lastEvent: 'Notification' } }];
    assert.equal(byAttention(list).length, 2);
    assert.equal(byAttention(list)[0].id, 'y');
  });
});

describe('parseSqliteUtc', () => {
  it('reads datetime(\'now\') as UTC, not as local time', () => {
    // The bug this exists to prevent: Date.parse('2026-10-06 12:00:00') is
    // LOCAL in every browser, so the age would be off by the viewer's offset.
    assert.equal(parseSqliteUtc('2026-10-06 12:00:00'), Date.parse('2026-10-06T12:00:00Z'));
  });

  it('leaves an already-explicit timestamp alone', () => {
    assert.equal(parseSqliteUtc('2026-10-06T12:00:00Z'), Date.parse('2026-10-06T12:00:00Z'));
  });

  it('returns null for nothing and for junk', () => {
    assert.equal(parseSqliteUtc(null), null);
    assert.equal(parseSqliteUtc(''), null);
    assert.equal(parseSqliteUtc('not a date'), null);
  });
});

describe('contextSplit', () => {
  it('computes the cached share of the context', () => {
    const s = contextSplit({ split: { input: 1000, cacheRead: 8000, cacheCreation: 1000 } });
    assert.equal(s.total, 10000);
    assert.equal(s.cachedFraction, 0.8);
  });

  it('is null when the hook reported only a total — unknown is not zero', () => {
    assert.equal(contextSplit({ contextTokens: 54200, split: null }), null);
    assert.equal(contextSplit({ contextTokens: 54200 }), null);
  });

  it('is null for an all-zero split rather than dividing by zero', () => {
    assert.equal(contextSplit({ split: { input: 0, cacheRead: 0, cacheCreation: 0 } }), null);
  });
});

/**
 * Storage round-trip, against a temp SQLite DB — no server, no Docker.
 *
 * The integration suite covers the HTTP path, but it needs a Docker host, so the
 * two rules that are easy to regress live here too: the split survives, and the
 * status message does NOT survive the next event.
 */
describe('setInstanceUsage storage', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-usage-test-'));
  process.env.DATA_DIR = tmpDir;
  const db = await import('../server/db.js');
  db.initDb();

  it('round-trips the three token parts', () => {
    db.setInstanceUsage('inst-a', {
      contextTokens: 10_000, outputTokens: 500,
      inputTokens: 1000, cacheReadTokens: 8000, cacheCreationTokens: 1000,
      model: 'claude-opus-5', event: 'Stop',
    });
    const row = db.getInstanceUsage('inst-a');
    assert.equal(row.context_tokens, 10_000);
    assert.equal(row.input_tokens, 1000);
    assert.equal(row.cache_read_tokens, 8000);
    assert.equal(row.cache_creation_tokens, 1000);
  });

  it('replaces the status message on the next event rather than keeping it', () => {
    db.setInstanceUsage('inst-b', { event: 'Notification', statusMessage: 'needs permission to use Bash' });
    assert.equal(db.getInstanceUsage('inst-b').status_message, 'needs permission to use Bash');

    db.setInstanceUsage('inst-b', { event: 'Stop', contextTokens: 10 });
    assert.equal(
      db.getInstanceUsage('inst-b').status_message, null,
      'a permission prompt must not outlive the turn it belonged to',
    );
  });

  it('keeps the last known model when an event reports none', () => {
    db.setInstanceUsage('inst-c', { event: 'Stop', model: 'claude-opus-5' });
    db.setInstanceUsage('inst-c', { event: 'Notification' });
    assert.equal(db.getInstanceUsage('inst-c').model, 'claude-opus-5');
  });

  it('defaults the parts to zero for a caller that only reports a total', () => {
    db.setInstanceUsage('inst-d', { contextTokens: 4242, event: 'Stop' });
    const row = db.getInstanceUsage('inst-d');
    assert.equal(row.context_tokens, 4242);
    assert.equal(row.input_tokens, 0);
    assert.equal(row.cache_read_tokens, 0);
  });

  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
});
