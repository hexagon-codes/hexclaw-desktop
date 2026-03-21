<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted, watch, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  MessageSquarePlus,
  Search,
  Download,
  ChevronDown,
  Settings2,
  PanelRightOpen,
  FileCode,
  Eye,
  Video,
  Headphones,
  Wrench,
  Zap,
  BookOpen,
  ExternalLink,
} from 'lucide-vue-next'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import { useAppStore } from '@/stores/app'
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
import { getSkills, type Skill } from '@/api/skills'
import crabLogo from '@/assets/logo-crab.png'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const chatStore = useChatStore()
const agentsStore = useAgentsStore()
const settingsStore = useSettingsStore()

const messagesEndRef = ref<HTMLDivElement>()
const chatInputRef = ref<InstanceType<typeof ChatInput>>()
const showSessions = ref(true)
const hoveredMsgId = ref<string | null>(null)
const showSearch = ref(false)
const showExport = ref(false)
const attachmentPreview = ref<{
  url: string
  name: string
  type: 'image' | 'video' | 'file'
  file: File
} | null>(null)
const showModelSelector = ref(false)
const chatViewTab = ref<'chat' | 'artifacts' | 'history'>('chat')
const availableSkills = ref<Skill[]>([])

const chatViewSegments = computed(() => [
  { key: 'chat', label: t('chat.modeChat') },
  { key: 'artifacts', label: t('chat.artifacts') },
  { key: 'history', label: t('chat.history', 'History') },
])

const activeSession = computed(
  () => chatStore.sessions.find((session) => session.id === chatStore.currentSessionId) ?? null,
)

const activeAgent = computed(
  () => agentsStore.roles.find((role) => role.name === chatStore.agentRole) ?? null,
)

const activeAgentTitle = computed(
  () => activeAgent.value?.title || chatStore.agentRole || t('chat.title'),
)

const activeAgentSummary = computed(() => {
  if (activeAgent.value?.goal) return activeAgent.value.goal
  if (activeSession.value?.title) return activeSession.value.title
  return t('chat.localFirstHint')
})

const activeSkillCount = computed(
  () => activeAgent.value?.tools?.length || availableSkills.value.length || 0,
)

// Message context menu
const msgCtxMenu = ref<InstanceType<typeof ContextMenu>>()
const ctxMsgIndex = ref(-1)
const ctxMsgRole = ref<'user' | 'assistant'>('user')

