<script setup lang="ts">
import { ref, nextTick, watch, onMounted, onUnmounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Send, StopCircle, Trash2, RotateCcw, ChevronDown } from 'lucide-vue-next'
import { sendChat } from '@/api/chat'
import { hexclawWS } from '@/api/websocket'
import { useSettingsStore } from '@/stores/settings'
import AssistantRunStatus from '@/components/chat/AssistantRunStatus.vue'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import MessageText from '@/components/chat/MessageText.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import { getAssistantDisplayContent, getAssistantReasoningFromMetadata, normalizeAssistantReasoning } from '@/utils/assistant-reply'
import { withModelReasoningDefaults } from '@/utils/model-reasoning'
import { normalizeReasoningReceipt, type ReasoningReceipt } from '@/types/chat'
import { insertAtSelection, normalizeMathMarkdown, readMathClipboard } from '@/utils/math-content'
import type { MessageContent, RenderManifest } from '@/contracts/message-content'
import { recordRenderManifest } from '@/contracts/render-evidence'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  message_content?: MessageContent
  render_manifest?: RenderManifest
  error?: boolean
}

const STORAGE_KEY = 'quick-chat-messages'
const MODEL_STORAGE_KEY = 'quick-chat-model'
const QUICK_CHAT_CONFIRMATION_KEY = 'quick-chat'

const { t, locale } = useI18n()
const settingsStore = useSettingsStore()

const messages = ref<Message[]>([])
const inputText = ref('')
const textareaRef = ref<HTMLTextAreaElement>()
const streaming = ref(false)
const streamingContent = ref('')
const streamingReasoning = ref('')
const streamingReasoningReceipt = ref<ReasoningReceipt>(createQuickChatReasoningReceipt())
const streamingReasoningElapsedSeconds = ref(0)
const hasVisibleStreamingAnswer = computed(() => streamingContent.value.trim().length > 0)
const messagesEnd = ref<HTMLDivElement>()
const selectedModel = ref('')
const selectedProviderId = ref('')
const selectedProviderKey = ref('')
const showModelDropdown = ref(false)
const showClearChatConfirm = ref(false)
const useWebSocket = ref(false)
const wsConnected = ref(false)

let reasoningStartedAt: number | null = null
let reasoningElapsedTimer: ReturnType<typeof setInterval> | undefined

