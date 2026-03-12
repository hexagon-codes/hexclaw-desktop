<script setup lang="ts">
import { ref, nextTick, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Send, StopCircle, X } from 'lucide-vue-next'
import { sendChatStream } from '@/api/chat'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
}

const { t } = useI18n()
const messages = ref<Message[]>([])
const inputText = ref('')
const streaming = ref(false)
const streamingContent = ref('')
const messagesEnd = ref<HTMLDivElement>()

async function handleSend() {
  const text = inputText.value.trim()
  if (!text || streaming.value) return

  inputText.value = ''
  messages.value.push({
    id: Date.now().toString(),
    role: 'user',
    content: text,
  })

  streaming.value = true
  streamingContent.value = ''

  try {
    const stream = await sendChatStream({ message: text })
    const reader = stream.getReader()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      try {
        const parsed = JSON.parse(value)
        if (parsed.content) {
          streamingContent.value += parsed.content
        }
      } catch {
        streamingContent.value += value
      }
    }

    messages.value.push({
      id: Date.now().toString(),
      role: 'assistant',
      content: streamingContent.value,
    })
  } catch (e) {
    console.error('发送失败:', e)
    messages.value.push({
      id: Date.now().toString(),
      role: 'assistant',
      content: t('quickChat.connectionFailed'),
    })
  } finally {
    streaming.value = false
    streamingContent.value = ''
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
}

function scrollToBottom() {
  messagesEnd.value?.scrollIntoView({ behavior: 'smooth' })
}

watch(() => messages.value.length, () => nextTick(scrollToBottom))
watch(streamingContent, () => nextTick(scrollToBottom))
</script>

<template>
  <div class="h-full flex flex-col" :style="{ background: 'var(--hc-bg-main)' }">
    <!-- 标题栏 -->
    <div
      data-tauri-drag-region
      class="h-[38px] flex items-center justify-between px-4 flex-shrink-0"
      :style="{ background: 'var(--hc-bg-sidebar)' }"
    >
      <span class="text-xs font-medium pl-16" :style="{ color: 'var(--hc-text-secondary)' }">Quick Chat</span>
    </div>

    <!-- 消息区 -->
    <div class="flex-1 overflow-y-auto px-4 py-3 space-y-3">
      <div
        v-for="msg in messages"
        :key="msg.id"
        class="text-sm leading-relaxed"
      >
        <div v-if="msg.role === 'user'" class="text-right">
          <span
            class="inline-block rounded-xl px-3 py-2 text-white max-w-[85%] text-left"
            :style="{ background: 'var(--hc-accent)' }"
          >
            {{ msg.content }}
          </span>
        </div>
        <div v-else>
          <div
            class="inline-block rounded-xl px-3 py-2 max-w-[85%]"
            :style="{ background: 'var(--hc-bg-card)', color: 'var(--hc-text-primary)' }"
          >
            <MarkdownRenderer :content="msg.content" />
          </div>
        </div>
      </div>

      <div v-if="streaming && streamingContent" class="text-sm">
        <div
          class="inline-block rounded-xl px-3 py-2 max-w-[85%]"
          :style="{ background: 'var(--hc-bg-card)', color: 'var(--hc-text-primary)' }"
        >
          <MarkdownRenderer :content="streamingContent" />
        </div>
      </div>
      <div ref="messagesEnd" />
    </div>

    <!-- 输入框 -->
    <div class="p-3 border-t" :style="{ borderColor: 'var(--hc-border)' }">
      <div
        class="flex items-end gap-2 rounded-lg border px-3 py-1.5"
        :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)' }"
      >
        <textarea
          v-model="inputText"
          rows="1"
          class="flex-1 resize-none bg-transparent outline-none text-sm leading-6 max-h-20"
          :style="{ color: 'var(--hc-text-primary)' }"
          :placeholder="t('quickChat.inputPlaceholder')"
          @keydown="handleKeydown"
        />
        <button
          class="p-1 rounded transition-colors"
          :class="inputText.trim() && !streaming ? 'opacity-100' : 'opacity-30'"
          :style="{ color: 'var(--hc-accent)' }"
          :disabled="!inputText.trim() || streaming"
          @click="handleSend"
        >
          <Send :size="16" />
        </button>
      </div>
    </div>
  </div>
</template>
