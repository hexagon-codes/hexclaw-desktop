/**
 * 入库徽章（record-chip）元数据解析 · 领域无关 shell 原语。
 *
 * BUG-1：后端 reply.Metadata 是 map[string]string，判错入库时 engine 以领域中立键 `record`
 * 透传结构化 JSON 字符串（{collection,fields,status}），前端据 schema registry 渲染徽章。
 * 历史上 messageRecordChip 直接 `metadata.record as {...}` 当对象，遇 JSON 字符串拿不到
 * collection → 徽章恒不显。这里统一容忍「JSON 字符串」与「已是对象」两种形态
 * （对齐 interactive_buttons 的双形态语义），并对缺 collection / 非法 JSON 返回 null。
 */
export interface RecordMeta {
  collection?: string
  fields?: Record<string, unknown>
  status?: string
}

export function parseRecordMeta(metadata?: Record<string, unknown> | null): RecordMeta | null {
  const raw = metadata?.record
  if (!raw) return null
  let rec: RecordMeta | null = null
  if (typeof raw === 'string') {
    try {
      rec = JSON.parse(raw) as RecordMeta
    } catch {
      return null
    }
  } else if (typeof raw === 'object') {
    rec = raw as RecordMeta
  }
  if (!rec?.collection) return null
  return rec
}
