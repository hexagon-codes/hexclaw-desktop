/**
 * Desktop 对持久 GradingJob 的最小会话绑定。
 *
 * 这里只允许保存恢复同一服务端真相所需的 session / agent / job ID；原图、base64、
 * 模型响应和领域结果都不得进入浏览器存储。所有读取均校验版本与字段，损坏数据 fail-closed。
 */
export const K12_GRADING_JOB_BINDINGS_KEY = 'hexclaw.k12.grading-job-bindings.v1'

interface StoredBinding {
  agent_id: string
  job_id: string
}

interface StoredBindingsV1 {
  version: 1
  bindings: Record<string, StoredBinding>
}

export interface GradingJobBinding {
  agentId: string
  jobId: string
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
  const raw = target.getItem(K12_GRADING_JOB_BINDINGS_KEY)
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
      throw new Error('unsupported grading-job binding payload')
    }
    const bindings: Record<string, StoredBinding> = {}
    for (const [sessionId, value] of Object.entries(candidate.bindings)) {
      const binding = value as Partial<StoredBinding> | null
      if (
        !validID(sessionId) ||
        !binding ||
        !validID(binding.agent_id) ||
        !validID(binding.job_id)
      ) {
        throw new Error('invalid grading-job binding')
      }
      bindings[sessionId] = {
        agent_id: binding.agent_id,
        job_id: binding.job_id,
      }
    }
    return { version: 1, bindings }
  } catch {
    // 损坏/未知版本不能参与恢复，也不能跨会话猜测；清掉后等待服务端新任务重新建立绑定。
    try {
      target.removeItem(K12_GRADING_JOB_BINDINGS_KEY)
    } catch {
      // localStorage 可能在隐私模式/容量异常时不可写；内存侧仍返回空状态。
    }
    return emptyState()
  }
}

function writeState(state: StoredBindingsV1): void {
  const target = storage()
  if (!target) return
  try {
    if (Object.keys(state.bindings).length === 0) {
      target.removeItem(K12_GRADING_JOB_BINDINGS_KEY)
      return
    }
    target.setItem(K12_GRADING_JOB_BINDINGS_KEY, JSON.stringify(state))
  } catch {
    // 持久化不可用时不影响服务端任务；本地只是不具备跨刷新恢复能力。
  }
}

export function getGradingJobBinding(
  sessionId: string | undefined,
  agentId: string,
): GradingJobBinding | null {
  if (!validID(sessionId) || !validID(agentId)) return null
  const stored = readState().bindings[sessionId]
  if (!stored || stored.agent_id !== agentId) return null
  return { agentId: stored.agent_id, jobId: stored.job_id }
}

export function hasGradingJobBinding(sessionId: string | undefined, agentId: string): boolean {
  return getGradingJobBinding(sessionId, agentId) !== null
}

export function setGradingJobBinding(
  sessionId: string | undefined,
  agentId: string,
  jobId: string,
): void {
  if (!validID(sessionId) || !validID(agentId) || !validID(jobId)) return
  const state = readState()
  state.bindings[sessionId] = { agent_id: agentId, job_id: jobId }
  writeState(state)
}

export function clearGradingJobBinding(
  sessionId: string | undefined,
  agentId: string,
  jobId?: string,
): void {
  if (!validID(sessionId) || !validID(agentId)) return
  const state = readState()
  const existing = state.bindings[sessionId]
  if (!existing || existing.agent_id !== agentId) return
  if (validID(jobId) && existing.job_id !== jobId) return
  delete state.bindings[sessionId]
  writeState(state)
}
