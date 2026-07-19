/**
 * 会话级“深度思考”偏好。
 *
 * 深度思考会改变响应时延、成本和输出形态，因此不能作为跨会话的隐式全局开关；
 * 但在同一条会话中又应保持到用户显式关闭。和会话模型/Agent 绑定一致，这属于
 * 客户端交互偏好，使用有界 localStorage map：切回/重启可恢复，删除会话即清理。
 */

export const SESSION_THINKING_STORAGE_KEY = 'hexclaw_sessionDeepThinking'

type PreferenceMap = Record<string, true>

function readAll(): PreferenceMap {
  try {
    const raw = localStorage.getItem(SESSION_THINKING_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: PreferenceMap = {}
    for (const [sessionId, enabled] of Object.entries(parsed)) {
      if (sessionId && enabled === true) result[sessionId] = true
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
  return !!sessionId && readAll()[sessionId] === true
}

export function setSessionDeepThinking(sessionId: string, enabled: boolean): void {
  if (!sessionId) return
  const map = readAll()
  if (enabled) map[sessionId] = true
  else delete map[sessionId]
  writeAll(map)
}

export function clearSessionDeepThinking(sessionId: string): void {
  setSessionDeepThinking(sessionId, false)
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
