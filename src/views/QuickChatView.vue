<script setup lang="ts">
import { ref, nextTick, watch, onMounted, onUnmounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Send, StopCircle, Trash2, RotateCcw, ChevronDown } from 'lucide-vue-next'
import { sendChat } from '@/api/chat'
import { hexclawWS } from '@/api/websocket'
import { useSettingsStore } from '@/stores/settings'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  error?: boolean
}

const STORAGE_KEY = 'quick-chat-messages'
const MODEL_STORAGE_KEY = 'quick-chat-model'

const { t } = useI18n()
const settingsStore = useSettingsStore()

const messages = ref<Message[]>([])
const inputText = ref('')
const streaming = ref(false)
const streamingContent = ref('')
const messagesEnd = ref<HTMLDivElement>()
const selectedModel = ref('')
const selectedProviderId = ref('')
const selectedProviderKey = ref('')
const showModelDropdown = ref(false)
const useWebSocket = ref(false)
const wsConnected = ref(false)

const availableModels = computed(() => settingsStore.availableModels)

function applySelectedModel(model: (typeof availableModels.value)[number] | null | undefined) {
  selectedModel.value = model?.modelId ?? ''
  selectedProviderId.value = model?.providerId ?? ''
  selectedProviderKey.value = model?.providerKey ?? ''
}

function resolvePreferredModel() {
  const defaultModelId = settingsStore.config?.llm.defaultModel ?? ''
  const defaultProviderId = settingsStore.config?.llm.defaultProviderId ?? ''
  if (defaultModelId) {
    return (
      availableModels.value.find(
        (model) =>
          model.modelId === defaultModelId &&
          (!defaultProviderId || model.providerId === defaultProviderId),
      ) ?? availableModels.value.find((model) => model.modelId === defaultModelId)
    )
  }
  return availableModels.value[0]
}

function loadModelSelection() {
  try {
    const savedModel = localStorage.getItem(MODEL_STORAGE_KEY)
    const [savedProviderId, savedModelId] = (savedModel || '').includes('::')
      ? (savedModel || '').split('::', 2)
      : ['', savedModel || '']
    const matched = availableModels.value.find(
      (model) =>
        model.modelId === savedModelId &&
        (!savedProviderId || model.providerId === savedProviderId),
    )
    if (matched) {
      applySelectedModel(matched)
      return
    }
  } catch {
    // ignore persisted selection failures
  }

  applySelectedModel(resolvePreferredModel())
}

// Load persisted messages and model selection
onMounted(async () => {
  // Load settings if not loaded
  if (!settingsStore.config) {
    await settingsStore.loadConfig()
  }

  // Restore messages from localStorage
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      messages.value = JSON.parse(saved)
    }
  } catch {}

  loadModelSelection()

  // Try to connect WebSocket
  try {
    await hexclawWS.connect()
    wsConnected.value = true
    useWebSocket.value = true
    setupWsCallbacks()
  } catch {
    wsConnected.value = false
    useWebSocket.value = false
  }

  try {
    const { listen } = await import('@tauri-apps/api/event')
    const unlisten = await listen('sidecar-ready', async () => {
      await settingsStore.loadConfig({ force: true })
      loadModelSelection()
      try {
        await hexclawWS.connect()
        wsConnected.value = true
        useWebSocket.value = true
        setupWsCallbacks()
      } catch {
        wsConnected.value = false
        useWebSocket.value = false
      }
      unlisten()
    })
    setTimeout(() => unlisten(), 30000)
  } catch {
    // 非 Tauri 环境忽略
  }
})

onUnmounted(() => {
  hexclawWS.clearCallbacks()
})

// Persist messages on change
watch(
  messages,
  (val) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(val))
    } catch {}
  },
  { deep: true },
)

// Persist model selection
watch([selectedProviderId, selectedModel], ([providerId, modelId]) => {
  if (modelId) {
    localStorage.setItem(MODEL_STORAGE_KEY, `${providerId}::${modelId}`)
  }
})

watch(availableModels, () => {
  const current = availableModels.value.find(
    (model) =>
      model.modelId === selectedModel.value && model.providerId === selectedProviderId.value,
  )
  if (!current) {
    loadModelSelection()
  }
})

