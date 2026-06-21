import { apiGet, apiPut } from './client'

/**
 * 默认助理（小蟹）人设(SOUL) API。
 *
 * 后端读写 `~/.hexclaw/SOUL.md`：
 *   - `system_prompt` 为空 = 使用引擎内置默认人设（亦即删除 SOUL.md）；
 *   - 非空 = 自定义人设，引擎每轮对话读取，保存后下一轮即时生效（无需重启）。
 */
export interface AssistantSoul {
  /** 用户自定义人设；空 = 使用内置默认 */
  system_prompt: string
  /** 是否已自定义 */
  is_custom: boolean
  /** 引擎内置默认人设（供预览 / 恢复默认） */
  default_prompt: string
}

/** 读取默认助理人设（自定义内容 + 是否自定义 + 内置默认）。 */
export function getAssistantSoul() {
  return apiGet<AssistantSoul>('/api/v1/assistant/soul')
}

/**
 * 写入默认助理人设。
 * 传空字符串 = 删除 SOUL.md，恢复内置默认人设。
 */
export function updateAssistantSoul(systemPrompt: string) {
  return apiPut<AssistantSoul>('/api/v1/assistant/soul', { system_prompt: systemPrompt })
}
