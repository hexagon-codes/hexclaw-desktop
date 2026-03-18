/**
 * Voice API
 *
 * 语音服务 — STT（语音识别）和 TTS（语音合成）。
 */

import { apiGet, apiPost } from './client'

/** 语音服务状态 */
export interface VoiceStatus {
  stt_enabled: boolean
  tts_enabled: boolean
  stt_provider: string
  tts_provider: string
}

/** TTS 合成请求 */
export interface TTSRequest {
  text: string
  voice?: string
  speed?: number
  language?: string
}

/** TTS 合成响应 */
export interface TTSResponse {
  audio_url: string
  duration_ms: number
  format: string
}

/** STT 识别响应 */
export interface STTResponse {
  text: string
  confidence: number
  language: string
  duration_ms: number
}

/** 获取语音服务状态 */
export function getVoiceStatus() {
  return apiGet<VoiceStatus>('/api/v1/voice/status')
}

/** 获取可用 TTS 音色列表 */
export function getVoiceList() {
  return apiGet<{ voices: { id: string; name: string; language: string; preview_url?: string }[] }>('/api/v1/voice/tts/voices')
}

/** 文本转语音 */
export function textToSpeech(req: TTSRequest) {
  return apiPost<TTSResponse>('/api/v1/voice/tts', req)
}

/** 语音转文本 — 接受音频文件 FormData */
export function speechToText(audioFile: File, language?: string) {
  const form = new FormData()
  form.append('audio', audioFile)
  if (language) form.append('language', language)
  return apiPost<STTResponse>('/api/v1/voice/stt', form)
}
