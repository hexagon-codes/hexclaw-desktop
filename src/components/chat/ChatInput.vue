<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import { ArrowUp, Square, Paperclip, Zap, PenLine, Wand2, Mic, MicOff } from 'lucide-vue-next'
import { speechToText, getVoiceStatus } from '@/api/voice'
import MentionPopup from './MentionPopup.vue'
import type { ExecMode } from '@/types'

const props = defineProps<{
  streaming?: boolean
  disabled?: boolean
  execMode?: ExecMode
  agents?: { name: string; title?: string; goal?: string }[]
  skills?: { id: string; name: string; display_name?: string; description?: string; enabled?: boolean }[]
  /** 是否允许上传图片 */
  allowImage?: boolean
  /** 是否允许上传视频 */
  allowVideo?: boolean
}>()

const emit = defineEmits<{
  send: [text: string]
  stop: []
  file: [file: File]
  'update:execMode': [mode: ExecMode]
}>()

const inputText = ref('')
const textareaRef = ref<HTMLTextAreaElement>()
const fileInputRef = ref<HTMLInputElement>()
const mentionRef = ref<InstanceType<typeof MentionPopup>>()

// @ 提及状态
const showMention = ref(false)
const mentionQuery = ref('')
const mentionPosition = ref({ bottom: 0, left: 0 })

const canSend = computed(() => inputText.value.trim() && !props.streaming && !props.disabled)

/** 根据模型能力动态生成文件接受类型 */
const fileAccept = computed(() => {
  const types = ['.pdf', '.txt', '.md', '.doc', '.docx', '.xlsx', '.xls', '.csv', '.json']
  if (props.allowImage !== false) {
    types.push('.png', '.jpg', '.jpeg', '.gif', '.webp')
  }
  if (props.allowVideo) {
    types.push('.mp4', '.mov', '.avi', '.mkv', '.webm')
  }
  return types.join(',')
})

const showUploadBtn = computed(() => props.allowImage !== false || props.allowVideo)

const enabledSkills = computed(() =>
  (props.skills || []).filter((s) => s.enabled !== false).slice(0, 4),
)

function handleSend() {
  const text = inputText.value.trim()
  if (!text || props.streaming) return
  showMention.value = false
  emit('send', text)
  inputText.value = ''
  nextTick(() => {
    if (textareaRef.value) {
      textareaRef.value.style.height = 'auto'
    }
  })
}

function handleKeydown(e: KeyboardEvent) {
  // 先让 mention popup 处理
  if (showMention.value) {
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
      mentionRef.value?.handleKeydown(e)
      return
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
}

function handleInput() {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 128) + 'px'

  // 检测 @ 提及
  detectMention()
}

function detectMention() {
  const el = textareaRef.value
  if (!el) return

  const text = el.value
  const cursorPos = el.selectionStart
  const beforeCursor = text.slice(0, cursorPos)

  // 查找最近的 @ 符号
  const atIdx = beforeCursor.lastIndexOf('@')
  if (atIdx >= 0 && (atIdx === 0 || beforeCursor[atIdx - 1] === ' ' || beforeCursor[atIdx - 1] === '\n')) {
    const query = beforeCursor.slice(atIdx + 1)
    if (!query.includes(' ') && !query.includes('\n') && query.length < 20) {
      mentionQuery.value = query
      showMention.value = true

      // 计算弹出位置，确保不溢出视口
      const rect = el.getBoundingClientRect()
      const popupMaxHeight = 240
      const popupWidth = 320
      let bottom = window.innerHeight - rect.top + 8
      let left = rect.left + 40

      // 防止顶部溢出（popup 从底部向上展开）
      if (bottom + popupMaxHeight > window.innerHeight) {
        bottom = window.innerHeight - rect.bottom - 8
      }
      // 防止右侧溢出
      if (left + popupWidth > window.innerWidth) {
        left = window.innerWidth - popupWidth - 8
      }
      // 防止左侧溢出
      if (left < 8) left = 8

      mentionPosition.value = { bottom, left }
      return
    }
  }

  showMention.value = false
}

function handleMentionSelect(item: { type: string; id: string; name: string }) {
  const el = textareaRef.value
  if (!el) return

  const cursorPos = el.selectionStart
  const text = el.value
  const beforeCursor = text.slice(0, cursorPos)
  const atIdx = beforeCursor.lastIndexOf('@')

  if (atIdx >= 0) {
    inputText.value = text.slice(0, atIdx) + `@${item.name} ` + text.slice(cursorPos)
    nextTick(() => {
      const newPos = atIdx + item.name.length + 2
      el.setSelectionRange(newPos, newPos)
      el.focus()
    })
  }

  showMention.value = false
}

