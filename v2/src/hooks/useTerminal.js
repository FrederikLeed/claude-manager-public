import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export function useTerminal(containerId, terminalRef) {
  const termRef = useRef(null);
  const wsRef = useRef(null);
  const fitRef = useRef(null);

  useEffect(() => {
    if (!containerId || !terminalRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, monospace",
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
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    termRef.current = term;
    fitRef.current = fitAddon;

    // Open terminal in DOM
    term.open(terminalRef.current);

    // Delay fit to ensure DOM is laid out
    requestAnimationFrame(() => {
      fitAddon.fit();
      connectWebSocket(containerId, term, fitAddon, wsRef);
    });

    // Resize observer with debounce
    let resizeTimeout;
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        fitAddon.fit();
        if (wsRef.current?.readyState === 1) {
          wsRef.current.send(JSON.stringify({
            type: 'resize',
            cols: term.cols,
            rows: term.rows,
          }));
        }
      }, 100);
    });
    resizeObserver.observe(terminalRef.current);

    return () => {
      clearTimeout(resizeTimeout);
      resizeObserver.disconnect();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [containerId, terminalRef]);

  return { terminal: termRef, fit: fitRef };
}

function connectWebSocket(containerId, term, fitAddon, wsRef) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(
    `${protocol}//${location.host}/api/instances/${containerId}/terminal`
  );
  ws.binaryType = 'arraybuffer';
  wsRef.current = ws;

  ws.onopen = () => {
    // Send initial terminal size
    ws.send(JSON.stringify({
      type: 'resize',
      cols: term.cols,
      rows: term.rows,
    }));
  };

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      term.write(new Uint8Array(event.data));
    } else {
      // Check for error messages from server
      try {
        const msg = JSON.parse(event.data);
        if (msg.error) {
          term.writeln(`\r\n\x1b[31mError: ${msg.error}\x1b[0m`);
          return;
        }
      } catch {
        // Not JSON, regular output
      }
      term.write(event.data);
    }
  };

  ws.onclose = () => {
    term.writeln('\r\n\x1b[33mConnection closed.\x1b[0m');
  };

  ws.onerror = () => {
    term.writeln('\r\n\x1b[31mConnection error.\x1b[0m');
  };

  // Forward terminal input to WebSocket
  term.onData((data) => {
    if (ws.readyState === 1) {
      ws.send(data);
    }
  });
}