const msgContextItems = computed<ContextMenuItem[]>(() => {
  const items: ContextMenuItem[] = [{ id: 'copy', label: t('chat.copyMessage'), icon: undefined }]
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

const selectedProviderName = computed(() => {
  const found = settingsStore.availableModels.find((m) => m.modelId === selectedModel.value)
  return found?.providerName || ''
})

// 按 Provider 分组的模型列表
const groupedModels = computed(() => {
  const groups: Record<
    string,
    {
      providerName: string
      models: {
        modelId: string
        modelName: string
        capabilities: import('@/types').ModelCapability[]
      }[]
    }
  > = {}
  for (const m of settingsStore.availableModels) {
    if (!groups[m.providerId]) {
      groups[m.providerId] = { providerName: m.providerName, models: [] }
    }
    groups[m.providerId]!.models.push({
      modelId: m.modelId,
      modelName: m.modelName,
      capabilities: m.capabilities,
    })
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
  isResearchMode.value && chatStore.isCurrentStreaming
    ? (chatStore.isCurrentStreamingContent?.length ?? 0)
    : 0,
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

function openArtifactInNewWindow() {
  const art = chatStore.artifacts.find((a) => a.id === chatStore.selectedArtifactId)
  if (!art) return
  const w = window.open('', '_blank', 'width=800,height=600')
  if (!w) return
  w.document.write(art.content)
  w.document.close()
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
  getSkills()
    .then((r) => {
      availableSkills.value = r.skills || []
    })
    .catch(() => {})

  // 从 Agent 管理页跳转过来：复用已有同角色会话 或 新建
  const roleQuery = route.query.role as string | undefined
  const roleTitleQuery = route.query.roleTitle as string | undefined
  if (roleQuery) {
    const roleTitle = roleTitleQuery || roleQuery
    // 查找是否已有同名会话
    const existing = chatStore.sessions.find((s) => s.title === roleTitle)
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

  if (!roleQuery) {
    chatStore.agentRole = settingsStore.config?.general.defaultAgentRole || 'assistant'
  }

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

function handleLike(msgId: string) {
  const msg = chatStore.messages.find((m) => m.id === msgId)
  if (msg) {
    if (!msg.metadata) msg.metadata = {}
    msg.metadata.user_feedback = msg.metadata.user_feedback === 'like' ? null : 'like'
  }
}

function handleDislike(msgId: string) {
  const msg = chatStore.messages.find((m) => m.id === msgId)
  if (msg) {
    if (!msg.metadata) msg.metadata = {}
    msg.metadata.user_feedback = msg.metadata.user_feedback === 'dislike' ? null : 'dislike'
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

watch(
  () => chatStore.messages.length,
  () => {
    nextTick(scrollToBottom)
  },
)

watch(
  () => chatStore.isCurrentStreamingContent,
  () => {
    nextTick(scrollToBottom)
  },
)

// 参数变更时同步到 chatStore
watch([() => chatTemperature.value, () => chatMaxTokens.value], syncChatParams)

function newSession() {
  if (chatStore.chatMode !== 'research') {
    chatStore.agentRole = settingsStore.config?.general.defaultAgentRole || 'assistant'
  }
  chatStore.newSession()
}

function openHistorySession(sessionId: string) {
  chatStore.selectSession(sessionId)
  chatViewTab.value = 'chat'
}

function metadataValue(message: import('@/types').ChatMessage, key: string): string | null {
  const value = message.metadata?.[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function normalizeHitList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    : []
}

function getKnowledgeHits(message: import('@/types').ChatMessage) {
  return normalizeHitList(message.metadata?.knowledge_hits)
}

function getMemoryHits(message: import('@/types').ChatMessage) {
  return normalizeHitList(message.metadata?.memory_hits)
}

function getHitTitle(hit: Record<string, unknown>) {
  const docTitle = typeof hit.doc_title === 'string' ? hit.doc_title : ''
  const source = typeof hit.source === 'string' ? hit.source : ''
  return docTitle || source || t('chat.knowledgeHit')
}

function getHitSubtitle(hit: Record<string, unknown>) {
  const parts: string[] = []
  if (typeof hit.source === 'string' && hit.source) parts.push(hit.source)
  if (typeof hit.chunk_index === 'number') {
    const chunkCount = typeof hit.chunk_count === 'number' ? `/${hit.chunk_count}` : ''
    parts.push(`${t('knowledge.chunk')} ${hit.chunk_index + 1}${chunkCount}`)
  }
  return parts.join(' · ')
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
      <!-- Compact toolbar -->
      <div class="hc-chat__toolbar">
        <div class="hc-chat__toolbar-row">
          <!-- Chat / Artifacts / History segmented control -->
          <SegmentedControl v-model="chatViewTab" :segments="chatViewSegments" />

          <div class="hc-chat__stat-strip">
            <!-- Chat mode toggle -->
            <button
              class="hc-chat__mode-btn"
              :class="{ 'hc-chat__mode-btn--active': chatStore.chatMode === 'research' }"
              :title="t('chat.researchMode', 'Research Mode')"
              @click="chatStore.chatMode = chatStore.chatMode === 'research' ? 'chat' : 'research'"
            >
              <BookOpen :size="12" />
              {{ t('chat.research', 'Research') }}
            </button>
            <span class="hc-chat__stat-pill"
              >{{ chatStore.messages.length }} {{ t('chat.messagesStat') }}</span
            >
            <span class="hc-chat__stat-pill"
              >{{ chatStore.artifacts.length }} {{ t('chat.artifactsStat') }}</span
            >
            <span class="hc-chat__stat-pill"
              >{{ activeSkillCount }} {{ t('chat.skillsStat') }}</span
            >
            <span
              v-if="chatStore.messages.length > 0"
              class="hc-token-badge"
              :title="t('chat.aboutTokens', { n: estimatedTokens })"
            >
              ~{{ formatTokenCount(estimatedTokens) }} tok
            </span>
          </div>

          <!-- Model selector -->
          <div class="hc-model-selector">
            <button class="hc-model-selector__btn" @click="showModelSelector = !showModelSelector">
              <span class="hc-model-selector__name">{{ selectedModelDisplay }}</span>
              <span v-if="supportsVision || supportsVideo" class="hc-model-selector__btn-caps">
                <Eye
                  v-if="supportsVision"
                  :size="11"
                  class="hc-model-selector__cap-icon hc-model-selector__cap-icon--vision"
                />
                <Video
                  v-if="supportsVideo"
                  :size="11"
                  class="hc-model-selector__cap-icon hc-model-selector__cap-icon--video"
                />
              </span>
              <ChevronDown :size="13" />
            </button>

            <!-- Dropdown -->
            <div
              v-if="showModelSelector"
              class="hc-model-selector__dropdown"
              @mouseleave="showModelSelector = false"
            >
              <!-- Auto 选项 -->
              <button
                class="hc-model-selector__item hc-model-selector__item--auto"
                :class="{ 'hc-model-selector__item--active': selectedModel === 'auto' }"
                @click="selectModel('auto')"
              >
                <Zap :size="12" style="color: var(--hc-accent); margin-right: 4px" />
                <span class="hc-model-selector__item-name">Auto</span>
                <span class="hc-model-selector__item-hint">{{ t('chat.autoMode') }}</span>
              </button>
              <div class="hc-model-selector__divider" />
              <template v-if="Object.keys(groupedModels).length > 0">
                <div
                  v-for="(group, pid) in groupedModels"
                  :key="pid"
                  class="hc-model-selector__group"
                >
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
                      <Eye
                        v-if="m.capabilities.includes('vision')"
                        :size="11"
                        class="hc-model-selector__cap-icon hc-model-selector__cap-icon--vision"
                        title="Vision"
                      />
                      <Video
                        v-if="m.capabilities.includes('video')"
                        :size="11"
                        class="hc-model-selector__cap-icon hc-model-selector__cap-icon--video"
                        title="Video"
                      />
                      <Headphones
                        v-if="m.capabilities.includes('audio')"
                        :size="11"
                        class="hc-model-selector__cap-icon hc-model-selector__cap-icon--audio"
                        title="Audio"
                      />
                    </span>
                  </button>
                </div>
              </template>
              <div v-else class="hc-model-selector__empty">
                {{
                  settingsStore.enabledProviders.length > 0
                    ? t('chat.noModels')
                    : t('settings.llm.noProvidersDesc')
                }}
              </div>
            </div>
          </div>

          <!-- Chat params toggle -->
          <button
            class="hc-chat__toolbar-btn"
            :title="t('settings.llm.temperature')"
            @click="showChatParams = !showChatParams"
            :class="{ 'hc-chat__toolbar-btn--active': showChatParams }"
          >
            <Settings2 :size="14" />
          </button>

          <div style="flex: 1" />

          <!-- Right actions -->
          <button
            v-if="chatStore.messages.length > 0"
            class="hc-chat__toolbar-btn"
            :title="t('common.search') + ' (⌘F)'"
            @click="showSearch = !showSearch"
          >
            <Search :size="14" />
          </button>
          <button
            v-if="chatStore.messages.length > 0"
            class="hc-chat__toolbar-btn"
            :title="t('common.download')"
            @click="showExport = !showExport"
          >
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
            :title="t('chat.artifacts')"
            @click="chatStore.showArtifacts = !chatStore.showArtifacts"
          >
            <PanelRightOpen :size="14" />
            <span v-if="chatStore.artifacts.length > 0" class="hc-chat__artifact-badge">{{
              chatStore.artifacts.length
            }}</span>
          </button>

          <span class="hc-chat__toolbar-sep" />

          <!-- Session list toggle -->
          <button
            class="hc-chat__toolbar-btn"
            :class="{ 'hc-chat__toolbar-btn--active': showSessions }"
            :title="t('chat.toggleSessions')"
            @click="showSessions = !showSessions"
          >
            <MessageSquarePlus :size="14" />
          </button>

          <!-- Context panel toggle -->
          <button
            class="hc-chat__toolbar-btn"
            :title="t('chat.contextPanel')"
            @click="appStore.toggleDetailPanel"
          >
            <PanelRightOpen :size="14" />
          </button>
        </div>
      </div>

      <!-- Chat params bar -->
      <div v-if="showChatParams" class="hc-chat__params">
        <div class="hc-chat__param">
          <label>Temperature</label>
          <input
            v-model.number="chatTemperature"
            type="range"
            min="0"
            max="2"
            step="0.1"
            class="hc-chat__param-range"
          />
          <span class="hc-chat__param-val">{{ chatTemperature }}</span>
        </div>
        <div class="hc-chat__param">
          <label>Max Tokens</label>
          <input
            v-model.number="chatMaxTokens"
            type="number"
            min="256"
            max="128000"
            step="256"
            class="hc-input hc-input--sm"
            style="width: 90px"
          />
        </div>
      </div>

      <!-- Search bar -->
      <ChatSearchDialog
        v-if="showSearch"
        :messages="chatStore.messages"
        @close="showSearch = false"
        @scroll-to="scrollToMessage"
      />

      <!-- ═══ Chat Tab ═══ -->
      <template v-if="chatViewTab === 'chat'">
        <!-- Messages -->
        <div class="hc-chat__messages">
          <div
            v-if="chatStore.messages.length === 0 && !chatStore.isCurrentStreaming"
            class="hc-chat__empty"
          >
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
                  <div class="hc-msg__name">{{ msg.agent_name || t('chat.botName') }}</div>
                  <div class="hc-msg__bubble-wrap">
                    <div
                      class="hc-msg__bubble hc-msg__bubble--assistant"
                      :title="formatFullTime(msg.timestamp)"
                    >
                      <MarkdownRenderer :content="msg.content" />
                    </div>
                    <div
                      v-show="hoveredMsgId === msg.id"
                      class="hc-msg__actions-float hc-msg__actions-float--left"
                    >
                      <MessageActions
                        role="assistant"
                        :content="msg.content"
                        @retry="handleRetry(idx)"
                        @like="handleLike(msg.id)"
                        @dislike="handleDislike(msg.id)"
                      />
                    </div>
                  </div>
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
                  <div
                    v-if="
                      metadataValue(msg, 'provider') ||
                      metadataValue(msg, 'model') ||
                      metadataValue(msg, 'route_source')
                    "
                    class="hc-msg__meta"
                  >
                    <span v-if="metadataValue(msg, 'provider')" class="hc-msg__meta-tag">
                      {{ t('chat.provider') }}: {{ metadataValue(msg, 'provider') }}
                    </span>
                    <span v-if="metadataValue(msg, 'model')" class="hc-msg__meta-tag">
                      {{ t('chat.model') }}: {{ metadataValue(msg, 'model') }}
                    </span>
                    <span v-if="metadataValue(msg, 'route_source')" class="hc-msg__meta-tag">
                      {{ t('chat.routeSource') }}: {{ metadataValue(msg, 'route_source') }}
                    </span>
                  </div>
                  <div
                    v-if="
                      msg.metadata?.knowledge_hits ||
                      msg.metadata?.memory_hits ||
                      msg.metadata?.routed_agent
                    "
                    class="hc-msg__sources"
                  >
                    <span
                      v-if="msg.metadata?.knowledge_hits"
                      class="hc-msg__source-tag hc-msg__source-tag--knowledge"
                      :title="t('chat.knowledgeHit')"
                    >
                      <BookOpen :size="11" /> {{ t('chat.knowledgeHit') }}
                    </span>
                    <span
                      v-if="msg.metadata?.memory_hits"
                      class="hc-msg__source-tag hc-msg__source-tag--memory"
                      :title="t('chat.memoryHit')"
                    >
                      <Zap :size="11" /> {{ t('chat.memoryHit') }}
                    </span>
                    <span
                      v-if="msg.metadata?.routed_agent"
                      class="hc-msg__source-tag hc-msg__source-tag--agent"
                    >
                      {{ msg.metadata.routed_agent }}
                    </span>
                  </div>
                  <div v-if="getKnowledgeHits(msg).length > 0" class="hc-msg__hit-list">
                    <div
                      v-for="(hit, hitIdx) in getKnowledgeHits(msg)"
                      :key="`knowledge-${msg.id}-${hitIdx}`"
                      class="hc-msg__hit"
                    >
                      <div class="hc-msg__hit-title">{{ getHitTitle(hit) }}</div>
                      <div v-if="getHitSubtitle(hit)" class="hc-msg__hit-subtitle">
                        {{ getHitSubtitle(hit) }}
                      </div>
                    </div>
                  </div>
                  <div v-if="getMemoryHits(msg).length > 0" class="hc-msg__hit-list">
                    <div
                      v-for="(hit, hitIdx) in getMemoryHits(msg)"
                      :key="`memory-${msg.id}-${hitIdx}`"
                      class="hc-msg__hit"
                    >
                      <div class="hc-msg__hit-title">
                        {{ typeof hit.content === 'string' ? hit.content : t('chat.memoryHit') }}
                      </div>
                      <div
                        v-if="typeof hit.source === 'string' && hit.source"
                        class="hc-msg__hit-subtitle"
                      >
                        {{ hit.source }}
                      </div>
                    </div>
                  </div>

                  <div v-if="msg.tool_calls?.length" class="hc-msg__tools">
                    <div v-for="tc in msg.tool_calls" :key="tc.id" class="hc-msg__tool">
                      <div class="hc-msg__tool-head">
                        <Wrench :size="14" />
                        <span class="hc-msg__tool-name">{{ tc.name }}</span>
                      </div>
                      <details v-if="tc.arguments" class="hc-msg__tool-detail">
                        <summary>{{ t('chat.toolParams') }}</summary>
                        <pre>{{ tc.arguments }}</pre>
                      </details>
                      <details v-if="tc.result" class="hc-msg__tool-detail">
                        <summary>{{ t('chat.toolResult') }}</summary>
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
                    <div
                      class="hc-msg__bubble hc-msg__bubble--user"
                      :title="formatFullTime(msg.timestamp)"
                    >
                      {{ msg.content }}
                    </div>
                    <!-- Hover actions toolbar -->
                    <div
                      v-show="hoveredMsgId === msg.id"
                      class="hc-msg__actions-float hc-msg__actions-float--right"
                    >
                      <MessageActions role="user" :content="msg.content" @edit="handleEdit(idx)" />
                    </div>
                  </div>
                  <div class="hc-msg__time hc-msg__time--right">
                    {{ formatTime(msg.timestamp) }}
                  </div>
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
                <div class="hc-msg__name">{{ t('chat.botName') }}</div>
                <div class="hc-msg__bubble hc-msg__bubble--assistant">
                  <MarkdownRenderer
                    v-if="chatStore.isCurrentStreamingContent"
                    :content="chatStore.isCurrentStreamingContent"
                  />
                  <span v-else class="hc-typing-dots">
                    <span class="hc-typing-dots__dot" />
                    <span class="hc-typing-dots__dot" />
                    <span class="hc-typing-dots__dot" />
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
              <img
                v-if="attachmentPreview.type === 'image'"
                :src="attachmentPreview.url"
                :alt="attachmentPreview.name"
                class="hc-chat__attach-thumb"
              />
              <video
                v-else-if="attachmentPreview.type === 'video'"
                :src="attachmentPreview.url"
                class="hc-chat__attach-thumb hc-chat__attach-thumb--video"
                muted
              />
              <div v-else class="hc-chat__attach-file-icon">📄</div>
              <div class="hc-chat__attach-info">
                <span class="hc-chat__attach-name">{{ attachmentPreview.name }}</span>
                <span
                  v-if="documentParsing"
                  class="hc-chat__attach-type hc-chat__attach-type--parsing"
                  >{{ t('chat.parsingDoc') }}</span
                >
                <span
                  v-else-if="parsedDocument"
                  class="hc-chat__attach-type hc-chat__attach-type--parsed"
                >
                  {{ t('chat.parsedDoc')
                  }}{{ parsedDocument.pageCount ? ` (${parsedDocument.pageCount}p)` : '' }} -
                  {{ parsedDocument.text.length }} {{ t('chat.parsedChars') }}
                </span>
                <span v-else class="hc-chat__attach-type">{{
                  attachmentPreview.type === 'image'
                    ? t('chat.fileImage')
                    : attachmentPreview.type === 'video'
                      ? t('chat.fileVideo')
                      : t('chat.fileGeneric')
                }}</span>
              </div>
              <button class="hc-chat__attach-remove" @click="clearAttachmentPreview">×</button>
            </div>
            <div
              v-if="!attachmentPreview"
              class="hc-chat-attach-zone"
              @click="chatInputRef?.triggerFileUpload?.()"
            >
              <span>📎</span>
              <span class="hc-chat-attach-zone__label">{{
                t('chat.attachHint', '拖拽文件到此处或点击添加附件')
              }}</span>
            </div>
            <ChatInput
              ref="chatInputRef"
              :streaming="chatStore.isCurrentStreaming"
              :exec-mode="chatStore.execMode"
              :agents="agentsStore.roles"
              :skills="availableSkills"
              :allow-image="supportsVision"
              :allow-video="supportsVideo"
              @send="handleSend"
              @stop="chatStore.stopStreaming()"
              @file="handleFileUpload"
              @update:exec-mode="chatStore.execMode = $event"
            />
            <!-- Composer chips -->
            <div class="hc-chat__composer-chips">
              <span v-if="selectedProviderName" class="hc-chat__chip"
                >{{ t('chat.provider') }}：{{ selectedProviderName }}</span
              >
              <span v-if="selectedModelDisplay" class="hc-chat__chip"
                >{{ t('chat.model') }}：{{ selectedModelDisplay }}</span
              >
              <span v-if="chatStore.agentRole" class="hc-chat__chip"
                >{{ t('chat.modeAgent') }}：{{ chatStore.agentRole }}</span
              >
            </div>
            <div class="hc-chat__input-hint">{{ t('chat.inputHint') }}</div>
          </div>
        </div>
      </template>

      <!-- ═══ Artifacts Tab ═══ -->
      <template v-else-if="chatViewTab === 'artifacts'">
        <div class="hc-chat__tab-content">
          <div class="hc-chat__artifacts-view">
            <div class="hc-chat__artifacts-list">
              <div class="hc-chat__artifacts-heading">
                {{ t('chat.currentArtifacts', '当前产物') }}
              </div>
              <template v-if="chatStore.artifacts.length > 0">
                <div
                  v-for="art in chatStore.artifacts"
                  :key="art.id"
                  class="hc-chat__artifact-row"
                  :class="{
                    'hc-chat__artifact-row--active': chatStore.selectedArtifactId === art.id,
                  }"
                  @click="chatStore.selectArtifact(art.id)"
                >
                  <FileCode :size="14" class="hc-chat__artifact-row-icon" />
                  <div class="hc-chat__artifact-row-info">
                    <div class="hc-chat__artifact-row-title">{{ art.title }}</div>
                    <div class="hc-chat__artifact-row-lang">{{ art.language }}</div>
                  </div>
                </div>
              </template>
              <div v-else class="hc-chat__artifacts-empty">
                {{ t('chat.noArtifacts', '暂无产物') }}
              </div>
            </div>
            <div v-if="chatStore.selectedArtifactId" class="hc-chat__artifact-detail">
              <div class="hc-chat__artifact-detail-bar">
                <span>{{
                  chatStore.artifacts.find((a) => a.id === chatStore.selectedArtifactId)?.title
                }}</span>
                <button
                  class="hc-chat__toolbar-btn"
                  :title="t('common.openInNewWindow', '在新窗口打开')"
                  @click="openArtifactInNewWindow"
                >
                  <ExternalLink :size="13" />
                </button>
              </div>
              <pre class="hc-chat__artifact-detail-code">{{
                chatStore.artifacts.find((a) => a.id === chatStore.selectedArtifactId)?.content
              }}</pre>
            </div>
          </div>
        </div>
      </template>

      <!-- ═══ History Tab ═══ -->
      <template v-else-if="chatViewTab === 'history'">
        <div class="hc-chat__tab-content">
          <div class="hc-chat__history-view">
            <div class="hc-chat__history-heading">{{ t('chat.history', 'History') }}</div>
            <template v-if="chatStore.sessions.length > 0">
              <div
                v-for="session in chatStore.sessions"
                :key="session.id"
                class="hc-chat__history-row"
                :class="{
                  'hc-chat__history-row--active': chatStore.currentSessionId === session.id,
                }"
                @click="openHistorySession(session.id)"
              >
                <div class="hc-chat__history-row-title">
                  {{ session.title || t('chat.newSession') }}
                </div>
                <div class="hc-chat__history-row-meta">{{ formatTime(session.updated_at) }}</div>
              </div>
            </template>
            <div v-else class="hc-chat__history-empty">
              {{ t('chat.noSessions', '暂无历史会话') }}
            </div>
          </div>
        </div>
      </template>
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
  width: 220px;
  flex-shrink: 0;
  border-right: 1px solid var(--hc-border-subtle);
  background: var(--hc-bg-sidebar);
  backdrop-filter: saturate(180%) blur(var(--hc-blur));
  -webkit-backdrop-filter: saturate(180%) blur(var(--hc-blur));
  display: flex;
  flex-direction: column;
}

.hc-chat__sidebar-header {
  padding: 10px 12px 6px;
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
  padding: 12px 16px;
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
  background: #5b9bd5;
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
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
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
  0%,
  100% {
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
  flex-direction: column;
  gap: 0;
  padding: 0 14px;
  border-bottom: 1px solid var(--hc-divider);
  position: relative;
  flex-shrink: 0;
}

.hc-chat__toolbar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  flex-wrap: nowrap;
}

.hc-chat__toolbar-sep {
  width: 1px;
  height: 16px;
  background: var(--hc-border);
  flex-shrink: 0;
}

.hc-chat__stat-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.hc-chat__stat-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--hc-bg-card);
  border: 1px solid var(--hc-border);
  font-size: 11px;
  font-weight: 600;
  color: var(--hc-text-muted);
}

.hc-chat__mode-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-card);
  font-size: 11px;
  font-weight: 600;
  color: var(--hc-text-muted);
  cursor: pointer;
  transition: all 0.15s;
}

.hc-chat__mode-btn:hover {
  color: var(--hc-text-secondary);
  border-color: var(--hc-accent);
}

.hc-chat__mode-btn--active {
  background: rgba(88, 86, 214, 0.12);
  color: #5856d6;
  border-color: rgba(88, 86, 214, 0.3);
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
  transition:
    background 0.15s,
    color 0.15s;
}

.hc-chat__toolbar-btn:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}

.hc-chat__toolbar-btn--active {
  color: var(--hc-accent);
}

/* ─── Context Tags ─── */
.hc-context-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 500;
}

.hc-context-tag--agent {
  background: rgba(139, 92, 246, 0.12);
  color: #8b5cf6;
}

.hc-context-tag--provider {
  background: rgba(14, 165, 233, 0.12);
  color: #0284c7;
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
  padding: 8px 16px 10px;
  border-top: 1px solid var(--hc-divider);
  flex-shrink: 0;
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
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
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

/* ─── Knowledge/Memory source tags ───── */
.hc-msg__sources {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

.hc-msg__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}

.hc-msg__meta-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 6px;
  border-radius: 6px;
  background: var(--hc-bg-hover);
  color: var(--hc-text-secondary);
  font-size: 10px;
  font-weight: 500;
}

.hc-msg__source-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 6px;
}

.hc-msg__source-tag--knowledge {
  background: rgba(59, 130, 246, 0.12);
  color: #3b82f6;
}

.hc-msg__source-tag--memory {
  background: rgba(168, 85, 247, 0.12);
  color: #a855f7;
}

.hc-msg__source-tag--agent {
  background: rgba(139, 92, 246, 0.12);
  color: #8b5cf6;
}

.hc-msg__hit-list {
  display: grid;
  gap: 6px;
  margin-top: 6px;
}

.hc-msg__hit {
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--hc-bg-hover);
  border: 1px solid var(--hc-border);
}

