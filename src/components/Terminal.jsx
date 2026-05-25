import { useState, useCallback, useEffect, useRef } from 'react';
import TerminalTab from './TerminalTab.jsx';

const MIN_HEIGHT = 120;
const TAB_BAR_HEIGHT = 36;
const MOBILE_BREAKPOINT = 768;

function isMobile() {
  return window.innerWidth < MOBILE_BREAKPOINT;
}

/**
 * Docked terminal panel with tabs — Windows Terminal style.
 * Resizable via drag handle on desktop, full-screen on mobile.
 */
export default function TerminalPanel({ tabs, activeTabId, onActivate, onClose, onCloseAll, onHeightChange }) {
  const [maximized, setMaximized] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [height, setHeight] = useState(() => Math.floor(window.innerHeight * 0.45));
  const [mobile, setMobile] = useState(isMobile);
  const [viewportHeight, setViewportHeight] = useState(() => window.visualViewport?.height || window.innerHeight);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startHeight = useRef(0);

  // Track mobile breakpoint
  useEffect(() => {
    let last = isMobile();
    const check = () => {
      const now = isMobile();
      if (now !== last) {
        last = now;
        setMobile(now);
      }
    };
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Track visual viewport (changes when mobile keyboard shows/hides)
  const [viewportOffset, setViewportOffset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      setViewportHeight(vv.height);
      setViewportOffset(vv.offsetTop);
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  // Mobile: always maximize, lock body scroll
  useEffect(() => {
    if (tabs.length === 0) {
      document.body.classList.remove('terminal-focused');
      return;
    }
    if (mobile && !minimized) {
      document.body.classList.add('terminal-focused');
    } else {
      document.body.classList.remove('terminal-focused');
    }
    return () => document.body.classList.remove('terminal-focused');
  }, [mobile, minimized, tabs.length]);

  // Notify parent of height changes for scroll padding
  useEffect(() => {
    if (tabs.length === 0) {
      onHeightChange?.(0);
    } else if (minimized) {
      onHeightChange?.(TAB_BAR_HEIGHT);
    } else if (maximized || mobile) {
      onHeightChange?.(window.innerHeight);
    } else {
      onHeightChange?.(height);
    }
  }, [tabs.length, minimized, maximized, mobile, height, onHeightChange]);

  const handleToggleMaximize = useCallback(() => {
    if (mobile) return; // Always maximized on mobile
    setMaximized((v) => !v);
    setMinimized(false);
  }, [mobile]);

  const handleToggleMinimize = useCallback(() => {
    setMinimized((v) => !v);
    setMaximized(false);
  }, []);

  // Drag-to-resize (desktop only)
  const handleDragStart = useCallback((e) => {
    if (mobile) return;
    e.preventDefault();
    dragging.current = true;
    startY.current = e.clientY || e.touches?.[0]?.clientY || 0;
    startHeight.current = height;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, [height, mobile]);

  useEffect(() => {
    const handleDragMove = (e) => {
      if (!dragging.current) return;
      const clientY = e.clientY || e.touches?.[0]?.clientY || 0;
      const delta = startY.current - clientY;
      const newHeight = Math.max(MIN_HEIGHT, Math.min(window.innerHeight - 60, startHeight.current + delta));
      setHeight(newHeight);
      setMaximized(false);
      setMinimized(false);
    };

    const handleDragEnd = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', handleDragMove);
    window.addEventListener('mouseup', handleDragEnd);
    window.addEventListener('touchmove', handleDragMove);
    window.addEventListener('touchend', handleDragEnd);
    return () => {
      window.removeEventListener('mousemove', handleDragMove);
      window.removeEventListener('mouseup', handleDragEnd);
      window.removeEventListener('touchmove', handleDragMove);
      window.removeEventListener('touchend', handleDragEnd);
    };
  }, []);

  // Escape to minimize
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey) {
        setMinimized(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  if (tabs.length === 0) return null;

  const isFullScreen = maximized || (mobile && !minimized);
  const panelHeight = isFullScreen ? `${viewportHeight}px` : minimized ? `${TAB_BAR_HEIGHT}px` : `${height}px`;

  return (
    <div
      className="fixed left-0 right-0 z-50 flex flex-col bg-gray-950 border-t border-gray-700 animate-slide-up"
      style={{
        height: panelHeight,
        bottom: isFullScreen && mobile ? 'auto' : 0,
        top: isFullScreen && mobile ? `${viewportOffset}px` : 'auto',
        paddingBottom: !mobile ? 'var(--safe-bottom)' : 0,
      }}
    >
      {/* Drag handle — desktop only, not when maximized/minimized */}
      {!isFullScreen && !minimized && !mobile && (
        <div
          onMouseDown={handleDragStart}
          onTouchStart={handleDragStart}
          className="absolute -top-1 left-0 right-0 h-2 cursor-row-resize z-10 group"
        >
          <div className="mx-auto mt-0.5 w-12 h-1 rounded-full bg-gray-700 group-hover:bg-gray-500 transition-colors" />
        </div>
      )}

      {/* Tab bar */}
      <div className="flex items-center bg-gray-900 border-b border-gray-800 shrink-0 h-9 min-h-[36px]">
        {/* Tabs */}
        <div className="flex-1 flex items-center overflow-x-auto no-scrollbar">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => {
                onActivate(tab.id);
                setMinimized(false);
              }}
              className={`group flex items-center gap-2 px-3 h-9 text-xs whitespace-nowrap border-r border-gray-800 transition-colors shrink-0 ${
                tab.id === activeTabId
                  ? 'bg-gray-800 text-gray-100'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                tab.state === 'running' ? 'bg-green-500' : 'bg-gray-500'
              }`} />
              <span className="max-w-[120px] sm:max-w-[140px] truncate">{tab.name}</span>
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                className="ml-1 text-gray-500 hover:text-gray-200 hover:bg-gray-700 rounded px-0.5 opacity-0 group-hover:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity cursor-pointer"
                style={{ opacity: mobile ? 1 : undefined }}
              >
                &times;
              </span>
            </button>
          ))}
        </div>

        {/* Window controls */}
        <div className="flex items-center gap-0.5 px-2 shrink-0">
          <button
            onClick={handleToggleMinimize}
            className="text-gray-500 hover:text-gray-200 hover:bg-gray-700 active:bg-gray-600 rounded p-1.5 transition-colors"
            title="Minimize"
          >
            <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 6h8" stroke="currentColor" strokeWidth="1.5"/></svg>
          </button>
          {!mobile && (
            <button
              onClick={handleToggleMaximize}
              className="text-gray-500 hover:text-gray-200 hover:bg-gray-700 active:bg-gray-600 rounded p-1.5 transition-colors"
              title={maximized ? 'Restore' : 'Maximize'}
            >
              {maximized ? (
                <svg width="12" height="12" viewBox="0 0 12 12"><rect x="1" y="3" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.2" fill="none"/><path d="M4 3V2a1 1 0 011-1h5a1 1 0 011 1v5a1 1 0 01-1 1H9" stroke="currentColor" strokeWidth="1.2" fill="none"/></svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" rx="1" stroke="currentColor" strokeWidth="1.2" fill="none"/></svg>
              )}
            </button>
          )}
          <button
            onClick={onCloseAll}
            className="text-gray-500 hover:text-red-400 hover:bg-gray-700 active:bg-gray-600 rounded p-1.5 transition-colors"
            title="Close all terminals"
          >
            <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5"/></svg>
          </button>
        </div>
      </div>

      {/* Terminal content area */}
      {!minimized && (
        <div className="flex-1 relative overflow-hidden">
          {tabs.map((tab) => (
            <TerminalTab
              key={tab.id}
              instanceId={tab.instanceId}
              instanceName={tab.name}
              visible={tab.id === activeTabId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
