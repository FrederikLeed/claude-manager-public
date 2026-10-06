import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';

export const DEFAULT_HOST_ID = 'local';

let db;

export function initDb() {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  const dbPath = path.join(config.DATA_DIR, 'manager.db');

  // Auto-backup existing DB on startup (keep last 3)
  if (fs.existsSync(dbPath)) {
    try {
      const backupDir = path.join(config.DATA_DIR, 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      fs.copyFileSync(dbPath, path.join(backupDir, `manager-${timestamp}.db`));
      // Prune old backups, keep last 3
      const backups = fs.readdirSync(backupDir)
        .filter((f) => f.startsWith('manager-') && f.endsWith('.db'))
        .sort()
        .reverse();
      for (const old of backups.slice(3)) {
        fs.unlinkSync(path.join(backupDir, old));
      }
    } catch { /* backup is best-effort */ }
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      docker_id TEXT,
      name TEXT NOT NULL,
      image TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      notes TEXT,
      tags TEXT,
      port INTEGER
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      instance_id TEXT,
      instance_name TEXT,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT,
      token_hash TEXT NOT NULL UNIQUE,
      approved INTEGER DEFAULT 0,
      is_admin INTEGER DEFAULT 0,
      user_agent TEXT,
      last_seen TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // v2: Capability grants table
  db.exec(`
    CREATE TABLE IF NOT EXISTS capability_grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      capability_name TEXT NOT NULL,
      granted_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      source TEXT DEFAULT 'manual',
      active INTEGER DEFAULT 1,
      UNIQUE(instance_id, capability_name)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_grants_instance ON capability_grants(instance_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_grants_expiry ON capability_grants(expires_at) WHERE active = 1');

  // v2: Access requests (instance → admin approval flow)
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      requested_policy TEXT,
      requested_hosts TEXT,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT,
      resolved_by TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_access_req_instance ON access_requests(instance_id)');

  // Latest Claude Code token/context usage per instance, reported by the
  // in-container Stop/Notification hook. One row per instance (latest wins).
  db.exec(`
    CREATE TABLE IF NOT EXISTS instance_usage (
      instance_id TEXT PRIMARY KEY,
      context_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      status_message TEXT,
      model TEXT,
      last_event TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Latest Trivy security scan result per instance
  db.exec(`
    CREATE TABLE IF NOT EXISTS instance_scans (
      instance_id TEXT PRIMARY KEY,
      critical INTEGER DEFAULT 0,
      high INTEGER DEFAULT 0,
      medium INTEGER DEFAULT 0,
      low INTEGER DEFAULT 0,
      secrets INTEGER DEFAULT 0,
      verified_secrets INTEGER DEFAULT 0,
      findings TEXT,
      error TEXT,
      scanned_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Key/value store for manager-wide metadata (e.g. workspace image version)
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Managed Docker hosts. The control host is a row like any other ('local'),
  // so there is one code path instead of two.
  db.exec(`
    CREATE TABLE IF NOT EXISTS hosts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'ssh',
      address TEXT,
      ssh_user TEXT,
      ssh_port INTEGER DEFAULT 22,
      docker_engine_id TEXT,
      ssh_key_ref TEXT,
      data_root TEXT,
      manager_url TEXT,
      proxy_container TEXT DEFAULT 'cm-proxy',
      network TEXT,
      enabled INTEGER DEFAULT 1,
      accepts_instances INTEGER DEFAULT 1,
      labels TEXT,
      status TEXT,
      status_detail TEXT,
      last_seen INTEGER,
      created_at INTEGER NOT NULL
    )
  `);

  // The manager's own daemon always exists.
  db.prepare(`
    INSERT INTO hosts (id, name, kind, enabled, accepts_instances, created_at)
    VALUES (?, ?, 'local', 1, 1, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(DEFAULT_HOST_ID, 'Local', Math.floor(Date.now() / 1000));

  // Migrations
  const columns = db.prepare("PRAGMA table_info(instances)").all();
  if (!columns.some((c) => c.name === 'docker_id')) {
    db.exec('ALTER TABLE instances ADD COLUMN docker_id TEXT');
  }
  if (!columns.some((c) => c.name === 'litellm_key')) {
    db.exec('ALTER TABLE instances ADD COLUMN litellm_key TEXT');
  }
  // Claude Code version baked into the image this instance was (re)created from
  if (!columns.some((c) => c.name === 'claude_version')) {
    db.exec('ALTER TABLE instances ADD COLUMN claude_version TEXT');
  }
  // Which managed host runs this instance. Existing rows predate multi-host,
  // so they belong to the manager's own daemon.
  if (!columns.some((c) => c.name === 'host_id')) {
    db.exec(`ALTER TABLE instances ADD COLUMN host_id TEXT NOT NULL DEFAULT '${DEFAULT_HOST_ID}'`);
  }
  // Per-instance token for the auth-exempt event/access endpoints. Those were
  // only reachable from the Docker bridge; a remote instance calls back over
  // the LAN, so the endpoints need to authenticate the caller.
  if (!columns.some((c) => c.name === 'event_token')) {
    db.exec('ALTER TABLE instances ADD COLUMN event_token TEXT');
  }
  // Engine identity: without it the same daemon can be registered twice — once
  // as 'local' and once by address — and the fleet silently double-counts a host.
  const hostCols = db.prepare("PRAGMA table_info(hosts)").all();
  if (hostCols.length && !hostCols.some((c) => c.name === 'docker_engine_id')) {
    db.exec('ALTER TABLE hosts ADD COLUMN docker_engine_id TEXT');
  }

  // The hook already measured the three parts of the context window and threw
  // the split away by summing them. input_tokens is what was actually sent
  // uncached, cache_read is the cheap replay, cache_creation is what it cost to
  // write the cache — a single total cannot tell a healthy steady state from
  // compaction thrash. status_message is the text the Stop/Notification hook
  // posts, which was broadcast to any open browser and then lost.
  const usageCols = db.prepare("PRAGMA table_info(instance_usage)").all();
  for (const col of ['input_tokens', 'cache_read_tokens', 'cache_creation_tokens']) {
    if (usageCols.length && !usageCols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE instance_usage ADD COLUMN ${col} INTEGER DEFAULT 0`);
    }
  }
  if (usageCols.length && !usageCols.some((c) => c.name === 'status_message')) {
    db.exec('ALTER TABLE instance_usage ADD COLUMN status_message TEXT');
  }

  const scanCols = db.prepare("PRAGMA table_info(instance_scans)").all();
  if (scanCols.length && !scanCols.some((c) => c.name === 'verified_secrets')) {
    db.exec('ALTER TABLE instance_scans ADD COLUMN verified_secrets INTEGER DEFAULT 0');
  }

  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function upsertInstance({ id, dockerId = null, name, image, notes = null, tags = null, port = null, hostId = null, eventToken = null }) {
  // hostId defaults to NULL so an omitted host preserves the stored one. Callers
  // that omit it — recreate, update-claude, adopt — used to reassign a remote
  // instance onto the manager's own daemon.
  //
  // Named parameters, not positional: the UPDATE branch has to see the RAW
  // @hostId. Referencing excluded.host_id there would see the INSERT's computed
  // value, which the COALESCE below has already turned into the default, so the
  // fallback would win on every update and the bug would survive.
  const stmt = db.prepare(`
    INSERT INTO instances (id, docker_id, name, image, created_at, notes, tags, port, host_id, event_token)
    VALUES (@id, @dockerId, @name, @image, @createdAt, @notes, @tags, @port,
            COALESCE(@hostId, '${DEFAULT_HOST_ID}'), @eventToken)
    ON CONFLICT(id) DO UPDATE SET
      docker_id = COALESCE(excluded.docker_id, instances.docker_id),
      name = excluded.name,
      image = excluded.image,
      notes = COALESCE(excluded.notes, instances.notes),
      tags = COALESCE(excluded.tags, instances.tags),
      port = COALESCE(excluded.port, instances.port),
      host_id = COALESCE(@hostId, instances.host_id),
      event_token = COALESCE(excluded.event_token, instances.event_token)
  `);
  stmt.run({
    id, dockerId, name, image,
    createdAt: Math.floor(Date.now() / 1000),
    notes, tags: tags ? JSON.stringify(tags) : null, port, hostId, eventToken,
  });
}

export function getInstanceByDockerId(dockerId, hostId = null) {
  // A container id is only unique within one daemon, so scope by host when known.
  const row = hostId
    ? db.prepare('SELECT * FROM instances WHERE docker_id = ? AND host_id = ?').get(dockerId, hostId)
    : db.prepare('SELECT * FROM instances WHERE docker_id = ?').get(dockerId);
  return row ? parseRow(row) : null;
}

export function getInstance(id) {
  const row = db.prepare('SELECT * FROM instances WHERE id = ?').get(id);
  return row ? parseRow(row) : null;
}

export function getAllInstances() {
  const rows = db.prepare('SELECT * FROM instances ORDER BY created_at DESC').all();
  return rows.map(parseRow);
}

export function updateInstance(id, fields) {
  const allowed = ['name', 'notes', 'tags', 'port'];
  const updates = [];
  const values = [];

  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) continue;
    updates.push(`${key} = ?`);
    values.push(key === 'tags' ? JSON.stringify(value) : value);
  }

  if (updates.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE instances SET ${updates.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteInstance(id) {
  db.prepare('DELETE FROM instances WHERE id = ?').run(id);
}

/**
 * Sync SQLite with Docker as source of truth, for ONE host.
 *
 * `hostIds` is the set of hosts whose containers are in `dockerContainers`.
 * Rows belonging to any other host are left alone: a host that is merely
 * unreachable must never look like "every instance on it was deleted".
 */
export function syncWithDocker(dockerContainers, hostIds = [DEFAULT_HOST_ID]) {
  const scope = new Set(hostIds);
  const reapSkipped = [];
  if (!scope.size) return { reapSkipped };

  const transaction = db.transaction(() => {
    const dockerIds = new Set(dockerContainers.map((c) => c.id));

    // Insert any Docker containers not in SQLite
    for (const container of dockerContainers) {
      const existing = db.prepare('SELECT id FROM instances WHERE id = ?').get(container.id);
      if (!existing) {
        upsertInstance({
          id: container.id,
          name: container.name,
          image: container.image,
          hostId: container.hostId || DEFAULT_HOST_ID,
        });
      }
    }

    // A host that answers with an empty list is indistinguishable from a host
    // whose daemon came up with an empty state — a wiped data root, a restored
    // backup, a daemon pointed at the wrong storage. Reaping on that signal
    // deletes real instances, so refuse it: if a polled host reported nothing
    // while the DB holds rows for it, that is a problem to raise, not licence
    // to delete. Callers read reapSkipped and surface it.
    const reportedPerHost = new Map();
    for (const c of dockerContainers) {
      const h = c.hostId || DEFAULT_HOST_ID;
      reportedPerHost.set(h, (reportedPerHost.get(h) || 0) + 1);
    }

    const dbRows = db.prepare('SELECT id, docker_id, host_id FROM instances').all();
    for (const host of scope) {
      const known = dbRows.filter((r) => (r.host_id || DEFAULT_HOST_ID) === host);
      if (known.length && !reportedPerHost.get(host)) {
        reapSkipped.push({ hostId: host, rows: known.length });
        scope.delete(host);
      }
    }

    // Remove orphaned rows for the hosts we actually polled (but keep adopted
    // containers with docker_id)
    for (const row of dbRows) {
      if (!scope.has(row.host_id || DEFAULT_HOST_ID)) continue;
      if (!dockerIds.has(row.id) && !row.docker_id) {
        deleteInstance(row.id);
      }
    }
  });

  transaction();
  return { reapSkipped };
}

export function logActivity(action, instanceId = null, instanceName = null, details = null) {
  const stmt = db.prepare(`
    INSERT INTO activity_log (action, instance_id, instance_name, details)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(action, instanceId, instanceName, details);
}

export function getActivityLog(limit = 50) {
  return db.prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT ?').all(limit);
}

// --- Device management (TOFU auth) ---

export function createDevice({ id, tokenHash, name, userAgent, forceAdmin = false }) {
  const txn = db.transaction(() => {
    const count = db.prepare('SELECT COUNT(*) as cnt FROM devices').get().cnt;
    const isFirst = count === 0 || forceAdmin;
    db.prepare(`
      INSERT INTO devices (id, name, token_hash, approved, is_admin, user_agent)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, tokenHash, isFirst ? 1 : 0, isFirst ? 1 : 0, userAgent);
    return { approved: isFirst ? 1 : 0, isAdmin: isFirst ? 1 : 0 };
  });
  return txn();
}

export function getDeviceByTokenHash(tokenHash) {
  const device = db.prepare('SELECT * FROM devices WHERE token_hash = ?').get(tokenHash);
  if (device) {
    db.prepare("UPDATE devices SET last_seen = datetime('now') WHERE id = ?").run(device.id);
  }
  return device || null;
}

export function getAllDevices() {
  return db.prepare('SELECT id, name, approved, is_admin, user_agent, last_seen, created_at FROM devices ORDER BY created_at').all();
}

export function approveDevice(id) {
  db.prepare('UPDATE devices SET approved = 1 WHERE id = ?').run(id);
}

export function revokeDevice(id) {
  db.prepare('DELETE FROM devices WHERE id = ?').run(id);
}

export function updateDeviceName(id, name) {
  db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(name, id);
}

// --- Capability grants ---

export function createGrant({ instanceId, capabilityName, expiresAt, source = 'manual' }) {
  return db.prepare(`
    INSERT INTO capability_grants (instance_id, capability_name, expires_at, source)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(instance_id, capability_name) DO UPDATE SET
      expires_at = excluded.expires_at,
      source = excluded.source,
      active = 1,
      granted_at = datetime('now')
  `).run(instanceId, capabilityName, expiresAt, source);
}

export function getGrantsForInstance(instanceId) {
  return db.prepare('SELECT * FROM capability_grants WHERE instance_id = ? AND active = 1').all(instanceId);
}

export function getActiveGrant(instanceId, capabilityName) {
  return db.prepare('SELECT * FROM capability_grants WHERE instance_id = ? AND capability_name = ? AND active = 1').get(instanceId, capabilityName);
}

export function getExpiredGrants() {
  return db.prepare("SELECT * FROM capability_grants WHERE active = 1 AND expires_at < datetime('now')").all();
}

export function renewGrant(id, newExpiresAt) {
  db.prepare('UPDATE capability_grants SET expires_at = ?, active = 1 WHERE id = ?').run(newExpiresAt, id);
}

export function deactivateGrant(id) {
  db.prepare('UPDATE capability_grants SET active = 0 WHERE id = ?').run(id);
}

export function deleteGrantsForInstance(instanceId) {
  db.prepare('DELETE FROM capability_grants WHERE instance_id = ?').run(instanceId);
}

export function getGrantById(id) {
  return db.prepare('SELECT * FROM capability_grants WHERE id = ?').get(id);
}

// --- LiteLLM key management ---

export function setLiteLLMKey(instanceId, key) {
  db.prepare('UPDATE instances SET litellm_key = ? WHERE id = ?').run(key, instanceId);
}

export function getLiteLLMKey(instanceId) {
  const row = db.prepare('SELECT litellm_key FROM instances WHERE id = ?').get(instanceId);
  return row?.litellm_key || null;
}

export function clearLiteLLMKey(instanceId) {
  db.prepare('UPDATE instances SET litellm_key = NULL WHERE id = ?').run(instanceId);
}

// --- Access requests ---

export function createAccessRequest({ instanceId, requestedPolicy, requestedHosts, reason }) {
  const stmt = db.prepare(`
    INSERT INTO access_requests (instance_id, requested_policy, requested_hosts, reason)
    VALUES (?, ?, ?, ?)
  `);
  const result = stmt.run(instanceId, requestedPolicy || null, requestedHosts ? JSON.stringify(requestedHosts) : null, reason || null);
  return { id: result.lastInsertRowid, instanceId, requestedPolicy, requestedHosts, reason, status: 'pending' };
}

export function getPendingAccessRequests() {
  const rows = db.prepare("SELECT * FROM access_requests WHERE status = 'pending' ORDER BY created_at DESC").all();
  return rows.map(parseAccessRequest);
}

export function getAccessRequestsForInstance(instanceId) {
  const rows = db.prepare("SELECT * FROM access_requests WHERE instance_id = ? ORDER BY created_at DESC").all(instanceId);
  return rows.map(parseAccessRequest);
}

export function getAccessRequestById(id) {
  const row = db.prepare('SELECT * FROM access_requests WHERE id = ?').get(id);
  return row ? parseAccessRequest(row) : null;
}

export function resolveAccessRequest(id, status, resolvedBy) {
  db.prepare("UPDATE access_requests SET status = ?, resolved_at = datetime('now'), resolved_by = ? WHERE id = ?")
    .run(status, resolvedBy, id);
}

function parseAccessRequest(row) {
  return {
    ...row,
    requested_hosts: row.requested_hosts ? JSON.parse(row.requested_hosts) : null,
  };
}

// --- Manager metadata (key/value) ---

export function getMeta(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(key, value) {
  db.prepare(`
    INSERT INTO meta (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value == null ? null : String(value));
}

export function setInstanceClaudeVersion(id, version) {
  db.prepare('UPDATE instances SET claude_version = ? WHERE id = ?').run(version || null, id);
}

// --- Instance usage (reported by in-container Claude Code hook) ---

export function setInstanceUsage(instanceId, {
  contextTokens = 0, outputTokens = 0, inputTokens = 0,
  cacheReadTokens = 0, cacheCreationTokens = 0,
  statusMessage = null, model = null, event = null,
}) {
  db.prepare(`
    INSERT INTO instance_usage (
      instance_id, context_tokens, output_tokens, input_tokens,
      cache_read_tokens, cache_creation_tokens, status_message,
      model, last_event, updated_at)
    VALUES (@id, @contextTokens, @outputTokens, @inputTokens,
            @cacheReadTokens, @cacheCreationTokens, @statusMessage,
            @model, @event, datetime('now'))
    ON CONFLICT(instance_id) DO UPDATE SET
      context_tokens = excluded.context_tokens,
      output_tokens = excluded.output_tokens,
      input_tokens = excluded.input_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_creation_tokens = excluded.cache_creation_tokens,
      -- NOT coalesced: the message belongs to last_event. Keeping an old
      -- "needs your permission" text after a Stop would read as still waiting.
      status_message = excluded.status_message,
      model = COALESCE(excluded.model, instance_usage.model),
      last_event = excluded.last_event,
      updated_at = datetime('now')
  `).run({
    id: instanceId, contextTokens, outputTokens, inputTokens,
    cacheReadTokens, cacheCreationTokens,
    statusMessage: statusMessage || null, model, event,
  });
}

export function getInstanceUsage(instanceId) {
  return db.prepare('SELECT * FROM instance_usage WHERE instance_id = ?').get(instanceId) || null;
}

export function getAllInstanceUsage() {
  return db.prepare('SELECT * FROM instance_usage').all();
}

export function deleteInstanceUsage(instanceId) {
  db.prepare('DELETE FROM instance_usage WHERE instance_id = ?').run(instanceId);
}

// --- Security scans (Trivy) ---

export function setInstanceScan(instanceId, { critical = 0, high = 0, medium = 0, low = 0, secrets = 0, verifiedSecrets = 0, findings = null, error = null }) {
  db.prepare(`
    INSERT INTO instance_scans (instance_id, critical, high, medium, low, secrets, verified_secrets, findings, error, scanned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(instance_id) DO UPDATE SET
      critical = excluded.critical, high = excluded.high, medium = excluded.medium,
      low = excluded.low, secrets = excluded.secrets, verified_secrets = excluded.verified_secrets,
      findings = excluded.findings, error = excluded.error, scanned_at = datetime('now')
  `).run(instanceId, critical, high, medium, low, secrets, verifiedSecrets,
    findings ? JSON.stringify(findings) : null, error);
}

export function getInstanceScan(instanceId) {
  const row = db.prepare('SELECT * FROM instance_scans WHERE instance_id = ?').get(instanceId);
  if (!row) return null;
  return { ...row, findings: row.findings ? JSON.parse(row.findings) : [] };
}

export function getAllInstanceScans() {
  return db.prepare('SELECT instance_id, critical, high, medium, low, secrets, verified_secrets, error, scanned_at FROM instance_scans').all();
}

export function deleteInstanceScan(instanceId) {
  db.prepare('DELETE FROM instance_scans WHERE instance_id = ?').run(instanceId);
}

export function closeDb() {
  if (db) db.close();
}

function parseRow(row) {
  return {
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : [],
  };
}

// ── Managed hosts ────────────────────────────────────────────────────────────

function parseHost(row) {
  if (!row) return null;
  return {
    ...row,
    enabled: !!row.enabled,
    acceptsInstances: !!row.accepts_instances,
    labels: row.labels ? JSON.parse(row.labels) : {},
  };
}

export function getHosts({ enabledOnly = false } = {}) {
  const sql = enabledOnly
    ? 'SELECT * FROM hosts WHERE enabled = 1 ORDER BY id = ? DESC, name'
    : 'SELECT * FROM hosts ORDER BY id = ? DESC, name';
  return db.prepare(sql).all(DEFAULT_HOST_ID).map(parseHost);
}

export function getHost(id) {
  return parseHost(db.prepare('SELECT * FROM hosts WHERE id = ?').get(id));
}

export function upsertHost({
  id, name, kind = 'ssh', address = null, sshUser = null, sshPort = 22, sshKeyRef = null,
  dataRoot = null, managerUrl = null, proxyContainer = 'cm-proxy', network = null,
  enabled = true, acceptsInstances = true, labels = null,
}) {
  db.prepare(`
    INSERT INTO hosts (id, name, kind, address, ssh_user, ssh_port, ssh_key_ref, data_root,
                       manager_url, proxy_container, network, enabled, accepts_instances,
                       labels, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      kind = excluded.kind,
      address = excluded.address,
      ssh_user = excluded.ssh_user,
      ssh_port = excluded.ssh_port,
      ssh_key_ref = excluded.ssh_key_ref,
      data_root = excluded.data_root,
      manager_url = excluded.manager_url,
      proxy_container = excluded.proxy_container,
      network = excluded.network,
      enabled = excluded.enabled,
      accepts_instances = excluded.accepts_instances,
      labels = excluded.labels
  `).run(id, name, kind, address, sshUser, sshPort, sshKeyRef, dataRoot, managerUrl,
         proxyContainer, network, enabled ? 1 : 0, acceptsInstances ? 1 : 0,
         labels ? JSON.stringify(labels) : null, Math.floor(Date.now() / 1000));
  return getHost(id);
}

/** Record what the manager learned about a host from its daemon. */
export function setHostIdentity(id, { name = null, engineId = null } = {}) {
  if (name) db.prepare('UPDATE hosts SET name = ? WHERE id = ?').run(name, id);
  if (engineId) db.prepare('UPDATE hosts SET docker_engine_id = ? WHERE id = ?').run(engineId, id);
  return getHost(id);
}

/** Another host already registered for this daemon, if any. */
export function getHostByEngineId(engineId, exceptId = null) {
  if (!engineId) return null;
  const row = exceptId
    ? db.prepare('SELECT * FROM hosts WHERE docker_engine_id = ? AND id != ?').get(engineId, exceptId)
    : db.prepare('SELECT * FROM hosts WHERE docker_engine_id = ?').get(engineId);
  return parseHost(row);
}

export function setHostStatus(id, status, detail = null) {
  db.prepare('UPDATE hosts SET status = ?, status_detail = ?, last_seen = ? WHERE id = ?')
    .run(status, detail, Math.floor(Date.now() / 1000), id);
}

export function deleteHost(id) {
  if (id === DEFAULT_HOST_ID) throw new Error('cannot delete the local host');
  const inUse = db.prepare('SELECT COUNT(*) n FROM instances WHERE host_id = ?').get(id).n;
  if (inUse) throw new Error(`host ${id} still runs ${inUse} instance(s)`);
  db.prepare('DELETE FROM hosts WHERE id = ?').run(id);
}

export function getInstancesByHost(hostId) {
  return db.prepare('SELECT * FROM instances WHERE host_id = ? ORDER BY created_at DESC')
    .all(hostId).map(parseRow);
}
