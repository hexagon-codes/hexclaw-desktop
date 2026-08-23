import { k12ListRecoverableImageTasks } from '@/api/k12'

const runtimeProjectionValues = new Map<string, string>()
const runtimeProjectionStorage = {
  getItem: (key: string) => runtimeProjectionValues.get(key) ?? null,
  setItem: (key: string, value: string) => {
    runtimeProjectionValues.set(key, value)
  },
  removeItem: (key: string) => {
    runtimeProjectionValues.delete(key)
  },
  clear: () => {
    runtimeProjectionValues.clear()
  },
}

/**
 * Desktop 对持久 ImageTaskDispatch 的最小会话绑定。
 *
 * 只保存恢复同一服务端分流根对象所需的 session / agent / dispatch ID；原图、
 * base64、模型输出和子链结果都不得进入浏览器存储。所有读取均校验版本与字段。
 */
export const IMAGE_TASK_RUNTIME_PROJECTION = 'image-task-runtime-projection'

interface StoredBinding {
  source_session_id: string
  agent_id: string
  source_message_id?: string
  dispatch_id: string
}

interface StoredBindingsV2 {
  version: 2
  bindings: StoredBinding[]
}

export interface ImageTaskBinding {
  agentId: string
  sourceMessageId?: string
  dispatchId: string
}

function storage(): typeof runtimeProjectionStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return runtimeProjectionStorage
  } catch {
    return null
  }
}

export * from './image-task-binding-compat'

