import { apiGet } from './client'

/** 语音服务状态 */
export interface VoiceStatus {
  stt_enabled: boolean
  tts_enabled: boolean
  stt_provider: string
  tts_provider: string
}

/** 获取语音服务状态 */
export function getVoiceStatus() {
  return apiGet<VoiceStatus>('/api/v1/voice/status')
}
