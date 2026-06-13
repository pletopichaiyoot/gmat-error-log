const crypto = require('crypto');
const { run, all, get } = require('./db');

async function createSession({ runId = null } = {}) {
  const id = crypto.randomUUID();
  await run(
    `INSERT INTO coach_sessions (id, title, run_id) VALUES (?, '', ?)`,
    [id, runId]
  );
  return get('SELECT * FROM coach_sessions WHERE id = ?', [id]);
}

async function getSession(sessionId) {
  if (!sessionId) return null;
  return get('SELECT * FROM coach_sessions WHERE id = ?', [sessionId]);
}

async function listSessions({ limit = 20, offset = 0 } = {}) {
  const sessions = await all(
    `SELECT cs.*, COUNT(cm.id) AS message_count
     FROM coach_sessions cs
     LEFT JOIN coach_messages cm ON cm.session_id = cs.id
     GROUP BY cs.id
     ORDER BY cs.updated_at DESC
     LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  return sessions;
}

async function addMessage(sessionId, { role, content }) {
  const result = await all(
    `INSERT INTO coach_messages (session_id, role, content) VALUES (?, ?, ?) RETURNING id`,
    [sessionId, role, content]
  );
  await run(
    `UPDATE coach_sessions SET updated_at = datetime('now') WHERE id = ?`,
    [sessionId]
  );
  return get('SELECT * FROM coach_messages WHERE id = ?', [result[0].id]);
}

async function getMessages(sessionId, { limit = 50 } = {}) {
  if (!sessionId) return [];
  return all(
    `SELECT * FROM coach_messages
     WHERE session_id = ?
     ORDER BY created_at ASC, id ASC
     LIMIT ?`,
    [sessionId, limit]
  );
}

async function updateSessionTitle(sessionId, title) {
  const result = await run(
    `UPDATE coach_sessions SET title = ?, updated_at = datetime('now') WHERE id = ?`,
    [String(title || '').slice(0, 120), sessionId]
  );
  return result.changes > 0;
}

async function deleteSession(sessionId) {
  if (!sessionId) return false;
  const result = await run('DELETE FROM coach_sessions WHERE id = ?', [sessionId]);
  return result.changes > 0;
}

async function getRecentHistory(sessionId, limit = 20) {
  if (!sessionId) return [];
  const rows = await all(
    `SELECT role, content FROM coach_messages
     WHERE session_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [sessionId, limit]
  );
  return rows.reverse();
}

module.exports = {
  createSession,
  getSession,
  listSessions,
  addMessage,
  getMessages,
  updateSessionTitle,
  deleteSession,
  getRecentHistory,
};
