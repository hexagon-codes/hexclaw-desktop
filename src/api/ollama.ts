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
