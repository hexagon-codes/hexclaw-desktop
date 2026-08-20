/**
 * 会话级“深度思考”偏好。
 *
 * 深度思考会改变响应时延、成本和输出形态，因此不能作为跨会话的隐式全局开关；
 * 但在同一条会话中又应保持到用户显式关闭。和会话模型/Agent 绑定一致，这属于
 * 客户端交互偏好，使用有界 localStorage map：切回/重启可恢复，删除会话即清理。
 */

import {
  cloneReasoningPolicy,
  normalizeReasoningPolicy,
  type ReasoningPolicy,
} from '@/utils/reasoning-policy'

export const SESSION_THINKING_STORAGE_KEY = 'hexclaw_sessionDeepThinking'

type StoredPreference = true | ReasoningPolicy
type PreferenceMap = Record<string, StoredPreference>

function readAll(): PreferenceMap {
  try {
    const raw = localStorage.getItem(SESSION_THINKING_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: PreferenceMap = {}
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (!sessionId) continue
      // v0.5.0-beta 之前只存 true；它等价于用户已显式打开思考。
      if (value === true) {
        result[sessionId] = true
        continue
      }
      const policy = normalizeReasoningPolicy(value)
      if (policy.mode !== 'inherit') result[sessionId] = policy
    }
    return result
  } catch {
    return {}
  }
}

function writeAll(map: PreferenceMap): void {
  try {
    localStorage.setItem(SESSION_THINKING_STORAGE_KEY, JSON.stringify(map))
  } catch {
    // 隐私模式/配额不足时只降级为本次内存态，不阻断聊天。
  }
}

export function getSessionDeepThinking(sessionId: string): boolean {
  const policy = getSessionThinkingPolicy(sessionId)
  return policy.mode === 'auto' || policy.mode === 'on' || policy.mode === 'effort'
}

export function setSessionDeepThinking(sessionId: string, enabled: boolean): void {
  setSessionThinkingPolicy(sessionId, enabled ? { mode: 'on' } : { mode: 'off' })
}

/** 读取会话显式策略；没有持久值才是 inherit，不能与显式 off 混同。 */
export function getSessionThinkingPolicy(sessionId: string): ReasoningPolicy {
  if (!sessionId) return { mode: 'inherit' }
  const value = readAll()[sessionId]
  if (value === true) return { mode: 'on' }
  return value ? cloneReasoningPolicy(value) : { mode: 'inherit' }
}

/** 仅会话策略为 inherit 时删除记录，显式 off 必须持久化。 */
export function setSessionThinkingPolicy(sessionId: string, policyValue: unknown): void {
  if (!sessionId) return
  const map = readAll()
  const policy = normalizeReasoningPolicy(policyValue)
  if (policy.mode === 'inherit') delete map[sessionId]
  else map[sessionId] = cloneReasoningPolicy(policy)
  writeAll(map)
}

export function clearSessionDeepThinking(sessionId: string): void {
  setSessionThinkingPolicy(sessionId, { mode: 'inherit' })
}

export function pruneSessionDeepThinking(existingIds: string[]): void {
  const keep = new Set(existingIds)
  const map = readAll()
  let changed = false
  for (const sessionId of Object.keys(map)) {
    if (!keep.has(sessionId)) {
      delete map[sessionId]
      changed = true
    }
  }
  if (changed) writeAll(map)
}
