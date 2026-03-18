<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted, watch, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { MessageSquarePlus, Search, Download, ChevronDown, Settings2, PanelRightOpen, FileCode, Eye, Video, Headphones, Wrench, Zap } from 'lucide-vue-next'
import { useChatStore } from '@/stores/chat'
import { dbDeleteMessage } from '@/db/chat'
import { useAgentsStore } from '@/stores/agents'
import { useSettingsStore } from '@/stores/settings'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import MessageActions from '@/components/chat/MessageActions.vue'
import ChatInput from '@/components/chat/ChatInput.vue'
import SessionList from '@/components/chat/SessionList.vue'
import ChatSearchDialog from '@/components/chat/ChatSearchDialog.vue'
import ChatExportMenu from '@/components/chat/ChatExportMenu.vue'
import ResearchProgress from '@/components/chat/ResearchProgress.vue'
import ArtifactsPanel from '@/components/artifacts/ArtifactsPanel.vue'
import ContextMenu from '@/components/common/ContextMenu.vue'
import type { ContextMenuItem } from '@/components/common/ContextMenu.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { isDocumentFile, parseDocument } from '@/utils/file-parser'
import crabLogo from '@/assets/logo-crab.png'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const chatStore = useChatStore()
const agentsStore = useAgentsStore()
const settingsStore = useSettingsStore()

const messagesEndRef = ref<HTMLDivElement>()
const chatInputRef = ref<InstanceType<typeof ChatInput>>()
const showSessions = ref(true)
const hoveredMsgId = ref<string | null>(null)
const showSearch = ref(false)
const showExport = ref(false)
const attachmentPreview = ref<{ url: string; name: string; type: 'image' | 'video' | 'file'; file: File } | null>(null)
const showModelSelector = ref(false)

// Message context menu
const msgCtxMenu = ref<InstanceType<typeof ContextMenu>>()
const ctxMsgIndex = ref(-1)
const ctxMsgRole = ref<'user' | 'assistant'>('user')

const msgContextItems = computed<ContextMenuItem[]>(() => {
  const items: ContextMenuItem[] = [
    { id: 'copy', label: t('chat.copyMessage'), icon: undefined },
  ]
  if (ctxMsgRole.value === 'assistant') {
    items.push({ id: 'retry', label: t('chat.regenerate'), icon: undefined })
  } else {
    items.push({ id: 'edit', label: t('chat.editMessage'), icon: undefined })
  }
  items.push(
    { id: 'sep1', label: '', separator: true },
    { id: 'delete', label: t('chat.deleteMessage'), icon: undefined, danger: true },
  )
  return items
})

function handleMsgContextMenu(e: MouseEvent, idx: number, role: 'user' | 'assistant') {
  ctxMsgIndex.value = idx
  ctxMsgRole.value = role
  msgCtxMenu.value?.show(e)
}

async function handleMsgCtxAction(action: string) {
  const idx = ctxMsgIndex.value
  const msg = chatStore.messages[idx]
  if (!msg) return
  switch (action) {
    case 'copy':
      await navigator.clipboard.writeText(msg.content)
      break
    case 'retry':
      handleRetry(idx)
      break
    case 'edit':
      handleEdit(idx)
      break
    case 'delete': {
      const removed = chatStore.messages.splice(idx, 1)
      for (const m of removed) {
        dbDeleteMessage(m.id).catch(() => {})
      }
      break
    }
  }
}

// Token count estimate (rough: ~4 chars per token for Chinese, ~4 chars per token for English)
const estimatedTokens = computed(() => {
  let total = 0
  for (const msg of chatStore.messages) {
    total += Math.ceil(msg.content.length / 3)
  }
  return total
})

function formatTokenCount(n: number): string {
  if (n < 1000) return String(n)
  return (n / 1000).toFixed(1) + 'k'
}

