<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowUp, Square, Paperclip, Mic } from 'lucide-vue-next'
import MentionPopup from './MentionPopup.vue'
import TemplatePopup from './TemplatePopup.vue'
import { useVoice } from '@/composables/useVoice'
import type { Skill } from '@/types'

const { t } = useI18n()
const { isListening, transcript, isSupported: voiceSupported, toggleListening } = useVoice()

// 语音识别结果 -> 输入框
watch(transcript, (text) => {
  if (text) {
    inputText.value = text
    nextTick(() => handleInput())
  }
})

const props = defineProps<{
  streaming?: boolean
  disabled?: boolean
  agents?: { name: string; title?: string; goal?: string }[]
  skills?: Skill[]
  allowImage?: boolean
  allowVideo?: boolean
  recipientName?: string
}>()

const emit = defineEmits<{
  send: [text: string, files: File[]]
  stop: []
  createTemplate: []
}>()

const inputText = ref('')
const textareaRef = ref<HTMLTextAreaElement>()
const fileInputRef = ref<HTMLInputElement>()
const mentionRef = ref<InstanceType<typeof MentionPopup>>()
const templateRef = ref<InstanceType<typeof TemplatePopup>>()

const attachedFiles = ref<{ file: File; previewUrl?: string }[]>([])

const showMention = ref(false)
const mentionQuery = ref('')
const mentionPosition = ref({ bottom: 0, left: 0 })
const showTemplate = ref(false)
const templateQuery = ref('')
const templatePosition = ref({ bottom: 0, left: 0 })

const canSend = computed(() =>
  (inputText.value.trim() || attachedFiles.value.length > 0) && !props.streaming && !props.disabled,
)

const placeholder = computed(() => {
  if (props.recipientName) return t('chat.sendTo', { name: props.recipientName })
  return t('chat.inputPlaceholder')
})

const fileAccept = computed(() => {
  const types = [
    '.pdf', '.txt', '.md', '.doc', '.docx', '.xlsx', '.xls', '.csv', '.json',
    '.png', '.jpg', '.jpeg', '.gif', '.webp',
  ]
  if (props.allowVideo) types.push('.mp4', '.mov', '.avi', '.mkv', '.webm')
  return types.join(',')
})

const MAX_HEIGHT = 160

function handleSend() {
  const text = inputText.value.trim()
  const files = attachedFiles.value.map((a) => a.file)
  if (!text && files.length === 0) return
  if (props.streaming) return
  closePopups()
  emit('send', text, files)
  inputText.value = ''
  attachedFiles.value.forEach((a) => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl) })
  attachedFiles.value = []
  nextTick(() => { if (textareaRef.value) textareaRef.value.style.height = 'auto' })
}

function handleKeydown(e: KeyboardEvent) {
  if (showTemplate.value && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
    templateRef.value?.handleKeydown(e); return
  }
  if (showMention.value && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
    mentionRef.value?.handleKeydown(e); return
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey) { e.preventDefault(); handleSend() }
}

function handleInput() {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, MAX_HEIGHT) + 'px'
  detectPopups()
}

function closePopups() { showMention.value = false; showTemplate.value = false }

function detectPopups() {
  const el = textareaRef.value
  if (!el) return
  const text = el.value
  const cursorPos = el.selectionStart
  const beforeCursor = text.slice(0, cursorPos)

  const slashMatch = beforeCursor.match(/(?:^|\n)\/([^\n/]{0,20})$/)
  if (slashMatch) {
    templateQuery.value = slashMatch[1] ?? ''
    showTemplate.value = true; showMention.value = false
    const rect = el.getBoundingClientRect()
    templatePosition.value = { bottom: window.innerHeight - rect.top + 8, left: Math.min(rect.left + 14, window.innerWidth - 356) }
    return
  }
  showTemplate.value = false

  const atIdx = beforeCursor.lastIndexOf('@')
  if (atIdx >= 0 && (atIdx === 0 || beforeCursor[atIdx - 1] === ' ' || beforeCursor[atIdx - 1] === '\n')) {
    const query = beforeCursor.slice(atIdx + 1)
    if (!query.includes(' ') && !query.includes('\n') && query.length < 20) {
      mentionQuery.value = query; showMention.value = true
      const rect = el.getBoundingClientRect()
      let bottom = window.innerHeight - rect.top + 8
      let left = rect.left + 40
      if (left + 320 > window.innerWidth) left = window.innerWidth - 328
      if (left < 8) left = 8
      mentionPosition.value = { bottom, left }; return
    }
  }
  showMention.value = false
}

