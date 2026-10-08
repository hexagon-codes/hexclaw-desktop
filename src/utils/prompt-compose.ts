import type { PromptInvocation } from '@/api/prompts'

/** 正文保存在ComposerDraft.text；这里仅保存模板身份和可见编辑区的边界。 */
export interface PromptComposerDraft {
  invocation: PromptInvocation
  title: string
  description: string
  template_snapshot: string
  unit_summary: boolean
  editor_expanded: boolean
  extra_range?: { start: number; end: number }
}

export function promptExtra(text: string, draft: PromptComposerDraft): string {
  const range = draft.extra_range
  if (!range || range.start < 0 || range.end !== text.length) return ''
  return text.slice(range.start, range.end).replace(/^\n\n/, '')
}

/** 补充直接替换唯一正文的尾段；发送入口不再拼接第二份补充。 */
export function replacePromptExtra(text: string, draft: PromptComposerDraft, extra: string): string {
  const start = draft.extra_range?.start ?? text.length
  const next = text.slice(0, start) + (extra ? '\n\n' + extra : '')
  draft.extra_range = { start, end: next.length }
  return next
}

export function reconcilePromptEdit(previous: string, next: string, draft: PromptComposerDraft): void {
  const range = draft.extra_range
  if (!range) return
  // 全文修改模板区后尾段边界失效。保留新全文，不把旧补充重新加回。
  if (!next.startsWith(previous.slice(0, range.start))) draft.extra_range = undefined
  else draft.extra_range = { start: range.start, end: next.length }
}

export function promptIntent(text: string, fallback: string): string {
  const task = text.match(/(?:^|\n)## 任务\s*\n([\s\S]*?)(?=\n## |$)/)?.[1]
  return task?.split(/[。\n]/)[0]?.trim() || text.split(/[。\n]/).find((line) => line.trim())?.trim() || fallback
}
