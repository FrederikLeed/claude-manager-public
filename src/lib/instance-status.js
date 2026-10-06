/**
 * What an instance is doing right now, derived from the lifecycle events its
 * in-container hook reported.
 *
 * One definition, used by the row, the card and the list order, so those three
 * can never disagree about which instances are waiting on you.
 *
 * The three events form a state machine:
 *   Notification      → Claude is waiting on the human (permission, or idle prompt)
 *   UserPromptSubmit  → the human answered; Claude is working
 *   Stop              → the turn finished
 *
 * UserPromptSubmit is what makes "needs input" trustworthy. With only
 * Notification and Stop, a permission prompt the user already answered in the
 * terminal still looks like it is waiting until the turn ends, which can be many
 * minutes of a wrong badge.
 */

/** Status colours are reserved, and each ships a glyph AND a word — never colour alone. */
const KINDS = {
  waiting: { glyph: '⏸', word: 'needs input', tone: 'var(--cm-warn)', rank: 0 },
  working: { glyph: '▶', word: 'working', tone: 'var(--cm-reach-3)', rank: 1 },
  idle: { glyph: '·', word: 'idle', tone: 'var(--cm-ink-3)', rank: 2 },
};

const EVENT_KIND = {
  Notification: 'waiting',
  UserPromptSubmit: 'working',
  Stop: 'idle',
};

/**
 * SQLite writes datetime('now') as "2026-10-06 12:34:56" — UTC with no marker,
 * which every browser parses as LOCAL time. Without the T and the Z the age is
 * wrong by the viewer's offset, which for this fleet is one or two hours.
 */
export function parseSqliteUtc(value) {
  if (!value) return null;
  const ms = Date.parse(/[TZ]/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}

export function shortAge(ms) {
  if (ms == null) return null;
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * The state a usage record describes, with no opinion about the container.
 * The fleet graph calls this directly: its node payload describes state as
 * Docker's status string ("Up 2 hours"), not as 'running'.
 */
export function statusFromUsage(usage) {
  const kind = EVENT_KIND[usage?.lastEvent];
  if (!kind) return null;
  const at = parseSqliteUtc(usage.updatedAt);
  return {
    kind,
    ...KINDS[kind],
    message: usage.statusMessage || null,
    at,
    age: shortAge(at),
  };
}

/**
 * Returns null when there is nothing to say — a stopped container, or a managed
 * instance whose hook has never reported. Absence is not "idle".
 */
export function instanceStatus(instance) {
  if (instance?.state !== 'running') return null;
  return statusFromUsage(instance.usage);
}

export function needsInput(instance) {
  return instanceStatus(instance)?.kind === 'waiting';
}

/** Waiting instances to the top; otherwise the order is left alone. */
export function byAttention(list) {
  return list
    .map((item, i) => ({ item, i, rank: instanceStatus(item)?.rank ?? 2 }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((e) => e.item);
}

/**
 * The context window, split into what it actually cost.
 *
 * cacheRead is replayed at a fraction of the input price and cacheCreation is
 * paid once to write it, so the ratio — not the total — is what says whether a
 * long session is cheap or thrashing. Returns null when the instance was last
 * seen by a hook that only reported a total; unknown is not zero.
 */
export function contextSplit(usage) {
  const s = usage?.split;
  if (!s) return null;
  const total = (s.input || 0) + (s.cacheRead || 0) + (s.cacheCreation || 0);
  if (!total) return null;
  return {
    ...s,
    total,
    cachedFraction: (s.cacheRead || 0) / total,
  };
}
