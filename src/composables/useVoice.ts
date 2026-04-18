/**
 * useVoice — 语音输入/输出 composable
 *
 * STT 双通道：
 *   - 浏览器 Web Speech API（实时识别，无网络往返）
 *   - MediaRecorder + 后端 /api/v1/voice/transcribe（Tauri WKWebView 兜底）
 * TTS: 调用后端 /api/v1/voice/synthesize
 */

import { ref, computed, onUnmounted, getCurrentInstance } from 'vue'
import { speechToText, textToSpeech } from '@/api/voice'
import { logger } from '@/utils/logger'

/* Web Speech API type shims (not in all TS libs) */
declare global {
   
  var SpeechRecognition: {
    new (): SpeechRecognition
    prototype: SpeechRecognition
  } | undefined
   
  var webkitSpeechRecognition: {
    new (): SpeechRecognition
    prototype: SpeechRecognition
  } | undefined

  interface SpeechRecognition extends EventTarget {
    continuous: boolean
    interimResults: boolean
    lang: string
    onresult: ((event: SpeechRecognitionEvent) => void) | null
    onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
    onend: (() => void) | null
    start(): void
    stop(): void
  }

  interface SpeechRecognitionEvent extends Event {
    readonly resultIndex: number
    readonly results: SpeechRecognitionResultList
  }

  interface SpeechRecognitionResultList {
    readonly length: number
    [index: number]: SpeechRecognitionResult
  }

  interface SpeechRecognitionResult {
    readonly isFinal: boolean
    readonly length: number
    [index: number]: SpeechRecognitionAlternative
  }

  interface SpeechRecognitionAlternative {
    readonly transcript: string
    readonly confidence: number
  }

  interface SpeechRecognitionErrorEvent extends Event {
    readonly error: string
    readonly message: string
  }
}