function handleTemplateSelect(content: string) {
  const el = textareaRef.value
  if (!el) return
  const cursorPos = el.selectionStart
  const text = el.value
  const beforeCursor = text.slice(0, cursorPos)
  const slashIdx = beforeCursor.lastIndexOf('/')
  inputText.value = slashIdx >= 0 ? text.slice(0, slashIdx) + content + text.slice(cursorPos) : content
  showTemplate.value = false
  nextTick(() => { handleInput(); focus() })
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
    nextTick(() => { el.setSelectionRange(atIdx + item.name.length + 2, atIdx + item.name.length + 2); el.focus() })
  }
  showMention.value = false
}

function handleFileClick() { fileInputRef.value?.click() }
function handleFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files) return
  addFiles(Array.from(input.files))
  input.value = ''
}

function addFiles(files: File[]) {
  for (const file of files) {
    const isImage = file.type.startsWith('image/')
    attachedFiles.value.push({ file, previewUrl: isImage ? URL.createObjectURL(file) : undefined })
  }
}

function removeFile(index: number) {
  const item = attachedFiles.value[index]
  if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl)
  attachedFiles.value.splice(index, 1)
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + 'B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB'
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB'
}

function focus() { textareaRef.value?.focus() }
function setInput(text: string) { inputText.value = text; nextTick(() => { handleInput(); focus() }) }
function triggerFileUpload() { handleFileClick() }

defineExpose({ focus, setInput, triggerFileUpload })
</script>

<template>
  <div class="hc-composer">
    <div class="hc-composer__box">
      <!-- 附件预览 -->
      <div v-if="attachedFiles.length > 0" class="hc-composer__files">
        <div v-for="(item, idx) in attachedFiles" :key="idx" class="hc-composer__file">
          <img v-if="item.previewUrl" :src="item.previewUrl" class="hc-composer__file-img" />
          <div v-else class="hc-composer__file-card">
            <Paperclip :size="16" class="hc-composer__file-icon" />
            <div class="hc-composer__file-info">
              <span class="hc-composer__file-name">{{ item.file.name }}</span>
              <span class="hc-composer__file-size">{{ formatFileSize(item.file.size) }}</span>
            </div>
          </div>
          <button class="hc-composer__file-remove" @click="removeFile(idx)">×</button>
        </div>
      </div>

      <textarea
        ref="textareaRef"
        v-model="inputText"
        rows="1"
        class="hc-composer__field"
        :placeholder="placeholder"
        :disabled="disabled"
        @keydown="handleKeydown"
        @input="handleInput"
      />

      <div class="hc-composer__bar">
        <div class="hc-composer__tools">
          <button class="hc-composer__tool" :title="t('chat.addFile', '添加文件')" @click="handleFileClick">
            <Paperclip :size="18" />
          </button>
          <button
            v-if="voiceSupported"
            class="hc-composer__tool"
            :class="{ 'hc-composer__tool--recording': isListening }"
            :title="isListening ? t('chat.voiceStop') : t('chat.voiceStart')"
            @click="toggleListening"
          >
            <Mic :size="18" />
          </button>
          <slot name="tools" />
        </div>
        <div class="hc-composer__actions">
          <button
            v-if="streaming"
            class="hc-composer__send hc-composer__send--stop"
            :title="t('chat.stopGenerate')"
            @click="emit('stop')"
          >
            <Square :size="14" />
          </button>
          <button
            v-else
            class="hc-composer__send"
            :class="{ 'hc-composer__send--active': canSend }"
            :disabled="!canSend"
            :title="t('chat.sendTitle')"
            @click="handleSend"
          >
            <ArrowUp :size="16" stroke-width="2.5" />
          </button>
        </div>
      </div>
    </div>

    <input ref="fileInputRef" type="file" multiple class="hidden" :accept="fileAccept" @change="handleFileChange" />
    <MentionPopup ref="mentionRef" :visible="showMention" :query="mentionQuery" :agents="agents || []" :skills="skills || []" :position="mentionPosition" @select="handleMentionSelect" @close="showMention = false" />
    <TemplatePopup ref="templateRef" :visible="showTemplate" :query="templateQuery" :position="templatePosition" @select="handleTemplateSelect" @close="showTemplate = false" @create="emit('createTemplate')" />
  </div>