function setupWsCallbacks() {
  hexclawWS.clearCallbacks()

  hexclawWS.onChunk((chunk) => {
    streamingContent.value += chunk.content
    if (chunk.done) {
      // Streaming complete - push final message
      if (streamingContent.value) {
        messages.value.push({
          id: Date.now().toString(),
          role: 'assistant',
          content: streamingContent.value,
        })
        streamingContent.value = ''
      }
      streaming.value = false
    }
  })

  hexclawWS.onReply((reply) => {
    messages.value.push({
      id: Date.now().toString(),
      role: 'assistant',
      content: reply.content,
    })
    streaming.value = false
    streamingContent.value = ''
  })

  hexclawWS.onError((error) => {
    messages.value.push({
      id: Date.now().toString(),
      role: 'assistant',
      content: error || t('quickChat.connectionFailed'),
      error: true,
    })
    streaming.value = false
    streamingContent.value = ''
  })
}

async function handleSend(retryContent?: string) {
  const text = retryContent || inputText.value.trim()
  if (!text || streaming.value) return

  if (!retryContent) {
    inputText.value = ''
  }

  // Remove the failed message if retrying
  if (retryContent) {
    // Find and remove the last error message and its preceding user message with this content
    const lastErrIdx = messages.value.reduce((acc, m, i) => (m.error ? i : acc), -1)
    if (lastErrIdx >= 0) {
      messages.value.splice(lastErrIdx, 1)
    }
  } else {
    messages.value.push({
      id: Date.now().toString(),
      role: 'user',
      content: text,
    })
  }

  streaming.value = true
  streamingContent.value = ''

  if (useWebSocket.value && wsConnected.value && hexclawWS.isConnected()) {
    // WebSocket streaming mode
    hexclawWS.sendMessage(
      text,
      undefined,
      selectedModel.value || undefined,
      undefined,
      undefined,
      selectedProviderKey.value || undefined,
    )
  } else {
    // HTTP fallback
    try {
      const resp = await sendChat({
        message: text,
        provider: selectedProviderKey.value || undefined,
        model: selectedModel.value || undefined,
      })
      messages.value.push({
        id: Date.now().toString(),
        role: 'assistant',
        content: typeof resp.reply === 'string' ? resp.reply : t('chat.receivedReply'),
      })
    } catch (e) {
      console.error('发送失败:', e)
      messages.value.push({
        id: Date.now().toString(),
        role: 'assistant',
        content: t('quickChat.connectionFailed'),
        error: true,
      })
    } finally {
      streaming.value = false
    }
  }
}

function handleRetry(msg: Message) {
  // Find the user message right before this error
  const idx = messages.value.indexOf(msg)
  if (idx > 0) {
    const prevMsg = messages.value[idx - 1]
    if (prevMsg && prevMsg.role === 'user') {
      handleSend(prevMsg.content)
      return
    }
  }
  // Fallback: just remove the error message
  messages.value = messages.value.filter((m) => m.id !== msg.id)
}

function clearChat() {
  messages.value = []
  streamingContent.value = ''
  localStorage.removeItem(STORAGE_KEY)
}

function handleStop() {
  streaming.value = false
  hexclawWS.clearCallbacks()
  if (streamingContent.value) {
    messages.value.push({
      id: Date.now().toString(),
      role: 'assistant',
      content: streamingContent.value,
    })
    streamingContent.value = ''
  }
  // Re-setup callbacks for next message
  if (wsConnected.value) {
    setupWsCallbacks()
  }
}