function formatFullTime(ts: string): string {
  return new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

// Document parsing state
const documentParsing = ref(false)
const parsedDocument = ref<{ text: string; fileName: string; pageCount?: number } | null>(null)

// 当前选中的模型
const selectedModel = ref('')
const chatTemperature = ref(0.7)
const chatMaxTokens = ref(4096)
const showChatParams = ref(false)

// 当前模型的显示名
const selectedModelDisplay = computed(() => {
  if (selectedModel.value === 'auto') return 'Auto'
  if (!selectedModel.value) return 'Select Model'
  const found = settingsStore.availableModels.find((m) => m.modelId === selectedModel.value)
  return found ? `${found.modelName}` : selectedModel.value
})

// 按 Provider 分组的模型列表
const groupedModels = computed(() => {
  const groups: Record<string, { providerName: string; models: { modelId: string; modelName: string; capabilities: import('@/types').ModelCapability[] }[] }> = {}
  for (const m of settingsStore.availableModels) {
    if (!groups[m.providerId]) {
      groups[m.providerId] = { providerName: m.providerName, models: [] }
    }
    groups[m.providerId]!.models.push({ modelId: m.modelId, modelName: m.modelName, capabilities: m.capabilities })
  }
  return groups
})

// 当前选中模型的能力
const selectedModelCapabilities = computed(() => {
  const found = settingsStore.availableModels.find((m) => m.modelId === selectedModel.value)
  return found?.capabilities ?? ['text']
})

// 当前模型是否支持视觉/视频上传
const supportsVision = computed(() => selectedModelCapabilities.value.includes('vision'))
const supportsVideo = computed(() => selectedModelCapabilities.value.includes('video'))

// Research mode state
const isResearchMode = computed(() => chatStore.chatMode === 'research')
const researchStreamingContentLength = computed(() =>
  isResearchMode.value && chatStore.isCurrentStreaming ? (chatStore.isCurrentStreamingContent?.length ?? 0) : 0,
)

function formatTime(ts: string) {
  const d = new Date(ts)
  const now = new Date()
  const h = d.getHours().toString().padStart(2, '0')
  const m = d.getMinutes().toString().padStart(2, '0')
  if (d.toDateString() === now.toDateString()) return `${h}:${m}`
  const month = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  return `${month}/${day} ${h}:${m}`
}

/** 初始化模型选择（路由守卫已保证 config 就绪，无需再调 loadConfig） */
function loadLLMConfig() {
  if (settingsStore.config?.llm?.defaultModel) {
    selectedModel.value = settingsStore.config.llm.defaultModel
  } else if (settingsStore.availableModels.length > 0) {
    selectedModel.value = settingsStore.availableModels[0]!.modelId
  }
  syncChatParams()
}

onMounted(async () => {
  chatStore.loadSessions()
  agentsStore.loadRoles()

  // 从 Agent 管理页跳转过来：复用已有同角色会话 或 新建
  const roleQuery = route.query.role as string | undefined
  const roleTitleQuery = route.query.roleTitle as string | undefined
  if (roleQuery) {
    const roleTitle = roleTitleQuery || roleQuery
    // 查找是否已有同名会话
    const existing = chatStore.sessions.find(s => s.title === roleTitle)
    if (existing) {
      await chatStore.selectSession(existing.id)
    } else {
      chatStore.newSession(roleTitle)
      await chatStore.ensureSession()
      chatStore.loadSessions()
    }
    chatStore.chatMode = 'agent'
    chatStore.agentRole = roleQuery
    router.replace({ path: '/chat' })
  }

  // 初始化模型选择（config 由路由守卫保证已就绪）
  loadLLMConfig()

  // sidecar-ready 事件：后端延迟就绪时重新同步 providers
  try {
    const { listen } = await import('@tauri-apps/api/event')
    const unlisten = await listen('sidecar-ready', async () => {
      await settingsStore.loadConfig({ force: true })
      loadLLMConfig()
      unlisten()
    })
    setTimeout(() => unlisten(), 30000)
  } catch {
    // 非 Tauri 环境忽略
  }
})

function selectModel(modelId: string) {
  selectedModel.value = modelId
  showModelSelector.value = false
  syncChatParams()
}

/** 同步模型和参数到 chatStore */
function syncChatParams() {
  chatStore.chatParams.model = selectedModel.value === 'auto' ? 'auto' : selectedModel.value
  chatStore.chatParams.temperature = chatTemperature.value
  chatStore.chatParams.maxTokens = chatMaxTokens.value
}

/** 获取某条消息关联的 artifacts */
function getMessageArtifacts(messageId: string) {
  return chatStore.artifacts.filter((a) => a.messageId === messageId)
}

async function handleSend(text: string) {
  // 如果有附件，转成 base64 一并发送
  const attachments: import('@/types').ChatAttachment[] = []
  if (attachmentPreview.value) {
    const { file, type } = attachmentPreview.value
    const data = await fileToBase64(file)
    attachments.push({ type, name: file.name, mime: file.type, data })
    clearAttachmentPreview()
  }

  // If a document was parsed, prepend its content to the message
  let finalText = text
  if (parsedDocument.value) {
    const doc = parsedDocument.value
    const pageInfo = doc.pageCount ? ` (${doc.pageCount}页)` : ''
    finalText = `[文件: ${doc.fileName}${pageInfo}]\n\n${doc.text}\n\n---\n${text}`
    parsedDocument.value = null
  }

  // Set agent role for research mode
  if (chatStore.chatMode === 'research') {
    chatStore.agentRole = 'researcher'
  }

  await chatStore.sendMessage(finalText, attachments.length > 0 ? attachments : undefined)
  await nextTick()
  scrollToBottom()
}

/** File → Base64 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      // 去掉 data:xxx;base64, 前缀
      resolve(result.split(',')[1] || result)
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

async function handleRetry(msgIndex: number) {
  const msgs = chatStore.messages
  for (let i = msgIndex - 1; i >= 0; i--) {
    if (msgs[i]?.role === 'user') {
      const removed = chatStore.messages.splice(msgIndex)
      for (const m of removed) {
        dbDeleteMessage(m.id).catch(() => {})
      }
      await chatStore.sendMessage(msgs[i]!.content)
      await nextTick()
      scrollToBottom()
      break
    }
  }
}

function handleEdit(msgIndex: number) {
  const msg = chatStore.messages[msgIndex]
  if (!msg || msg.role !== 'user') return
  const content = msg.content
  const removed = chatStore.messages.splice(msgIndex)
  for (const m of removed) {
    dbDeleteMessage(m.id).catch(() => {})
  }
  chatInputRef.value?.setInput(content)
}

function scrollToBottom() {
  messagesEndRef.value?.scrollIntoView({ behavior: 'smooth' })
}

watch(() => chatStore.messages.length, () => {
  nextTick(scrollToBottom)
})

watch(() => chatStore.isCurrentStreamingContent, () => {
  nextTick(scrollToBottom)
})

// 参数变更时同步到 chatStore
watch([() => chatTemperature.value, () => chatMaxTokens.value], syncChatParams)

function newSession() {
  chatStore.newSession()
}

function scrollToMessage(msgId: string) {
  const el = document.getElementById(`msg-${msgId}`)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('hc-msg--highlight')
    setTimeout(() => el.classList.remove('hc-msg--highlight'), 1500)
  }
}

async function handleFileUpload(file: File) {
  const url = URL.createObjectURL(file)
  let type: 'image' | 'video' | 'file' = 'file'
  if (file.type.startsWith('image/')) type = 'image'
  else if (file.type.startsWith('video/')) type = 'video'
  attachmentPreview.value = { url, name: file.name, type, file }

  // Parse document files to extract text
  if (isDocumentFile(file)) {
    documentParsing.value = true
    parsedDocument.value = null
    try {
      parsedDocument.value = await parseDocument(file)
    } catch (err) {
      console.error('Document parsing failed:', err)
      // Still allow sending as raw file attachment
    } finally {
      documentParsing.value = false
    }
  }
}

function clearAttachmentPreview() {
  if (attachmentPreview.value) {
    URL.revokeObjectURL(attachmentPreview.value.url)
    attachmentPreview.value = null
  }
  parsedDocument.value = null
  documentParsing.value = false
}

function handleSearchShortcut(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    e.preventDefault()
    showSearch.value = !showSearch.value
  }
}

onMounted(() => document.addEventListener('keydown', handleSearchShortcut))
onUnmounted(() => document.removeEventListener('keydown', handleSearchShortcut))
</script>

<template>
  <div class="hc-chat">
    <!-- Session sidebar -->
    <div v-show="showSessions" class="hc-chat__sidebar">
      <div class="hc-chat__sidebar-header">
        <span class="hc-chat__sidebar-title">{{ t('chat.sessions') }}</span>
        <button class="hc-chat__new-btn" :title="t('chat.newSession')" @click="newSession">
          <MessageSquarePlus :size="16" />
        </button>
      </div>
      <SessionList />
    </div>

    <!-- Main chat area -->
    <div class="hc-chat__main">
      <!-- Toolbar with mode tab + model selector -->
      <div class="hc-chat__toolbar">
        <!-- Chat/Agent mode tab -->
        <div class="hc-mode-tab">
          <button
            class="hc-mode-tab__btn"
            :class="{ 'hc-mode-tab__btn--active': chatStore.chatMode === 'chat' }"
            @click="chatStore.chatMode = 'chat'"
          >对话</button>
          <button
            class="hc-mode-tab__btn"
            :class="{ 'hc-mode-tab__btn--active': chatStore.chatMode === 'agent' }"
            @click="chatStore.chatMode = 'agent'"
          >Agent</button>
          <button
            class="hc-mode-tab__btn hc-mode-tab__btn--research"
            :class="{ 'hc-mode-tab__btn--active': chatStore.chatMode === 'research' }"
            @click="chatStore.chatMode = 'research'"
          >深度研究</button>
        </div>

        <!-- Research mode badge -->
        <span v-if="isResearchMode" class="hc-research-badge">🔍 Deep Research · Hexagon 引擎驱动</span>

        <!-- Token count -->
        <span v-if="chatStore.messages.length > 0" class="hc-token-badge" :title="`约 ${estimatedTokens} tokens`">
          ~{{ formatTokenCount(estimatedTokens) }} tok
        </span>

        <!-- Model selector -->
        <div class="hc-model-selector">
          <button class="hc-model-selector__btn" @click="showModelSelector = !showModelSelector">
            <span class="hc-model-selector__name">{{ selectedModelDisplay }}</span>
            <span v-if="supportsVision || supportsVideo" class="hc-model-selector__btn-caps">
              <Eye v-if="supportsVision" :size="11" class="hc-model-selector__cap-icon hc-model-selector__cap-icon--vision" />
              <Video v-if="supportsVideo" :size="11" class="hc-model-selector__cap-icon hc-model-selector__cap-icon--video" />
            </span>
            <ChevronDown :size="13" />
          </button>

          <!-- Dropdown -->
          <div v-if="showModelSelector" class="hc-model-selector__dropdown" @mouseleave="showModelSelector = false">
            <!-- Auto 选项 -->
            <button
              class="hc-model-selector__item hc-model-selector__item--auto"
              :class="{ 'hc-model-selector__item--active': selectedModel === 'auto' }"
              @click="selectModel('auto')"
            >
              <Zap :size="12" style="color: var(--hc-accent); margin-right: 4px" />
              <span class="hc-model-selector__item-name">Auto</span>
              <span class="hc-model-selector__item-hint">自动选择，故障切换</span>
            </button>
            <div class="hc-model-selector__divider" />
            <template v-if="Object.keys(groupedModels).length > 0">
              <div v-for="(group, pid) in groupedModels" :key="pid" class="hc-model-selector__group">
                <div class="hc-model-selector__group-label">{{ group.providerName }}</div>
                <button
                  v-for="m in group.models"
                  :key="m.modelId"
                  class="hc-model-selector__item"
                  :class="{ 'hc-model-selector__item--active': selectedModel === m.modelId }"
                  @click="selectModel(m.modelId)"
                >
                  <span class="hc-model-selector__item-name">{{ m.modelName }}</span>
                  <span class="hc-model-selector__caps">
                    <Eye v-if="m.capabilities.includes('vision')" :size="11" class="hc-model-selector__cap-icon hc-model-selector__cap-icon--vision" title="Vision" />
                    <Video v-if="m.capabilities.includes('video')" :size="11" class="hc-model-selector__cap-icon hc-model-selector__cap-icon--video" title="Video" />
                    <Headphones v-if="m.capabilities.includes('audio')" :size="11" class="hc-model-selector__cap-icon hc-model-selector__cap-icon--audio" title="Audio" />
                  </span>
                </button>
              </div>
            </template>
            <div v-else class="hc-model-selector__empty">
              {{ settingsStore.enabledProviders.length > 0 ? '服务商未添加模型，请前往设置添加' : '尚未添加服务商，请前往设置配置' }}
            </div>
          </div>
        </div>

        <!-- Chat params toggle -->
        <button class="hc-chat__toolbar-btn" :title="t('settings.llm.temperature')" @click="showChatParams = !showChatParams" :class="{ 'hc-chat__toolbar-btn--active': showChatParams }">
          <Settings2 :size="14" />
        </button>

        <div style="flex: 1;" />

        <!-- Right actions -->
        <button v-if="chatStore.messages.length > 0" class="hc-chat__toolbar-btn" title="搜索消息 (⌘F)" @click="showSearch = !showSearch">
          <Search :size="14" />
        </button>
        <button v-if="chatStore.messages.length > 0" class="hc-chat__toolbar-btn" title="导出对话" @click="showExport = !showExport">
          <Download :size="14" />
        </button>
        <ChatExportMenu
          v-if="showExport"
          :messages="chatStore.messages"
          @close="showExport = false"
        />

        <!-- Artifacts panel toggle -->
        <button
          class="hc-chat__toolbar-btn"
          :class="{ 'hc-chat__toolbar-btn--active': chatStore.showArtifacts }"
          title="产物面板"
          @click="chatStore.showArtifacts = !chatStore.showArtifacts"
        >
          <PanelRightOpen :size="14" />
          <span v-if="chatStore.artifacts.length > 0" class="hc-chat__artifact-badge">{{ chatStore.artifacts.length }}</span>
        </button>
      </div>

      <!-- Chat params bar -->
      <div v-if="showChatParams" class="hc-chat__params">
        <div class="hc-chat__param">
          <label>Temperature</label>
          <input v-model.number="chatTemperature" type="range" min="0" max="2" step="0.1" class="hc-chat__param-range" />
          <span class="hc-chat__param-val">{{ chatTemperature }}</span>
        </div>
        <div class="hc-chat__param">
          <label>Max Tokens</label>
          <input v-model.number="chatMaxTokens" type="number" min="256" max="128000" step="256" class="hc-input hc-input--sm" style="width: 90px;" />
        </div>
      </div>

      <!-- Search bar -->
      <ChatSearchDialog
        v-if="showSearch"
        :messages="chatStore.messages"
        @close="showSearch = false"
        @scroll-to="scrollToMessage"
      />

      <!-- Messages -->
      <div class="hc-chat__messages">
        <div v-if="chatStore.messages.length === 0 && !chatStore.isCurrentStreaming" class="hc-chat__empty">
          <EmptyState
            :icon="MessageSquarePlus"
            :title="t('chat.startChat')"
            :description="t('chat.startChatDesc')"
          />
        </div>

        <div v-else class="hc-chat__thread">
          <!-- Message list -->
          <div
            v-for="(msg, idx) in chatStore.messages"
            :id="`msg-${msg.id}`"
            :key="msg.id"
            class="hc-msg"
            :class="msg.role === 'user' ? 'hc-msg--user' : 'hc-msg--assistant'"
            @mouseenter="hoveredMsgId = msg.id"
            @mouseleave="hoveredMsgId = null"
            @contextmenu="handleMsgContextMenu($event, idx, msg.role as 'user' | 'assistant')"
          >
            <!-- Assistant message (Feishu style: avatar left + bubble) -->
            <template v-if="msg.role === 'assistant'">
              <div class="hc-msg__avatar">
                <img :src="crabLogo" alt="HC" class="hc-msg__avatar-img" />
                <span class="hc-msg__avatar-badge" />
              </div>
              <div class="hc-msg__body">
                <div class="hc-msg__name">{{ msg.agent_name || '小蟹' }}</div>
                <div class="hc-msg__bubble-wrap">
                  <div class="hc-msg__bubble hc-msg__bubble--assistant" :title="formatFullTime(msg.timestamp)">
                    <MarkdownRenderer :content="msg.content" />
                  </div>
                  <!-- Hover actions toolbar (floating above bubble) -->
                  <div v-show="hoveredMsgId === msg.id" class="hc-msg__actions-float hc-msg__actions-float--left">
                    <MessageActions
                      role="assistant"
                      :content="msg.content"
                      @retry="handleRetry(idx)"
                    />
                  </div>
                </div>
                <!-- Artifact cards for this message -->
                <div v-if="getMessageArtifacts(msg.id).length > 0" class="hc-msg__artifacts">
                  <button
                    v-for="art in getMessageArtifacts(msg.id)"
                    :key="art.id"
                    class="hc-msg__artifact-card"
                    @click="chatStore.selectArtifact(art.id)"
                  >
                    <FileCode :size="13" />
                    <span>{{ art.title }}</span>
                  </button>
                </div>
                <!-- Tool call cards -->
                <div v-if="msg.tool_calls?.length" class="hc-msg__tools">
                  <div v-for="tc in msg.tool_calls" :key="tc.id" class="hc-msg__tool">
                    <div class="hc-msg__tool-head">
                      <Wrench :size="14" />
                      <span class="hc-msg__tool-name">{{ tc.name }}</span>
                    </div>
                    <details v-if="tc.arguments" class="hc-msg__tool-detail">
                      <summary>参数</summary>
                      <pre>{{ tc.arguments }}</pre>
                    </details>
                    <details v-if="tc.result" class="hc-msg__tool-detail">
                      <summary>结果</summary>
                      <pre>{{ tc.result }}</pre>
                    </details>
                  </div>
                </div>
                <div class="hc-msg__time">{{ formatTime(msg.timestamp) }}</div>
              </div>
            </template>

            <!-- User message (Feishu style: right-aligned blue bubble, no avatar) -->
            <template v-else-if="msg.role === 'user'">
              <div class="hc-msg__body hc-msg__body--user">
                <div class="hc-msg__bubble-wrap hc-msg__bubble-wrap--user">
                  <div class="hc-msg__bubble hc-msg__bubble--user" :title="formatFullTime(msg.timestamp)">
                    {{ msg.content }}
                  </div>
                  <!-- Hover actions toolbar -->
                  <div v-show="hoveredMsgId === msg.id" class="hc-msg__actions-float hc-msg__actions-float--right">
                    <MessageActions
                      role="user"
                      :content="msg.content"
                      @edit="handleEdit(idx)"
                    />
                  </div>
                </div>
                <div class="hc-msg__time hc-msg__time--right">{{ formatTime(msg.timestamp) }}</div>
              </div>
            </template>
          </div>

          <!-- Research progress panel -->
          <ResearchProgress
            v-if="isResearchMode && chatStore.isCurrentStreaming"
            :active="chatStore.isCurrentStreaming"
            :content-length="researchStreamingContentLength"
          />

          <!-- Streaming / Typing indicator -->
          <div v-if="chatStore.isCurrentStreaming" class="hc-msg hc-msg--assistant">
            <div class="hc-msg__avatar">
              <img :src="crabLogo" alt="HC" class="hc-msg__avatar-img" />
              <span class="hc-msg__avatar-badge" />
            </div>
            <div class="hc-msg__body">
              <div class="hc-msg__name">小蟹</div>
              <div class="hc-msg__bubble hc-msg__bubble--assistant">
                <MarkdownRenderer
                  v-if="chatStore.isCurrentStreamingContent"
                  :content="chatStore.isCurrentStreamingContent"
                />
                <span v-else class="hc-msg__typing">
                  <span class="hc-msg__typing-icon">&#x2328;&#xFE0F;</span>
                  <span class="hc-msg__typing-text">正在输入...</span>
                </span>
              </div>
            </div>
          </div>

          <div ref="messagesEndRef" />
        </div>
      </div>

      <!-- Input area -->
      <div class="hc-chat__input-area">
        <div class="hc-chat__input-wrap">
          <!-- Attachment preview -->
          <div v-if="attachmentPreview" class="hc-chat__attach-preview">
            <img v-if="attachmentPreview.type === 'image'" :src="attachmentPreview.url" :alt="attachmentPreview.name" class="hc-chat__attach-thumb" />
            <video v-else-if="attachmentPreview.type === 'video'" :src="attachmentPreview.url" class="hc-chat__attach-thumb hc-chat__attach-thumb--video" muted />
            <div v-else class="hc-chat__attach-file-icon">📄</div>
            <div class="hc-chat__attach-info">
              <span class="hc-chat__attach-name">{{ attachmentPreview.name }}</span>
              <span v-if="documentParsing" class="hc-chat__attach-type hc-chat__attach-type--parsing">正在解析文档...</span>
              <span v-else-if="parsedDocument" class="hc-chat__attach-type hc-chat__attach-type--parsed">
                已解析{{ parsedDocument.pageCount ? ` (${parsedDocument.pageCount}页)` : '' }} - {{ parsedDocument.text.length }} 字符
              </span>
              <span v-else class="hc-chat__attach-type">{{ attachmentPreview.type === 'image' ? '图片' : attachmentPreview.type === 'video' ? '视频' : '文件' }}</span>
            </div>
            <button class="hc-chat__attach-remove" @click="clearAttachmentPreview">×</button>
          </div>
          <ChatInput
            ref="chatInputRef"
            :streaming="chatStore.isCurrentStreaming"
            :exec-mode="chatStore.execMode"
            :agents="agentsStore.roles"
            :skills="[]"
            :allow-image="supportsVision"
            :allow-video="supportsVideo"
            @send="handleSend"
            @stop="chatStore.stopStreaming()"
            @file="handleFileUpload"
            @update:exec-mode="chatStore.execMode = $event"
          />
          <div class="hc-chat__input-hint">Enter 发送 · Shift+Enter 换行</div>
        </div>
      </div>
    </div>

    <!-- Message context menu -->
    <ContextMenu ref="msgCtxMenu" :items="msgContextItems" @select="handleMsgCtxAction" />

    <!-- Artifacts Panel (right side) -->
    <ArtifactsPanel
      v-if="chatStore.showArtifacts"
      :artifacts="chatStore.artifacts"
      :selected-id="chatStore.selectedArtifactId"
      @close="chatStore.showArtifacts = false"
      @select="chatStore.selectArtifact($event)"
    />
  </div>
</template>

<style scoped>
.hc-chat {
  display: flex;
  height: 100%;
}

/* ─── Sidebar ───── */
.hc-chat__sidebar {
  width: 260px;
  flex-shrink: 0;
  border-right: 1px solid var(--hc-border-subtle);
  background: var(--hc-bg-sidebar);
  backdrop-filter: saturate(180%) blur(var(--hc-blur));
  -webkit-backdrop-filter: saturate(180%) blur(var(--hc-blur));
  display: flex;
  flex-direction: column;
}

.hc-chat__sidebar-header {
  padding: 14px 14px 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.hc-chat__sidebar-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--hc-text-secondary);
}

