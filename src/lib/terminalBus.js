// Tiny registry so out-of-tree UI (e.g. the mobile key bar in TerminalPanel)
// can send input to the active terminal's WebSocket without prop-drilling.
const bus = new Map();

export function registerTerminal(instanceId, api) {
  bus.set(instanceId, api);
}

export function unregisterTerminal(instanceId) {
  bus.delete(instanceId);
}

export function getTerminal(instanceId) {
  return bus.get(instanceId) || null;
}
