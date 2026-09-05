import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dbPath = process.env.DB_PATH || './data/app.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN', 'USER')),
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
  );
`);

export function getUserByUsername(username) {
  const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
  return stmt.get(username);
}

export function getUserById(id) {
  const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
  return stmt.get(id);
}

export function listUsers() {
  const stmt = db.prepare(
    'SELECT id, username, role, disabled, created_at, last_login_at FROM users ORDER BY id'
  );
  return stmt.all();
}

export function createUser({ username, passwordHash, role }) {
  const stmt = db.prepare(
    'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
  );
  const info = stmt.run(username, passwordHash, role);
  return getUserById(info.lastInsertRowid);
}

export function updatePasswordHash(id, passwordHash) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
}

export function setDisabled(id, disabled) {
  db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
}

export function touchLastLogin(id) {
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(id);
}