.hc-chat__new-btn {
  padding: 5px;
  border-radius: var(--hc-radius-sm);
  border: none;
  background: transparent;
  color: var(--hc-text-secondary);
  cursor: pointer;
  display: flex;
  transition: background 0.15s;
}

.hc-chat__new-btn:hover {
  background: var(--hc-bg-hover);
}

/* ─── Main ───── */
.hc-chat__main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.hc-chat__messages {
  flex: 1;
  overflow-y: auto;
  padding: 24px 16px;
}

.hc-chat__empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.hc-chat__thread {
  max-width: 720px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ─── Messages (Feishu style) ───── */
.hc-msg {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.hc-msg--user {
  justify-content: flex-end;
}

.hc-msg--assistant {
  justify-content: flex-start;
}

/* ─── Avatar ───── */
.hc-msg__avatar {
  position: relative;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  margin-top: 2px;
  border-radius: 50%;
  overflow: hidden;
}

.hc-msg__avatar-img {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
  background: #5B9BD5;
  transform: scale(1.25);
}

.hc-msg__avatar-badge {
  position: absolute;
  bottom: 0;
  right: 0;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #34c759;
  border: 2px solid var(--hc-bg-card, #fff);
  box-sizing: border-box;
}

/* ─── Message body ───── */
.hc-msg__body {
  max-width: 70%;
  min-width: 0;
}

.hc-msg__body--user {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.hc-msg__name {
  font-size: 12px;
  font-weight: 500;
  color: var(--hc-text-muted);
  margin-bottom: 4px;
  padding-left: 2px;
}

/* ─── Bubble wrap (contains bubble + floating actions) ───── */
.hc-msg__bubble-wrap {
  position: relative;
}

.hc-msg__bubble-wrap--user {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

/* ─── Actions floating toolbar ───── */
.hc-msg__actions-float {
  position: absolute;
  top: -36px;
  z-index: var(--hc-z-dropdown);
  animation: hc-actions-fade-in 0.15s ease;
}

.hc-msg__actions-float--left {
  right: 0;
}

.hc-msg__actions-float--right {
  right: 0;
}

@keyframes hc-actions-fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ─── Bubble ───── */
.hc-msg__bubble {
  border-radius: 12px;
  padding: 12px 16px;
  font-size: 14px;
  line-height: 1.6;
  word-break: break-word;
}

.hc-msg__bubble--assistant {
  background: var(--hc-bg-card);
  color: var(--hc-text-primary);
  border: 1px solid var(--hc-border-subtle, var(--hc-border));
  border-top-left-radius: 4px;
}

.hc-msg__bubble--user {
  background: var(--hc-accent);
  color: #fff;
  border-bottom-right-radius: 4px;
}

/* ─── Time ───── */
.hc-msg__time {
  font-size: 11px;
  color: var(--hc-text-muted);
  white-space: nowrap;
  margin-top: 4px;
  padding-left: 2px;
}

.hc-msg__time--right {
  text-align: right;
  padding-left: 0;
  padding-right: 2px;
}

/* ─── Typing indicator (keyboard emoji animation) ───── */
.hc-msg__typing {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
}

.hc-msg__typing-icon {
  font-size: 18px;
  display: inline-block;
  animation: hc-typing-bounce 1s ease-in-out infinite;
}

.hc-msg__typing-text {
  font-size: 13px;
  color: var(--hc-text-muted);
}

@keyframes hc-typing-bounce {
  0%, 100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-3px);
  }
}

/* ─── Mode Tab ───── */
.hc-mode-tab {
  display: flex;
  padding: 2px;
  border-radius: var(--hc-radius-sm);
  background: var(--hc-bg-hover);
  gap: 1px;
}

.hc-mode-tab__btn {
  padding: 3px 10px;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.15s;
}

.hc-mode-tab__btn:hover {
  color: var(--hc-text-secondary);
}

.hc-mode-tab__btn--active {
  background: var(--hc-bg-card);
  color: var(--hc-text-primary);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}

/* ─── Toolbar ───── */
.hc-chat__toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--hc-divider);
  position: relative;
}

.hc-chat__toolbar-btn {
  position: relative;
  padding: 5px;
  border-radius: var(--hc-radius-sm);
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  display: flex;
  transition: background 0.15s, color 0.15s;
}

.hc-chat__toolbar-btn:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}

