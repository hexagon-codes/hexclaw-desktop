/**
 * SQLite 数据库连接（单例）
 *
 * 所有本地持久化模块共享同一个连接实例。
 */

import Database from '@tauri-apps/plugin-sql'
import { logger } from '@/utils/logger'

let db: Database | null = null

export async function getDB(): Promise<Database> {
  if (!db) {
    db = await Database.load('sqlite:hexclaw.db')
    logger.debug('SQLite 数据库已连接')
  }
  return db
}

// ─── App State (简单 key-value 持久化) ─────────────────

/** 读取应用状态 */
export async function dbGetAppState(key: string): Promise<string | null> {
  const d = await getDB()
  const rows = await d.select<{ value: string }[]>(
    'SELECT value FROM app_state WHERE key = $1',
    [key],
  )
  return rows[0]?.value ?? null
}

/** 写入应用状态 */
export async function dbSetAppState(key: string, value: string): Promise<void> {
  const d = await getDB()
  await d.execute(
    'INSERT OR REPLACE INTO app_state (key, value) VALUES ($1, $2)',
    [key, value],
  )
}