function handleFileClick() {
  fileInputRef.value?.click()
}

function handleFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) {
    emit('file', file)
    input.value = ''
  }
}

function insertSkill(skillName: string) {
  const prefix = `/${skillName} `
  if (!inputText.value.startsWith('/')) {
    inputText.value = prefix + inputText.value
  }
  nextTick(() => {
    handleInput()
    focus()
  })
}

// ─── 语音输入 ───────────────────────────────────────
const recording = ref(false)
const voiceAvailable = ref(false)
let mediaRecorder: MediaRecorder | null = null
let audioChunks: Blob[] = []

// 检查语音服务可用性
;(async () => {
  try {
    const status = await getVoiceStatus()
    voiceAvailable.value = status.stt_enabled
  } catch {
    voiceAvailable.value = false
  }
})()

async function toggleVoice() {
  if (recording.value) {
    stopRecording()
    return
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    mediaRecorder = new MediaRecorder(stream)
    audioChunks = []
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data)
    }
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop())
      if (audioChunks.length === 0) return
      const blob = new Blob(audioChunks, { type: 'audio/webm' })
      const file = new File([blob], 'voice.webm', { type: 'audio/webm' })
      try {
        const res = await speechToText(file)
        if (res.text) {
          inputText.value += res.text
          nextTick(() => handleInput())
        }
      } catch {
        // STT 服务不可用时静默失败
      }
    }
    mediaRecorder.start()
    recording.value = true
  } catch {
    // 麦克风权限被拒绝
    voiceAvailable.value = false
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop()
  }
  recording.value = false
}

function focus() {
  textareaRef.value?.focus()
}

function setInput(text: string) {
  inputText.value = text
  nextTick(() => {
    handleInput()
    focus()
  })
}

defineExpose({ focus, setInput })
</script>

<template>
  <div class="hc-chat-input-wrap">
    <!-- Main input area -->
    <div class="hc-chat-input">
      <button
        v-if="showUploadBtn"
        class="hc-chat-input__attach"
        :title="allowVideo ? '上传图片/视频/文件' : allowImage !== false ? '上传图片/文件' : '上传文件'"
        @click="handleFileClick"
      >
        <Paperclip :size="16" />
      </button>
      <input
        ref="fileInputRef"
        type="file"
        class="hidden"
        :accept="fileAccept"
        @change="handleFileChange"
      />

      <textarea
        ref="textareaRef"
        v-model="inputText"
        rows="1"
        class="hc-chat-input__textarea"
        placeholder="输入消息...（@ 提及 Agent/Skill）"
        :disabled="disabled"
        @keydown="handleKeydown"
        @input="handleInput"
      />

      <button
        v-if="voiceAvailable"
        class="hc-chat-input__voice"
        :class="{ 'hc-chat-input__voice--active': recording }"
        :title="recording ? '停止录音' : '语音输入'"
        @click="toggleVoice"
      >
        <MicOff v-if="recording" :size="15" />
        <Mic v-else :size="15" />
      </button>

      <button
        v-if="streaming"
        class="hc-chat-input__send hc-chat-input__send--stop"
        title="停止生成"
        @click="emit('stop')"
      >
        <Square :size="12" />
      </button>
      <button
        v-else
        class="hc-chat-input__send"
        :class="{ 'hc-chat-input__send--active': canSend }"
        :disabled="!canSend"
        title="发送 (Enter)"
        @click="handleSend"
      >
        <ArrowUp :size="15" stroke-width="2.5" />
      </button>
    </div>

    <!-- Bottom toolbar: Craft/Auto + Skills -->
    <div class="hc-chat-input__toolbar">
      <div class="hc-chat-input__mode-group">
        <!-- Craft/Auto toggle -->
        <button
          class="hc-chat-input__mode-btn"
          :class="{ 'hc-chat-input__mode-btn--active': execMode === 'craft' }"
          @click="emit('update:execMode', 'craft')"
        >
          <PenLine :size="12" />
          精编
        </button>
        <button
          class="hc-chat-input__mode-btn"
          :class="{ 'hc-chat-input__mode-btn--active': execMode === 'auto' }"
          @click="emit('update:execMode', 'auto')"
        >
          <Wand2 :size="12" />
          自动
        </button>
      </div>

      <!-- Skills quick access -->
      <div v-if="enabledSkills.length > 0" class="hc-chat-input__skills">
        <button
          v-for="skill in enabledSkills"
          :key="skill.id"
          class="hc-chat-input__skill-btn"
          :title="skill.display_name || skill.name"
          @click="insertSkill(skill.name)"
        >
          <Zap :size="11" />
          {{ skill.display_name || skill.name }}
        </button>
      </div>
    </div>

    <!-- @ Mention Popup -->
    <MentionPopup
      ref="mentionRef"
      :visible="showMention"
      :query="mentionQuery"
      :agents="agents || []"
      :skills="skills || []"
      :position="mentionPosition"
      @select="handleMentionSelect"
      @close="showMention = false"
    />
  </div>