</template>

<style scoped>
/* ─── Apple HIG 规范变量 ───── */
.hc-composer__box {
  display: flex;
  flex-direction: column;
  background: var(--hc-bg-input);
  border: 0.5px solid rgba(0, 0, 0, 0.1);
  border-radius: 16px;
  padding: 20px 20px 12px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04);
  transition: border-color 0.3s cubic-bezier(0.16, 1, 0.3, 1),
              box-shadow 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

.hc-composer__box:focus-within {
  border-color: var(--hc-accent, #007AFF);
  box-shadow: 0 0 0 3px rgba(0, 122, 255, 0.12),
              0 1px 3px rgba(0, 0, 0, 0.06);
}

/* Textarea */
.hc-composer__field {
  width: 100%;
  resize: none;
  background: transparent;
  border: none;
  outline: none;
  font-size: 16px;
  line-height: 1.6;
  max-height: 160px;
  min-height: 24px;
  color: var(--hc-text-primary, #1D1D1F);
  padding: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
  overflow-y: auto;
  letter-spacing: -0.01em;
}

.hc-composer__field::placeholder {
  color: var(--hc-text-secondary, #6E6E73);
  font-weight: 400;
}

.hc-composer__field::-webkit-scrollbar { width: 3px; }
.hc-composer__field::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.15);
  border-radius: 2px;
}

/* ─── 附件预览 ───── */
.hc-composer__files {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding-bottom: 12px;
  margin-bottom: 8px;
  border-bottom: 0.5px solid rgba(0, 0, 0, 0.08);
}

.hc-composer__file {
  position: relative;
  animation: fadeScaleIn 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
}

.hc-composer__file-img {
  width: 72px;
  height: 72px;
  object-fit: cover;
  border-radius: 10px;
  border: 0.5px solid rgba(0, 0, 0, 0.08);
}

.hc-composer__file-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--hc-bg-card, #F5F5F7);
  border: 0.5px solid rgba(0, 0, 0, 0.06);
  max-width: 200px;
}

.hc-composer__file-icon { color: var(--hc-text-secondary, #6E6E73); flex-shrink: 0; }
.hc-composer__file-info { display: flex; flex-direction: column; min-width: 0; }
.hc-composer__file-name { font-size: 13px; font-weight: 500; color: var(--hc-text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hc-composer__file-size { font-size: 12px; color: var(--hc-text-secondary, #6E6E73); }

.hc-composer__file-remove {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: none;
  background: rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(20px) saturate(180%);
  color: var(--hc-text-secondary);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  transition: color 0.15s;
}

.hc-composer__file-remove:hover { color: var(--hc-error, #FF3B30); }

/* ─── 底部栏 ───── */
.hc-composer__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 10px;
  gap: 8px;
}

.hc-composer__tools {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.hc-composer__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

/* 工具按钮 28x28 (macOS toolbar icon) */
.hc-composer__tool {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--hc-text-secondary, #6E6E73);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.15s, color 0.15s;
}

.hc-composer__tool:hover {
  color: var(--hc-text-primary, #1D1D1F);
  background: rgba(0, 0, 0, 0.05);
}

/* 语音录音中 — 红色脉动 */
.hc-composer__tool--recording {
  color: var(--hc-error, #FF3B30);
  animation: voicePulse 1.2s ease-in-out infinite;
}

@keyframes voicePulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* 发送按钮 */
.hc-composer__send {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: var(--hc-bg-active, #EBEBED);
  color: var(--hc-text-secondary, #6E6E73);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background-color 0.3s cubic-bezier(0.16, 1, 0.3, 1),
              color 0.3s cubic-bezier(0.16, 1, 0.3, 1),
              transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.hc-composer__send:disabled { cursor: default; opacity: 0.3; }

.hc-composer__send--active {
  background: var(--hc-accent, #007AFF);
  color: var(--hc-text-inverse);
  box-shadow: 0 2px 8px rgba(0, 122, 255, 0.25);
}

.hc-composer__send--active:hover {
  transform: scale(1.06);
}

.hc-composer__send--active:active {
  transform: scale(0.94);
}

.hc-composer__send--stop {
  background: var(--hc-error, #FF3B30);
  color: var(--hc-text-inverse);
}

/* ─── 入场动效 (Apple 弹簧曲线) ───── */
@keyframes fadeScaleIn {
  from {
    opacity: 0;
    transform: scale(0.96) translateY(8px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}
</style>
