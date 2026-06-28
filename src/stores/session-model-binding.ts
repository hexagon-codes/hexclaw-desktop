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

/** 单条会话绑定。model 可为具体 modelId 或 'auto'。
 *
 *  ★自足性（best-practice，修复 BUG-20260626 的根上）：绑定不仅存「用哪个模型」，还存其
 *  **显示名 + 能力**——这样会话的模型身份/标签/能力门控**完全由绑定决定，不依赖 availableModels
 *  是否已加载**。provider/Ollama 异步未同步时，UI 仍能正确显示模型名并正确门控 vision/image，
 *  绝不退化成默认模型或 text-only。availableModels 退化为纯「下拉填充 + 元信息精修」角色。 */
export interface SessionModelBinding {
  model: string
  providerId: string
  providerKey: string
  providerName?: string
  modelName?: string // 显示名（自足）
  capabilities?: string[] // 能力（自足，门控 vision/image/video）
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
  | { kind: 'restore'; model: AvailableModelLite } // 绑定且模型仍可用（带最新 provider 元信息）
  | { kind: 'unavailable'; binding: SessionModelBinding } // 绑定的模型此刻不在可用列表（多为异步未加载/Ollama 未同步）→ 调用方乐观恢复绑定本身

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
    ...(binding.modelName ? { modelName: binding.modelName } : {}),
    ...(binding.capabilities?.length ? { capabilities: binding.capabilities } : {}),
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
  return match ? { kind: 'restore', model: match } : { kind: 'unavailable', binding: bound }
}

/**
 * 进入某会话时应落地的具体 UI 动作（由 ChatView 执行）。把「解析结果 → 动作」的
 * 决策抽成纯函数，是为了让切换编排可单测——跨会话串模型的 bug 正落在这层。
 */
export type SessionModelAction =
  | { kind: 'restore'; model: AvailableModelLite } // 恢复会话绑定模型（列表里有，带最新元信息），置 override
  | { kind: 'auto' } // 恢复为 'auto'，置 override
  | { kind: 'restore-pending'; binding: SessionModelBinding } // 绑定存在但模型此刻不在列表 → 乐观恢复绑定本身，置 override；列表补齐后由 availableModels watcher 复解析精修为 restore
  | { kind: 'bind-current' } // 新会话首发（null → 新建 id）→ 把当前 UI 选择固定到新会话
  | { kind: 'reset-default' } // 无绑定 → UI 回退全局默认、清 override（不沿用上一会话模型）

/**
 * 决定进入会话 newId 时该做什么。纯函数，无副作用。
 *
 * 关键不变量：
 * - 会话**有绑定**（restore/auto/unavailable）→ 一律恢复该会话自己的模型。其中 unavailable
 *   （绑定模型此刻不在 availableModels，多为 provider/Ollama 异步未加载）→ **restore-pending 乐观恢复**，
 *   不得静默回退默认（修复 BUG-20260626：切 tab 显示默认、点开下拉才切回上次选的）。会话绑定是
 *   「该会话用哪个模型」的唯一事实源，列表补齐后由 availableModels watcher 复解析精修。
 * - 「无绑定」会话（resolution=none）只在「新会话首发」补绑当前选择；其余一律 reset-default
 *   ——从「绑定了模型的会话」切到「无绑定会话」必须回退全局默认，不得静默沿用上一会话模型（修复 BUG-20260625）。
 * - bind-current 仅当 prevId===null（null → 真实 id）且用户已显式选模型时触发。调用方必须保证
 *   「离开会话(→null)时清掉 userOverrodeModel」，否则残留覆盖标记会把上一会话模型串过去。
 */
export function decideSessionModelAction(params: {
  resolution: ModelBindingResolution
  prevId: string | null
  userOverrodeModel: boolean
  hasSelectedModel: boolean
}): SessionModelAction {
  const { resolution, prevId, userOverrodeModel, hasSelectedModel } = params
  switch (resolution.kind) {
    case 'restore':
      return { kind: 'restore', model: resolution.model }
    case 'auto':
      return { kind: 'auto' }
    case 'unavailable':
      return { kind: 'restore-pending', binding: resolution.binding }
    case 'none':
      if (prevId === null && userOverrodeModel && hasSelectedModel) {
        return { kind: 'bind-current' }
      }
      return { kind: 'reset-default' }
  }
}
