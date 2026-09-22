/**
 * Shared logger for modules that run outside a request (Docker helpers, proxy
 * ACLs, background monitors). index.js calls setLogger(fastify.log) at startup
 * so everything lands in the same structured pino stream; until then (and in
 * tests) it falls back to the console.
 */
const fallback = {
  trace() {}, debug() {},
  info: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
  child() { return fallback; },
};

let root = fallback;

export function setLogger(logger) {
  root = logger || fallback;
}

/** Module-scoped logger: every line carries { module }. Resolved per call so setLogger() applies late. */
export function moduleLogger(module) {
  const get = () => (root === fallback ? fallback : root.child({ module }));
  return {
    trace: (...a) => get().trace(...a),
    debug: (...a) => get().debug(...a),
    info: (...a) => get().info(...a),
    warn: (...a) => get().warn(...a),
    error: (...a) => get().error(...a),
  };
}
