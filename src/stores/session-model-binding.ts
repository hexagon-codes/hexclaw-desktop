/**
 * 会话级模型绑定（per-conversation model binding）
 *
 * 业界共识（ChatGPT / Cursor / Poe）：模型是「会话上下文」的一部分——同一会话的
 * 回答风格/能力档位由模型决定，切走再切回不应被静默换成别的模型。
 *
 * 本应用的模型选择是**每请求随 ChatRequest 发送、后端对「会话用哪个模型」无状态**，
 * 因此绑定本质是**客户端偏好**，正确的持久化层是前端 localStorage
 *（与 messageService 的 `hexclaw_lastSessionId` 同源），无需后端 / DB / 契约改动。
 *
 * 解析优先级（在 ChatView 落地）：会话绑定 > Agent 绑定模型 > 全局默认模型。
 *
 * 防累积：删除会话时 clearSessionModel；加载会话列表后 pruneSessionModels，
 * 使 map 永远 ≤ 会话数（规避 localStorage 无界膨胀）。
 */

export const SESSION_MODEL_STORAGE_KEY = 'hexclaw_sessionModels'

/** 单条会话绑定。model 可为具体 modelId 或 'auto'。 */
export interface SessionModelBinding {
  model: string
  providerId: string
  providerKey: string
  providerName?: string
}

/** 解析所需的可用模型轻量视图（settingsStore.availableModels 的子集）。 */
export interface AvailableModelLite {
  modelId: string
  providerId: string
  providerKey: string
  providerName: string
}

/** resolveSessionModel 的决策结果，由调用方落地为具体 UI 状态。 */
export type ModelBindingResolution =
  | { kind: 'none' } // 无绑定 → 沿用默认 / Agent 决策
  | { kind: 'auto' } // 绑定到 'auto'
  | { kind: 'restore'; model: AvailableModelLite } // 绑定且模型仍可用
  | { kind: 'unavailable' } // 绑定的模型已不可用 → 调用方应清绑定 + 回退默认 + 提示

type BindingMap = Record<string, SessionModelBinding>

function readAll(): BindingMap {
  try {
    const raw = localStorage.getItem(SESSION_MODEL_STORAGE_KEY)
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
    localStorage.setItem(SESSION_MODEL_STORAGE_KEY, JSON.stringify(map))
  } catch {
    // 持久化失败（隐私模式 / 配额）不应阻断会话流程
  }
}

/** 取某会话的模型绑定，无绑定 / 损坏存储返回 null。 */
export function getSessionModel(sessionId: string): SessionModelBinding | null {
  if (!sessionId) return null
  const map = readAll()
  const binding = map[sessionId]
  return binding && typeof binding.model === 'string' ? binding : null
}

/** 绑定模型到某会话（用户在该会话显式选模型时调用）。 */
export function setSessionModel(sessionId: string, binding: SessionModelBinding): void {
  if (!sessionId || !binding?.model) return
  const map = readAll()
  map[sessionId] = {
    model: binding.model,
    providerId: binding.providerId || '',
    providerKey: binding.providerKey || '',
    ...(binding.providerName ? { providerName: binding.providerName } : {}),
  }
  writeAll(map)
}

/** 清除单个会话的绑定（删除会话时调用，防孤儿）。 */
export function clearSessionModel(sessionId: string): void {
  if (!sessionId) return
  const map = readAll()
  if (map[sessionId]) {
    delete map[sessionId]
    writeAll(map)
  }
}

/** 仅保留 validIds 中仍存在的会话绑定（加载会话列表后调用，使 map 有界）。 */
export function pruneSessionModels(validIds: string[]): void {
  const valid = new Set(validIds)
  const map = readAll()
  let changed = false
  for (const id of Object.keys(map)) {
    if (!valid.has(id)) {
      delete map[id]
      changed = true
    }
  }
  if (changed) writeAll(map)
}

/**
 * 解析某会话应当应用的模型绑定决策。纯函数（除读 localStorage 外无副作用），
 * 便于单测；UI 状态落地交由调用方按 kind 处理。
 */
export function resolveSessionModel(
  sessionId: string,
  available: AvailableModelLite[],
): ModelBindingResolution {
  const bound = getSessionModel(sessionId)
  if (!bound) return { kind: 'none' }
  if (bound.model === 'auto') return { kind: 'auto' }
  const match = available.find(
    (m) => m.modelId === bound.model && (!bound.providerId || m.providerId === bound.providerId),
  )
  return match ? { kind: 'restore', model: match } : { kind: 'unavailable' }
}
