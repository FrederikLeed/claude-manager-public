// Keeps the claude-workspace image current with the latest Claude Code release.
//
// The workspace Dockerfile auto-busts its npm layer (ADD of the registry
// "latest" metadata), so any rebuild installs the newest CLI. This module lets
// the manager trigger that rebuild over the Docker API — on a daily timer when
// npm publishes a newer version, or on demand — so NEW instances always launch
// on the latest Claude. Existing instances are left alone; the UI flags them as
// updatable and the per-instance "Update Claude" action recreates them.
import Docker from 'dockerode';
import { PassThrough } from 'stream';
import fs from 'fs';
import { config } from './config.js';
import { getMeta, setMeta } from './db.js';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const NPM_LATEST_URL = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest';
const META_VERSION = 'workspace_claude_version';
const META_BUILT_AT = 'workspace_image_built_at';

const state = {
  currentVersion: null,   // Claude Code version baked into the live image
  latestVersion: null,    // newest version published to npm
  building: false,
  lastBuiltAt: null,
  lastError: null,
};

let _broadcast = () => {};
export function setImageBroadcaster(fn) { _broadcast = fn || (() => {}); }

/** Public status for the API. */
export function getImageStatus() {
  return {
    currentVersion: state.currentVersion,
    latestVersion: state.latestVersion,
    updateAvailable: !!(state.latestVersion && state.currentVersion && state.latestVersion !== state.currentVersion),
    building: state.building,
    builtAt: state.lastBuiltAt,
    error: state.lastError,
    canRebuild: !!config.WORKSPACE_SRC_DIR,
  };
}

/** Version currently considered baked into claude-workspace:latest. */
export function getCurrentImageVersion() {
  return state.currentVersion;
}

/** Fetch the newest Claude Code version from the npm registry. */
export async function fetchLatestClaudeVersion() {
  const res = await fetch(NPM_LATEST_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`npm registry ${res.status}`);
  const body = await res.json();
  return body.version || null;
}

/** Detect the Claude Code version baked into an image by running `claude --version`. */
async function detectImageVersion(image) {
  return new Promise((resolve) => {
    const out = new PassThrough();
    let buf = '';
    out.on('data', (c) => { buf += c.toString(); });
    const timer = setTimeout(() => resolve(parseVersion(buf)), 15_000);
    docker.run(image, ['--version'], out, {
      Entrypoint: ['claude'],
      Tty: true,
      HostConfig: { AutoRemove: true },
    }, (err) => {
      clearTimeout(timer);
      if (err && !buf) return resolve(null);
      resolve(parseVersion(buf));
    });
  });
}

function parseVersion(text) {
  const m = (text || '').match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

/**
 * Initialise version state on startup: load the last-built version from the DB,
 * detect it from the live image if unknown, and fetch the latest from npm.
 */
export async function initImageState(log) {
  state.currentVersion = getMeta(META_VERSION);
  state.lastBuiltAt = getMeta(META_BUILT_AT);

  if (!state.currentVersion) {
    try {
      const detected = await detectImageVersion(config.CLAUDE_IMAGE);
      if (detected) {
        state.currentVersion = detected;
        setMeta(META_VERSION, detected);
        log?.info(`Detected workspace image Claude Code version: ${detected}`);
      }
    } catch (err) {
      log?.warn({ err: err.message }, 'Could not detect workspace image Claude version');
    }
  }

  try {
    state.latestVersion = await fetchLatestClaudeVersion();
  } catch (err) {
    log?.warn({ err: err.message }, 'Could not fetch latest Claude Code version from npm');
  }
}

/**
 * Rebuild claude-workspace from the mounted build context. The Dockerfile's
 * auto-bust layer ensures the newest Claude Code is installed.
 */
export async function buildWorkspaceImage(log, { reason = 'manual' } = {}) {
  if (!config.WORKSPACE_SRC_DIR) {
    throw new Error('Workspace build context not mounted (set WORKSPACE_SRC_DIR / mount ./workspace)');
  }
  if (state.building) {
    return { started: false, reason: 'already building' };
  }
  if (!fs.existsSync(`${config.WORKSPACE_SRC_DIR}/Dockerfile`)) {
    throw new Error(`No Dockerfile at ${config.WORKSPACE_SRC_DIR}`);
  }

  state.building = true;
  state.lastError = null;
  _broadcast({ type: 'workspace_image', status: getImageStatus() });
  log?.info({ reason }, `Rebuilding ${config.CLAUDE_IMAGE} to pick up latest Claude Code`);

  // Capture the target version before building (the image installs npm @latest)
  let targetVersion = null;
  try { targetVersion = await fetchLatestClaudeVersion(); } catch { /* best effort */ }

  try {
    const src = fs.readdirSync(config.WORKSPACE_SRC_DIR);
    const stream = await docker.buildImage(
      { context: config.WORKSPACE_SRC_DIR, src },
      { t: config.CLAUDE_IMAGE, pull: false },
    );

    await new Promise((resolve, reject) => {
      docker.modem.followProgress(
        stream,
        (err, res) => {
          if (err) return reject(err);
          const failed = (res || []).find((e) => e.error || e.errorDetail);
          if (failed) return reject(new Error(failed.error || failed.errorDetail?.message || 'build failed'));
          resolve(res);
        },
        (evt) => { if (evt.stream && evt.stream.trim()) log?.debug(evt.stream.trim()); },
      );
    });

    // Prefer the actually-installed version; fall back to the npm target.
    const built = (await detectImageVersion(config.CLAUDE_IMAGE)) || targetVersion;
    state.currentVersion = built;
    state.latestVersion = targetVersion || state.latestVersion || built;
    state.lastBuiltAt = new Date().toISOString();
    if (built) setMeta(META_VERSION, built);
    setMeta(META_BUILT_AT, state.lastBuiltAt);
    log?.info(`Workspace image rebuilt — Claude Code ${built || 'unknown'}`);
    return { started: true, version: built };
  } catch (err) {
    state.lastError = err.message;
    log?.error({ err: err.message }, 'Workspace image rebuild failed');
    throw err;
  } finally {
    state.building = false;
    _broadcast({ type: 'workspace_image', status: getImageStatus() });
  }
}

/** Daily check: rebuild only when npm has a newer version than the live image. */
export async function checkAndMaybeRebuild(log) {
  if (!config.WORKSPACE_SRC_DIR) return;
  try {
    const latest = await fetchLatestClaudeVersion();
    state.latestVersion = latest;
    if (latest && latest !== state.currentVersion) {
      log?.info(`Claude Code ${latest} available (have ${state.currentVersion || 'unknown'}) — rebuilding`);
      await buildWorkspaceImage(log, { reason: 'scheduled-update' });
    } else {
      log?.info(`Workspace image up to date (Claude Code ${state.currentVersion || 'unknown'})`);
    }
  } catch (err) {
    log?.warn({ err: err.message }, 'Workspace image update check failed');
  }
}
