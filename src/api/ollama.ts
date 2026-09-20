import { shallowRef } from 'vue'
import { backendLocalStorage, backendScopeKey, assertBackendActive } from '@/services/backend-context'
import { env } from '@/config/env'
import { apiGet, apiPost, apiPut, apiDelete } from './client'
import { sidecarStreamFetch } from './native-sidecar-stream'

/** 轻量错误消息提取（不引入额外依赖，避免测试 mock 面扩大）。 */
function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  return 'Ollama daemon unreachable'
}

export interface OllamaModel {
  name: string
  size: number
  modified: string
  family?: string
  parameter_size?: string
  quantization_level?: string
  /** Ollama /api/tags 上报的真实能力（completion / vision / tools / thinking …），
   *  BUG-20260704：据此显示视觉徽章，替代按模型名猜的静态表。 */
  capabilities?: string[]
}

export interface OllamaStatus {
  target_id: string
  target_revision: number
  resolved_base_url: string
  can_restart: boolean
  running: boolean
  /** daemon 是否可达（BUG-20260718：区分「不可达」与「可达但无模型」）。 */
  reachable?: boolean
  /** 不可达原因（reachable=false 时）。 */
  error?: string
  version?: string
  models?: OllamaModel[]
  associated: boolean
  model_count: number
}

export interface OllamaRunningModel {
  name: string
  size: number
  size_vram: number
  expires_at: string
  parameter_size?: string
  quantization_level?: string
  context_length: number
}

export interface OllamaTarget {
  mode: 'default' | 'custom'
  custom_base_url: string
  resolved_base_url: string
  target_id: string
  target_revision: number
  target_digest: string
  associated_provider_instance_ids: string[]
  can_restart: boolean
}
export const activeOllamaTarget = shallowRef<Pick<OllamaTarget, 'target_id' | 'target_revision'> | null>(null)
function acceptOllamaTarget(target: Pick<OllamaTarget, 'target_id' | 'target_revision'>) {
  const current = activeOllamaTarget.value
  if (current && target.target_revision < current.target_revision) throw new DOMException('Ollama target changed', 'AbortError')
  activeOllamaTarget.value = target
}
export async function getOllamaTarget(): Promise<OllamaTarget> {
  const result = await apiGet<{ ollama: OllamaTarget }>('/api/v1/config')
  acceptOllamaTarget(result.ollama)
  return result.ollama
}
export async function saveOllamaTarget(target: OllamaTarget, ids: string[]): Promise<OllamaTarget> {
  const scope = backendScopeKey()
  const llm = await apiGet<{ config_revision: number; config_digest: string }>('/api/v1/config/llm')
  assertBackendActive(scope)
  const requestId = crypto.randomUUID()
  const body = { expected_config_revision: llm.config_revision, expected_config_digest: llm.config_digest,
    expected_target_revision: target.target_revision, expected_target_digest: target.target_digest,
    ollama: { mode: target.mode, custom_base_url: target.custom_base_url, associated_provider_instance_ids: ids } }
  try {
    await apiPut('/api/v1/config', body, { headers: { 'Idempotency-Key': requestId } })
  } catch (error) {
    assertBackendActive(scope)
    // 丢响应只查原提交证明；查询失败保留未确认状态，不再发送 PUT。
    try { await apiGet(`/api/v1/config/mutations/${requestId}`, { operation_kind: 'ollama_target' }) }
    catch { throw error }
  }
  assertBackendActive(scope)
  return getOllamaTarget()
}

/** 管理列表与推理均由当前后端访问已保存的目标。 */
export async function getOllamaStatus(): Promise<OllamaStatus> {
  const result = await apiGet<OllamaStatus>('/api/v1/ollama/status')
  acceptOllamaTarget(result)
  return result
}

/** 运行中模型结果（BUG-20260718：区分「daemon 不可达」与「可达但无运行模型」）。 */
export interface OllamaRunningResult {
  models: OllamaRunningModel[]
  /** daemon 是否可达。 */
  reachable: boolean
  /** 异常原因（不可达或 /api/ps 非 2xx）。 */
  error?: string
}

export async function getOllamaRunningResult(): Promise<OllamaRunningResult> {
  try {
    const result = await apiGet<{ models: OllamaRunningModel[]; target_id: string; target_revision: number }>('/api/v1/ollama/running')
    if (!Array.isArray(result.models)) throw new Error('Invalid Ollama running models response')
    acceptOllamaTarget(result)
    return { models: result.models, reachable: true }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    return { models: [], reachable: false, error: errMessage(error) }
  }
}