.hc-chat__toolbar-btn--active {
  color: var(--hc-accent);
}

/* ─── Model Selector ───── */
.hc-model-selector {
  position: relative;
}

.hc-model-selector__btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: var(--hc-radius-sm);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-card);
  color: var(--hc-text-primary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: border-color 0.15s;
}

.hc-model-selector__btn:hover {
  border-color: var(--hc-accent-subtle);
}

.hc-model-selector__name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hc-model-selector__dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 200px;
  max-height: 320px;
  overflow-y: auto;
  border-radius: var(--hc-radius-md);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-card);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  z-index: var(--hc-z-dropdown);
  padding: 4px;
}

.hc-model-selector__group {
  padding: 4px 0;
}

.hc-model-selector__group + .hc-model-selector__group {
  border-top: 1px solid var(--hc-divider);
}

.hc-model-selector__group-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--hc-text-muted);
  padding: 4px 8px 2px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.hc-model-selector__item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  background: transparent;
  color: var(--hc-text-secondary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  border-radius: var(--hc-radius-sm);
  transition: background 0.1s;
}

.hc-model-selector__item-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hc-model-selector__caps {
  display: flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
}

.hc-model-selector__cap-icon {
  opacity: 0.6;
}

.hc-model-selector__cap-icon--vision {
  color: #34c759;
}