.hc-msg__hit-title {
  font-size: 11px;
  color: var(--hc-text-primary);
  line-height: 1.4;
}

.hc-msg__hit-subtitle {
  margin-top: 2px;
  font-size: 10px;
  color: var(--hc-text-muted);
}

/* ─── Composer Chips ───── */
.hc-chat__composer-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

.hc-chat__chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 500;
  background: var(--hc-bg-hover);
  color: var(--hc-text-secondary);
  border: 1px solid var(--hc-border);
  cursor: default;
  transition: background 0.15s;
}

.hc-chat__chip:hover {
  background: var(--hc-bg-active);
}

/* ─── Input Hint ───── */
.hc-chat__input-hint {
  text-align: center;
  font-size: 10px;
  color: var(--hc-text-muted);
  margin-top: 3px;
  opacity: 0.7;
}

/* ─── Tab Content (Artifacts / History) ───── */
.hc-chat__tab-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px 16px;
}

.hc-chat__artifacts-view {
  display: flex;
  gap: 16px;
  max-width: 900px;
  margin: 0 auto;
  height: 100%;
}

.hc-chat__artifacts-list {
  width: 280px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.hc-chat__artifacts-heading,
.hc-chat__history-heading {
  font-size: 14px;
  font-weight: 600;
  color: var(--hc-text-primary);
  margin-bottom: 12px;
}

.hc-chat__artifact-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--hc-radius-md);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-card);
  cursor: pointer;
  transition: all 0.15s;
}