function validID(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function emptyState(): StoredBindingsV2 {
  return { version: 2, bindings: [] }
}

function readState(): StoredBindingsV2 {
  const target = storage()
  if (!target) return emptyState()
  const raw = target.getItem(IMAGE_TASK_RUNTIME_PROJECTION)
  if (!raw) return emptyState()
  try {
    const candidate = JSON.parse(raw) as {
      version?: unknown
      bindings?: unknown
    }
    if (
      candidate.version === 1 &&
      candidate.bindings &&
      typeof candidate.bindings === 'object' &&
      !Array.isArray(candidate.bindings)
    ) {
      const bindings: StoredBinding[] = []
      for (const [sourceSessionId, value] of Object.entries(candidate.bindings)) {
        const binding = value as { agent_id?: unknown; dispatch_id?: unknown } | null
        if (
          !validID(sourceSessionId) ||
          !binding ||
          !validID(binding.agent_id) ||
          !validID(binding.dispatch_id) ||
          Object.keys(binding).some((key) => key !== 'agent_id' && key !== 'dispatch_id')
        ) {
          throw new Error('invalid legacy image-task binding')
        }
        bindings.push({
          source_session_id: sourceSessionId,
          agent_id: binding.agent_id,
          dispatch_id: binding.dispatch_id,
        })
      }
      return { version: 2, bindings }
    }
    if (candidate.version !== 2 || !Array.isArray(candidate.bindings)) {
      throw new Error('unsupported image-task binding payload')
    }
    const bindings: StoredBinding[] = []
    const identities = new Set<string>()
    for (const value of candidate.bindings) {
      const binding = value as Partial<StoredBinding> | null
      if (
        !binding ||
        !validID(binding.source_session_id) ||
        !validID(binding.agent_id) ||
        !validID(binding.dispatch_id) ||
        (binding.source_message_id !== undefined && !validID(binding.source_message_id)) ||
        Object.keys(binding).some(
          (key) =>
            key !== 'source_session_id' &&
            key !== 'agent_id' &&
            key !== 'source_message_id' &&
            key !== 'dispatch_id',
        )
      ) {
        throw new Error('invalid image-task binding')
      }
      const identity = [
        binding.source_session_id,
        binding.agent_id,
        binding.source_message_id ?? '',
        binding.dispatch_id,
      ].join('\u0000')
      if (identities.has(identity)) throw new Error('duplicate image-task binding')
      identities.add(identity)
      bindings.push({
        source_session_id: binding.source_session_id,
        agent_id: binding.agent_id,
        ...(binding.source_message_id ? { source_message_id: binding.source_message_id } : {}),
        dispatch_id: binding.dispatch_id,
      })
    }
    return { version: 2, bindings }
  } catch {
    try {
      target.removeItem(IMAGE_TASK_RUNTIME_PROJECTION)
    } catch {
      // runtimeProjectionStorage 可能不可写；内存侧仍安全返回空状态。
    }
    return emptyState()
  }
}

function writeState(state: StoredBindingsV2): void {
  const target = storage()
  if (!target) return
  try {
    if (state.bindings.length === 0) {
      target.removeItem(IMAGE_TASK_RUNTIME_PROJECTION)
      return
    }
    target.setItem(IMAGE_TASK_RUNTIME_PROJECTION, JSON.stringify(state))
  } catch {
    // 持久化不可用不改变服务端任务；只是无法跨刷新恢复。
  }
}

export function getImageTaskBinding(
  sessionId: string | undefined,
  agentId: string,
  sourceMessageId?: string,
): ImageTaskBinding | null {
  if (!validID(sessionId) || !validID(agentId)) return null
  const candidates = readState().bindings.filter(
    (binding) =>
      binding.source_session_id === sessionId &&
      binding.agent_id === agentId &&
      (!validID(sourceMessageId) || binding.source_message_id === sourceMessageId),
  )
  if (candidates.length !== 1) return null
  const stored = candidates[0]!
  return {
    agentId: stored.agent_id,
    ...(stored.source_message_id ? { sourceMessageId: stored.source_message_id } : {}),
    dispatchId: stored.dispatch_id,
  }
}

export function listImageTaskBindings(
  sessionId: string | undefined,
  agentId: string,
): ImageTaskBinding[] {
  if (!validID(sessionId) || !validID(agentId)) return []
  return readState()
    .bindings.filter(
      (binding) =>
        binding.source_session_id === sessionId &&
        binding.agent_id === agentId &&
        validID(binding.source_message_id),
    )
    .map((binding) => ({
      agentId: binding.agent_id,
      sourceMessageId: binding.source_message_id!,
      dispatchId: binding.dispatch_id,
    }))
}

export function hasImageTaskBinding(sessionId: string | undefined, agentId: string): boolean {
  if (!validID(sessionId) || !validID(agentId)) return false
  return readState().bindings.some(
    (binding) => binding.source_session_id === sessionId && binding.agent_id === agentId,
  )
}

export function setImageTaskBinding(
  sessionId: string | undefined,
  agentId: string,
  sourceMessageOrDispatchId: string,
  dispatchId?: string,
): void {
  const sourceMessageId = validID(dispatchId) ? sourceMessageOrDispatchId : undefined
  const resolvedDispatchId = validID(dispatchId) ? dispatchId : sourceMessageOrDispatchId
  if (!validID(sessionId) || !validID(agentId) || !validID(resolvedDispatchId)) return
  const state = readState()
  const existing = state.bindings.findIndex(
    (binding) =>
      binding.source_session_id === sessionId &&
      binding.agent_id === agentId &&
      (sourceMessageId
        ? binding.source_message_id === sourceMessageId
        : binding.dispatch_id === resolvedDispatchId),
  )
  const next: StoredBinding = {
    source_session_id: sessionId,
    agent_id: agentId,
    ...(sourceMessageId ? { source_message_id: sourceMessageId } : {}),
    dispatch_id: resolvedDispatchId,
  }
  if (existing >= 0) state.bindings.splice(existing, 1, next)
  else state.bindings.push(next)
  writeState(state)
}

export function clearImageTaskBinding(
  sessionId: string | undefined,
  agentId: string,
  sourceMessageOrDispatchId?: string,
  dispatchId?: string,
): void {
  if (!validID(sessionId) || !validID(agentId)) return
  const state = readState()
  const sourceMessageId = validID(dispatchId) ? sourceMessageOrDispatchId : undefined
  const resolvedDispatchId = validID(dispatchId) ? dispatchId : sourceMessageOrDispatchId
  state.bindings = state.bindings.filter((binding) => {
    if (binding.source_session_id !== sessionId || binding.agent_id !== agentId) return true
    if (validID(sourceMessageId) && binding.source_message_id !== sourceMessageId) return true
    if (validID(resolvedDispatchId) && binding.dispatch_id !== resolvedDispatchId) return true
    return false
  })
  writeState(state)
}

export async function listRecoverableImageTasks(agent: string, session: string) {
  return k12ListRecoverableImageTasks(agent, session)
}

/**
 * Replaces one owner's disposable renderer projection with the Sidecar's
 * durable recovery view. Missing/invalid identities fail closed.
 */
export async function refreshRecoverableImageTaskBindings(
  agent: string,
  session: string | undefined,
): Promise<void> {
  if (!validID(agent) || !validID(session)) return
  const recoverable = await k12ListRecoverableImageTasks(agent, session)
  const state = readState()
  state.bindings = state.bindings.filter(
    (binding) => binding.agent_id !== agent || binding.source_session_id !== session,
  )
  for (const item of recoverable) {
    if (
      !validID(item.source_session_id) ||
      !validID(item.source_message_id) ||
      !validID(item.dispatch_id)
    ) {
      continue
    }
    state.bindings.push({
      source_session_id: item.source_session_id,
      source_message_id: item.source_message_id,
      agent_id: agent,
      dispatch_id: item.dispatch_id,
    })
  }
  writeState(state)
}
