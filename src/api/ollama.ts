import { env, OLLAMA_BASE } from '@/config/env'
import { apiPost, apiDelete } from './client'
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

/**
 * 直连 Ollama 原生 API 获取状态（不依赖 hexclaw sidecar）
 *
 * Ollama 是独立进程，状态检测不应经过后端代理，
 * 避免 sidecar 未启动时误报 Ollama 不可用。
 */
export async function getOllamaStatus(): Promise<OllamaStatus> {
  // BUG-20260718（§15）：以 /api/tags 作为存活探针（必需）。version 是可选补充，
  // 不能因 version 探测失败就把一个存活的 daemon 误报为 running:false（旧 Promise.all
  // 任一失败即 catch → 不可达与无模型混为一谈）。
  let tagsRes: Response
  try {
    tagsRes = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(3000) })
  } catch (e) {
    return { running: false, reachable: false, error: errMessage(e), models: [], associated: false, model_count: 0 }
  }
  if (!tagsRes.ok) {
    return { running: false, reachable: false, error: `tags: ${tagsRes.status}`, models: [], associated: false, model_count: 0 }
  }

  const tags = await tagsRes.json() as { models?: Array<{ name: string; size: number; modified_at: string; capabilities?: string[]; details?: { family?: string; parameter_size?: string; quantization_level?: string } }> }

  // version 可选：失败不掩盖「daemon 存活」这一事实。
  let version: string | undefined
  try {
    const versionRes = await fetch(`${OLLAMA_BASE}/api/version`, { signal: AbortSignal.timeout(3000) })
    if (versionRes.ok) version = ((await versionRes.json()) as { version?: string }).version
  } catch {
    // daemon 已确认可达（tags 成功），version 拿不到无妨
  }

  const models: OllamaModel[] = (tags.models || []).map((m) => ({
    name: m.name,
    size: m.size,
    modified: m.modified_at,
    family: m.details?.family,
    parameter_size: m.details?.parameter_size,
    quantization_level: m.details?.quantization_level,
    // BUG-20260704：透出真实能力，视觉模型（如 qwen3.5:9b）才能显示「视觉」徽章
    capabilities: m.capabilities,
  }))
  return {
    running: true,
    reachable: true,
    version,
    models,
    associated: true,
    model_count: models.length,
  }
}

/** 运行中模型结果（BUG-20260718：区分「daemon 不可达」与「可达但无运行模型」）。 */
export interface OllamaRunningResult {
  models: OllamaRunningModel[]
  /** daemon 是否可达。 */
  reachable: boolean
  /** 异常原因（不可达或 /api/ps 非 2xx）。 */
  error?: string
}

/**
 * 直连 Ollama /api/ps 获取运行中模型，区分不可达 vs 无模型。
 *
 * BUG-20260718（§15）：旧 getOllamaRunning 捕获任意错误都返回 []，「daemon 不可达」
 * 与「可达但无运行模型」无法区分。此处返回 reachable/error；空模型（reachable=true）
 * 与不可达（reachable=false）分开。
 */
export async function getOllamaRunningResult(): Promise<OllamaRunningResult> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/ps`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return { models: [], reachable: true, error: `ps: ${res.status}` }
    const data = await res.json() as { models?: Array<{ name: string; size: number; size_vram: number; expires_at: string; details?: { parameter_size?: string; quantization_level?: string }; context_length?: number }> }
    const models = (data.models || []).map((m) => ({
      name: m.name,
      size: m.size,
      size_vram: m.size_vram,
      expires_at: m.expires_at,
      parameter_size: m.details?.parameter_size,
      quantization_level: m.details?.quantization_level,
      context_length: m.context_length ?? 0,
    }))
    return { models, reachable: true }
  } catch (e) {
    return { models: [], reachable: false, error: errMessage(e) }
  }
}

/** 运行中模型（best-effort 旧签名）：委托 getOllamaRunningResult，仅取 models。 */
export async function getOllamaRunning(): Promise<OllamaRunningModel[]> {
  return (await getOllamaRunningResult()).models
}

export async function loadOllamaModel(model: string): Promise<void> {
  // 直连 Ollama 原生 API 预热模型（Tauri webview 允许 localhost 跨域）
  const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: '', keep_alive: '5m' }),
  })
  if (!res.ok) throw new Error(`Ollama load failed: ${res.status}`)
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
  status: string
  completed?: number
  total?: number
  digest?: string
  error?: string
}

/**
 * 拉取 Ollama 模型，流式返回下载进度
 * @param model 模型名称（如 "llama3.1", "qwen3:14b"）
 * @param onProgress 进度回调
 * @returns 完成后 resolve
 */
export async function pullOllamaModel(
  model: string,
  onProgress: (p: OllamaPullProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const resp = await sidecarStreamFetch(`${env.apiBase}/api/v1/ollama/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
    signal,
  })
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }))
    throw new Error(err.error || `Pull failed: ${resp.status}`)
  }
  const reader = resp.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''
  let streamError = ''
  let receivedAnyEvent = false
  while (true) {
    const { done, value } = await reader.read()
    if (!done) {
      buffer += decoder.decode(value, { stream: true })
    }
    const lines = buffer.split('\n')
    buffer = done ? '' : (lines.pop() || '')
    for (const line of lines) {
      const trimmed = line.replace(/^data:\s*/, '').trim()
      if (!trimmed) continue
      try {
        const p: OllamaPullProgress = JSON.parse(trimmed)
        receivedAnyEvent = true
        if (p.error) streamError = p.error
        onProgress(p)
      } catch { /* ignore non-JSON lines */ }
    }
    if (done) break
  }
  if (streamError) throw new Error(streamError)
  if (!receivedAnyEvent) throw new Error('Download interrupted — no progress events received')
}
