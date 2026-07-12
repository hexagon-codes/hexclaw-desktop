/**
 * 会话级 Agent（收件人/人设）绑定（per-conversation agent binding）
 *
 * 背景（BUG-20260708 装机反馈）：从「进入辅导」深链进入 K12 辅导会话时，前端只把 agentRole 设为
 * 临时态（用于发消息的 pinnedAgent + 解析场景增强视图），**从不持久化到会话**；后端 session 记录里
 * agent_name/role 也全为 null。于是切走再切回该会话时 `selectSession` 把 agentRole 清空 →
 *   ① 场景增强（K12 会话框）消失、退化成普通会话框；
 *   ② 消息发给默认助理「小蟹」人设，而非该会话应有的辅导老师人设。
 *
 * 与 session-model-binding 同理：绑定本质是**客户端偏好**（后端对「会话归属哪个 Agent」无状态），
 * 正确的持久化层是前端 localStorage，无需后端/DB/契约改动。切走再切回确定性恢复。
 *
 * 防累积：删除会话时 clearSessionAgent；加载会话列表后 pruneSessionAgents，使 map ≤ 会话数。
 */

export const SESSION_AGENT_STORAGE_KEY = 'hexclaw_sessionAgents'

type BindingMap = Record<string, string>

function readAll(): BindingMap {
  try {
    const raw = localStorage.getItem(SESSION_AGENT_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as BindingMap
  } catch {
    // 损坏 / 非浏览器环境 → 降级为无绑定，绝不抛错阻断会话加载
    return {}
  }
}

function writeAll(map: BindingMap): void {
  try {
    localStorage.setItem(SESSION_AGENT_STORAGE_KEY, JSON.stringify(map))
  } catch {
    /* 非浏览器 / 配额满 → 静默降级 */
  }
}

/** 绑定某会话到某 Agent（agentName 为空/空串 = 清除绑定，避免把默认助理会话误绑） */
export function bindSessionAgent(sessionId: string, agentName: string): void {
  if (!sessionId) return
  const map = readAll()
  const name = (agentName ?? '').trim()
  if (!name) {
    if (!(sessionId in map)) return
    delete map[sessionId]
  } else {
    if (map[sessionId] === name) return
    map[sessionId] = name
  }
  writeAll(map)
}

// 墓碑前缀（BUG-20260712 治标）：agent 被删除后绑定不删除而是标记孤儿——
// 活绑定语义（发送 role/selectSession 恢复）失效，但名字保留给显示层
// （SessionList 据此显示「已删除的智能体」而非裸内部 ID）。'!' 不是合法 agent 名首字符。
const TOMBSTONE_PREFIX = '!'

/** 取某会话绑定的 Agent 名（无绑定/已墓碑返回空串——墓碑不得再作为活 role 恢复） */
export function getSessionAgent(sessionId: string): string {
  if (!sessionId) return ''
  const v = readAll()[sessionId] ?? ''
  return v.startsWith(TOMBSTONE_PREFIX) ? '' : v
}

/** 标记某会话的绑定为孤儿墓碑（agent 已删除；幂等，无活绑定时 no-op） */
export function markSessionAgentOrphaned(sessionId: string): void {
  if (!sessionId) return
  const map = readAll()
  const v = map[sessionId]
  if (!v || v.startsWith(TOMBSTONE_PREFIX)) return
  map[sessionId] = TOMBSTONE_PREFIX + v
  writeAll(map)
}

/** 取墓碑上的原 agent 名（仅显示层用；无墓碑返回空串） */
export function getSessionAgentTombstone(sessionId: string): string {
  if (!sessionId) return ''
  const v = readAll()[sessionId] ?? ''
  return v.startsWith(TOMBSTONE_PREFIX) ? v.slice(TOMBSTONE_PREFIX.length) : ''
}

/** 删除单条绑定（删除会话时调用） */
export function clearSessionAgent(sessionId: string): void {
  if (!sessionId) return
  const map = readAll()
  if (!(sessionId in map)) return
  delete map[sessionId]
  writeAll(map)
}

/** 防累积：只保留仍存在的会话绑定 */
export function pruneSessionAgents(existingIds: string[]): void {
  const keep = new Set(existingIds)
  const map = readAll()
  let changed = false
  for (const id of Object.keys(map)) {
    if (!keep.has(id)) {
      delete map[id]
      changed = true
    }
  }
  if (changed) writeAll(map)
}