.hc-model-selector__cap-icon--video {
  color: #ff9500;
}

.hc-model-selector__cap-icon--audio {
  color: #af52de;
}

.hc-model-selector__btn-caps {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: 2px;
}

.hc-model-selector__item:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}

.hc-model-selector__item--active {
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  font-weight: 500;
}

.hc-model-selector__item--auto {
  display: flex;
  align-items: center;
}

.hc-model-selector__item-hint {
  margin-left: auto;
  font-size: 10px;
  color: var(--hc-text-muted);
}

.hc-model-selector__divider {
  height: 1px;
  background: var(--hc-border);
  margin: 4px 8px;
}

.hc-model-selector__empty {
  padding: 12px;
  text-align: center;
  font-size: 12px;
  color: var(--hc-text-muted);
}

/* ─── Chat Params Bar ───── */
.hc-chat__params {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 6px 16px;
  border-bottom: 1px solid var(--hc-divider);
  background: var(--hc-bg-hover);
}

.hc-chat__param {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--hc-text-secondary);
}

.hc-chat__param label {
  font-weight: 500;
  white-space: nowrap;
}

.hc-chat__param-range {
  width: 80px;
  accent-color: var(--hc-accent);
}

.hc-chat__param-val {
  font-variant-numeric: tabular-nums;
  color: var(--hc-text-muted);
  width: 24px;
  text-align: right;
}

