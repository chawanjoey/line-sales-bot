// sessionStore.js — Chat history only (SQLite, fast, local)
// Employee data & KPI → employeeStore.js (Neon PostgreSQL)

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'sessions.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS chat_sessions (
    user_id    TEXT PRIMARY KEY,
    history    TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  )
`);

const MAX_HISTORY = 20;

function getChatHistory(userId) {
  const row = db.prepare('SELECT history FROM chat_sessions WHERE user_id = ?').get(userId);
  return row ? JSON.parse(row.history) : [];
}

function addMessage(userId, role, content) {
  let history = getChatHistory(userId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO chat_sessions (user_id, history, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET history = excluded.history, updated_at = excluded.updated_at
  `).run(userId, JSON.stringify(history), now);
  return history;
}

function resetChatHistory(userId) {
  db.prepare('DELETE FROM chat_sessions WHERE user_id = ?').run(userId);
}

module.exports = { getChatHistory, addMessage, resetChatHistory };
