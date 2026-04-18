/**
 * Voice Chat API — audio-to-audio 对话（gpt-4o-audio-preview / glm-4-voice）
 *
 * 后端：/api/v1/voicechat/{status,chat}
 */

import { apiGet, apiPost } from './client'
import { env } from '@/config/env'

export interface VoiceChatStatus {
  enabled: boolean
  providers: string[]
  models: string[]
}

export interface VoiceChatTurn {
  role: 'user' | 'assistant'
  text?: string
  audio_id?: string
}

export interface VoiceChatRequest {
  provider?: string
  model: string
  audio?: string  // base64
  text?: string
  voice?: string  // 输出音色（alloy / echo / fable ...）
  format?: string // wav / mp3
  system?: string
  history?: VoiceChatTurn[]
}

export interface VoiceChatResult {
  provider: string
  model: string
  audio?: string                  // 模型回应音频 base64（落盘后会被清空）
  audio_file_path?: string        // 持久化路径
  transcript?: string             // 模型回应文本（始终返回）
  user_text?: string              // 用户音频转写（gpt-4o 也返回）
  format?: string
  usage_ms?: number
}

export function getVoiceChatStatus() {
  return apiGet<VoiceChatStatus>('/api/v1/voicechat/status')
}

export function voiceChat(req: VoiceChatRequest) {
  return apiPost<VoiceChatResult>('/api/v1/voicechat/chat', req)
}

/** 优先用持久化路径，其次 b64 data URL */
export function audioToSrc(r: VoiceChatResult): string {
  if (r.audio_file_path) return `${env.apiBase}/api/v1/files/generated/${r.audio_file_path}`
  if (r.audio) {
    const mime = r.format === 'mp3' ? 'audio/mpeg' : 'audio/wav'
    return `data:${mime};base64,${r.audio}`
  }
  return ''
}