/* ─── Message highlight ───── */
.hc-msg--highlight .hc-msg__bubble {
  box-shadow: 0 0 0 2px var(--hc-accent);
  transition: box-shadow 0.3s;
}

/* ─── Attachment preview ───── */
.hc-chat__attach-preview {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  margin-bottom: 8px;
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-hover);
  border: 1px solid var(--hc-border);
}

.hc-chat__attach-thumb {
  width: 44px;
  height: 44px;
  border-radius: var(--hc-radius-sm);
  object-fit: cover;
  flex-shrink: 0;
}

.hc-chat__attach-thumb--video {
  background: #000;
}

.hc-chat__attach-file-icon {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  background: var(--hc-bg-active);
  border-radius: var(--hc-radius-sm);
  flex-shrink: 0;
}

.hc-chat__attach-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.hc-chat__attach-name {
  font-size: 12px;
  color: var(--hc-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hc-chat__attach-type {
  font-size: 11px;
  color: var(--hc-text-muted);
}

.hc-chat__attach-remove {
  padding: 2px 6px;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  font-size: 16px;
  border-radius: var(--hc-radius-sm);
  flex-shrink: 0;
}

.hc-chat__attach-remove:hover {
  background: var(--hc-bg-active);
  color: var(--hc-error);
}

/* ─── Artifact Badge ───── */
.hc-chat__artifact-badge {
  position: absolute;
  top: -2px;
  right: -4px;
  font-size: 9px;
  font-weight: 700;
  background: var(--hc-accent);
  color: #fff;
  border-radius: 6px;
  padding: 0 4px;
  min-width: 14px;
  height: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

/* ─── Message Artifact Cards ───── */
.hc-msg__artifacts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}

.hc-msg__artifact-card {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: var(--hc-radius-sm);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-card);
  color: var(--hc-accent);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.hc-msg__artifact-card:hover {
  border-color: var(--hc-accent);
  background: var(--hc-accent-subtle);
}

/* ─── Input area ───── */
.hc-chat__input-area {
  padding: 12px 16px 16px;
  border-top: 1px solid var(--hc-divider);
}

.hc-chat__input-wrap {
  max-width: 720px;
  margin: 0 auto;
}

/* ─── Research Mode ───── */
.hc-mode-tab__btn--research.hc-mode-tab__btn--active {
  background: rgba(88, 86, 214, 0.12);
  color: #5856d6;
}

.hc-research-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 8px;
  background: rgba(88, 86, 214, 0.12);
  color: #5856d6;
  white-space: nowrap;
}

/* ─── Document Parsing States ───── */
.hc-chat__attach-type--parsing {
  color: var(--hc-accent) !important;
  animation: hc-parsing-pulse 1.5s ease-in-out infinite;
}

.hc-chat__attach-type--parsed {
  color: #34c759 !important;
}

@keyframes hc-parsing-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* ─── Token Badge ───── */
.hc-token-badge {
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 8px;
  background: var(--hc-bg-hover);
  color: var(--hc-text-muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

/* ─── Input Hint ───── */
.hc-chat__input-hint {
  text-align: center;
  font-size: 11px;
  color: var(--hc-text-muted);
  margin-top: 6px;
  opacity: 0.7;
}
</style>