function createQuickChatReasoningReceipt(): ReasoningReceipt {
  return {
    version: 1,
    reasoning_request: 'off',
    reasoning_support: 'unknown',
    reasoning_execution: 'unknown',
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readReasoningReceipt(payload: unknown): ReasoningReceipt | null {
  if (!isRecord(payload)) return null
  if (Object.prototype.hasOwnProperty.call(payload, 'reasoning_receipt')) {
    return normalizeReasoningReceipt(payload.reasoning_receipt, 'off')
  }
  const metadata = isRecord(payload.metadata) ? payload.metadata : null
  return metadata && Object.prototype.hasOwnProperty.call(metadata, 'reasoning_receipt')
    ? normalizeReasoningReceipt(metadata.reasoning_receipt, 'off')
    : null
}

function updateReasoningElapsedSeconds() {
  if (reasoningStartedAt === null) return
  streamingReasoningElapsedSeconds.value = Math.max(
    0,
    Math.floor((Date.now() - reasoningStartedAt) / 1000),
  )
}

function stopReasoningTimer() {
  updateReasoningElapsedSeconds()
  if (reasoningElapsedTimer !== undefined) {
    clearInterval(reasoningElapsedTimer)
    reasoningElapsedTimer = undefined
  }
  reasoningStartedAt = null
}

function startReasoningTimer() {
  if (reasoningStartedAt !== null || hasVisibleStreamingAnswer.value) return
  reasoningStartedAt = Date.now()
  streamingReasoningElapsedSeconds.value = 0
  reasoningElapsedTimer = setInterval(updateReasoningElapsedSeconds, 1000)
}

function resetReasoningStatus() {
  stopReasoningTimer()
  streamingReasoningReceipt.value = createQuickChatReasoningReceipt()
  streamingReasoningElapsedSeconds.value = 0
}

function applyReasoningReceipt(payload: unknown) {
  const receipt = readReasoningReceipt(payload)
  if (!receipt) return
  streamingReasoningReceipt.value = receipt
  if (receipt.reasoning_execution === 'applied') {
    startReasoningTimer()
  } else {
    stopReasoningTimer()
  }
}

function buildQuickChatMetadata(): Record<string, string> {
  return withModelReasoningDefaults(selectedModel.value, {
    pinned_agent: 'default',
    producer_kind: 'quick_chat',
    locale: locale.value,
    thinking: 'off',
  }) ?? { thinking: 'off' }
}

function captureRenderManifest(message: Message, manifest: RenderManifest) {
  recordRenderManifest(message, manifest)
}

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
  stopReasoningTimer()
  hexclawWS.clearStreamCallbacks()
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

let replySettled = false
let responseRequestGen = 0

function setupWsCallbacks(requestGen: number) {
  hexclawWS.clearStreamCallbacks()

  hexclawWS.onChunk((chunk) => {
    if (requestGen !== responseRequestGen) return
    applyReasoningReceipt(chunk)
    streamingContent.value += chunk.content
    if (hasVisibleStreamingAnswer.value) {
      stopReasoningTimer()
    }
    if (chunk.reasoning) {
      streamingReasoning.value = normalizeAssistantReasoning(streamingReasoning.value + chunk.reasoning, { trim: false })
    }
    if (chunk.done && !replySettled) {
      replySettled = true
      // Streaming complete - push final message
      messages.value.push({
        id: Date.now().toString(),
        role: 'assistant',
        content: getAssistantDisplayContent(
          streamingContent.value,
          streamingReasoning.value || getAssistantReasoningFromMetadata(chunk.metadata),
        ),
        message_content: chunk.message_content,
      })
      streamingContent.value = ''
      streamingReasoning.value = ''
      streaming.value = false
      stopReasoningTimer()
    }
  })

  hexclawWS.onReply((reply) => {
    if (requestGen !== responseRequestGen) return
    if (replySettled) return
    replySettled = true
    applyReasoningReceipt(reply)
    messages.value.push({
      id: Date.now().toString(),
      role: 'assistant',
      content: getAssistantDisplayContent(
        reply.content,
        reply.reasoning
          ? normalizeAssistantReasoning(reply.reasoning)
          : getAssistantReasoningFromMetadata(reply.metadata),
      ),
      message_content: reply.message_content,
    })
    streaming.value = false
    streamingContent.value = ''
    streamingReasoning.value = ''
    stopReasoningTimer()
  })

  hexclawWS.onError((error) => {
    if (requestGen !== responseRequestGen) return
    replySettled = true
    messages.value.push({
      id: Date.now().toString(),
      role: 'assistant',
      content: error || t('quickChat.connectionFailed'),
      error: true,
    })
    streaming.value = false
    streamingContent.value = ''
    streamingReasoning.value = ''
    stopReasoningTimer()
  })
}

async function handleSend(retryContent?: string, retryErrorId?: string) {
  const text = normalizeMathMarkdown(retryContent || inputText.value.trim())
  if (!text || streaming.value) return

  if (!retryContent) {
    inputText.value = ''
  }

  // Remove the failed message if retrying
  if (retryContent && retryErrorId) {
    messages.value = messages.value.filter((m) => m.id !== retryErrorId)
  } else {
    messages.value.push({
      id: Date.now().toString(),
      role: 'user',
      content: text,
    })
  }

  streaming.value = true
  streamingContent.value = ''
  streamingReasoning.value = ''
  resetReasoningStatus()
  replySettled = false
  const requestGen = ++responseRequestGen
  const requestId = `quick-${Date.now()}-${requestGen}`

  if (useWebSocket.value && wsConnected.value && hexclawWS.isConnected()) {
    // WebSocket streaming mode
    setupWsCallbacks(requestGen)
    hexclawWS.sendMessage(
      text,
      undefined,
      selectedModel.value || undefined,
      undefined,
      undefined,
      selectedProviderKey.value || undefined,
      undefined,
      undefined,
      // BUG-20260703 A1：QuickChat 无 Agent 选择 UI = 恒对默认助理，须发 pinned_agent
      // 锁定信号，否则 provider 解析为空时后端会按内容路由被专属 Agent 抢答。
      buildQuickChatMetadata(),
      requestId,
    )
  } else {
    // HTTP fallback
    try {
      const resp = await sendChat({
        message: text,
        provider: selectedProviderKey.value || undefined,
        model: selectedModel.value || undefined,
        request_id: requestId,
        // BUG-20260703 A1：同上，QuickChat 恒锁默认助理，防内容路由抢答。
        metadata: buildQuickChatMetadata(),
      })
      if (requestGen !== responseRequestGen) return
      applyReasoningReceipt(resp)
      messages.value.push({
        id: Date.now().toString(),
        role: 'assistant',
        content: getAssistantDisplayContent(
          typeof resp.reply === 'string' ? resp.reply : '',
          getAssistantReasoningFromMetadata(resp.metadata),
        ),
        message_content: resp.message_content,
      })
    } catch (e) {
      if (requestGen !== responseRequestGen) return
      console.error('发送失败:', e)
      messages.value.push({
        id: Date.now().toString(),
        role: 'assistant',
        content: t('quickChat.connectionFailed'),
        error: true,
      })
    } finally {
      if (requestGen === responseRequestGen) {
        streaming.value = false
        stopReasoningTimer()
      }
    }
  }
}

function handlePaste(event: ClipboardEvent) {
  const paste = readMathClipboard(event.clipboardData)
  if (!paste.text || !paste.handled) return
  event.preventDefault()
  const textarea = textareaRef.value
  if (!textarea) return
  const start = textarea.selectionStart ?? inputText.value.length
  const end = textarea.selectionEnd ?? start
  const inserted = insertAtSelection(inputText.value, paste.text, start, end)
  inputText.value = inserted.value
  nextTick(() => {
    textarea.setSelectionRange(inserted.caret, inserted.caret)
    textarea.focus()
  })
}

function handleRetry(msg: Message) {
  // Find the user message right before this error
  const idx = messages.value.indexOf(msg)
  if (idx > 0) {
    const prevMsg = messages.value[idx - 1]
    if (prevMsg && prevMsg.role === 'user') {
      handleSend(prevMsg.content, msg.id)
      return
    }
  }
  // Fallback: just remove the error message
  messages.value = messages.value.filter((m) => m.id !== msg.id)
}

function clearChat() {
  showClearChatConfirm.value = false
  responseRequestGen++
  streaming.value = false
  replySettled = true
  hexclawWS.clearStreamCallbacks()
  messages.value = []
  streamingContent.value = ''
  streamingReasoning.value = ''
  resetReasoningStatus()
  localStorage.removeItem(STORAGE_KEY)
}

function handleStop() {
  responseRequestGen++
  streaming.value = false
  stopReasoningTimer()
  hexclawWS.clearStreamCallbacks()
  if (streamingContent.value || streamingReasoning.value) {
    const reasoning = streamingReasoning.value
      ? normalizeAssistantReasoning(streamingReasoning.value)
      : undefined
    messages.value.push({
      id: Date.now().toString(),
      role: 'assistant',
      content: getAssistantDisplayContent(streamingContent.value, reasoning),
    })
    streamingContent.value = ''
    streamingReasoning.value = ''
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
          @click="showClearChatConfirm = true"
        >
          <Trash2 :size="13" />
        </button>
      </div>
    </div>

    <!-- 消息区 -->
    <div class="flex-1 overflow-y-auto px-4 py-3 space-y-3" @click="showModelDropdown = false">
      <div v-for="msg in messages" :key="msg.id" class="text-sm leading-relaxed">
        <div v-if="msg.role === 'user'" class="text-right">
          <div
            class="inline-block rounded-xl px-3 py-2 text-white max-w-[85%] text-left"
            :style="{ background: 'var(--hc-accent)' }"
          >
            <MessageText :content="msg.content" />
          </div>
        </div>
        <div v-else>
          <div
            class="inline-block rounded-xl px-3 py-2 max-w-[85%]"
            :style="{
              background: msg.error ? 'color-mix(in srgb, var(--hc-error) 8%, transparent)' : 'var(--hc-bg-card)',
              color: msg.error ? 'var(--hc-error)' : 'var(--hc-text-primary)',
            }"
          >
            <MarkdownRenderer
              :content="msg.message_content ?? msg.content"
              surface="quick_chat"
              @rendered="captureRenderManifest(msg, $event)"
            />
            <button
              v-if="msg.error"
              class="flex items-center gap-1 mt-1.5 text-xs px-2 py-0.5 rounded transition-colors"
              style="color: var(--hc-error); background: color-mix(in srgb, var(--hc-error) 10%, transparent)"
              @click="handleRetry(msg)"
            >
              <RotateCcw :size="11" />
              {{ t('common.retry') }}
            </button>
          </div>
        </div>
      </div>

      <div v-if="streaming" class="text-sm">
        <AssistantRunStatus
          :reasoning-request="streamingReasoningReceipt.reasoning_request"
          :reasoning-support="streamingReasoningReceipt.reasoning_support"
          :reasoning-execution="streamingReasoningReceipt.reasoning_execution"
          :has-visible-answer="hasVisibleStreamingAnswer"
          :elapsed-seconds="streamingReasoningElapsedSeconds"
        />
        <div
          v-if="hasVisibleStreamingAnswer"
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
        <HcClearableField>
          <textarea
          ref="textareaRef"
          v-model="inputText"
          rows="1"
          class="flex-1 resize-none bg-transparent outline-none text-sm leading-6 max-h-20"
          :style="{ color: 'var(--hc-text-primary)' }"
          :placeholder="t('quickChat.inputPlaceholder')"
          @keydown="handleKeydown"
          @paste="handlePaste"
        />
        </HcClearableField>
        <button
          v-if="streaming"
          class="p-1 rounded transition-colors opacity-100"
          :style="{ color: 'var(--hc-error)' }"
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

    <ConfirmDialog
      :open="showClearChatConfirm"
      :confirmation-key="QUICK_CHAT_CONFIRMATION_KEY"
      :title="t('chat.clearConfirmTitle')"
      :message="t('chat.clearConfirmMessage')"
      :confirm-text="t('chat.clearConfirm')"
      :cancel-text="t('common.cancel')"
      danger
      @confirm="clearChat"
      @cancel="showClearChatConfirm = false"
    />
  </div>
</template>
