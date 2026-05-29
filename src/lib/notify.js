// Browser notifications for instance lifecycle events (Claude finished / needs
// attention). Three channels: in-app toast (handled by the caller), desktop
// Notification, and a short audio chime. Enablement is user-controlled and
// persisted; desktop permission must be requested from a user gesture.

const STORAGE_KEY = 'cm-notify-enabled';

export function notificationsEnabled() {
  return localStorage.getItem(STORAGE_KEY) === '1';
}

export function setNotificationsEnabled(value) {
  localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
}

export function notificationPermission() {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

/** Enable notifications and request desktop permission (call from a click). */
export async function enableNotifications() {
  setNotificationsEnabled(true);
  if ('Notification' in window && Notification.permission === 'default') {
    try {
      await Notification.requestPermission();
    } catch {
      /* user dismissed — toasts + audio still work */
    }
  }
}

export function disableNotifications() {
  setNotificationsEnabled(false);
}

/** Raise an OS-level notification if permitted. Coalesces per instance via tag. */
export function desktopNotify(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body: body || '', tag: tag || undefined, renotify: false });
  } catch {
    /* some browsers throw if constructed outside a SW for certain options */
  }
}

let _audioCtx = null;

/** Short, unobtrusive two-tone chime via the Web Audio API (no asset needed). */
export function playChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    _audioCtx = _audioCtx || new Ctx();
    const ctx = _audioCtx;
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    const notes = [880, 1175]; // A5 → D6
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = now + i * 0.12;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.2);
    });
  } catch {
    /* audio not available / blocked — non-fatal */
  }
}

/** Format a token count compactly: 54200 → "54.2k", 1900 → "1.9k", 800 → "800". */
export function formatTokens(n) {
  if (!n || n < 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
