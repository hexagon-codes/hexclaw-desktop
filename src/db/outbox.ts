/**
 * 消息发件箱 — 离线队列持久化层
 *
 * 实现 Outbox Pattern：消息先写入本地 SQLite，再异步发送到 sidecar。
 * 确保用户输入不会因 sidecar 不可用或 app 闪退而丢失。
 */

import { getDB } from './connection'
import { logger } from '@/utils/logger'

export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed'

export interface OutboxMessage {
  id: string
  sessionId: string
  content: string
  attachments: string // JSON array
  status: OutboxStatus
  retryCount: number
  error: string
  createdAt: string
}

interface DBOutboxRow {
  id: string
  session_id: string
  content: string
  attachments: string
  status: string
  retry_count: number
  error: string
  created_at: string
}

function rowToOutbox(row: DBOutboxRow): OutboxMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    content: row.content,
    attachments: row.attachments,
    status: row.status as OutboxStatus,
    retryCount: row.retry_count,
    error: row.error,
    createdAt: row.created_at,
  }
}

/** 写入发件箱（发送前调用） */
export async function dbOutboxInsert(msg: {
  id: string
  sessionId: string
  content: string
  attachments?: string
}): Promise<void> {
  const d = await getDB()
  await d.execute(
    `INSERT INTO message_outbox (id, session_id, content, attachments, status, created_at)
     VALUES ($1, $2, $3, $4, 'pending', $5)`,
    [msg.id, msg.sessionId, msg.content, msg.attachments ?? '[]', new Date().toISOString()],
  )
}

/** 标记为发送中 */
export async function dbOutboxMarkSending(id: string): Promise<void> {
  const d = await getDB()
  await d.execute(
    `UPDATE message_outbox SET status = 'sending' WHERE id = $1`,
    [id],
  )
}

/** 标记为发送成功（然后删除） */
export async function dbOutboxMarkSent(id: string): Promise<void> {
  const d = await getDB()
  await d.execute(`DELETE FROM message_outbox WHERE id = $1`, [id])
}

/** 标记为发送失败 */
export async function dbOutboxMarkFailed(id: string, error: string): Promise<void> {
  const d = await getDB()
  await d.execute(
    `UPDATE message_outbox SET status = 'failed', error = $1, retry_count = retry_count + 1 WHERE id = $2`,
    [error, id],
  )
}

/** 获取所有待发送/失败的消息（启动时重试用） */
export async function dbOutboxGetPending(): Promise<OutboxMessage[]> {
  const d = await getDB()
  const rows = await d.select<DBOutboxRow[]>(
    `SELECT * FROM message_outbox WHERE status IN ('pending', 'failed') AND retry_count < 3 ORDER BY created_at ASC`,
  )
  return rows.map(rowToOutbox)
}

/** 获取指定消息的 outbox 状态 */
export async function dbOutboxGetStatus(id: string): Promise<OutboxStatus | null> {
  const d = await getDB()
  const rows = await d.select<{ status: string }[]>(
    `SELECT status FROM message_outbox WHERE id = $1`,
    [id],
  )
  return (rows[0]?.status as OutboxStatus) ?? null
}

/** 清理已发送超过 1 小时的记录（防止表无限增长） */
export async function dbOutboxCleanup(): Promise<void> {
  try {
    const d = await getDB()
    await d.execute(
      `DELETE FROM message_outbox WHERE status = 'sent' OR (status = 'failed' AND retry_count >= 3 AND created_at < datetime('now', '-1 hour'))`,
    )
  } catch (e) {
    logger.debug('outbox cleanup failed', e)
  }
}
