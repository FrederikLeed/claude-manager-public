import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';

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

  // Migration: add docker_id column if missing (existing databases)
  const columns = db.prepare("PRAGMA table_info(instances)").all();
  if (!columns.some((c) => c.name === 'docker_id')) {
    db.exec('ALTER TABLE instances ADD COLUMN docker_id TEXT');
  }

  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function upsertInstance({ id, dockerId = null, name, image, notes = null, tags = null, port = null }) {
  const stmt = db.prepare(`
    INSERT INTO instances (id, docker_id, name, image, created_at, notes, tags, port)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      docker_id = COALESCE(excluded.docker_id, instances.docker_id),
      name = excluded.name,
      image = excluded.image,
      notes = COALESCE(excluded.notes, instances.notes),
      tags = COALESCE(excluded.tags, instances.tags),
      port = COALESCE(excluded.port, instances.port)
  `);
  stmt.run(id, dockerId, name, image, Math.floor(Date.now() / 1000), notes, tags ? JSON.stringify(tags) : null, port);
}

export function getInstanceByDockerId(dockerId) {
  const row = db.prepare('SELECT * FROM instances WHERE docker_id = ?').get(dockerId);
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
 * Sync SQLite with Docker as source of truth.
 * Insert missing containers, remove orphaned rows.
 */
export function syncWithDocker(dockerContainers) {
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
        });
      }
    }

    // Remove orphaned SQLite rows (but keep adopted containers with docker_id)
    const dbRows = db.prepare('SELECT id, docker_id FROM instances').all();
    for (const row of dbRows) {
      if (!dockerIds.has(row.id) && !row.docker_id) {
        deleteInstance(row.id);
      }
    }
  });

  transaction();
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

export function closeDb() {
  if (db) db.close();
}

function parseRow(row) {
  return {
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : [],
  };
}
