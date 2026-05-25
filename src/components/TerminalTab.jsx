import { useRef, useEffect } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { showToast } from './Toast.jsx';

const COMPLETION_MARKER = '[CM_DONE]';
const MIN_NOTIFY_INTERVAL_MS = 15000;

/**
 * A single terminal tab — creates its own xterm instance and WebSocket.
 * Only mounts the terminal into the DOM when `visible` is true.
 *
 * Clipboard:
 *   Select text in tmux → auto-copies via OSC 52 bridge
 *   Shift+select → browser-native selection + Ctrl+C
 *   Ctrl+Shift+V / Ctrl+V / right-click → paste
 *
 * Mobile:
 *   Touch scrollback via xterm's built-in touch support
 *   Tap to focus and open keyboard
 */

/** Copy text to the host clipboard (works over HTTP) */
function copyToClipboard(text) {
  // Try modern API first, fall back to execCommand
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => execCommandCopy(text));
  } else {
    execCommandCopy(text);
  }
}
function execCommandCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;left:-9999px';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch { /* ignore */ }
  document.body.removeChild(ta);
}
export default function TerminalTab({ instanceId, instanceName, visible }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const wsRef = useRef(null);
  const resizeObserverRef = useRef(null);
  const audioContextRef = useRef(null);
  const completionAudioRef = useRef(null);
  const completionAudioUrlRef = useRef(undefined);
  const completionBufferRef = useRef('');
  const lastNotifyAtRef = useRef(0);

  const ensureAudioContext = () => {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;

    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContextClass();
    }

    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume().catch(() => {});
    }

    return audioContextRef.current;
  };

  const playFallbackTone = () => {
    const audioContext = ensureAudioContext();
    if (!audioContext) return;

    const now = audioContext.currentTime;
    const gain = audioContext.createGain();
    const osc = audioContext.createOscillator();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.setValueAtTime(660, now + 0.12);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.06, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);

    osc.connect(gain);
    gain.connect(audioContext.destination);
    osc.start(now);
    osc.stop(now + 0.45);
  };

  const resolveCompletionSoundUrl = async () => {
    if (completionAudioUrlRef.current !== undefined) {
      return completionAudioUrlRef.current;
    }

    // Optional explicit override in browser storage.
    const override = localStorage.getItem('cm:completionSoundUrl');
    if (override) {
      completionAudioUrlRef.current = override;
      return override;
    }

    // Auto-detect drop-in sound from operator-level claude-home storage.
    const candidates = ['/api/system/notification-sound'];

    for (const url of candidates) {
      try {
        const res = await fetch(url, { method: 'HEAD', credentials: 'include' });
        if (res.ok) {
          completionAudioUrlRef.current = url;
          return url;
        }
      } catch {
        // Keep trying candidates.
      }
    }

    // Do not cache misses forever; sound file may appear later.
    return null;
  };

  const playCompletionTone = async () => {
    const url = await resolveCompletionSoundUrl();
    if (url) {
      try {
        if (!completionAudioRef.current || completionAudioRef.current.src !== url) {
          completionAudioRef.current = new Audio(url);
          completionAudioRef.current.preload = 'auto';
        }
        completionAudioRef.current.currentTime = 0;
        await completionAudioRef.current.play();
        console.info('[terminal-notify] Played custom completion sound', { instanceId, instanceName, url });
        return;
      } catch (err) {
        console.warn('[terminal-notify] Failed custom completion sound, using fallback tone', {
          instanceId,
          instanceName,
          url,
          error: err?.message,
        });
      }
    }

    playFallbackTone();
  };

  const showCompletionNotification = () => {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      console.info('[terminal-notify] Browser notification permission not decided yet', { instanceId, instanceName });
      return;
    }
    if (Notification.permission !== 'granted') {
      console.info('[terminal-notify] Browser notification permission denied', { instanceId, instanceName });
      return;
    }

    const notification = new Notification(instanceName ? `Claude finished in ${instanceName}` : 'Claude finished', {
      body: 'The current task appears to be complete.',
      silent: true,
    });
    notification.onclick = () => {
      notification.close();
      window.focus();
    };
    setTimeout(() => notification.close(), 10000);
  };

  const notifyCompletion = (source = 'marker', force = false) => {
    const now = Date.now();
    if (!force && now - lastNotifyAtRef.current < MIN_NOTIFY_INTERVAL_MS) {
      return;
    }
    lastNotifyAtRef.current = now;

    console.info('[terminal-notify] Completion marker detected', {
      instanceId,
      instanceName,
      source,
      hidden: document.hidden,
      hasFocus: document.hasFocus(),
    });

    // Always show a visual in-app cue; click to dismiss.
    showToast(
      instanceName ? `Claude finished in ${instanceName}` : 'Claude finished',
      'info',
      10000,
    );

    // Always try sound, even when Claude Manager is focused.
    void playCompletionTone();

    if (document.hidden || !document.hasFocus()) {
      console.info('[terminal-notify] Tab is not focused; attempting desktop notification', {
        instanceId,
        instanceName,
      });
      showCompletionNotification();
    } else {
      console.info('[terminal-notify] Tab is focused; sound + in-app toast shown', { instanceId, instanceName });
    }
  };

  const processCompletionMarkers = (text) => {
    if (!text) return;

    const combined = `${completionBufferRef.current}${text}`;
    completionBufferRef.current = combined.slice(-128);

    if (combined.includes(COMPLETION_MARKER)) {
      notifyCompletion('marker');
    }
  };

  // Create terminal + WebSocket on mount, destroy on unmount
  useEffect(() => {
    if (!instanceId) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, monospace",
      rightClickSelectsWord: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        selectionBackground: '#264f78',
        black: '#0d1117',
        red: '#ff7b72',
        green: '#7ee787',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#c9d1d9',
        scrollbarSliderBackground: 'rgba(121, 121, 121, 0.4)',
        scrollbarSliderHoverBackground: 'rgba(121, 121, 121, 0.7)',
        scrollbarSliderActiveBackground: 'rgba(121, 121, 121, 0.8)',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    // Clipboard: intercept key events before xterm processes them
    term.attachCustomKeyEventHandler((e) => {
      // Ctrl+C with xterm selection (Shift+select) → copy, don't send SIGINT
      if (e.type === 'keydown' && e.ctrlKey && e.key === 'c' && term.hasSelection()) {
        copyToClipboard(term.getSelection());
        term.clearSelection();
        return false;
      }

      // Ctrl+Shift+V or Ctrl+V → paste
      if (e.type === 'keydown' && e.ctrlKey && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault(); // prevent native paste (would cause double-paste via onData)
        navigator.clipboard.readText().then((text) => {
          if (text && wsRef.current?.readyState === 1) {
            // Use bracketed paste mode so shells/editors handle multi-line correctly
            wsRef.current.send('\x1b[200~' + text + '\x1b[201~');
          }
        });
        return false;
      }

      return true; // let xterm handle everything else
    });

    termRef.current = term;
    fitRef.current = fitAddon;

    return () => {
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
        resizeObserverRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [instanceId]);

  // Attach terminal to DOM when container div is available and visible
  useEffect(() => {
    const term = termRef.current;
    const fitAddon = fitRef.current;
    const el = containerRef.current;
    if (!term || !fitAddon || !el || !visible) return;

    // Only open once — check if already opened
    if (!el.querySelector('.xterm')) {
      term.open(el);

      const unlockAudio = () => {
        ensureAudioContext();
        console.info('[terminal-notify] User interaction detected; audio context prepared', { instanceId, instanceName });
        if ('Notification' in window && Notification.permission === 'default') {
          Notification.requestPermission().catch(() => {});
        }
      };
      el.addEventListener('pointerdown', unlockAudio, { passive: true });
      el.addEventListener('keydown', unlockAudio);

      // Disable right-click context menu in terminal
      el.addEventListener('contextmenu', (e) => e.preventDefault());

      // Connect WebSocket
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(
        `${protocol}//${location.host}/api/instances/${instanceId}/terminal`
      );
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'resize',
          cols: term.cols,
          rows: term.rows,
        }));
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(event.data);
          const text = new TextDecoder().decode(bytes);
          processCompletionMarkers(text);
          term.write(bytes);
        } else {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'clipboard' && msg.data) {
              // OSC 52 clipboard bridge — tmux copied text, write to host clipboard
              copyToClipboard(msg.data);
              return;
            }
            if (msg.error) {
              term.writeln(`\r\n\x1b[31mError: ${msg.error}\x1b[0m`);
              return;
            }
          } catch { /* not JSON */ }
          processCompletionMarkers(event.data);
          term.write(event.data);
        }
      };

      ws.onclose = () => {
        term.writeln('\r\n\x1b[33mConnection closed.\x1b[0m');
      };

      ws.onerror = () => {
        term.writeln('\r\n\x1b[31mConnection error.\x1b[0m');
      };

      term.onData((data) => {
        if (ws.readyState === 1) ws.send(data);
      });

      // Resize observer
      let resizeTimeout;
      const observer = new ResizeObserver(() => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
          try {
            fitAddon.fit();
          } catch { /* may fail if element not visible */ }
          if (wsRef.current?.readyState === 1) {
            wsRef.current.send(JSON.stringify({
              type: 'resize',
              cols: term.cols,
              rows: term.rows,
            }));
          }
        }, 100);
      });
      observer.observe(el);
      resizeObserverRef.current = observer;

      // Handle virtual keyboard resize on mobile
      if (window.visualViewport) {
        const handleViewportResize = () => {
          clearTimeout(resizeTimeout);
          resizeTimeout = setTimeout(() => {
            try {
              fitAddon.fit();
            } catch { /* ignore */ }
          }, 150);
        };
        window.visualViewport.addEventListener('resize', handleViewportResize);
        // Store cleanup ref
        const cleanup = () => window.visualViewport.removeEventListener('resize', handleViewportResize);
        el._viewportCleanup = cleanup;
      }

      term.onBell(() => {
        // Ignore generic terminal bells to avoid noisy false positives.
        console.info('[terminal-notify] xterm bell event ignored (marker-only mode)', { instanceId, instanceName });
      });
    }

    // Fit whenever tab becomes visible
    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch { /* ignore */ }
      term.focus();
    });
  }, [visible, instanceId]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{
        display: visible ? 'block' : 'none',
        touchAction: 'pan-y',
      }}
    />
  );
}
