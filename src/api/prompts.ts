/**
 * §11.8 交互层 API 客户端：Prompt 库（一库三 type）。
 *
 * 后端：storage/migrate v6 建表 + api/handler_library.go。GET /prompts 服务端下发
 * 启用条目；command 型 body_md 里的 $ARGUMENTS 由前端填参后做纯文本替换再发送。
 *
 * 砍薄版（§5）：旧记忆薄版（standing/fact，/api/v1/memories）已并入统一文件记忆，本文件不再含记忆 API。
 */

import { apiGet, apiPost, apiDelete } from './client'

/** Prompt 条目类型：prompt 普通片段 / command 带参命令。 */
export type PromptType = 'prompt' | 'command'

/** Prompt 库条目（对齐后端 library.Prompt）。 */
export interface Prompt {
  id: string
  type: PromptType
  title: string
  body_md: string
  args_json: string
  tool_scope: string
  model: string
  category: string
  enabled: boolean
  updated_at: string
}

/** 创建/更新 Prompt 的入参（id 空 → 新建）。 */
export type PromptInput = Partial<Prompt> & { title: string }

/** 列出启用的 Prompt（前端 ✨ / `/` 召唤拉取）。 */
export function getPrompts() {
  return apiGet<{ prompts: Prompt[]; total: number }>('/api/v1/prompts')
}

/** 列出全部 Prompt（含禁用，管理 UI 用）。 */
export function getAllPrompts() {
  return apiGet<{ prompts: Prompt[]; total: number }>('/api/v1/prompts/all')
}

/** 创建或更新 Prompt。 */
export function upsertPrompt(p: PromptInput) {
  return apiPost<{ id: string }>('/api/v1/prompts', p as Record<string, unknown>)
}

/** 删除 Prompt。 */
export function deletePrompt(id: string) {
  return apiDelete<{ deleted: string }>(`/api/v1/prompts/${encodeURIComponent(id)}`)
}
