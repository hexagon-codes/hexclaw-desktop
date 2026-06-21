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

/** STT 识别响应 — 匹配后端 voice.TranscribeResult
 *  Text 恒返回；confidence/language/duration 后端均 omitempty，零值时整字段缺失，故声明为可选。 */
export interface STTResponse {
  text: string
  confidence?: number
  language?: string
  duration?: number
}

/** 获取语音服务状态 */
export function getVoiceStatus() {
  return apiGet<VoiceStatus>('/api/v1/voice/status')
}

/**
 * 文本转语音 — 注意：后端返回音频二进制流（audio/mpeg 等），
 * 不是 JSON，需要用 fetch + blob 接收。
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

/** 从 File 的 MIME / 文件名推断真实音频容器格式（webm / mp4 / mp3 / wav / ogg / flac）。
 *  后端只从 query 读取 format，空则默认 wav；必须把真实容器传过去，否则 webm/mp4 被当 wav 处理。 */
export function resolveAudioFormat(audioFile: File): string {
  const mime = (audioFile.type || '').toLowerCase()
  const name = (audioFile.name || '').toLowerCase()
  // 优先 MIME 子类型（去掉 codecs 参数，如 audio/webm;codecs=opus → webm）
  const sub = mime.split(';')[0]?.split('/')[1] ?? ''
  const m = sub === 'mpeg' ? 'mp3' : sub
  if (m) return m
  // 退化到文件扩展名
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  return ext
}

/** 语音转文本 — 接受音频文件 FormData。
 *  format / language 必须走 URL query（后端从 r.URL.Query() 读取，不读 FormData body）。 */
export function speechToText(audioFile: File, language?: string) {
  const form = new FormData()
  form.append('audio', audioFile)
  const params = new URLSearchParams()
  const format = resolveAudioFormat(audioFile)
  if (format) params.set('format', format)
  if (language) params.set('language', language)
  const qs = params.toString()
  const path = qs ? `/api/v1/voice/transcribe?${qs}` : '/api/v1/voice/transcribe'
  return apiPost<STTResponse>(path, form)
}
