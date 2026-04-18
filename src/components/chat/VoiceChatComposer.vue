<script setup lang="ts">
/**
 * 语音对话 composer — audio-to-audio 单轮往返。
 *
 * 流程：按住 🎤 录音 → 松开 → 上传 → 模型返回音频 + 文字 → 自动播放。
 * 也支持文字输入（用户没法说话时兜底）。
 */
import { ref, onBeforeUnmount } from 'vue'
import { Mic, Loader2, Send, MessageCircle } from 'lucide-vue-next'
import { voiceChat, audioToSrc, type VoiceChatResult } from '@/api/voicechat'
import { logger } from '@/utils/logger'

const props = defineProps<{
  modelId: string
  modelName: string
}>()

const emit = defineEmits<{
  exchanged: [result: VoiceChatResult, userPrompt: string]
  error: [message: string]
}>()

const recording = ref(false)
const sending = ref(false)
const text = ref('')
const lastError = ref('')
const voice = ref<'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer'>('alloy')

let mediaRecorder: MediaRecorder | null = null
let recordedChunks: Blob[] = []
let activeStream: MediaStream | null = null

async function startRecording() {
  if (recording.value || sending.value) return
  lastError.value = ''
  try {
    activeStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    recordedChunks = []
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
      const stream = activeStream
      activeStream = null
      stream?.getTracks().forEach(t => t.stop())
      const blob = new Blob(recordedChunks, { type: mediaRecorder?.mimeType || 'audio/webm' })
      recordedChunks = []
      mediaRecorder = null
      await sendAudio(blob)
    }
    // timeslice=1000ms 每秒切一次数据块（长录音不积压单块）
    mediaRecorder.start(1000)
    recording.value = true
  } catch (e) {
    lastError.value = e instanceof Error ? e.message : '麦克风访问失败'
    logger.error('[VoiceChatComposer] getUserMedia failed', e)
  }
}

function stopRecording() {
  if (!recording.value || !mediaRecorder) return
  recording.value = false
  try { mediaRecorder.stop() } catch { /* ignore */ }
}

