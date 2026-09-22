/**
 * Idle stop — stops instances nobody has used for IDLE_STOP_DAYS, after giving
 * Claude a chance to save its memory.
 *
 * Idle = no Claude hook event (usage.updated_at) and no container start within
 * the window, and no browser terminal attached. Remote Control turns also fire
 * the Stop hook, so they count as activity.
 *
 * Flow per idle instance:
 *   1. If Claude is running in the tmux "main" pane, type a save-memory prompt
 *      into it and remember when we asked.
 *   2. Stop the container once Claude reports a Stop event after that prompt,
 *      or after IDLE_SAVE_TIMEOUT_MINUTES. Without a Claude pane, stop at once.
 * Containers are only stopped (never removed); on the next start the entrypoint
 * autostarts Claude and resumes the session.
 */
import Docker from 'dockerode';
import { config } from './config.js';
import { LABELS } from '../shared/constants.js';
import { getAllInstanceUsage, logActivity } from './db.js';
import { execInContainer, stopInstance } from './docker.js';
import { hasOpenTerminal } from './routes/terminal.js';
import { moduleLogger } from './logger.js';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const log = moduleLogger('idle-stop');

// Phrased as a plain user request. Measured on fresh sessions (2026-09-16):
// "system notice" and "stop the container / save to memory files" wordings were
// flagged by model safeguards in most runs; this one in 1 of 5. A flagged turn
// still ends with a Stop event, so the stop proceeds either way.
export const SAVE_PROMPT =
  "Let's pause here for today. Before we stop, please note where we are in your memory so we can pick it up next time.";

const pending = new Map(); // instanceId -> { askedAt: ms }
const notReadyWarned = new Set(); // log "not at prompt" once per instance
let timer = null;
let tickInProgress = false; // a slow tick must not overlap the next one (double prompts)

