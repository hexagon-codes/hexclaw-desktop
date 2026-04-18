<script setup lang="ts">
/**
 * 视频生成 composer — 异步两步：submit → poll → 完成。
 * 进度展示：状态文案 + 已耗时（轮询无 progress 字段时按秒计）。
 */
import { ref, computed, onBeforeUnmount } from 'vue'
import { Sparkles, Loader2, Video, X } from 'lucide-vue-next'
import { submitVideoGeneration, pollUntilDone, videoToSrc, type VideoTaskStatus } from '@/api/videogen'
import { logger } from '@/utils/logger'

const props = defineProps<{
  modelId: string
  modelName: string
  providerKey?: string
}>()

const emit = defineEmits<{
  generated: [status: VideoTaskStatus, prompt: string]
  error: [message: string]
}>()

const prompt = ref('')
const size = ref('1280x720')
const withAudio = ref(true)
const duration = ref(5)
const generating = ref(false)
const taskStatus = ref('')      // 当前后端状态（queueing / running ...）
const elapsedSec = ref(0)
const lastError = ref('')

let abortController: AbortController | null = null
let elapsedTimer: ReturnType<typeof setInterval> | null = null

const sizeOptions = computed(() => {
  if (props.modelId.startsWith('cogvideox')) return ['1280x720', '720x1280', '1024x1024']
  return ['1280x720', '1920x1080', '720x1280']
})

const statusLabel = computed(() => {
  switch (taskStatus.value) {
    case 'queueing': return '排队中…'
    case 'running': return '生成中…'
    case 'processing': return '生成中…'
    case 'success': return '生成完成'
    case 'failed': return '生成失败'
    default: return generating.value ? '提交中…' : ''
  }
})

function startElapsedTimer() {
  elapsedSec.value = 0
  if (elapsedTimer) clearInterval(elapsedTimer)
  elapsedTimer = setInterval(() => { elapsedSec.value += 1 }, 1000)
}

function stopElapsedTimer() {
  if (elapsedTimer) {
    clearInterval(elapsedTimer)
    elapsedTimer = null
  }
}

async function handleGenerate() {
  const text = prompt.value.trim()
  if (!text || generating.value) return
  generating.value = true
  taskStatus.value = ''
  lastError.value = ''
  startElapsedTimer()
  abortController = new AbortController()

  try {
    const { task_id } = await submitVideoGeneration({
      model: props.modelId,
      prompt: text,
      size: size.value,
      with_audio: withAudio.value,
      duration: duration.value,
    })
    taskStatus.value = 'queueing'

    const final = await pollUntilDone(task_id, {
      signal: abortController.signal,
      onTick: (st) => { taskStatus.value = st.status },
    })

    // 成功判定走 videoToSrc 兜底：file_path（持久化）或 video_url（临时）任一可用即视为成功
    if (final.status === 'success' && videoToSrc(final)) {
      emit('generated', final, text)
      prompt.value = ''
    } else {
      const msg = final.error || '生成失败'
      lastError.value = msg
      emit('error', msg)
    }
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') {
      lastError.value = '已取消'
    } else {
      const msg = e instanceof Error ? e.message : '生成失败'
      lastError.value = msg
      logger.error('[VideoGenComposer] generate failed', e)
      emit('error', msg)
    }
  } finally {
    generating.value = false
    taskStatus.value = ''
    stopElapsedTimer()
    abortController = null
  }
}

function handleCancel() {
  abortController?.abort()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    handleGenerate()
  }
}

onBeforeUnmount(() => {
  abortController?.abort()
  stopElapsedTimer()
})
</script>