/** 运行中模型（best-effort 旧签名）：委托 getOllamaRunningResult，仅取 models。 */
export async function getOllamaRunning(): Promise<OllamaRunningModel[]> {
  return (await getOllamaRunningResult()).models
}

export async function loadOllamaModel(model: string): Promise<void> {
  await apiPost('/api/v1/ollama/load', { model })
}

export function unloadOllamaModel(model: string): Promise<void> {
  return apiPost('/api/v1/ollama/unload', { model })
}

export function deleteOllamaModel(name: string): Promise<void> {
  return apiDelete(`/api/v1/ollama/models/${encodeURIComponent(name)}`)
}

export async function restartOllama(): Promise<string> {
  const data = await apiPost<{ status?: string }>('/api/v1/ollama/restart')
  return data.status || 'unknown'
}

export interface OllamaPullProgress {
  operation_id?: string
  target_id?: string
  target_revision?: number
  state?: 'running' | 'succeeded' | 'failed' | 'outcome_unknown'
  model?: string
  status: string
  completed?: number
  total?: number
  digest?: string
  error?: string
}

interface SavedPull { operationId: string; targetId: string; targetRevision: number; model: string }
const pullStorageKey = 'ollama-pull-operations'
function savedPulls(): SavedPull[] {
  try { return JSON.parse(backendLocalStorage.getItem(pullStorageKey) ?? '[]') } catch { return [] }
}
function retainPull(pull: SavedPull) { backendLocalStorage.setItem(pullStorageKey, JSON.stringify([...savedPulls().filter((p) => p.operationId !== pull.operationId), pull])) }
function forgetPull(id: string) { backendLocalStorage.setItem(pullStorageKey, JSON.stringify(savedPulls().filter((p) => p.operationId !== id))) }
async function consumePullResponse(resp: Response, scope: string, onProgress: (p: OllamaPullProgress) => void): Promise<void> {
  if (!resp.ok) throw new Error(`Ollama pull state unavailable: HTTP ${resp.status}`)
  const reader = resp.body?.getReader()
  if (!reader) throw new Error('Ollama pull response is unavailable')
  const decoder = new TextDecoder()
  let buffer = ''; let terminal: OllamaPullProgress | undefined
  try {
    while (true) {
      const { done, value } = await reader.read()
      assertBackendActive(scope)
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split('\n'); buffer = done ? '' : (lines.pop() ?? '')
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const event = JSON.parse(line.slice(5).trim()) as OllamaPullProgress
        onProgress(event)
        if (event.state && event.state !== 'running') terminal = event
      }
      if (done) break
    }
  } finally { reader.releaseLock() }
  if (terminal?.state === 'succeeded') { if (terminal.operation_id) forgetPull(terminal.operation_id); return }
  if (terminal?.state === 'failed' && terminal.operation_id) forgetPull(terminal.operation_id)
  throw new Error(terminal?.error || 'Ollama pull outcome is unknown; reconnect to query the original operation')
}
export async function pullOllamaModel(model: string, onProgress: (p: OllamaPullProgress) => void, signal?: AbortSignal): Promise<void> {
  const scope = backendScopeKey()
  const target = await getOllamaTarget()
  assertBackendActive(scope)
  const pull = { operationId: crypto.randomUUID(), targetId: target.target_id, targetRevision: target.target_revision, model }
  retainPull(pull)
  const resp = await sidecarStreamFetch(`${env.apiBase}/api/v1/ollama/pull`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pull.operationId },
    body: JSON.stringify({ model, expected_target_id: pull.targetId, expected_target_revision: pull.targetRevision }), signal,
  })
  await consumePullResponse(resp, scope, onProgress)
}
export async function resumeOllamaPulls(onProgress: (p: OllamaPullProgress) => void, signal?: AbortSignal): Promise<void> {
  const scope = backendScopeKey()
  const target = await getOllamaTarget()
  let failure: unknown
  for (const pull of savedPulls().filter((p) => p.targetId === target.target_id && p.targetRevision === target.target_revision)) {
    assertBackendActive(scope)
    try {
      const resp = await sidecarStreamFetch(`${env.apiBase}/api/v1/ollama/pulls/${encodeURIComponent(pull.operationId)}/events`, { method: 'GET', signal })
      await consumePullResponse(resp, scope, onProgress)
    } catch (error) {
      assertBackendActive(scope)
      if (signal?.aborted) throw error
      failure = error
    }
  }
  if (failure) throw failure
}
