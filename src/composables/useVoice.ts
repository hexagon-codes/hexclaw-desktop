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
    abort?(): void
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

// ─── 模块级 TTS 单例（AP-097/叠音修复）──────────────────────
// 全局同一时刻只播一段语音（跨所有 useVoice 实例互斥）；AbortController 让"停止/卸载"
// 能中断进行中的合成 await——否则合成 resolve 后仍 new Audio().play() = 幽灵音频 + 状态脱节。
let voiceSeq = 0
const activeSpeakerId = ref<string | null>(null)
let activeAudio: HTMLAudioElement | null = null
let activeAudioUrl: string | null = null
let activeAbort: AbortController | null = null

function teardownActiveTTS() {
  if (activeAudio) {
    activeAudio.onended = null
    activeAudio.onerror = null
    try { activeAudio.pause() } catch { /* already stopped */ }
    activeAudio = null
  }
  if (activeAudioUrl) {
    URL.revokeObjectURL(activeAudioUrl)
    activeAudioUrl = null
  }
}

function stopActiveTTS() {
  if (activeAbort) { activeAbort.abort(); activeAbort = null }
  teardownActiveTTS()
  activeSpeakerId.value = null
}

export function useVoice() {
  const isListening = ref(false)
  const isTranscribing = ref(false)
  const myVoiceId = `voice-${++voiceSeq}`
  // 本实例是否正在朗读：由模块级单例决定 → 别的实例开播时本实例自动变 false（互斥）。
  const isSpeaking = computed(() => activeSpeakerId.value === myVoiceId)
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
  // MediaRecorder fallback 状态
  let mediaRecorder: MediaRecorder | null = null
  let activeStream: MediaStream | null = null
  let mediaCaptureId = 0
  let pendingMediaStart: { id: number; promise: Promise<void> } | null = null
  let captureSeq = 0
  let activeCaptureId = 0
  const discardedCaptureIds = new Set<number>()
  let captureCompletion: {
    id: number
    promise: Promise<string>
    resolve: (text: string) => void
    settled: boolean
  } | null = null

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

  function beginCapture(): number {
    const id = ++captureSeq
    activeCaptureId = id
    let resolveCompletion: (text: string) => void = () => {}
    const promise = new Promise<string>((resolve) => {
      resolveCompletion = resolve
    })
    captureCompletion = { id, promise, resolve: resolveCompletion, settled: false }
    return id
  }

  function settleCapture(id: number, text: string) {
    if (!captureCompletion || captureCompletion.id !== id || captureCompletion.settled) return
    captureCompletion.settled = true
    captureCompletion.resolve(text)
  }

  function startListening(): void | Promise<void> {
    if (isListening.value || pendingMediaStart) return pendingMediaStart?.promise
    error.value = null
    transcript.value = ''
    isTranscribing.value = false
    const captureId = beginCapture()

    // 优先 Web Speech（实时识别），不可用则走 MediaRecorder + 后端
    if (hasWebSpeech.value) {
      startWebSpeech(captureId)
      return
    }
    if (hasMediaRecorder.value) {
      const promise = startMediaRecorder(captureId).finally(() => {
        if (pendingMediaStart?.id === captureId) pendingMediaStart = null
      })
      pendingMediaStart = { id: captureId, promise }
      return promise
    }
    error.value = 'Speech recognition is not supported on this device'
    settleCapture(captureId, '')
    logger.warn('[useVoice] no STT channel available (no Web Speech, no MediaRecorder)')
  }

  function startWebSpeech(captureId: number) {
    recognition = createRecognition()
    if (!recognition) {
      error.value = 'Failed to create speech recognition instance'
      settleCapture(captureId, '')
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
      // 主动丢弃录音时 aborted 是预期结果。
      if (event.error === 'aborted') return
      error.value = `Speech recognition error: ${event.error}`
      logger.warn(`[useVoice] recognition error: ${event.error}`)
      isListening.value = false
      settleCapture(captureId, '')
    }

    recognition.onend = () => {
      recognition = null
      isListening.value = false
      if (discardedCaptureIds.has(captureId)) {
        discardedCaptureIds.delete(captureId)
        settleCapture(captureId, '')
        return
      }
      settleCapture(captureId, transcript.value.trim())
    }

    try {
      recognition.start()
      isListening.value = true
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to start speech recognition'
      recognition = null
      settleCapture(captureId, '')
      logger.error('[useVoice] start failed', e)
    }
  }

  /**
   * MediaRecorder 兜底：录音 → blob → POST 后端 transcribe → 写入 transcript。
   * 在 Tauri WKWebView 下是唯一可用的 STT 路径。
   */
  async function startMediaRecorder(captureId: number) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (discardedCaptureIds.has(captureId) || activeCaptureId !== captureId) {
        stream.getTracks().forEach((track) => track.stop())
        discardedCaptureIds.delete(captureId)
        settleCapture(captureId, '')
        return
      }
      activeStream = stream
      const recordedChunks: Blob[] = []
      // 优先 webm/opus（Chrome/Tauri 默认），回退 mp4
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4')
          ? 'audio/mp4'
          : ''
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)
      mediaRecorder = recorder
      mediaCaptureId = captureId

      recorder.ondataavailable = (ev: BlobEvent) => {
        if (ev.data && ev.data.size > 0) recordedChunks.push(ev.data)
      }
      recorder.onstop = async () => {
        if (mediaRecorder === recorder) mediaRecorder = null
        if (activeStream === stream) activeStream = null
        if (mediaCaptureId === captureId) mediaCaptureId = 0
        stream.getTracks().forEach((track) => track.stop())
        isListening.value = false

        if (discardedCaptureIds.has(captureId)) {
          discardedCaptureIds.delete(captureId)
          recordedChunks.length = 0
          settleCapture(captureId, '')
          return
        }

        if (!recordedChunks.length) {
          error.value = 'No speech was recognized'
          settleCapture(captureId, '')
          return
        }
        const usedMime = recorder.mimeType || 'audio/webm'
        const ext = usedMime.includes('mp4') ? 'mp4' : 'webm'
        const blob = new Blob(recordedChunks, { type: usedMime })
        recordedChunks.length = 0
        isTranscribing.value = true
        try {
          const file = new File([blob], `recording.${ext}`, { type: usedMime })
          const result = await speechToText(file)
          const text = result?.text?.trim() ?? ''
          if (text) transcript.value = text
          else error.value = 'No speech was recognized'
          settleCapture(captureId, text)
        } catch (e) {
          error.value = e instanceof Error ? e.message : 'Transcribe failed'
          logger.error('[useVoice] backend transcribe failed', e)
          settleCapture(captureId, '')
        } finally {
          isTranscribing.value = false
        }
      }
      recorder.onerror = (ev: Event) => {
        error.value = `MediaRecorder error: ${(ev as ErrorEvent).message ?? 'unknown'}`
        logger.warn('[useVoice] MediaRecorder error', ev)
        isListening.value = false
        isTranscribing.value = false
        settleCapture(captureId, '')
      }

      // timeslice=1000ms：每秒切一次数据块，长录音避免单块过大；stop 时拼回整段 Blob。
      recorder.start(1000)
      isListening.value = true
    } catch (e) {
      if (!discardedCaptureIds.has(captureId)) {
        error.value = e instanceof Error ? e.message : 'Microphone access denied'
        logger.error('[useVoice] getUserMedia failed', e)
      }
      discardedCaptureIds.delete(captureId)
      isListening.value = false
      settleCapture(captureId, '')
    }
  }

  async function finishListening(): Promise<string> {
    const captureId = activeCaptureId
    const completion = captureCompletion?.id === captureId ? captureCompletion : null
    if (!completion) return transcript.value.trim()

    const mediaStart = pendingMediaStart?.id === captureId ? pendingMediaStart.promise : null
    if (mediaStart) await mediaStart

    if (recognition) {
      try {
        recognition.stop()
      } catch {
        recognition = null
        isListening.value = false
        settleCapture(captureId, transcript.value.trim())
      }
    }
    if (mediaRecorder && mediaCaptureId === captureId && mediaRecorder.state !== 'inactive') {
      try {
        mediaRecorder.stop()
      } catch {
        isListening.value = false
        settleCapture(captureId, '')
      }
    }

    const text = await completion.promise
    if (!text && !error.value && !discardedCaptureIds.has(captureId)) {
      error.value = 'No speech was recognized'
    }
    return text
  }

  function cancelListening() {
    const captureId = activeCaptureId
    if (!captureId) return
    discardedCaptureIds.add(captureId)
    transcript.value = ''
    error.value = null
    isListening.value = false
    isTranscribing.value = false
    settleCapture(captureId, '')

    if (recognition) {
      const activeRecognition = recognition
      recognition = null
      try {
        if (typeof activeRecognition.abort === 'function') activeRecognition.abort()
        else activeRecognition.stop()
      } catch {
        discardedCaptureIds.delete(captureId)
      }
    }
    if (mediaRecorder && mediaCaptureId === captureId && mediaRecorder.state !== 'inactive') {
      try {
        mediaRecorder.stop()
      } catch {
        activeStream?.getTracks().forEach((track) => track.stop())
        activeStream = null
        mediaRecorder = null
        mediaCaptureId = 0
        discardedCaptureIds.delete(captureId)
      }
    }
  }

  function stopListening() {
    void finishListening()
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
    stopActiveTTS() // 互斥：停掉任何进行中/正在播放的语音（含其它实例）
    error.value = null
    const ac = new AbortController()
    activeAbort = ac
    activeSpeakerId.value = myVoiceId

    try {
      const blob = await textToSpeech({ text, voice })
      if (ac.signal.aborted) return // 合成期间被停止/卸载 → 不再起播（防幽灵音频）

      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      activeAudio = audio
      activeAudioUrl = url

      audio.onended = () => { if (activeAbort === ac) stopActiveTTS() }
      audio.onerror = () => {
        error.value = 'Failed to play audio'
        if (activeAbort === ac) stopActiveTTS()
      }

      await audio.play()
      if (ac.signal.aborted) stopActiveTTS() // play() promise 期间被停止
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'TTS failed'
      if (activeAbort === ac) stopActiveTTS() // 失败也清理（含 revokeObjectURL，修 blob 泄漏）
      logger.error('[useVoice] TTS failed', e)
    }
  }

  function stopSpeaking() {
    // 只停本实例当前的语音（合成中 activeSpeakerId 已是本实例）
    if (activeSpeakerId.value === myVoiceId) stopActiveTTS()
  }

  // ─── Cleanup on unmount ──────────────────────────────

  function cleanup() {
    cancelListening()
    stopSpeaking()
  }

  if (getCurrentInstance()) {
    onUnmounted(cleanup)
  }

  return {
    isListening,
    isTranscribing,
    isSpeaking,
    transcript,
    error,
    isSupported,
    startListening,
    stopListening,
    finishListening,
    cancelListening,
    toggleListening,
    speak,
    stopSpeaking,
  }
}
