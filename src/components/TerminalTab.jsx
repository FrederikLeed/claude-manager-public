import { useRef, useEffect, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { registerTerminal, unregisterTerminal } from '../lib/terminalBus.js';

/**
 * A single terminal tab — creates its own xterm instance and WebSocket.
 * Only mounts the terminal into the DOM when `visible` is true.
 *
 * Renderer: WebGL (GPU) with automatic fallback to the DOM renderer on
 * context loss / unsupported browsers.
 *
 * Reconnect: the WebSocket auto-reconnects with backoff; the server-side tmux
 * session persists, so reconnecting redraws the live screen.
 *
 * Clipboard:
 *   Select text in tmux → auto-copies via the server clipboard bridge
 *   Shift+select → browser-native selection + Ctrl+C
 *   Ctrl+Shift+V / Ctrl+V / right-click → paste
 *
 * Search: Ctrl+F opens an in-terminal search box (Enter / Shift+Enter to cycle).
 */

/** Copy text to the host clipboard (works over HTTP) */
function copyToClipboard(text) {
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

const THEME = {
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
};

export default function TerminalTab({ instanceId, visible }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const searchRef = useRef(null);
  const wsRef = useRef(null);
  const resizeObserverRef = useRef(null);
  const reconnectTimer = useRef(null);
  const reconnectDelay = useRef(1000);
  const closingRef = useRef(false);

  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef(null);

  // Create terminal + addons on mount, destroy on unmount
  useEffect(() => {
    if (!instanceId) return;
    closingRef.current = false;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, monospace",
      rightClickSelectsWord: false, // right-click pastes instead (see contextmenu handler)
      scrollback: 5000,
      allowProposedApi: true,
      theme: THEME,
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.loadAddon(new WebLinksAddon());

    // OSC 52 clipboard: tmux (set-clipboard on) emits ESC]52;<Pc>;<base64>BEL on
    // copy. Handle it ourselves rather than via addon-clipboard so we (a) accept
    // the empty-selection form `]52;;…` that tmux emits, and (b) fall back to
    // execCommand on non-secure-context HTTP where the Clipboard API is blocked.
    term.parser.registerOscHandler(52, (data) => {
      const semi = data.indexOf(';');
      if (semi === -1) return false;
      const payload = data.slice(semi + 1);
      if (payload === '?') return true; // clipboard read request — ignore
      try {
        const bin = atob(payload);
        const text = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
        if (text) copyToClipboard(text);
      } catch { /* malformed base64 — ignore */ }
      return true;
    });
    // Correct cell widths for box-drawing / CJK / emoji in TUIs like Claude Code
    try {
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = '11';
    } catch { /* non-fatal */ }

    termRef.current = term;
    fitRef.current = fitAddon;
    searchRef.current = searchAddon;

    // Key handling: clipboard + search
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;

      // Ctrl+F / Cmd+F → open in-terminal search (don't trigger browser find)
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        setShowSearch(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
        return false;
      }

      // Ctrl+C with an xterm selection (Shift+select) → copy, don't send SIGINT
      if (e.ctrlKey && e.key === 'c' && term.hasSelection()) {
        copyToClipboard(term.getSelection());
        term.clearSelection();
        return false;
      }

      // Ctrl+Shift+V or Ctrl+V → paste (bracketed) via WebSocket
      if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        navigator.clipboard.readText().then((text) => {
          if (text && wsRef.current?.readyState === 1) {
            wsRef.current.send('\x1b[200~' + text + '\x1b[201~');
          }
        });
        return false;
      }

      return true;
    });

    return () => {
      closingRef.current = true;
      clearTimeout(reconnectTimer.current);
      unregisterTerminal(instanceId);
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
      searchRef.current = null;
    };
  }, [instanceId]);

  // Attach to DOM + connect when the container is available and visible
  useEffect(() => {
    const term = termRef.current;
    const fitAddon = fitRef.current;
    const el = containerRef.current;
    if (!term || !fitAddon || !el || !visible) return;

    if (!el.querySelector('.xterm')) {
      term.open(el);

      // GPU renderer — load after open(); fall back to DOM on context loss
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => { try { webgl.dispose(); } catch { /* ignore */ } });
        term.loadAddon(webgl);
      } catch { /* WebGL unavailable → default DOM renderer */ }

      // Right-click pastes (bracketed) from the host clipboard
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!navigator.clipboard?.readText) return;
        navigator.clipboard.readText().then((text) => {
          if (text && wsRef.current?.readyState === 1) {
            wsRef.current.send('\x1b[200~' + text + '\x1b[201~');
          }
        }).catch(() => { /* permission denied / empty */ });
      });

      const sendResize = () => {
        if (wsRef.current?.readyState === 1) {
          wsRef.current.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      };

      // --- WebSocket with auto-reconnect (tmux persists the session) ---
      const connect = () => {
        if (closingRef.current) return;
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${location.host}/api/instances/${instanceId}/terminal`);
        ws.binaryType = 'arraybuffer';
        wsRef.current = ws;

        ws.onopen = () => {
          reconnectDelay.current = 1000;
          sendResize();
          registerTerminal(instanceId, { send: (d) => { if (ws.readyState === 1) ws.send(d); } });
        };

        ws.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            term.write(new Uint8Array(event.data));
          } else {
            try {
              const msg = JSON.parse(event.data);
              // Fallback clipboard bridge for instances still on the old image
              if (msg.type === 'clipboard' && msg.data) { copyToClipboard(msg.data); return; }
              if (msg.error) { term.writeln(`\r\n\x1b[31mError: ${msg.error}\x1b[0m`); return; }
            } catch { /* not JSON */ }
            term.write(event.data);
          }
        };

        ws.onclose = () => {
          unregisterTerminal(instanceId);
          if (closingRef.current) return;
          // tmux keeps the session alive — reconnect and it redraws
          term.writeln(`\r\n\x1b[33mDisconnected — reconnecting…\x1b[0m`);
          reconnectTimer.current = setTimeout(() => {
            reconnectDelay.current = Math.min(reconnectDelay.current * 2, 15000);
            connect();
          }, reconnectDelay.current);
        };

        ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };

        term.onData((data) => { if (ws.readyState === 1) ws.send(data); });
      };
      connect();

      // Resize observer
      let resizeTimeout;
      const observer = new ResizeObserver(() => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
          try { fitAddon.fit(); } catch { /* not visible */ }
          sendResize();
        }, 100);
      });
      observer.observe(el);
      resizeObserverRef.current = observer;

      // Virtual keyboard resize on mobile
      if (window.visualViewport) {
        const handleViewportResize = () => {
          clearTimeout(resizeTimeout);
          resizeTimeout = setTimeout(() => { try { fitAddon.fit(); } catch { /* ignore */ } }, 150);
        };
        window.visualViewport.addEventListener('resize', handleViewportResize);
        el._viewportCleanup = () => window.visualViewport.removeEventListener('resize', handleViewportResize);
      }
    }

    requestAnimationFrame(() => {
      try { fitAddon.fit(); } catch { /* ignore */ }
      term.focus();
    });
  }, [visible, instanceId]);

  // --- Search box actions ---
  const runSearch = (dir, opts = {}) => {
    const s = searchRef.current;
    if (!s || !searchQuery) return;
    const o = { incremental: false, decorations: { matchOverviewRuler: '#d29922', activeMatchColorOverviewRuler: '#58a6ff' } };
    if (dir === 'prev') s.findPrevious(searchQuery, o); else s.findNext(searchQuery, { ...o, ...opts });
  };
  const closeSearch = () => {
    setShowSearch(false);
    setSearchQuery('');
    try { searchRef.current?.clearDecorations(); } catch { /* ignore */ }
    termRef.current?.focus();
  };

  return (
    <div className="h-full w-full relative" style={{ display: visible ? 'block' : 'none' }}>
      {showSearch && (
        <div className="absolute top-1 right-3 z-20 flex items-center gap-1 bg-gray-900 border border-gray-700 rounded-md px-1.5 py-1 shadow-lg">
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setTimeout(() => runSearch('next', { incremental: true }), 0); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); runSearch(e.shiftKey ? 'prev' : 'next'); }
              else if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
            }}
            placeholder="Search…"
            className="bg-gray-800 text-gray-100 text-xs rounded px-2 py-1 w-40 outline-none focus:ring-1 focus:ring-blue-600"
          />
          <button onClick={() => runSearch('prev')} title="Previous (Shift+Enter)" className="text-gray-400 hover:text-gray-100 px-1">↑</button>
          <button onClick={() => runSearch('next')} title="Next (Enter)" className="text-gray-400 hover:text-gray-100 px-1">↓</button>
          <button onClick={closeSearch} title="Close (Esc)" className="text-gray-400 hover:text-gray-100 px-1">×</button>
        </div>
      )}
      <div ref={containerRef} className="h-full w-full" style={{ touchAction: 'pan-y' }} />
    </div>
  );
}