export function useVoice() {
  const isListening = ref(false)
  const isSpeaking = ref(false)
  const transcript = ref('')
  const error = ref<string | null>(null)

  // 检测 Web Speech API 是否真正可用（Tauri WKWebView 有构造函数但运行时失败）
  const hasWebSpeech = computed(() => {
    if (typeof window === 'undefined') return false
    try {
      const Ctor =
        (window as unknown as Record<string, unknown>).SpeechRecognition as typeof SpeechRecognition | undefined
        ?? (window as unknown as Record<string, unknown>).webkitSpeechRecognition as typeof SpeechRecognition | undefined
      if (!Ctor) return false
      if ((globalThis as unknown as Record<string, unknown>).isTauri) return false
      return true
    } catch {
      return false
    }
  })

  // MediaRecorder + 后端 STT 兜底：Tauri / 不支持 Web Speech 的浏览器都能用
  const hasMediaRecorder = computed(() => {
    if (typeof window === 'undefined') return false
    return typeof window.MediaRecorder !== 'undefined'
      && typeof navigator !== 'undefined'
      && !!navigator.mediaDevices
      && typeof navigator.mediaDevices.getUserMedia === 'function'
  })

  // 任一通道可用即视为支持
  const isSupported = computed(() => hasWebSpeech.value || hasMediaRecorder.value)

  let recognition: SpeechRecognition | null = null
  let audioElement: HTMLAudioElement | null = null
  let audioUrl: string | null = null
  // MediaRecorder fallback 状态
  let mediaRecorder: MediaRecorder | null = null
  let recordedChunks: Blob[] = []
  let activeStream: MediaStream | null = null

  // ─── STT (Speech-to-Text) ────────────────────────────

  function createRecognition(): SpeechRecognition | null {
    const SpeechRecognitionCtor =
      (window as unknown as Record<string, unknown>).SpeechRecognition as typeof SpeechRecognition | undefined
      ?? (window as unknown as Record<string, unknown>).webkitSpeechRecognition as typeof SpeechRecognition | undefined
    if (!SpeechRecognitionCtor) return null

    const sr = new SpeechRecognitionCtor()
    sr.continuous = false
    sr.interimResults = true
    sr.lang = navigator.language || 'zh-CN'
    return sr
  }

  function startListening() {
    if (isListening.value) return
    error.value = null
    transcript.value = ''

    // 优先 Web Speech（实时识别），不可用则走 MediaRecorder + 后端
    if (hasWebSpeech.value) {
      startWebSpeech()
      return
    }
    if (hasMediaRecorder.value) {
      void startMediaRecorder()
      return
    }
    error.value = 'Speech recognition is not supported on this device'
    logger.warn('[useVoice] no STT channel available (no Web Speech, no MediaRecorder)')
  }

  function startWebSpeech() {
    recognition = createRecognition()
    if (!recognition) {
      error.value = 'Failed to create speech recognition instance'
      return
    }

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = ''
      let final = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]!
        if (result.isFinal) {
          final += result[0]!.transcript
        } else {
          interim += result[0]!.transcript
        }
      }
      transcript.value = final || interim
    }

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      // "aborted" is expected when we call stopListening()
      if (event.error === 'aborted') return
      error.value = `Speech recognition error: ${event.error}`
      logger.warn(`[useVoice] recognition error: ${event.error}`)
      isListening.value = false
    }

    recognition.onend = () => {
      isListening.value = false
    }

    try {
      recognition.start()
      isListening.value = true
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to start speech recognition'
      logger.error('[useVoice] start failed', e)
    }
  }

  /**
   * MediaRecorder 兜底：录音 → blob → POST 后端 transcribe → 写入 transcript。
   * 在 Tauri WKWebView 下是唯一可用的 STT 路径。
   */
  async function startMediaRecorder() {
    try {
      activeStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      recordedChunks = []
      // 优先 webm/opus（Chrome/Tauri 默认），回退 mp4
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4')
          ? 'audio/mp4'
          : ''
      mediaRecorder = mimeType
        ? new MediaRecorder(activeStream, { mimeType })
        : new MediaRecorder(activeStream)

      mediaRecorder.ondataavailable = (ev: BlobEvent) => {
        if (ev.data && ev.data.size > 0) recordedChunks.push(ev.data)
      }
      mediaRecorder.onstop = async () => {
        const stoppedRecorder = mediaRecorder
        const stoppedStream = activeStream
        mediaRecorder = null
        activeStream = null
        // 释放麦克风
        stoppedStream?.getTracks().forEach(t => t.stop())

        if (!recordedChunks.length) {
          isListening.value = false
          return
        }
        const usedMime = stoppedRecorder?.mimeType || 'audio/webm'
        const ext = usedMime.includes('mp4') ? 'mp4' : 'webm'
        const blob = new Blob(recordedChunks, { type: usedMime })
        recordedChunks = []
        try {
          const file = new File([blob], `recording.${ext}`, { type: usedMime })
          const result = await speechToText(file)
          if (result?.text) transcript.value = result.text
        } catch (e) {
          error.value = e instanceof Error ? e.message : 'Transcribe failed'
          logger.error('[useVoice] backend transcribe failed', e)
        } finally {
          isListening.value = false
        }
      }
      mediaRecorder.onerror = (ev: Event) => {
        error.value = `MediaRecorder error: ${(ev as ErrorEvent).message ?? 'unknown'}`
        logger.warn('[useVoice] MediaRecorder error', ev)
        isListening.value = false
      }

      // timeslice=1000ms：每秒切一次数据块，长录音避免单块过大；stop 时拼回整段 Blob。
      mediaRecorder.start(1000)
      isListening.value = true
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Microphone access denied'
      logger.error('[useVoice] getUserMedia failed', e)
      isListening.value = false
    }
  }

  function stopListening() {
    if (recognition) {
      try { recognition.stop() } catch { /* already stopped */ }
      recognition = null
    }
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try { mediaRecorder.stop() } catch { /* already stopped */ }
      // isListening 在 onstop 后端 transcribe 完成后置 false
      return
    }
    isListening.value = false
  }

  function toggleListening() {
    if (isListening.value) {
      stopListening()
    } else {
      startListening()
    }
  }

  // ─── TTS (Text-to-Speech) ────────────────────────────

  async function speak(text: string, voice?: string) {
    if (isSpeaking.value) stopSpeaking()
    error.value = null

    try {
      isSpeaking.value = true
      const blob = await textToSpeech({ text, voice })

      // Clean up previous audio URL
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl)
        audioUrl = null
      }

      audioUrl = URL.createObjectURL(blob)
      audioElement = new Audio(audioUrl)

      audioElement.onended = () => {
        isSpeaking.value = false
        cleanupAudio()
      }

      audioElement.onerror = () => {
        error.value = 'Failed to play audio'
        isSpeaking.value = false
        cleanupAudio()
      }

      await audioElement.play()
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'TTS failed'
      isSpeaking.value = false
      logger.error('[useVoice] TTS failed', e)
    }
  }

  function stopSpeaking() {
    if (audioElement) {
      audioElement.pause()
      audioElement.currentTime = 0
    }
    isSpeaking.value = false
    cleanupAudio()
  }

  function cleanupAudio() {
    if (audioElement) {
      audioElement.onended = null
      audioElement.onerror = null
      audioElement = null
    }
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl)
      audioUrl = null
    }
  }

  // ─── Cleanup on unmount ──────────────────────────────

  function cleanup() {
    stopListening()
    stopSpeaking()
  }

  if (getCurrentInstance()) {
    onUnmounted(cleanup)
  }

  return {
    isListening,
    isSpeaking,
    transcript,
    error,
    isSupported,
    startListening,
    stopListening,
    toggleListening,
    speak,
    stopSpeaking,
  }
}
