import { env, OLLAMA_BASE } from '@/config/env'
import { apiPost, apiDelete } from './client'

export interface OllamaModel {
  name: string
  size: number
  modified: string
  family?: string
  parameter_size?: string
  quantization_level?: string
}

export interface OllamaStatus {
  running: boolean
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
  try {
    const [tagsRes, versionRes] = await Promise.all([
      fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(3000) }),
      fetch(`${OLLAMA_BASE}/api/version`, { signal: AbortSignal.timeout(3000) }),
    ])
    if (!tagsRes.ok) throw new Error(`tags: ${tagsRes.status}`)
    const tags = await tagsRes.json() as { models?: Array<{ name: string; size: number; modified_at: string; details?: { family?: string; parameter_size?: string; quantization_level?: string } }> }
    const version = versionRes.ok ? ((await versionRes.json()) as { version?: string }).version : undefined
    const models: OllamaModel[] = (tags.models || []).map((m) => ({
      name: m.name,
      size: m.size,
      modified: m.modified_at,
      family: m.details?.family,
      parameter_size: m.details?.parameter_size,
      quantization_level: m.details?.quantization_level,
    }))
    return {
      running: true,
      version,
      models,
      associated: true,
      model_count: models.length,
    }
  } catch {
    return { running: false, models: [], associated: false, model_count: 0 }
  }
}

/** 直连 Ollama /api/ps 获取运行中模型 */
export async function getOllamaRunning(): Promise<OllamaRunningModel[]> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/ps`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return []
    const data = await res.json() as { models?: Array<{ name: string; size: number; size_vram: number; expires_at: string; details?: { parameter_size?: string; quantization_level?: string }; context_length?: number }> }
    return (data.models || []).map((m) => ({
      name: m.name,
      size: m.size,
      size_vram: m.size_vram,
      expires_at: m.expires_at,
      parameter_size: m.details?.parameter_size,
      quantization_level: m.details?.quantization_level,
      context_length: m.context_length ?? 0,
    }))
  } catch {
    return []
  }
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
  const resp = await fetch(`${env.apiBase}/api/v1/ollama/pull`, {
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
