/**
 * Desktop 对持久 ImageTaskDispatch 的最小会话绑定。
 *
 * 只保存恢复同一服务端分流根对象所需的 session / agent / dispatch ID；原图、
 * base64、模型输出和子链结果都不得进入浏览器存储。所有读取均校验版本与字段。
 */
export const K12_IMAGE_TASK_BINDINGS_KEY = 'hexclaw.k12.image-task-bindings.v1'

interface StoredBinding {
  agent_id: string
  dispatch_id: string
}

interface StoredBindingsV1 {
  version: 1
  bindings: Record<string, StoredBinding>
}

export interface ImageTaskBinding {
  agentId: string
  dispatchId: string
}

function storage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function validID(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function emptyState(): StoredBindingsV1 {
  return { version: 1, bindings: {} }
}

function readState(): StoredBindingsV1 {
  const target = storage()
  if (!target) return emptyState()
  const raw = target.getItem(K12_IMAGE_TASK_BINDINGS_KEY)
  if (!raw) return emptyState()
  try {
    const candidate = JSON.parse(raw) as {
      version?: unknown
      bindings?: unknown
    }
    if (
      candidate.version !== 1 ||
      !candidate.bindings ||
      typeof candidate.bindings !== 'object' ||
      Array.isArray(candidate.bindings)
    ) {
      throw new Error('unsupported image-task binding payload')
    }
    const bindings: Record<string, StoredBinding> = {}
    for (const [sessionId, value] of Object.entries(candidate.bindings)) {
      const binding = value as Partial<StoredBinding> | null
      if (
        !validID(sessionId) ||
        !binding ||
        !validID(binding.agent_id) ||
        !validID(binding.dispatch_id) ||
        Object.keys(binding).some((key) => key !== 'agent_id' && key !== 'dispatch_id')
      ) {
        throw new Error('invalid image-task binding')
      }
      bindings[sessionId] = {
        agent_id: binding.agent_id,
        dispatch_id: binding.dispatch_id,
      }
    }
    return { version: 1, bindings }
  } catch {
    try {
      target.removeItem(K12_IMAGE_TASK_BINDINGS_KEY)
    } catch {
      // localStorage 可能不可写；内存侧仍安全返回空状态。
    }
    return emptyState()
  }
}

function writeState(state: StoredBindingsV1): void {
  const target = storage()
  if (!target) return
  try {
    if (Object.keys(state.bindings).length === 0) {
      target.removeItem(K12_IMAGE_TASK_BINDINGS_KEY)
      return
    }
    target.setItem(K12_IMAGE_TASK_BINDINGS_KEY, JSON.stringify(state))
  } catch {
    // 持久化不可用不改变服务端任务；只是无法跨刷新恢复。
  }
}

export function getImageTaskBinding(
  sessionId: string | undefined,
  agentId: string,
): ImageTaskBinding | null {
  if (!validID(sessionId) || !validID(agentId)) return null
  const stored = readState().bindings[sessionId]
  if (!stored || stored.agent_id !== agentId) return null
  return { agentId: stored.agent_id, dispatchId: stored.dispatch_id }
}

export function hasImageTaskBinding(sessionId: string | undefined, agentId: string): boolean {
  return getImageTaskBinding(sessionId, agentId) !== null
}

export function setImageTaskBinding(
  sessionId: string | undefined,
  agentId: string,
  dispatchId: string,
): void {
  if (!validID(sessionId) || !validID(agentId) || !validID(dispatchId)) return
  const state = readState()
  state.bindings[sessionId] = { agent_id: agentId, dispatch_id: dispatchId }
  writeState(state)
}

export function clearImageTaskBinding(
  sessionId: string | undefined,
  agentId: string,
  dispatchId?: string,
): void {
  if (!validID(sessionId) || !validID(agentId)) return
  const state = readState()
  const existing = state.bindings[sessionId]
  if (!existing || existing.agent_id !== agentId) return
  if (validID(dispatchId) && existing.dispatch_id !== dispatchId) return
  delete state.bindings[sessionId]
  writeState(state)
}