</template>

<style scoped>
.hc-chat-input-wrap {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.hc-chat-input {
  display: flex;
  align-items: flex-end;
  gap: var(--hc-space-2);
  border-radius: var(--hc-radius-lg) var(--hc-radius-lg) 0 0;
  border: 1px solid var(--hc-border);
  border-bottom: none;
  background: var(--hc-bg-input);
  padding: var(--hc-space-2) var(--hc-space-2) var(--hc-space-2) var(--hc-space-1);
  transition: border-color 0.2s, box-shadow 0.2s;
}

.hc-chat-input-wrap:focus-within .hc-chat-input {
  border-color: var(--hc-accent);
  box-shadow: 0 0 0 3px var(--hc-accent-subtle);
}

.hc-chat-input-wrap:focus-within .hc-chat-input__toolbar {
  border-color: var(--hc-accent);
  box-shadow: 0 0 0 3px var(--hc-accent-subtle);
}

.hc-chat-input__attach {
  padding: var(--hc-space-2);
  border-radius: var(--hc-radius-sm);
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  display: flex;
  transition: color 0.15s;
  margin-bottom: 1px;
}

.hc-chat-input__attach:hover {
  color: var(--hc-text-secondary);
}

.hc-chat-input__textarea {
  flex: 1;
  resize: none;
  background: transparent;
  border: none;
  outline: none;
  font-size: 14px;
  line-height: 1.5;
  max-height: 128px;
  color: var(--hc-text-primary);
  padding: var(--hc-space-1) 0;
  font-family: inherit;
}

.hc-chat-input__textarea::placeholder {
  color: var(--hc-text-muted);
}

.hc-chat-input__send {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: none;
  background: var(--hc-bg-active);
  color: var(--hc-text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-bottom: 1px;
  transition: all 0.2s;
}

.hc-chat-input__send--active {
  background: var(--hc-accent);
  color: #fff;
}

.hc-chat-input__send--active:hover {
  background: var(--hc-accent-hover);
}

.hc-chat-input__send--stop {
  background: var(--hc-error);
  color: #fff;
}

.hc-chat-input__send:disabled {
  cursor: default;
}

.hc-chat-input__voice {
  padding: var(--hc-space-2);
  border-radius: var(--hc-radius-sm);
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  display: flex;
  transition: color 0.15s;
  margin-bottom: 1px;
}

.hc-chat-input__voice:hover {
  color: var(--hc-text-secondary);
}

.hc-chat-input__voice--active {
  color: var(--hc-error);
  animation: hc-pulse 1.5s infinite;
}

@keyframes hc-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* ─── Bottom Toolbar ───── */
.hc-chat-input__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  border-radius: 0 0 var(--hc-radius-lg) var(--hc-radius-lg);
  border: 1px solid var(--hc-border);
  border-top: 1px solid var(--hc-divider);
  background: var(--hc-bg-input);
  transition: border-color 0.2s, box-shadow 0.2s;
}

.hc-chat-input__mode-group {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--hc-radius-sm);
  background: var(--hc-bg-hover);
}

.hc-chat-input__mode-btn {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 3px 8px;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  border-radius: var(--hc-radius-sm);
  transition: all 0.15s;
}

.hc-chat-input__mode-btn:hover {
  color: var(--hc-text-secondary);
}

.hc-chat-input__mode-btn--active {
  background: var(--hc-bg-card);
  color: var(--hc-text-primary);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}

.hc-chat-input__skills {
  display: flex;
  gap: 4px;
}

.hc-chat-input__skill-btn {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 3px 7px;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  font-size: 11px;
  cursor: pointer;
  border-radius: var(--hc-radius-sm);
  transition: all 0.15s;
}

.hc-chat-input__skill-btn:hover {
  background: var(--hc-bg-active);
  color: #af52de;
}
</style>
