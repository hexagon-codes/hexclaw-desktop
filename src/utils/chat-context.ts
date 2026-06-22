/**
 * `@` 召唤上下文的注入工具（纯函数，可单测）。
 *
 * 设计：上下文引用只注入「发给后端的 backendText」，用户气泡显示原文不变
 * （复用 chat-send-controller 的 text/backendText 解耦机制）。零后端改动。
 */
import type { ChatContextRef } from '@/types'

/** 单条上下文内容上限（防止把超大文档整段塞进 prompt）。 */
export const CONTEXT_CONTENT_BUDGET = 4000

/** 截断到预算长度，超出加省略标记。 */
export function clampContent(content: string, budget = CONTEXT_CONTENT_BUDGET): string {
  const t = content.trim()
  if (t.length <= budget) return t
  return t.slice(0, budget) + '\n…（内容已截断）'
}

/**
 * 把上下文引用拼成一个标注来源的上下文块；无引用时返回空串。
 * content 已是解析好的文本（知识正文 / 连接说明 / 会话摘要）。
 */
export function formatContextBlock(refs: ChatContextRef[]): string {
  const blocks = refs
    .map((r) => clampContent(r.content))
    .filter((c) => c.length > 0)
  if (blocks.length === 0) return ''
  return `[用户引用的参考上下文 — 请结合以下内容回答用户问题]\n${blocks.join('\n\n')}`
}
