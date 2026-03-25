/**
 * Prompt 模板库持久化层
 */

import { getDB } from './connection'

export interface PromptTemplate {
  id: string
  title: string
  content: string
  category: string
  useCount: number
  pinned: boolean
  createdAt: string
  updatedAt: string
}

interface DBRow {
  id: string
  title: string
  content: string
  category: string
  use_count: number
  pinned: number
  created_at: string
  updated_at: string
}

function rowToTemplate(r: DBRow): PromptTemplate {
  return {
    id: r.id,
    title: r.title,
    content: r.content,
    category: r.category,
    useCount: r.use_count,
    pinned: r.pinned === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** 获取所有模板（置顶优先，然后按使用次数降序） */
export async function dbGetTemplates(): Promise<PromptTemplate[]> {
  const d = await getDB()
  const rows = await d.select<DBRow[]>(
    'SELECT * FROM prompt_templates ORDER BY pinned DESC, use_count DESC, updated_at DESC',
  )
  return rows.map(rowToTemplate)
}

/** 搜索模板（标题或内容匹配） */
export async function dbSearchTemplates(query: string): Promise<PromptTemplate[]> {
  const d = await getDB()
  const like = `%${query}%`
  const rows = await d.select<DBRow[]>(
    'SELECT * FROM prompt_templates WHERE title LIKE $1 OR content LIKE $1 OR category LIKE $1 ORDER BY pinned DESC, use_count DESC',
    [like],
  )
  return rows.map(rowToTemplate)
}

/** 新增模板 */
export async function dbAddTemplate(t: {
  id: string
  title: string
  content: string
  category?: string
}): Promise<void> {
  const d = await getDB()
  const now = new Date().toISOString()
  await d.execute(
    `INSERT INTO prompt_templates (id, title, content, category, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [t.id, t.title, t.content, t.category ?? '', now, now],
  )
}

/** 更新模板 */
export async function dbUpdateTemplate(id: string, fields: {
  title?: string
  content?: string
  category?: string
  pinned?: boolean
}): Promise<void> {
  const d = await getDB()
  const sets: string[] = []
  const args: unknown[] = []
  let idx = 1

  if (fields.title !== undefined) { sets.push(`title = $${idx++}`); args.push(fields.title) }
  if (fields.content !== undefined) { sets.push(`content = $${idx++}`); args.push(fields.content) }
  if (fields.category !== undefined) { sets.push(`category = $${idx++}`); args.push(fields.category) }
  if (fields.pinned !== undefined) { sets.push(`pinned = $${idx++}`); args.push(fields.pinned ? 1 : 0) }
  sets.push(`updated_at = $${idx++}`); args.push(new Date().toISOString())
  args.push(id)

  await d.execute(
    `UPDATE prompt_templates SET ${sets.join(', ')} WHERE id = $${idx}`,
    args,
  )
}

/** 删除模板 */
export async function dbDeleteTemplate(id: string): Promise<void> {
  const d = await getDB()
  await d.execute('DELETE FROM prompt_templates WHERE id = $1', [id])
}

/** 增加使用次数（选中模板时调用） */
export async function dbTemplateIncrementUse(id: string): Promise<void> {
  const d = await getDB()
  await d.execute(
    'UPDATE prompt_templates SET use_count = use_count + 1, updated_at = $1 WHERE id = $2',
    [new Date().toISOString(), id],
  )
}
