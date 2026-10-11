/**
 * Is Claude Code logged in on a host? Claude Max instances share one Claude
 * home per host, so a host whose home has no credentials gives every Claude Max
 * instance there a "Not logged in" prompt. Nothing used to say so before the
 * instance was created.
 *
 * Checks only that the credentials file exists, never reads it. Results are
 * cached; remote hosts need a helper container, so the check is not free.
 */
import { existsSync } from 'node:fs';
import { getHost } from './db.js';
import { dockerFor } from './hosts.js';
import { runOnHost } from './host-fs.js';
import { moduleLogger } from './logger.js';

const log = moduleLogger('claude-login');
const TTL_MS = 5 * 60_000;
const cache = new Map();   // hostId -> { at, loggedIn }
const inflight = new Map(); // hostId -> Promise, so concurrent callers share one check

// The manager's own Claude home is mounted here (docker-compose.yml).
export const LOCAL_CLAUDE_HOME = '/claude-home';

export async function claudeLoginStatus(hostId, { refresh = false } = {}) {
  const hit = cache.get(hostId);
  if (!refresh && hit && Date.now() - hit.at < TTL_MS) return { hostId, loggedIn: hit.loggedIn, checkedAt: hit.at };
  if (inflight.has(hostId)) return inflight.get(hostId);
  const p = check(hostId).finally(() => inflight.delete(hostId));
  inflight.set(hostId, p);
  return p;
}

async function check(hostId) {
  const host = getHost(hostId);
  if (!host) return { hostId, loggedIn: null, checkedAt: null };
  let loggedIn = null;
  try {
    if (host.kind === 'local') {
      loggedIn = existsSync(`${LOCAL_CLAUDE_HOME}/.credentials.json`);
    } else if (host.data_root) {
      const out = await runOnHost(await dockerFor(hostId), host, 'test -f /root/claude-home/.credentials.json && echo LOGGED_IN || echo NO_LOGIN');
      loggedIn = out.includes('LOGGED_IN') ? true : out.includes('NO_LOGIN') ? false : null;
    }
  } catch (err) {
    log.warn({ hostId, err: err.message }, 'could not check the Claude login on this host');
  }
  const at = Date.now();
  cache.set(hostId, { at, loggedIn });
  return { hostId, loggedIn, checkedAt: at };
}

/** The last known answer, without checking (for payloads that must not block). */
export function cachedClaudeLogin(hostId) {
  return cache.has(hostId) ? cache.get(hostId).loggedIn : null;
}
