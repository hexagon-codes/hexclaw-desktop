/**
 * useVoice — 语音输入/输出 composable
 *
 * STT: 优先使用浏览器 Web Speech API，可回退到后端 /api/v1/voice/transcribe
 * TTS: 调用后端 /api/v1/voice/synthesize
 */

import { ref, computed, onUnmounted, getCurrentInstance } from 'vue'
import { textToSpeech } from '@/api/voice'
import { logger } from '@/utils/logger'

export function useVoice() {
  const isListening = ref(false)
  const isSpeaking = ref(false)
  const transcript = ref('')
  const error = ref<string | null>(null)

  const isSupported = computed(
    () => typeof window !== 'undefined'
      && ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window),
  )

  let recognition: SpeechRecognition | null = null
  let audioElement: HTMLAudioElement | null = null
  let audioUrl: string | null = null

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

    if (!isSupported.value) {
      error.value = 'Speech recognition is not supported in this browser'
      logger.warn('[useVoice] SpeechRecognition not supported')
      return
    }

    recognition = createRecognition()
    if (!recognition) {
      error.value = 'Failed to create speech recognition instance'
      return
    }

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = ''
      let final = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) {
          final += result[0].transcript
        } else {
          interim += result[0].transcript
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

  function stopListening() {
    if (recognition) {
      try { recognition.stop() } catch { /* already stopped */ }
      recognition = null
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
