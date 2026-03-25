/**
 * Artifacts SQLite 持久化层
 *
 * 将聊天中提取的代码块/HTML 持久化到本地 SQLite，
 * 避免页面刷新后丢失。
 */

import { getDB } from './connection'
import { logger } from '@/utils/logger'
import type { Artifact } from '@/types'

interface DBArtifactRow {
  id: string
  session_id: string
  message_id: string
  type: string
  title: string
  language: string | null
  content: string
  previous_content: string | null
  created_at: string
}

function rowToArtifact(row: DBArtifactRow): Artifact {
  return {
    id: row.id,
    type: row.type as Artifact['type'],
    title: row.title,
    language: row.language ?? undefined,
    content: row.content,
    previousContent: row.previous_content ?? undefined,
    messageId: row.message_id,
    createdAt: row.created_at,
  }
}

/** 获取会话的所有 Artifacts */
export async function dbGetArtifacts(sessionId: string): Promise<Artifact[]> {
  const d = await getDB()
  const rows = await d.select<DBArtifactRow[]>(
    'SELECT * FROM artifacts WHERE session_id = $1 ORDER BY created_at ASC',
    [sessionId],
  )
  return rows.map(rowToArtifact)
}

/** 保存或更新单个 Artifact */
export async function dbSaveArtifact(sessionId: string, artifact: Artifact): Promise<void> {
  const d = await getDB()
  await d.execute(
    `INSERT OR REPLACE INTO artifacts
     (id, session_id, message_id, type, title, language, content, previous_content, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      artifact.id,
      sessionId,
      artifact.messageId,
      artifact.type,
      artifact.title,
      artifact.language ?? null,
      artifact.content,
      artifact.previousContent ?? null,
      artifact.createdAt,
    ],
  )
}

/** 批量保存 Artifacts */
export async function dbSaveArtifacts(sessionId: string, artifacts: Artifact[]): Promise<void> {
  if (artifacts.length === 0) return
  const d = await getDB()
  try {
    await d.execute('BEGIN')
    for (const a of artifacts) {
      await d.execute(
        `INSERT OR REPLACE INTO artifacts
         (id, session_id, message_id, type, title, language, content, previous_content, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [a.id, sessionId, a.messageId, a.type, a.title, a.language ?? null, a.content, a.previousContent ?? null, a.createdAt],
      )
    }
    await d.execute('COMMIT')
  } catch (e) {
    await d.execute('ROLLBACK').catch((re) => logger.warn('ROLLBACK 失败', re))
    throw e
  }
}

/** 删除会话的所有 Artifacts（随会话级联删除） */
export async function dbDeleteSessionArtifacts(sessionId: string): Promise<void> {
  const d = await getDB()
  await d.execute('DELETE FROM artifacts WHERE session_id = $1', [sessionId])
}
