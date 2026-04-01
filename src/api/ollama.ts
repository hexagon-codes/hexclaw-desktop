import { env } from '@/config/env'

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

export async function getOllamaStatus(): Promise<OllamaStatus> {
  const resp = await fetch(`${env.apiBase}/api/v1/ollama/status`, {
    signal: AbortSignal.timeout(5000),
  })
  if (!resp.ok) throw new Error(`Ollama status: ${resp.status}`)
  return resp.json()
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
): Promise<void> {
  const resp = await fetch(`${env.apiBase}/api/v1/ollama/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  })
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }))
    throw new Error(err.error || `Pull failed: ${resp.status}`)
  }
  const reader = resp.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.replace(/^data:\s*/, '').trim()
      if (!trimmed) continue
      try {
        onProgress(JSON.parse(trimmed))
      } catch { /* ignore non-JSON lines */ }
    }
  }
}
