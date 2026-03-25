/**
 * 聊天记录 SQLite 持久化层
 *
 * 使用 @tauri-apps/plugin-sql 操作本地 SQLite 数据库。
 * 所有会话和消息的 CRUD 操作集中在此模块。
 */

import { getDB } from './connection'

// ─── 会话操作 ───────────────────────────────────────

export interface DBSession {
  id: string
  title: string
  created_at: string
  updated_at: string
}

/** 获取所有会话（按更新时间倒序） */
export async function dbGetSessions(): Promise<DBSession[]> {
  const d = await getDB()
  return d.select<DBSession[]>('SELECT * FROM sessions ORDER BY updated_at DESC')
}

/** 创建会话 */
export async function dbCreateSession(id: string, title: string): Promise<void> {
  const d = await getDB()
  const now = new Date().toISOString()
  await d.execute(
    'INSERT INTO sessions (id, title, created_at, updated_at) VALUES ($1, $2, $3, $4)',
    [id, title, now, now],
  )
}

/** 更新会话标题 */
export async function dbUpdateSessionTitle(id: string, title: string): Promise<void> {
  const d = await getDB()
  await d.execute(
    'UPDATE sessions SET title = $1, updated_at = $2 WHERE id = $3',
    [title, new Date().toISOString(), id],
  )
}

/** 更新会话时间戳 */
export async function dbTouchSession(id: string): Promise<void> {
  const d = await getDB()
  await d.execute(
    'UPDATE sessions SET updated_at = $1 WHERE id = $2',
    [new Date().toISOString(), id],
  )
}

/** 删除会话（级联删除消息） */
export async function dbDeleteSession(id: string): Promise<void> {
  const d = await getDB()
  // 先手动删消息（确保兼容性），再删会话
  await d.execute('DELETE FROM messages WHERE session_id = $1', [id])
  await d.execute('DELETE FROM sessions WHERE id = $1', [id])
}

// ─── 消息操作 ───────────────────────────────────────

export interface DBMessage {
  id: string
  session_id: string
  role: string
  content: string
  timestamp: string
  metadata: string | null
}

/** 获取会话的所有消息（按时间顺序） */
export async function dbGetMessages(sessionId: string): Promise<DBMessage[]> {
  const d = await getDB()
  return d.select<DBMessage[]>(
    'SELECT * FROM messages WHERE session_id = $1 ORDER BY timestamp ASC',
    [sessionId],
  )
}

/** 保存单条消息 */
export async function dbSaveMessage(
  id: string,
  sessionId: string,
  role: string,
  content: string,
  timestamp: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const d = await getDB()
  await d.execute(
    'INSERT OR REPLACE INTO messages (id, session_id, role, content, timestamp, metadata) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, sessionId, role, content, timestamp, metadata ? JSON.stringify(metadata) : null],
  )
}

/** 删除单条消息 */
export async function dbDeleteMessage(id: string): Promise<void> {
  const d = await getDB()
  await d.execute('DELETE FROM messages WHERE id = $1', [id])
}

/** 获取会话消息数量 */
export async function dbGetMessageCount(sessionId: string): Promise<number> {
  const d = await getDB()
  const rows = await d.select<{ count: number }[]>(
    'SELECT COUNT(*) as count FROM messages WHERE session_id = $1',
    [sessionId],
  )
  return rows[0]?.count ?? 0
}