/** SQLite datetime('now') is UTC without a zone marker. */
export function parseSqliteUtc(value) {
  if (!value) return 0;
  const t = Date.parse(`${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Decide what to do with one instance. Pure — exported for tests.
 * @returns 'active' | 'ask' | 'stop' | 'wait'
 */
export function decide({ now, idleMs, lastActivityMs, terminalOpen, pendingAskedAt, lastEvent, eventAtMs, claudeRunning, saveTimeoutMs }) {
  if (terminalOpen) return 'active';
  if (pendingAskedAt) {
    // usage timestamps have 1 s resolution
    if (lastEvent === 'Stop' && eventAtMs >= Math.floor(pendingAskedAt / 1000) * 1000) return 'stop';
    if (now - pendingAskedAt >= saveTimeoutMs) return 'stop';
    return 'wait';
  }
  if (now - lastActivityMs < idleMs) return 'active';
  return claudeRunning ? 'ask' : 'stop';
}

const PROMPT_MARK = '\u276f'; // "❯" — Claude Code's input line

/**
 * Classify the Claude pane from `tmux capture-pane` text. Pure — exported for tests.
 * @returns {{ state: 'busy'|'dialog'|'ready', draft: string }}
 *   busy   = a turn is running
 *   dialog = no input line at the bottom (a picker/review dialog is open) — typing would land in it
 *   ready  = input line visible; draft = text already typed but not sent
 */
export function paneState(text) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.some((l) => l.includes('esc to interrupt'))) return { state: 'busy', draft: '' };
  const tail = lines.slice(-8);
  const at = tail.findIndex((l) => l.trimStart().startsWith(PROMPT_MARK));
  if (at < 0) return { state: 'dialog', draft: '' };
  const parts = [tail[at].trimStart().slice(PROMPT_MARK.length)];
  for (const l of tail.slice(at + 1)) {
    if (/^\s*\u2500{3,}/.test(l)) break; // box rule under the input
    parts.push(l);
  }
  const draft = parts.map((p) => p.replace(/\u00a0/g, ' ').trim()).filter(Boolean).join(' ');
  return { state: 'ready', draft };
}

async function capturePane(id) {
  return execInContainer(id, ['tmux', '-L', 'cm', 'capture-pane', '-p', '-t', 'main']).catch(() => '');
}

async function claudeInPane(id) {
  // The pane runs cm-autostart → claude; find a claude process on the pane's tty.
  const out = await execInContainer(id, [
    'sh', '-c',
    't=$(tmux -L cm display-message -p -t main "#{pane_tty}" 2>/dev/null) || exit 0; '
    + '[ -n "$t" ] && pgrep -x claude -t "${t#/dev/}" >/dev/null && echo yes',
  ]).catch(() => '');
  return String(out).includes('yes');
}

/**
 * Type the save request. An unsent draft is saved to /workspace/.cm-draft
 * (cm-autostart retypes it after the next start) and cleared first, so the
 * request isn't appended to it. Returns false when the pane isn't safe to type into.
 */
async function askToSave(id, name) {
  const pane = paneState(await capturePane(id));
  if (pane.state !== 'ready') {
    if (notReadyWarned.has(id)) return false;
    notReadyWarned.add(id);
    log.warn({ instanceId: id, instance: name, pane: pane.state }, 'idle but Claude is not at its input prompt; leaving it running');
    return false;
  }
  if (pane.draft) {
    await execInContainer(id, ['sh', '-c', 'printf "%s" "$1" > /workspace/.cm-draft', 'sh', pane.draft]);
    await execInContainer(id, ['tmux', '-L', 'cm', 'send-keys', '-t', 'main', 'C-c']);
    await new Promise((r) => setTimeout(r, 500));
    if (paneState(await capturePane(id)).draft) {
      log.warn({ instanceId: id, instance: name }, 'could not clear the unsent draft; leaving it running');
      return false;
    }
    log.info({ instanceId: id, instance: name }, 'saved unsent draft to /workspace/.cm-draft');
  }
  await execInContainer(id, ['tmux', '-L', 'cm', 'send-keys', '-t', 'main', '-l', SAVE_PROMPT]);
  await new Promise((r) => setTimeout(r, 300));
  await execInContainer(id, ['tmux', '-L', 'cm', 'send-keys', '-t', 'main', 'Enter']);
  return true;
}

export async function runIdleCheck() {
  const idleMs = config.IDLE_STOP_DAYS * 86_400_000;
  const saveTimeoutMs = config.IDLE_SAVE_TIMEOUT_MINUTES * 60_000;
  const usage = new Map(getAllInstanceUsage().map((u) => [u.instance_id, u]));
  const containers = await docker.listContainers({ filters: { label: [`${LABELS.MANAGED}=true`] } });
  const now = Date.now();
  const running = new Set();

  for (const c of containers) {
    const id = c.Labels?.[LABELS.ID];
    const name = c.Labels?.[LABELS.NAME] || id;
    if (!id) continue;
    if (config.IDLE_STOP_INSTANCE_IDS.length && !config.IDLE_STOP_INSTANCE_IDS.includes(id)) continue;
    running.add(id);
    const u = usage.get(id);
    const eventAtMs = parseSqliteUtc(u?.updated_at);
    let startedAtMs = 0;
    try {
      startedAtMs = Date.parse((await docker.getContainer(c.Id).inspect()).State?.StartedAt) || 0;
    } catch { continue; }

    const p = pending.get(id);
    const needsPaneCheck = !p && now - Math.max(eventAtMs, startedAtMs) >= idleMs && !hasOpenTerminal(id);
    const action = decide({
      now, idleMs, saveTimeoutMs,
      lastActivityMs: Math.max(eventAtMs, startedAtMs),
      terminalOpen: hasOpenTerminal(id),
      pendingAskedAt: p?.askedAt || 0,
      lastEvent: u?.last_event, eventAtMs,
      claudeRunning: needsPaneCheck ? await claudeInPane(id) : false,
    });

    const idleDays = ((now - Math.max(eventAtMs, startedAtMs)) / 86_400_000).toFixed(1);
    if (action === 'active') notReadyWarned.delete(id);
    if (action === 'active') {
      if (p) { pending.delete(id); log.info({ instanceId: id, instance: name }, 'idle stop cancelled: terminal opened'); }
    } else if (action === 'ask') {
      try {
        if (!(await askToSave(id, name))) continue;
        pending.set(id, { askedAt: now });
        log.info({ instanceId: id, instance: name, idleDays }, 'idle: asked Claude to save memory before stopping');
        logActivity('idle_save_requested', id, name, `Idle ${idleDays} days — asked Claude to save memory`);
      } catch (err) {
        log.warn({ err, instanceId: id }, 'could not prompt Claude; stopping without save');
        await stop(id, name, 'idle (prompt failed)');
      }
    } else if (action === 'stop') {
      const reason = p ? (u?.last_event === 'Stop' && eventAtMs >= Math.floor(p.askedAt / 1000) * 1000 ? 'memory saved' : 'save timed out') : `idle ${idleDays} days, no Claude session`;
      await stop(id, name, reason);
    }
  }
  for (const id of pending.keys()) if (!running.has(id)) pending.delete(id);
}

async function stop(id, name, reason) {
  pending.delete(id);
  try {
    await stopInstance(id, 30);
    log.info({ instanceId: id, instance: name, reason }, 'idle instance stopped');
    logActivity('idle_stopped', id, name, `Stopped: ${reason}`);
  } catch (err) {
    log.error({ err, instanceId: id }, 'failed to stop idle instance');
  }
}

export function startIdleStop() {
  if (!(config.IDLE_STOP_DAYS > 0)) return;
  const tick = async () => {
    if (tickInProgress) return;
    tickInProgress = true;
    try { await runIdleCheck(); } catch (err) { log.error({ err }, 'idle check crashed'); } finally { tickInProgress = false; }
  };
  const every = config.IDLE_CHECK_INTERVAL_SECONDS * 1000;
  timer = setInterval(tick, every);
  timer.unref?.();
  setTimeout(tick, Math.min(60_000, Math.floor(every / 2))).unref?.();
  log.info(`idle stop after ${config.IDLE_STOP_DAYS} days (save timeout ${config.IDLE_SAVE_TIMEOUT_MINUTES} min)`);
}

export function stopIdleStop() {
  if (timer) clearInterval(timer);
  timer = null;
}
