/**
 * RAG/记忆命中卡展示逻辑（U9 契约消费端）。
 *
 * 后端 KnowledgeHit（hexclaw adapter.go）doc_title/source 均 omitempty——无标题文档、
 * 旧索引 chunk 两者皆空是合法形态；content 是命中卡唯一保证有信息量的字段。
 * 标题兜底链因此必须落到 content 摘要，占位文案只兜「完全无内容」的异常 hit
 * （BUG-20260711-B：此前兜底链缺 content 一级，合法数据渲染成整排「知识库命中」占位卡）。
 */

type Translate = (key: string) => string

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** 取正文首行并限长作摘要（命中卡单行标题/副标题预览用） */
function snippet(text: string, max: number): string {
  const firstLine = text.split('\n', 1)[0]!.trim()
  return firstLine.length > max ? `${firstLine.slice(0, max)}…` : firstLine
}

/** 命中卡标题：doc_title → source → content 摘要 → i18n 占位（仅异常形态） */
export function knowledgeHitTitle(hit: Record<string, unknown>, t: Translate): string {
  const content = str(hit.content)
  return str(hit.doc_title) || str(hit.source) || (content ? snippet(content, 60) : t('chat.knowledgeHit'))
}

/** 命中卡副标题：不重复标题已用字段；标题来自 doc_title/source 时补正文预览；尾缀分块位置 */
export function knowledgeHitSubtitle(hit: Record<string, unknown>, t: Translate): string {
  const docTitle = str(hit.doc_title)
  const source = str(hit.source)
  const content = str(hit.content)
  const parts: string[] = []
  if (docTitle && source && source !== docTitle) parts.push(source)
  if ((docTitle || source) && content) parts.push(snippet(content, 80))
  if (typeof hit.chunk_index === 'number') {
    const chunkCount = typeof hit.chunk_count === 'number' ? `/${hit.chunk_count}` : ''
    parts.push(`${t('knowledge.chunk')} ${hit.chunk_index + 1}${chunkCount}`)
  }
  return parts.join(' · ')
}
