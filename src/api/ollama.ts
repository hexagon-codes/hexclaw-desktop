import { env } from '@/config/env'
import { apiGet, apiPost, apiDelete } from './client'

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

export function getOllamaStatus(): Promise<OllamaStatus> {
  return apiGet<OllamaStatus>('/api/v1/ollama/status')
}

export async function getOllamaRunning(): Promise<OllamaRunningModel[]> {
  const data = await apiGet<{ models?: OllamaRunningModel[] }>('/api/v1/ollama/running')
  return data.models || []
}

export function loadOllamaModel(model: string): Promise<void> {
  return apiPost('/api/v1/ollama/load', { model })
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