<template>
  <div class="hc-videogen">
    <div class="hc-videogen__header">
      <Video :size="16" />
      <span class="hc-videogen__title">视频生成</span>
    </div>

    <textarea
      v-model="prompt"
      class="hc-videogen__prompt"
      placeholder="描述视频内容，例如「一只橘猫在月球表面跳跃，回头看相机，写实电影感」"
      :disabled="generating"
      @keydown="onKeydown"
    />

    <div class="hc-videogen__options">
      <label class="hc-videogen__opt">
        <span>分辨率</span>
        <select v-model="size" :disabled="generating">
          <option v-for="s in sizeOptions" :key="s" :value="s">{{ s }}</option>
        </select>
      </label>

      <label class="hc-videogen__opt">
        <span>时长</span>
        <select v-model.number="duration" :disabled="generating">
          <option :value="5">5 秒</option>
          <option :value="10">10 秒</option>
        </select>
      </label>

      <label class="hc-videogen__opt hc-videogen__opt--check">
        <input v-model="withAudio" type="checkbox" :disabled="generating" />
        <span>含音轨</span>
      </label>

      <button
        v-if="generating"
        class="hc-videogen__btn hc-videogen__btn--cancel"
        title="取消仅停止前端轮询，已提交任务仍会按生成计费"
        @click="handleCancel"
      >
        <X :size="13" /> 取消
      </button>
      <button
        v-else
        class="hc-videogen__btn"
        :disabled="!prompt.trim()"
        @click="handleGenerate"
      >
        <Sparkles :size="13" />
        生成视频
        <span class="hc-videogen__hint">⌘↩</span>
      </button>
    </div>

    <div v-if="generating || statusLabel" class="hc-videogen__progress">
      <Loader2 v-if="generating" :size="13" class="hc-videogen__spin" />
      <span class="hc-videogen__status">{{ statusLabel }}</span>
      <span v-if="elapsedSec > 0 && generating" class="hc-videogen__elapsed">{{ elapsedSec }}s · 视频生成通常需要 30s-2min</span>
    </div>

    <p v-if="lastError" class="hc-videogen__error">{{ lastError }}</p>
  </div>
</template>

<style scoped>
.hc-videogen {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  border: 0.5px solid var(--hc-border);
  border-radius: 16px;
  background: var(--hc-bg-card);
}

.hc-videogen__header {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--hc-text-secondary);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.hc-videogen__title { color: var(--hc-text-primary); }

.hc-videogen__prompt {
  width: 100%;
  min-height: 72px;
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

.hc-videogen__prompt:focus {
  border-color: var(--hc-accent);
  box-shadow: 0 0 0 3px rgba(0, 122, 255, 0.12);
}

.hc-videogen__options {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
}

.hc-videogen__opt {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--hc-text-secondary);
}

.hc-videogen__opt--check input { margin: 0; }

.hc-videogen__opt select {
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
.hc-videogen__opt select:hover { border-color: var(--hc-text-muted); }
.hc-videogen__opt select:focus { border-color: var(--hc-accent); }

.hc-videogen__btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-left: auto;
  padding: 8px 18px;
  border-radius: 10px;
  background: var(--hc-accent);
  color: var(--hc-text-inverse);
  border: 0.5px solid var(--hc-accent);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease, transform 0.12s ease;
}
.hc-videogen__btn:active:not(:disabled) { transform: scale(0.97); }

.hc-videogen__btn:hover:not(:disabled) { background: var(--hc-accent-hover); }
.hc-videogen__btn:disabled { opacity: 0.5; cursor: not-allowed; }

.hc-videogen__btn--cancel {
  background: transparent;
  color: var(--hc-text-secondary);
  border-color: var(--hc-border);
}

.hc-videogen__btn--cancel:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-error);
}

.hc-videogen__hint {
  margin-left: 4px;
  opacity: 0.7;
  font-family: 'SF Mono', ui-monospace, monospace;
  font-size: 10px;
}

.hc-videogen__spin { animation: hc-videogen-spin 0.8s linear infinite; }

@keyframes hc-videogen-spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

.hc-videogen__progress {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--hc-text-secondary);
  padding: 6px 8px;
  background: var(--hc-bg-hover);
  border-radius: var(--hc-radius-sm);
}

.hc-videogen__elapsed {
  color: var(--hc-text-muted);
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}

.hc-videogen__error {
  color: var(--hc-error);
  font-size: 11px;
  margin-top: 4px;
}
</style>