async function sendAudio(blob: Blob) {
  sending.value = true
  try {
    const b64 = await blobToBase64(blob)
    // gpt-4o-audio 接受 wav/mp3，webm 需先转 — 但 b64 直传 OpenAI 实际能识别 opus，
    // 出问题再加客户端解码。
    const result = await voiceChat({
      model: props.modelId,
      audio: b64,
      format: 'wav', // 告诉模型期望输出 wav
      voice: voice.value,
    })
    const userPrompt = result.user_text || '[语音输入]'
    emit('exchanged', result, userPrompt)
    // 自动播放回应；autoplay policy 拒绝时提示用户手动点消息播放
    const src = audioToSrc(result)
    if (src) {
      const audio = new Audio(src)
      try {
        await audio.play()
      } catch (playErr) {
        lastError.value = '浏览器阻止自动播放，请点击消息气泡里的播放按钮'
        logger.warn('[VoiceChatComposer] autoplay blocked', playErr)
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : '语音对话失败'
    lastError.value = msg
    logger.error('[VoiceChatComposer] voiceChat failed', e)
    emit('error', msg)
  } finally {
    sending.value = false
  }
}

async function sendText() {
  const t = text.value.trim()
  if (!t || sending.value) return
  sending.value = true
  try {
    const result = await voiceChat({
      model: props.modelId,
      text: t,
      format: 'wav',
      voice: voice.value,
    })
    emit('exchanged', result, t)
    const src = audioToSrc(result)
    if (src) {
      const audio = new Audio(src)
      try {
        await audio.play()
      } catch (playErr) {
        lastError.value = '浏览器阻止自动播放，请点击消息气泡里的播放按钮'
        logger.warn('[VoiceChatComposer] autoplay blocked', playErr)
      }
    }
    text.value = ''
  } catch (e) {
    const msg = e instanceof Error ? e.message : '对话失败'
    lastError.value = msg
    emit('error', msg)
  } finally {
    sending.value = false
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const dataUrl = reader.result as string
      // dataUrl 形如 "data:audio/webm;base64,xxxx"，只取 b64 部分
      const idx = dataUrl.indexOf(',')
      resolve(idx >= 0 ? dataUrl.slice(idx + 1) : '')
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

onBeforeUnmount(() => {
  if (mediaRecorder?.state !== 'inactive') {
    try { mediaRecorder?.stop() } catch { /* ignore */ }
  }
  activeStream?.getTracks().forEach(t => t.stop())
})
</script>

<template>
  <div class="hc-voicechat">
    <div class="hc-voicechat__header">
      <MessageCircle :size="16" />
      <span class="hc-voicechat__title">语音对话</span>
    </div>

    <textarea
      v-model="text"
      class="hc-voicechat__text"
      placeholder="按住右下角 🎤 说话，或在此输入文字（模型会以语音回应）"
      :disabled="sending || recording"
      @keydown.meta.enter="sendText"
      @keydown.ctrl.enter="sendText"
    />

    <div class="hc-voicechat__bar">
      <label class="hc-voicechat__opt">
        <span>音色</span>
        <select v-model="voice" :disabled="sending || recording">
          <option value="alloy">Alloy（中性）</option>
          <option value="echo">Echo（男）</option>
          <option value="fable">Fable（英式）</option>
          <option value="onyx">Onyx（深沉）</option>
          <option value="nova">Nova（女）</option>
          <option value="shimmer">Shimmer（轻柔）</option>
        </select>
      </label>

      <button
        v-if="text.trim()"
        class="hc-voicechat__btn"
        :disabled="sending"
        @click="sendText"
      >
        <Loader2 v-if="sending" :size="13" class="hc-voicechat__spin" />
        <Send v-else :size="13" /> 发送文字
      </button>
      <button
        v-else
        class="hc-voicechat__mic"
        :class="{
          'hc-voicechat__mic--recording': recording,
          'hc-voicechat__mic--sending': sending,
        }"
        :disabled="sending"
        @mousedown="startRecording"
        @mouseup="stopRecording"
        @mouseleave="recording && stopRecording()"
        @touchstart.prevent="startRecording"
        @touchend.prevent="stopRecording"
        @touchcancel.prevent="stopRecording"
      >
        <Loader2 v-if="sending" :size="14" class="hc-voicechat__spin" />
        <Mic v-else :size="14" />
        {{ sending ? '处理中…' : recording ? '松开发送' : '按住说话' }}
      </button>
    </div>

    <p v-if="lastError" class="hc-voicechat__error">{{ lastError }}</p>
  </div>
</template>

<style scoped>
.hc-voicechat {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  border: 0.5px solid var(--hc-border);
  border-radius: 16px;
  background: var(--hc-bg-card);
}

.hc-voicechat__header {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--hc-text-secondary);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.hc-voicechat__title { color: var(--hc-text-primary); }

.hc-voicechat__text {
  width: 100%;
  min-height: 64px;
  resize: vertical;
  padding: 12px 14px;
  border: 0.5px solid var(--hc-border);
  border-radius: 10px;
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
  font-family: inherit;
  font-size: 14px;
  line-height: 1.6;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.hc-voicechat__text:focus {
  border-color: var(--hc-accent);
  box-shadow: 0 0 0 3px rgba(0, 122, 255, 0.12);
}

.hc-voicechat__bar {
  display: flex;
  align-items: center;
  gap: 14px;
}

.hc-voicechat__opt {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--hc-text-secondary);
}

.hc-voicechat__opt select {
  appearance: none;
  -webkit-appearance: none;
  padding: 7px 28px 7px 12px;
  border: 0.5px solid var(--hc-border);
  border-radius: 8px;
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
  font-size: 13px;
  outline: none;
  cursor: pointer;
  transition: border-color 0.15s ease;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6' fill='none'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%238b95a5' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 9px center;
}
.hc-voicechat__opt select:hover { border-color: var(--hc-text-muted); }
.hc-voicechat__opt select:focus { border-color: var(--hc-accent); }

.hc-voicechat__btn,
.hc-voicechat__mic {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-left: auto;
  padding: 8px 18px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  border: 0.5px solid var(--hc-accent);
  background: var(--hc-accent);
  color: var(--hc-text-inverse);
  transition: background 0.15s ease, transform 0.12s ease;
  user-select: none;
}
.hc-voicechat__btn:active:not(:disabled),
.hc-voicechat__mic:active:not(:disabled) { transform: scale(0.97); }

.hc-voicechat__btn:hover:not(:disabled),
.hc-voicechat__mic:hover:not(:disabled) { background: var(--hc-accent-hover); }
.hc-voicechat__btn:disabled,
.hc-voicechat__mic:disabled { opacity: 0.5; cursor: not-allowed; }

.hc-voicechat__mic--recording {
  background: var(--hc-error, #ff3b30);
  border-color: var(--hc-error, #ff3b30);
  animation: hc-vc-pulse 1.2s ease-in-out infinite;
}

@keyframes hc-vc-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255, 59, 48, 0.4); }
  50%      { box-shadow: 0 0 0 6px rgba(255, 59, 48, 0); }
}

.hc-voicechat__spin { animation: hc-vc-spin 0.8s linear infinite; }

@keyframes hc-vc-spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

.hc-voicechat__error {
  color: var(--hc-error);
  font-size: 11px;
  margin-top: 4px;
}
</style>