function selectModel(modelId: string, providerId: string, providerKey: string) {
  selectedModel.value = modelId
  selectedProviderId.value = providerId
  selectedProviderKey.value = providerKey
  showModelDropdown.value = false
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

watch(
  () => messages.value.length,
  () => nextTick(scrollToBottom),
)
watch(streamingContent, () => nextTick(scrollToBottom))

const selectedModelName = computed(() => {
  const m = availableModels.value.find(
    (m) => m.modelId === selectedModel.value && m.providerId === selectedProviderId.value,
  )
  return m ? m.modelName : selectedModel.value || 'Default'
})
</script>

<template>
  <div class="h-full flex flex-col" :style="{ background: 'var(--hc-bg-main)' }">
    <!-- 标题栏 -->
    <div
      data-tauri-drag-region
      class="h-[38px] flex items-center justify-between px-4 flex-shrink-0"
      :style="{ background: 'var(--hc-bg-sidebar)' }"
    >
      <span class="text-xs font-medium pl-16" :style="{ color: 'var(--hc-text-secondary)' }"
        >Quick Chat</span
      >
      <div class="flex items-center gap-2">
        <!-- Model Selector -->
        <div class="relative">
          <button
            class="flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors"
            :style="{ color: 'var(--hc-text-secondary)', background: 'var(--hc-bg-card)' }"
            @click="showModelDropdown = !showModelDropdown"
          >
            <span class="max-w-[120px] truncate">{{ selectedModelName }}</span>
            <ChevronDown :size="12" />
          </button>
          <div
            v-if="showModelDropdown"
            class="absolute right-0 top-full mt-1 w-52 rounded-lg border shadow-lg overflow-hidden z-50"
            :style="{ background: 'var(--hc-bg-elevated)', borderColor: 'var(--hc-border)' }"
          >
            <button
              v-for="model in availableModels"
              :key="model.modelId"
              class="w-full text-left px-3 py-2 text-xs hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex flex-col"
              :style="{
                color:
                  model.modelId === selectedModel && model.providerId === selectedProviderId
                    ? 'var(--hc-accent)'
                    : 'var(--hc-text-primary)',
              }"
              @click="selectModel(model.modelId, model.providerId, model.providerKey)"
            >
              <span class="font-medium truncate">{{ model.modelName }}</span>
              <span class="text-[10px] truncate" :style="{ color: 'var(--hc-text-muted)' }">{{
                model.providerName
              }}</span>
            </button>
            <div
              v-if="availableModels.length === 0"
              class="px-3 py-2 text-xs"
              :style="{ color: 'var(--hc-text-muted)' }"
            >
              {{ t('chat.noModels') }}
            </div>
          </div>
        </div>
        <!-- Clear button -->
        <button
          v-if="messages.length > 0"
          class="p-1 rounded transition-colors hover:bg-black/5 dark:hover:bg-white/5"
          :style="{ color: 'var(--hc-text-muted)' }"
          :title="t('chat.clearChat')"
          @click="clearChat"
        >
          <Trash2 :size="13" />
        </button>
      </div>
    </div>

    <!-- 消息区 -->
    <div class="flex-1 overflow-y-auto px-4 py-3 space-y-3" @click="showModelDropdown = false">
      <div v-for="msg in messages" :key="msg.id" class="text-sm leading-relaxed">
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
            :style="{
              background: msg.error ? 'rgba(239, 68, 68, 0.08)' : 'var(--hc-bg-card)',
              color: msg.error ? '#ef4444' : 'var(--hc-text-primary)',
            }"
          >
            <MarkdownRenderer :content="msg.content" />
            <button
              v-if="msg.error"
              class="flex items-center gap-1 mt-1.5 text-xs px-2 py-0.5 rounded transition-colors"
              style="color: #ef4444; background: rgba(239, 68, 68, 0.1)"
              @click="handleRetry(msg)"
            >
              <RotateCcw :size="11" />
              {{ t('common.retry') }}
            </button>
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

      <div v-if="streaming && !streamingContent" class="text-sm">
        <div
          class="inline-block rounded-xl px-3 py-2"
          :style="{ background: 'var(--hc-bg-card)', color: 'var(--hc-text-muted)' }"
        >
          <span class="inline-flex gap-1">
            <span
              class="w-1.5 h-1.5 rounded-full bg-current animate-bounce"
              style="animation-delay: 0ms"
            />
            <span
              class="w-1.5 h-1.5 rounded-full bg-current animate-bounce"
              style="animation-delay: 150ms"
            />
            <span
              class="w-1.5 h-1.5 rounded-full bg-current animate-bounce"
              style="animation-delay: 300ms"
            />
          </span>
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
          v-if="streaming"
          class="p-1 rounded transition-colors opacity-100"
          :style="{ color: '#ef4444' }"
          :title="t('chat.stopGenerate')"
          @click="handleStop"
        >
          <StopCircle :size="16" />
        </button>
        <button
          v-else
          class="p-1 rounded transition-colors"
          :class="inputText.trim() ? 'opacity-100' : 'opacity-30'"
          :style="{ color: 'var(--hc-accent)' }"
          :disabled="!inputText.trim()"
          @click="handleSend()"
        >
          <Send :size="16" />
        </button>
      </div>
    </div>
  </div>
</template>
