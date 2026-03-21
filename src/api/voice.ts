/**
 * Voice API
 *
 * 语音服务 — STT（语音识别）和 TTS（语音合成）。
 */

import { apiGet, apiPost } from './client'
import { env } from '@/config/env'

/** 语音服务状态 */
export interface VoiceStatus {
  stt_enabled: boolean
  tts_enabled: boolean
  stt_provider: string
  tts_provider: string
}

/** TTS 合成请求 — 匹配后端 handleVoiceSynthesize */
export interface TTSRequest {
  text: string
  voice?: string
}

/** STT 识别响应 — 匹配后端 voice.TranscribeResult */
export interface STTResponse {
  text: string
  confidence: number
  language: string
  duration: number
}

/** 获取语音服务状态 */
export function getVoiceStatus() {
  return apiGet<VoiceStatus>('/api/v1/voice/status')
}

/**
 * 文本转语音 — 注意：后端返回音频二进制流（audio/mpeg 等），
 * 不是 JSON，需要用 fetch + blob 接收。当前未被调用。
 */
export async function textToSpeech(req: TTSRequest): Promise<Blob> {
  const res = await fetch(`${env.apiBase}/api/v1/voice/synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (!res.ok) throw new Error(`TTS failed: ${res.status}`)
  return res.blob()
}

/** 语音转文本 — 接受音频文件 FormData，language 通过 query param 传递 */
export function speechToText(audioFile: File, language?: string) {
  const form = new FormData()
  form.append('audio', audioFile)
  const params = new URLSearchParams()
  if (language) params.set('language', language)
  const qs = params.toString()
  return apiPost<STTResponse>(`/api/v1/voice/transcribe${qs ? `?${qs}` : ''}`, form)
}