.hc-chat__artifact-row:hover {
  border-color: var(--hc-accent-subtle);
}

.hc-chat__artifact-row--active {
  border-color: var(--hc-accent);
  background: var(--hc-accent-subtle);
}

.hc-chat__artifact-row-icon {
  color: var(--hc-accent);
  flex-shrink: 0;
}

.hc-chat__artifact-row-info {
  min-width: 0;
}

.hc-chat__artifact-row-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hc-chat__artifact-row-lang {
  font-size: 11px;
  color: var(--hc-text-muted);
  margin-top: 2px;
}

.hc-chat__artifacts-empty,
.hc-chat__history-empty {
  padding: 24px;
  text-align: center;
  color: var(--hc-text-muted);
  font-size: 13px;
}

.hc-chat__artifact-detail {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-card);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.hc-chat__artifact-detail-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--hc-divider);
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-primary);
}

.hc-chat__artifact-detail-code {
  flex: 1;
  overflow: auto;
  padding: 12px;
  margin: 0;
  font-family: var(--hc-font-mono, 'SF Mono', monospace);
  font-size: 12px;
  line-height: 1.5;
  color: var(--hc-text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
}

/* ─── History View ───── */
.hc-chat__history-view {
  max-width: 600px;
  margin: 0 auto;
}

.hc-chat__history-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-radius: var(--hc-radius-md);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-card);
  margin-bottom: 6px;
  cursor: pointer;
  transition: all 0.15s;
}

.hc-chat__history-row:hover {
  border-color: var(--hc-accent-subtle);
}

.hc-chat__history-row--active {
  border-color: var(--hc-accent);
  background: var(--hc-accent-subtle);
}

.hc-chat__history-row-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-primary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hc-chat__history-row-meta {
  font-size: 11px;
  color: var(--hc-text-muted);
  white-space: nowrap;
  flex-shrink: 0;
  margin-left: 12px;
}

@media (max-width: 860px) {
  .hc-chat__toolbar {
    padding: 0 10px;
  }

  .hc-chat__toolbar-row {
    gap: 6px;
  }

  .hc-chat__stat-strip {
    display: none;
  }
}
</style>
