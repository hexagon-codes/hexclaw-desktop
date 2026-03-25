/**
 * 知识库文档只读缓存层
 *
 * 本地 SQLite 仅作为 Sidecar 文档列表的只读缓存，
 * 采用 stale-while-revalidate 策略：先展示缓存，后台从后端刷新。
 *
 * 所有写操作（添加/删除/重建索引）仍然直接走后端 API，
 * 成功后刷新本地缓存。
 */

import { getDB } from './connection'
import { logger } from '@/utils/logger'
import type { KnowledgeDoc } from '@/types'

interface DBKnowledgeDocRow {
  id: string
  title: string
  source: string | null
  chunk_count: number
  status: string | null
  error_message: string | null
  source_type: string | null
  created_at: string
  updated_at: string | null
  cached_at: string
}

function rowToDoc(row: DBKnowledgeDocRow): KnowledgeDoc {
  return {
    id: row.id,
    title: row.title,
    source: row.source ?? undefined,
    chunk_count: row.chunk_count,
    status: (row.status as KnowledgeDoc['status']) ?? undefined,
    error_message: row.error_message ?? undefined,
    source_type: row.source_type ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at ?? undefined,
  }
}

/** 读取缓存的文档列表 */
export async function dbGetCachedKnowledgeDocs(): Promise<KnowledgeDoc[]> {
  const d = await getDB()
  const rows = await d.select<DBKnowledgeDocRow[]>(
    'SELECT * FROM knowledge_docs_cache ORDER BY updated_at DESC, created_at DESC',
  )
  return rows.map(rowToDoc)
}

/** 全量替换缓存（从后端拉取的最新列表） */
export async function dbReplaceKnowledgeDocsCache(docs: KnowledgeDoc[]): Promise<void> {
  const d = await getDB()
  const now = new Date().toISOString()

  try {
    await d.execute('BEGIN')
    await d.execute('DELETE FROM knowledge_docs_cache')

    for (const doc of docs) {
      await d.execute(
        `INSERT INTO knowledge_docs_cache
         (id, title, source, chunk_count, status, error_message, source_type, created_at, updated_at, cached_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          doc.id,
          doc.title,
          doc.source ?? null,
          doc.chunk_count,
          doc.status ?? null,
          doc.error_message ?? null,
          doc.source_type ?? null,
          doc.created_at,
          doc.updated_at ?? null,
          now,
        ],
      )
    }

    await d.execute(
      `INSERT OR REPLACE INTO knowledge_cache_meta (key, value) VALUES ('last_synced_at', $1)`,
      [now],
    )
    await d.execute('COMMIT')
  } catch (e) {
    await d.execute('ROLLBACK').catch((e) => logger.warn('ROLLBACK 失败', e))
    logger.warn('替换知识库缓存失败', e)
    throw e
  }
}

/** 获取上次同步时间 */
export async function dbGetKnowledgeCacheTimestamp(): Promise<string | null> {
  const d = await getDB()
  const rows = await d.select<{ value: string }[]>(
    `SELECT value FROM knowledge_cache_meta WHERE key = 'last_synced_at'`,
  )
  return rows[0]?.value ?? null
}
