/**
 * Image Generation API — 文本到图像生成
 *
 * 后端：/api/v1/images/{status,generate}
 * Provider：openai-dalle / zhipu-cogview（按 LLM Provider API Key 自动派生）。
 */

import { apiGet, apiPost } from './client'
import { env } from '@/config/env'

export interface ImageGenStatus {
  enabled: boolean
  providers: string[]
  models: string[]
}

export interface ImageGenRequest {
  /** 显式指定 Provider，留空则按 model 自动路由 */
  provider?: string
  /** 模型 ID（如 dall-e-3 / cogview-4） */
  model: string
  /** 提示词（必填） */
  prompt: string
  /** 反向提示词，部分 Provider 支持 */
  negative?: string
  /** 尺寸 1024x1024 / 1792x1024 / 1024x1792 等 */
  size?: string
  /** 张数（默认 1） */
  n?: number
  /** DALL-E 3 风格：vivid / natural */
  style?: string
  /** DALL-E 3 质量：standard / hd */
  quality?: string
}

export interface GeneratedImage {
  url?: string
  b64_json?: string
  /** 持久化路径（如 "202604/abc.png"），由后端 genstore 落盘后返回 */
  file_path?: string
  revised_prompt?: string
}

export interface ImageGenResult {
  provider: string
  model: string
  created: number
  images: GeneratedImage[]
  usage_ms?: number
}

export function getImageGenStatus() {
  return apiGet<ImageGenStatus>('/api/v1/images/status')
}

export function generateImage(req: ImageGenRequest) {
  return apiPost<ImageGenResult>('/api/v1/images/generate', req)
}

/**
 * 把后端返回的图像（持久化路径 / URL / b64）统一为可放进 <img src> 的字符串。
 * 优先级：file_path（最稳定，不会过期/不撑爆 SQLite）→ url（Provider 临时链接）→ b64
 */
export function imageToSrc(img: GeneratedImage): string {
  if (img.file_path) {
    return `${env.apiBase}/api/v1/files/generated/${img.file_path}`
  }
  if (img.url) return img.url
  if (img.b64_json) return `data:image/png;base64,${img.b64_json}`
  return ''
}
