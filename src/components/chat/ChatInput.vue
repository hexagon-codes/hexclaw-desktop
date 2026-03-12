<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import { Send, StopCircle, Paperclip } from 'lucide-vue-next'

const props = defineProps<{
  streaming?: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  send: [text: string]
  stop: []
  file: [file: File]
}>()

const inputText = ref('')
const textareaRef = ref<HTMLTextAreaElement>()
const fileInputRef = ref<HTMLInputElement>()

const canSend = computed(() => inputText.value.trim() && !props.streaming && !props.disabled)

function handleSend() {
  const text = inputText.value.trim()
  if (!text || props.streaming) return
  emit('send', text)
  inputText.value = ''
  // 重置 textarea 高度
  nextTick(() => {
    if (textareaRef.value) {
      textareaRef.value.style.height = 'auto'
    }
  })
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
}

/** 自动调整 textarea 高度 */
function handleInput() {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 128) + 'px'
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

/** 聚焦输入框 */
function focus() {
  textareaRef.value?.focus()
}

/** 设置输入框内容并聚焦 */
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
  <div
    class="flex items-end gap-2 rounded-xl border px-3 py-2"
    :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)' }"
  >
    <button
      class="p-1.5 rounded-md transition-colors mb-0.5"
      :style="{ color: 'var(--hc-text-muted)' }"
      title="上传文件"
      @click="handleFileClick"
    >
      <Paperclip :size="16" />
    </button>
    <input
      ref="fileInputRef"
      type="file"
      class="hidden"
      accept=".pdf,.txt,.md,.doc,.docx,.csv,.json"
      @change="handleFileChange"
    />

    <textarea
      ref="textareaRef"
      v-model="inputText"
      rows="1"
      class="flex-1 resize-none bg-transparent outline-none text-sm leading-6 max-h-32"
      :style="{ color: 'var(--hc-text-primary)' }"
      placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
      :disabled="disabled"
      @keydown="handleKeydown"
      @input="handleInput"
    />

    <div class="flex items-center gap-1 mb-0.5">
      <button
        v-if="streaming"
        class="p-1.5 rounded-md transition-colors"
        :style="{ color: 'var(--hc-error)' }"
        title="停止生成"
        @click="emit('stop')"
      >
        <StopCircle :size="18" />
      </button>
      <button
        v-else
        class="p-1.5 rounded-md transition-colors"
        :class="canSend ? 'opacity-100' : 'opacity-30'"
        :style="{ color: 'var(--hc-accent)' }"
        :disabled="!canSend"
        title="发送 (Enter)"
        @click="handleSend"
      >
        <Send :size="18" />
      </button>
    </div>
  </div>
</template>
