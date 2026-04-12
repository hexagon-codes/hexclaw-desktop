<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted, watch, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  ChevronDown,
  ChevronUp,
  FileCode,
  MessageSquarePlus,
  Wrench,
  Zap,
  BookOpen,
  ExternalLink,
  Brain,
} from 'lucide-vue-next'
import { useChatStore } from '@/stores/chat'
import { removeMessage } from '@/services/messageService'
import { useAgentsStore } from '@/stores/agents'
import { useSettingsStore } from '@/stores/settings'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import MessageActions from '@/components/chat/MessageActions.vue'
import ChatInput from '@/components/chat/ChatInput.vue'
import SessionList from '@/components/chat/SessionList.vue'
import ChatSearchDialog from '@/components/chat/ChatSearchDialog.vue'
import ChatToolbar from '@/components/chat/ChatToolbar.vue'
import ResearchProgress from '@/components/chat/ResearchProgress.vue'
import AgentBadge from '@/components/chat/AgentBadge.vue'
import ToolApprovalCard from '@/components/chat/ToolApprovalCard.vue'
import ArtifactsPanel from '@/components/artifacts/ArtifactsPanel.vue'
import ContextMenu from '@/components/common/ContextMenu.vue'
import type { ContextMenuItem } from '@/components/common/ContextMenu.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { useToast, useConversationAutomation, useChatSend, useChatActions } from '@/composables'
import { isDocumentFile, parseDocument } from '@/utils/file-parser'
import { waitForOllamaModelVisibility } from '@/utils/ollama-visibility'
import { openSanitizedArtifact } from '@/utils/safe-html'
import { normalizeAssistantReasoning } from '@/utils/assistant-reply'
import { getSkills, type Skill } from '@/api/skills'
import { setClipboard } from '@/api/desktop'
import type { ChatAttachment, ChatMessage } from '@/types'
import crabLogo from '@/assets/logo-crab.png'

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const chatStore = useChatStore()
const agentsStore = useAgentsStore()
const settingsStore = useSettingsStore()
const toast = useToast()
const QUERY_MODEL_RETRY_INTERVAL = 1000
const QUERY_MODEL_RETRY_TIMES = 4
let queryModelSelectionAbort: AbortController | null = null
const streamingReasoningDisplay = computed(() =>
  normalizeAssistantReasoning(chatStore.isCurrentStreamingReasoning, { trim: false }),
)

const messagesEndRef = ref<HTMLDivElement>()
const messagesContainerRef = ref<HTMLDivElement>()
const thinkingContentRef = ref<HTMLDivElement>()
const showScrollToBottom = ref(false)
const showScrollToTop = ref(false)
const userScrolledUp = ref(false)
const showSessions = ref(true)
const sidebarWidth = ref(260)
const hoveredMsgId = ref<string | null>(null)
let hoverTimer: ReturnType<typeof setTimeout> | null = null
const SIDEBAR_WIDTH_STORAGE_KEY = 'hexclaw_chat_sidebar_width'
const SIDEBAR_MIN_WIDTH = 260
const SIDEBAR_MAX_WIDTH = 420
const sidebarResizing = ref(false)
let sidebarDragging = false
let sidebarDragStartX = 0
let sidebarDragStartWidth = 0
let sidebarRafId = 0
let bodyCursorBeforeDrag = ''
let bodyUserSelectBeforeDrag = ''

function delayedClearHover() {
  if (hoverTimer) clearTimeout(hoverTimer)
  hoverTimer = setTimeout(() => { hoveredMsgId.value = null; hoverTimer = null }, 150)
}

function setHoveredMsg(id: string) {
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null }
  hoveredMsgId.value = id
}

onUnmounted(() => { if (hoverTimer) clearTimeout(hoverTimer) })
const showSearch = ref(false)
const attachmentPreview = ref<{
  url: string
  name: string
  type: 'image' | 'video' | 'file'
  file: File
} | null>(null)
const showModelSelector = ref(false)
const isDragging = ref(false)
const chatViewTab = ref<'chat' | 'artifacts' | 'history'>('chat')
const availableSkills = ref<Skill[]>([])

// Message context menu
const msgCtxMenu = ref<InstanceType<typeof ContextMenu>>()
const ctxMsgIndex = ref(-1)
const ctxMsgId = ref<string | null>(null)
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
  ctxMsgId.value = chatStore.messages[idx]?.id ?? null
  ctxMsgRole.value = role
  msgCtxMenu.value?.show(e)
}

async function handleMsgCtxAction(action: string) {
  const idx = ctxMsgId.value
    ? chatStore.messages.findIndex((item) => item.id === ctxMsgId.value)
    : ctxMsgIndex.value
  const msg = chatStore.messages[idx]
  if (!msg) return
  switch (action) {
    case 'copy':
      try {
        await setClipboard(msg.content)
      } catch {
        // clipboard access can be unavailable in tests or restricted runtimes
      }
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
        removeMessage(m.id).catch(() => {})
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

const EMPTY_REPLY_PATTERN = /^模型未生成有效回复|^模型未返回有效内容|^\(空回复\)$/
function isEmptyReply(content: string): boolean {
  return !content.trim() || EMPTY_REPLY_PATTERN.test(content.trim())
}

function formatThinkingDuration(seconds?: unknown): string {
  const s = Number(seconds)
  if (!s || s <= 0) return ''
  if (s >= 60) {
    const m = Math.floor(s / 60)
    const r = s % 60
    return r > 0 ? `${m}m ${r}s` : `${m}m`
  }
  return `${s}s`
}

function formatFullTime(ts: string): string {
  return new Date(ts).toLocaleString(locale.value, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function getMessageAttachments(message: ChatMessage): ChatAttachment[] {
  const attachments = message.metadata?.attachments
  return Array.isArray(attachments) ? (attachments as ChatAttachment[]) : []
}

// Document parsing state
const documentParsing = ref(false)
const parsedDocument = ref<{ text: string; fileName: string; pageCount?: number } | null>(null)
let documentParseGen = 0

// 当前选中的模型
const selectedModel = ref('')
const selectedProviderId = ref('')
const selectedProviderKey = ref('')
const selectedProviderName = ref('')
const chatTemperature = ref(0.7)
const chatMaxTokens = ref(4096)
const showChatParams = ref(false)
/** true when user explicitly picks a model via selectModel(), reset on agent/session switch */
const userOverrodeModel = ref(false)

// 当前模型的显示名
const selectedModelDisplay = computed(() => {
  if (!userOverrodeModel.value) {
    // Show agent preference source when backend decides
    const agentName = (chatStore.chatMode === 'agent' && chatStore.agentRole)
      ? chatStore.agentRole
      : agentsStore.defaultAgentName
    if (agentName) {
      const cfg = agentsStore.findAgent(agentName)
      if (cfg?.model) return `${cfg.model} ⟵ Agent`
    }
  }
  if (selectedModel.value === 'auto') return 'Auto'
  if (!selectedModel.value) return 'Select Model'
  const found = settingsStore.availableModels.find(
    (m) =>
      m.modelId === selectedModel.value &&
      (!selectedProviderId.value || m.providerId === selectedProviderId.value),
  )
  return found ? `${found.modelName}` : selectedModel.value
})

// 按 Provider 分组的模型列表
const groupedModels = computed(() => {
  const groups: Record<
    string,
    {
      providerName: string
      models: {
        providerKey: string
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
      providerKey: m.providerKey,
      modelId: m.modelId,
      modelName: m.modelName,
      capabilities: m.capabilities,
    })
  }
  return groups
})

// 当前选中模型的能力
const selectedModelCapabilities = computed(() => {
  const found = settingsStore.availableModels.find(
    (m) =>
      m.modelId === selectedModel.value &&
      (!selectedProviderId.value || m.providerId === selectedProviderId.value),
  )
  return found?.capabilities ?? ['text']
})

// 当前模型是否支持视觉/视频上传
const supportsVision = computed(() => selectedModelCapabilities.value.includes('vision'))
const supportsVideo = computed(() => selectedModelCapabilities.value.includes('video'))

// Deep thinking = research mode + thinking enabled (merged UX)
const isDeepThinking = computed(() => chatStore.chatMode === 'research' && chatStore.thinkingEnabled)
function toggleDeepThinking() {
  if (isDeepThinking.value) {
    chatStore.chatMode = 'chat'
    chatStore.thinkingEnabled = false
  } else {
    chatStore.chatMode = 'research'
    chatStore.thinkingEnabled = true
  }
}

// Research mode state (kept for streaming display logic)
const isResearchMode = computed(() => chatStore.chatMode === 'research')
const researchStreamingContentLength = computed(() =>
  isResearchMode.value && chatStore.isCurrentStreaming
    ? (chatStore.isCurrentStreamingContent?.length ?? 0)
    : 0,
)

import { formatTime } from '@/utils/time'
import { on } from '@/utils/eventBus'
import { hexclawWS } from '@/api/websocket'

function openArtifactInNewWindow() {
  const art = chatStore.artifacts.find((a) => a.id === chatStore.selectedArtifactId)
  if (!art) return
  openSanitizedArtifact(art.content, art.title || 'Artifact Preview')
}

function cancelQueryModelSelection() {
  if (queryModelSelectionAbort) {
    queryModelSelectionAbort.abort()
    queryModelSelectionAbort = null
  }
}

async function applyQueryModelSelection(modelQuery: string): Promise<boolean> {
  const trySelect = () => {
    // Ollama 模型名可能带 :latest 后缀（用户输入 "qwen3" → 存为 "qwen3:latest"）
    const matched = settingsStore.availableModels.find(m =>
      m.modelId === modelQuery ||
      m.modelId === `${modelQuery}:latest` ||
      m.modelId.replace(/:latest$/, '') === modelQuery,
    )
    if (!matched) return false
    selectModel(matched.modelId, matched.providerId, matched.providerKey, matched.providerName)
    return true
  }

  if (trySelect()) return true

  cancelQueryModelSelection()
  queryModelSelectionAbort = new AbortController()
  return waitForOllamaModelVisibility({
    sync: settingsStore.syncOllamaModels,
    isVisible: trySelect,
    intervalMs: QUERY_MODEL_RETRY_INTERVAL,
    maxRetries: QUERY_MODEL_RETRY_TIMES,
    signal: queryModelSelectionAbort.signal,
  })
}

/** 初始化模型选择（路由守卫已保证 config 就绪，无需再调 loadConfig） */
function loadLLMConfig() {
  const defaultModel = settingsStore.config?.llm?.defaultModel
  const defaultProviderId = settingsStore.config?.llm?.defaultProviderId
  const matched = defaultModel
    ? (settingsStore.availableModels.find(
        (m) =>
          m.modelId === defaultModel && (!defaultProviderId || m.providerId === defaultProviderId),
      ) ?? settingsStore.availableModels.find((m) => m.modelId === defaultModel))
    : settingsStore.availableModels[0]

  if (matched) {
    selectedModel.value = matched.modelId
    selectedProviderId.value = matched.providerId
    selectedProviderKey.value = matched.providerKey
    selectedProviderName.value = matched.providerName
  } else {
    selectedModel.value = ''
    selectedProviderId.value = ''
    selectedProviderKey.value = ''
    selectedProviderName.value = ''
  }
  syncChatParams()
}

onMounted(async () => {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed >= SIDEBAR_MIN_WIDTH && parsed <= SIDEBAR_MAX_WIDTH) {
      sidebarWidth.value = parsed
    }
  } catch {
    // ignore localStorage failures
  }

  // 先用当前配置同步默认模型，避免首屏在会话/恢复请求未完成前出现
  // “发送按钮可点但消息被静默吞掉”的初始化竞态。
  loadLLMConfig()

  await chatStore.loadSessions()
  await chatStore.recoverActiveStreams()
  chatStore.initApprovalListener()
  agentsStore.loadRoles()
  await agentsStore.loadAgents()
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
      await chatStore.loadSessions()
    }
    chatStore.chatMode = 'agent'
    chatStore.agentRole = roleQuery
    chatStore.hasCustomTitle = true
    router.replace({ path: '/chat' })
  }

  // 先同步 Ollama 列表再初始化模型 —— 否则 loadLLMConfig 在 ollamaModelsCache 仍空时会把默认模型判空
  await settingsStore.syncOllamaModels()

  // 初始化模型选择（config 由路由守卫保证已就绪）
  loadLLMConfig()

  // 从设置页跳转：预选指定模型
  const modelQuery = route.query.model as string | undefined
  if (modelQuery) {
    const selected = await applyQueryModelSelection(modelQuery)
    if (selected) {
      router.replace({ path: '/chat' })
    }
  }

  if (!roleQuery) {
    chatStore.agentRole = ''
  }

  // sidecar-ready 事件：后端延迟就绪时重新同步 providers
  try {
    const { listen } = await import('@tauri-apps/api/event')
    const unlisten = await listen('sidecar-ready', async () => {
      await settingsStore.loadConfig({ force: true })
      await settingsStore.syncOllamaModels()
      loadLLMConfig()
      unlisten()
    })
    setTimeout(() => unlisten(), 30000)
  } catch {
    // 非 Tauri 环境忽略
  }
})

async function toggleModelSelector() {
  showModelSelector.value = !showModelSelector.value
  if (showModelSelector.value) {
    await settingsStore.loadConfig({ force: true })
    await settingsStore.syncOllamaModels()
  }
}

function selectModel(modelId: string, providerId = '', providerKey = '', providerName = '') {
  selectedModel.value = modelId
  selectedProviderId.value = modelId === 'auto' ? '' : providerId
  selectedProviderKey.value = modelId === 'auto' ? '' : providerKey
  selectedProviderName.value = modelId === 'auto' ? '' : providerName
  showModelSelector.value = false
  userOverrodeModel.value = true
  syncChatParams()
}

/** 同步模型和参数到 chatStore
 *
 * 当后端有 Agent 可决策模型（显式 agentRole 或默认 Agent 有模型偏好），
 * 且用户没有主动选模型时，不发 provider/model，让后端决策。
 */
function syncChatParams() {
  const hasExplicitAgent = chatStore.chatMode === 'agent' && !!chatStore.agentRole
  const defaultAgentHasModel = !hasExplicitAgent
    && !!agentsStore.defaultAgentName
    && !!agentsStore.findAgent(agentsStore.defaultAgentName)?.model
  const letBackendDecide = (hasExplicitAgent || defaultAgentHasModel) && !userOverrodeModel.value

  chatStore.chatParams.provider = letBackendDecide
    ? undefined
    : (selectedModel.value === 'auto' ? undefined : selectedProviderKey.value || undefined)
  chatStore.chatParams.model = letBackendDecide
    ? undefined
    : (selectedModel.value === 'auto' ? 'auto' : selectedModel.value)
  chatStore.chatParams.temperature = chatTemperature.value
  chatStore.chatParams.maxTokens = chatMaxTokens.value
}

/** 获取某条消息关联的 artifacts */
function getMessageArtifacts(messageId: string) {
  return chatStore.artifacts.filter((a) => a.messageId === messageId)
}

let _scrollTimer: ReturnType<typeof setTimeout> | null = null
function scrollToBottom(force = false) {
  if (!force && userScrolledUp.value) return // 用户主动向上滚动时不自动跟随
  if (_scrollTimer) return // throttle: max 1 scroll per 100ms
  _scrollTimer = setTimeout(() => {
    messagesEndRef.value?.scrollIntoView({ behavior: 'smooth' })
    userScrolledUp.value = false
    _scrollTimer = null
  }, 100)
}

function scrollToTop() {
  messagesContainerRef.value?.scrollTo({ top: 0, behavior: 'smooth' })
}

function handleMessagesScroll() {
  const el = messagesContainerRef.value
  if (!el) return
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
  const distanceFromTop = el.scrollTop
  // 用户向上滚动超过 100px → 标记为主动滚动，停止自动跟随
  userScrolledUp.value = distanceFromBottom > 100
  showScrollToBottom.value = distanceFromBottom > 200
  showScrollToTop.value = distanceFromTop > 200 && distanceFromBottom < 100
}

function clearAttachmentPreview() {
  if (attachmentPreview.value) {
    URL.revokeObjectURL(attachmentPreview.value.url)
    attachmentPreview.value = null
  }
  parsedDocument.value = null
  documentParsing.value = false
}

// ─── Composables ────────────────────────────────────
const {
  getVisibleConversationActions,
  attachConversationAutomationActions,
  automationStatusLabel,
  automationExecuteLabel,
  handleConversationAction,
  dismissConversationAction,
} = useConversationAutomation(chatStore, toast, t)

const { handleSend } = useChatSend({
  chatStore,
  parsedDocument,
  attachmentPreview,
  clearAttachmentPreview,
  scrollToBottom,
  attachConversationAutomationActions,
})

const {
  editingMsgId,
  editingText,
  setEditTextareaEl,
  handleRetry,
  handleLike,
  handleDislike,
  handleEdit,
  confirmEdit,
  cancelEdit,
  autoResizeEditTextarea,
} = useChatActions(chatStore, toast, handleSend)

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

watch(
  () => chatStore.isCurrentStreamingReasoning,
  () => {
    nextTick(() => {
      if (thinkingContentRef.value) {
        thinkingContentRef.value.scrollTop = thinkingContentRef.value.scrollHeight
      }
      scrollToBottom()
    })
  },
)

// 参数变更时同步到 chatStore
watch([() => chatTemperature.value, () => chatMaxTokens.value], syncChatParams)

// Agent 切换时重置模型覆盖标记，让后端决策模型
watch(
  () => chatStore.agentRole,
  () => {
    userOverrodeModel.value = false
    syncChatParams()
  },
)

function newSession() {
  if (chatStore.chatMode !== 'research') {
    chatStore.agentRole = ''
  }
  userOverrodeModel.value = false
  chatStore.newSession()
}

function openHistorySession(sessionId: string) {
  userOverrodeModel.value = false
  chatStore.selectSession(sessionId)
  chatViewTab.value = 'chat'
}

function metadataValue(message: import('@/types').ChatMessage, key: string): string | null {
  const value = message.metadata?.[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function messageFeedbackValue(message: import('@/types').ChatMessage) {
  const feedback = message.metadata?.user_feedback
  return feedback === 'like' || feedback === 'dislike' ? feedback : null
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
    const parseGen = ++documentParseGen
    documentParsing.value = true
    parsedDocument.value = null
    try {
      const nextParsedDocument = await parseDocument(file)
      if (parseGen !== documentParseGen) return
      parsedDocument.value = nextParsedDocument
    } catch (err) {
      if (parseGen !== documentParseGen) return
      console.error('Document parsing failed:', err)
      // Still allow sending as raw file attachment
    } finally {
      if (parseGen === documentParseGen) {
        documentParsing.value = false
      }
    }
  }
}

function handleDrop(e: DragEvent) {
  e.preventDefault()
  isDragging.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) handleFileUpload(file)
}

function handleSearchShortcut(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    e.preventDefault()
    showSearch.value = !showSearch.value
  }
}

// Memory update notification — shows a transient toast when memory is modified elsewhere
const memoryJustUpdated = ref(false)
let memoryToastTimer: ReturnType<typeof setTimeout> | null = null
function showMemoryToast(content?: string) {
  memoryToastContent.value = content || ''
  memoryJustUpdated.value = true
  if (memoryToastTimer) clearTimeout(memoryToastTimer)
  memoryToastTimer = setTimeout(() => { memoryJustUpdated.value = false }, 4000)
}

const memoryToastContent = ref('')
const offMemoryBus = on('memory:updated', () => showMemoryToast())
const offMemoryWS = hexclawWS.onMemorySaved((content) => showMemoryToast(content))

onMounted(() => document.addEventListener('keydown', handleSearchShortcut))
onUnmounted(() => document.removeEventListener('keydown', handleSearchShortcut))
onUnmounted(() => {
  stopSidebarResize()
  cancelQueryModelSelection()
  offMemoryBus()
  offMemoryWS()
  if (memoryToastTimer) clearTimeout(memoryToastTimer)
})

function clampSidebarWidth(next: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, next))
}

function persistSidebarWidth() {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth.value))
  } catch {
    // ignore localStorage failures
  }
}

function handleSidebarResizeMove(event: MouseEvent) {
  if (!sidebarDragging) return
  const delta = event.clientX - sidebarDragStartX
  const next = clampSidebarWidth(sidebarDragStartWidth + delta)
  if (next === sidebarWidth.value) return
  cancelAnimationFrame(sidebarRafId)
  sidebarRafId = requestAnimationFrame(() => {
    sidebarWidth.value = next
  })
}

function stopSidebarResize() {
  if (!sidebarDragging) return
  sidebarDragging = false
  sidebarResizing.value = false
  cancelAnimationFrame(sidebarRafId)
  document.removeEventListener('mousemove', handleSidebarResizeMove)
  document.removeEventListener('mouseup', stopSidebarResize)
  document.body.style.cursor = bodyCursorBeforeDrag
  document.body.style.userSelect = bodyUserSelectBeforeDrag
  persistSidebarWidth()
}

function startSidebarResize(event: MouseEvent) {
  if (event.button !== 0) return
  sidebarDragging = true
  sidebarResizing.value = true
  sidebarDragStartX = event.clientX
  sidebarDragStartWidth = sidebarWidth.value
  bodyCursorBeforeDrag = document.body.style.cursor
  bodyUserSelectBeforeDrag = document.body.style.userSelect
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', handleSidebarResizeMove)
  document.addEventListener('mouseup', stopSidebarResize)
}
</script>

<template>
  <div class="hc-chat">
    <!-- Session sidebar -->
    <div v-show="showSessions" class="hc-chat__sidebar" :class="{ 'hc-chat__sidebar--resizing': sidebarResizing }" :style="{ width: `${sidebarWidth}px` }">
      <div class="hc-chat__sidebar-header">
        <span class="hc-chat__sidebar-title">{{ t('chat.sessions') }}</span>
        <button class="hc-chat__new-btn" :title="t('chat.newSession')" @click="newSession">
          <MessageSquarePlus :size="16" />
        </button>
      </div>
      <SessionList />
    </div>
    <div
      v-show="showSessions"
      class="hc-chat__sidebar-resizer"
      :class="{ 'hc-chat__sidebar-resizer--active': sidebarResizing }"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sessions sidebar"
      @mousedown="startSidebarResize"
    />

    <!-- Main chat area -->
    <div
      class="hc-chat__main"
      @dragover.prevent="isDragging = true"
      @dragleave.prevent="isDragging = false"
      @drop.prevent="handleDrop"
    >
      <!-- Drag overlay (文件拖入时显示) -->
      <Transition name="fade">
        <div v-if="isDragging" class="hc-chat__drop-overlay">
          <div class="hc-chat__drop-hint">
            {{ t('chat.dropHint', '松开以添加文件') }}
          </div>
        </div>
      </Transition>
      <!-- Compact toolbar -->
      <ChatToolbar
        v-model:active-tab="chatViewTab"
        v-model:show-sessions="showSessions"
        :message-count="chatStore.messages.length"
        :token-badge="t('chat.aboutTokens', { n: formatTokenCount(estimatedTokens) })"
        @search="showSearch = !showSearch"
      />

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
        <div ref="messagesContainerRef" class="hc-chat__messages" @scroll="handleMessagesScroll">
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
              @mouseenter="setHoveredMsg(msg.id)"
              @mouseleave="delayedClearHover()"
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
                  <AgentBadge
                    v-if="msg.agent_name || (msg.metadata?.agent_name as string)"
                    :agent-name="msg.agent_name || (msg.metadata?.agent_name as string) || ''"
                    :is-handoff="idx > 0 && chatStore.messages[idx - 1]?.role === 'assistant' && chatStore.messages[idx - 1]?.agent_name !== msg.agent_name"
                  />
                  <!-- Thinking block for finalized messages (ChatGPT style) -->
                  <div v-if="msg.reasoning && normalizeAssistantReasoning(msg.reasoning)" class="hc-thinking">
                    <details class="hc-thinking__details">
                      <summary class="hc-thinking__summary">
                        <span class="hc-thinking__icon">●</span>
                        <span class="hc-thinking__label">{{ formatThinkingDuration(msg.metadata?.thinking_duration) ? (t('chat.thoughtFor') + ' ' + formatThinkingDuration(msg.metadata?.thinking_duration)) : t('chat.thoughtProcess') }}</span>
                      </summary>
                      <div class="hc-thinking__content">{{ normalizeAssistantReasoning(msg.reasoning) }}</div>
                    </details>
                  </div>
                  <div class="hc-msg__bubble-wrap">
                    <div
                      class="hc-msg__bubble hc-msg__bubble--assistant"
                      :class="{ 'hc-msg__bubble--empty': isEmptyReply(msg.content) }"
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
                        :feedback="messageFeedbackValue(msg)"
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
                  <!-- Meta footer: 时间 · 模型 · Agent 合并一行 -->
                  <!-- (moved to hc-msg__footer below) -->
                  <div
                    v-if="
                      msg.metadata?.knowledge_hits ||
                      msg.metadata?.memory_hits
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
                  <!-- Backend auto-extracted memory notification -->
                  <div
                    v-if="typeof msg.metadata?.memory_saved === 'string' && msg.metadata.memory_saved"
                    class="hc-msg__memory-saved"
                  >
                    <Brain :size="12" />
                    <span>{{ t('chat.memorySaved') }}: {{ msg.metadata.memory_saved }}</span>
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
                  <div
                    v-if="getVisibleConversationActions(msg).length"
                    class="hc-msg__automation-list"
                  >
                    <div
                      v-for="action in getVisibleConversationActions(msg)"
                      :key="action.id"
                      class="hc-msg__automation-card"
                      :class="`hc-msg__automation-card--${action.status}`"
                    >
                      <div class="hc-msg__automation-head">
                        <div>
                          <div class="hc-msg__automation-title">{{ action.title }}</div>
                          <div class="hc-msg__automation-desc">{{ action.description }}</div>
                        </div>
                        <span class="hc-msg__automation-status">
                          {{ automationStatusLabel(action.status) }}
                        </span>
                      </div>
                      <div v-if="action.result" class="hc-msg__automation-result">
                        <div class="hc-msg__automation-summary">{{ action.result.summary }}</div>
                        <div v-if="action.result.items?.length" class="hc-msg__automation-items">
                          <div
                            v-for="(item, resultIdx) in action.result.items"
                            :key="`${action.id}-${resultIdx}`"
                            class="hc-msg__automation-item"
                          >
                            <div class="hc-msg__automation-item-title">{{ item.title }}</div>
                            <div v-if="item.subtitle" class="hc-msg__automation-item-subtitle">
                              {{ item.subtitle }}
                            </div>
                            <div v-if="item.content" class="hc-msg__automation-item-content">
                              {{ item.content }}
                            </div>
                          </div>
                        </div>
                      </div>
                      <div v-if="action.error" class="hc-msg__automation-error">
                        {{ action.error }}
                      </div>
                      <div v-if="action.status !== 'completed'" class="hc-msg__automation-actions">
                        <button
                          class="hc-msg__automation-btn hc-msg__automation-btn--primary"
                          :disabled="action.status === 'running'"
                          @click="handleConversationAction(msg.id, action.id)"
                        >
                          {{ automationExecuteLabel(action) }}
                        </button>
                        <button
                          class="hc-msg__automation-btn"
                          :disabled="action.status === 'running'"
                          @click="dismissConversationAction(msg.id, action.id)"
                        >
                          {{ t('chat.automationDismiss') }}
                        </button>
                      </div>
                    </div>
                  </div>
                  <div class="hc-msg__meta">
                    <span>{{ formatTime(msg.timestamp) }}</span>
                    <span v-if="metadataValue(msg, 'provider') || metadataValue(msg, 'model')">{{ [metadataValue(msg, 'provider'), metadataValue(msg, 'model')].filter(Boolean).join(' · ') }}</span>
                    <span v-if="msg.agent_name || msg.metadata?.agent_name || msg.metadata?.routed_agent">{{ msg.agent_name || msg.metadata?.agent_name || msg.metadata?.routed_agent }}</span>
                  </div>
                </div>
              </template>

              <!-- User message (Feishu style: right-aligned blue bubble, no avatar) -->
              <template v-else-if="msg.role === 'user'">
                <div class="hc-msg__body hc-msg__body--user">
                  <div class="hc-msg__bubble-wrap hc-msg__bubble-wrap--user">
                    <div
                      v-if="editingMsgId !== msg.id"
                      class="hc-msg__bubble hc-msg__bubble--user"
                      :title="formatFullTime(msg.timestamp)"
                    >
                      <div v-if="getMessageAttachments(msg).length" class="hc-msg__attachments">
                        <template v-for="(att, ai) in getMessageAttachments(msg)" :key="ai">
                          <img
                            v-if="att.type === 'image'"
                            class="hc-msg__attachment-img"
                            :src="'data:' + att.mime + ';base64,' + att.data"
                            :alt="att.name"
                          />
                          <div v-else class="hc-msg__attachment-file">📎 {{ att.name }}</div>
                        </template>
                      </div>
                      {{ msg.content }}
                    </div>
                    <!-- DeepSeek 风格原位编辑框（独立圆角卡片） -->
                    <div v-if="editingMsgId === msg.id" class="hc-msg__edit-card">
                      <textarea
                        :ref="(el) => { if (el) setEditTextareaEl(el as HTMLTextAreaElement) }"
                        v-model="editingText"
                        class="hc-msg__edit-textarea"
                        rows="1"
                        @keydown.enter.exact.prevent="confirmEdit(msg.id)"
                        @keydown.escape="cancelEdit"
                        @input="autoResizeEditTextarea"
                      />
                      <div class="hc-msg__edit-actions">
                        <button class="hc-msg__edit-btn hc-msg__edit-btn--cancel" @click="cancelEdit">{{ t('common.cancel') }}</button>
                        <button class="hc-msg__edit-btn hc-msg__edit-btn--send" @click="confirmEdit(msg.id)">{{ t('chat.send') }}</button>
                      </div>
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
                <!-- Thinking block: open while reasoning, collapse to <details> once reply starts -->
                <div v-if="streamingReasoningDisplay && !chatStore.isCurrentStreamingContent" class="hc-thinking">
                  <div class="hc-thinking__header">
                    <span class="hc-thinking__spinner" />
                    <span class="hc-thinking__label">{{ t('chat.thinking') }}</span>
                    <span v-if="chatStore.streamingThinkingElapsed > 0" class="hc-thinking__time">{{ chatStore.streamingThinkingElapsed }}s</span>
                  </div>
                  <div ref="thinkingContentRef" class="hc-thinking__content">{{ streamingReasoningDisplay }}</div>
                </div>
                <div v-else-if="streamingReasoningDisplay && chatStore.isCurrentStreamingContent" class="hc-thinking">
                  <details class="hc-thinking__details">
                    <summary class="hc-thinking__summary">
                      <span class="hc-thinking__label">{{ t('chat.thoughtProcess') }}</span>
                      <span v-if="chatStore.streamingThinkingElapsed > 0" class="hc-thinking__time">{{ chatStore.streamingThinkingElapsed }}s</span>
                    </summary>
                    <div class="hc-thinking__content">{{ streamingReasoningDisplay }}</div>
                  </details>
                </div>
                <!-- Main reply content -->
                <div v-if="chatStore.isCurrentStreamingContent" class="hc-msg__bubble hc-msg__bubble--assistant">
                  <MarkdownRenderer :content="chatStore.isCurrentStreamingContent" />
                </div>
                <div v-else-if="!streamingReasoningDisplay" class="hc-msg__bubble hc-msg__bubble--assistant">
                  <span class="hc-typing-dots">
                    <span class="hc-typing-dots__dot" />
                    <span class="hc-typing-dots__dot" />
                    <span class="hc-typing-dots__dot" />
                  </span>
                </div>
              </div>
            </div>

            <!-- 工具审批卡片 -->
            <ToolApprovalCard
              v-if="chatStore.pendingApproval"
              :request-id="chatStore.pendingApproval.requestId"
              :tool-name="chatStore.pendingApproval.toolName"
              :risk="(chatStore.pendingApproval.risk as 'safe' | 'sensitive' | 'dangerous')"
              :reason="chatStore.pendingApproval.reason"
              @respond="chatStore.respondApproval"
            />

            <div ref="messagesEndRef" />
          </div>
        </div>

        <!-- Scroll navigation buttons (ChatGPT style) -->
        <Transition name="hc-fade">
          <button
            v-if="showScrollToTop"
            class="hc-chat__scroll-btn hc-chat__scroll-btn--top"
            :title="t('chat.scrollToTop', 'Scroll to top')"
            @click="scrollToTop"
          >
            <ChevronUp :size="18" />
          </button>
        </Transition>
        <Transition name="hc-fade">
          <button
            v-if="showScrollToBottom"
            class="hc-chat__scroll-btn hc-chat__scroll-btn--bottom"
            @click="scrollToBottom(true)"
          >
            <ChevronDown :size="18" />
          </button>
        </Transition>

        <!-- Memory update toast -->
        <Transition name="hc-fade">
          <div v-if="memoryJustUpdated" class="hc-chat__memory-toast">
            <Brain :size="13" />
            {{ memoryToastContent ? `${t('chat.memorySaved')}: ${memoryToastContent}` : t('chat.memoryUpdated') }}
          </div>
        </Transition>

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
            <ChatInput
              :streaming="chatStore.isCurrentStreaming"
              :disabled="chatStore.sending"
              :agents="agentsStore.roles"
              :skills="availableSkills"
              :allow-image="supportsVision"
              :allow-video="supportsVideo"
              :recipient-name="chatStore.agentRole || t('chat.defaultAgent', '小蟹')"
              :send-handler="handleSend"
              @stop="chatStore.stopStreaming()"
            >
              <!-- 模型选择器 + 深度研究（ChatGPT 风格，在输入框内底部工具栏） -->
              <template #tools>
                <div class="hc-model-selector hc-model-selector--inline">
                  <button class="hc-model-selector__btn" @click="toggleModelSelector">
                    <span class="hc-model-selector__name">{{ selectedModelDisplay }}</span>
                    <ChevronDown :size="12" />
                  </button>
                  <div v-if="showModelSelector" class="hc-model-selector__dropdown hc-model-selector__dropdown--up" @mouseleave="showModelSelector = false">
                    <button class="hc-model-selector__item hc-model-selector__item--auto" :class="{ 'hc-model-selector__item--active': selectedModel === 'auto' }" @click="selectModel('auto')">
                      <Zap :size="12" style="color: var(--hc-accent); margin-right: 4px" />
                      <span class="hc-model-selector__item-name">Auto</span>
                    </button>
                    <div class="hc-model-selector__divider" />
                    <template v-if="Object.keys(groupedModels).length > 0">
                      <div v-for="(group, pid) in groupedModels" :key="pid" class="hc-model-selector__group">
                        <div class="hc-model-selector__group-label">{{ group.providerName }}</div>
                        <button v-for="m in group.models" :key="m.modelId" class="hc-model-selector__item" :class="{ 'hc-model-selector__item--active': selectedModel === m.modelId && selectedProviderId === pid }" @click="selectModel(m.modelId, String(pid), m.providerKey, group.providerName)">
                          <span class="hc-model-selector__item-name">{{ m.modelName }}</span>
                          <span v-if="selectedModel === m.modelId && selectedProviderId === pid" style="color: var(--hc-accent); margin-left: auto;">✓</span>
                        </button>
                      </div>
                    </template>
                    <div v-else class="hc-model-selector__empty">
                      <template v-if="settingsStore.enabledProviders.length > 0">{{ t('chat.noModels') }}</template>
                      <button v-else class="hc-model-selector__add-link" @click="showModelSelector = false; $router.push('/settings')">
                        {{ t('settings.llm.noProvidersDesc') }}
                      </button>
                    </div>
                  </div>
                </div>
                <button
                  class="hc-chat__research-btn"
                  :class="{ 'hc-chat__research-btn--active': isDeepThinking }"
                  @click="toggleDeepThinking"
                >
                  <Brain :size="12" />
                  {{ t('chat.deepThink', '深度思考') }}
                </button>
              </template>
            </ChatInput>
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
  flex-shrink: 0;
  border-right: 1px solid var(--hc-border-subtle);
  background: var(--hc-bg-sidebar);
  backdrop-filter: saturate(180%) blur(var(--hc-blur));
  -webkit-backdrop-filter: saturate(180%) blur(var(--hc-blur));
  display: flex;
  flex-direction: column;
}
.hc-chat__sidebar--resizing {
  will-change: width;
  pointer-events: none;
}

.hc-chat__sidebar-resizer {
  width: 6px;
  flex-shrink: 0;
  cursor: col-resize;
  position: relative;
}

.hc-chat__sidebar-resizer::before {
  content: '';
  position: absolute;
  inset: 0 2px;
  border-radius: 999px;
  background: transparent;
  transition: background 0.15s ease;
}

.hc-chat__sidebar-resizer:hover::before,
.hc-chat__sidebar-resizer--active::before {
  background: var(--hc-accent);
  opacity: 0.45;
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
  position: relative;
}

/* 拖拽文件 overlay */
.hc-chat__drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 50;
  background: rgba(0, 0, 0, 0.08);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.hc-chat__drop-hint {
  padding: 16px 32px;
  border-radius: 12px;
  border: 2px dashed var(--hc-accent);
  background: var(--hc-bg-elevated);
  color: var(--hc-accent);
  font-size: 14px;
  font-weight: 500;
}

.fade-enter-active, .fade-leave-active { transition: opacity 0.15s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

.hc-chat__messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px 80px;
}

/* ─── Scroll navigation (ChatGPT style: 底部居中，输入框上方) ───── */
.hc-chat__scroll-btn {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-elevated);
  color: var(--hc-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,.1);
  transition: background 0.15s, color 0.15s, box-shadow 0.15s, opacity 0.15s;
}
.hc-chat__scroll-btn:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
  box-shadow: 0 4px 12px rgba(0,0,0,.15);
}
.hc-chat__scroll-btn--top {
  top: 56px;
}
.hc-chat__scroll-btn--bottom {
  bottom: 90px;
}

.hc-chat__empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.hc-chat__thread {
  max-width: min(94%, 1200px);
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
  background: var(--hc-accent);
  transform: scale(1.25);
}

.hc-msg__avatar-badge {
  position: absolute;
  bottom: 0;
  right: 0;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--hc-success);
  border: 2px solid var(--hc-bg-card, #fff);
  box-sizing: border-box;
}

/* ─── Message body ───── */
.hc-msg__body {
  max-width: 100%;
  min-width: 0;
  flex: 1;
}

.hc-msg__body--user {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  max-width: 70%;
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

/* ─── Actions floating toolbar（气泡下方，不会被顶部裁剪） ───── */
.hc-msg__actions-float {
  position: absolute;
  bottom: -28px;
  z-index: var(--hc-z-dropdown);
  animation: hc-actions-fade-in 0.15s ease;
  padding-top: 4px;
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
  background: transparent;
  color: var(--hc-text-primary);
  border: none;
  padding: 0;
  border-radius: 0;
}

.hc-msg__bubble--empty {
  background: color-mix(in srgb, var(--hc-text-secondary) 5%, var(--hc-bg-card));
  border-style: dashed;
  color: var(--hc-text-secondary);
  font-style: italic;
  font-size: 13px;
}

.hc-msg__bubble--user {
  background: color-mix(in srgb, var(--hc-accent) 8%, var(--hc-bg-card));
  color: var(--hc-text-primary);
  border-bottom-right-radius: 4px;
  border: 1px solid color-mix(in srgb, var(--hc-accent) 10%, transparent);
}

/* ─── Tool call 参数/结果折叠 ───── */
.hc-msg__tools {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.hc-msg__tool {
  border-radius: 8px;
  border: 1px solid var(--hc-border-subtle, var(--hc-border));
  background: var(--hc-bg-sidebar);
  overflow: hidden;
}
.hc-msg__tool-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--hc-text-secondary);
}
.hc-msg__tool-name {
  color: var(--hc-accent);
}
.hc-msg__tool-detail {
  border-top: 1px solid var(--hc-border-subtle, var(--hc-border));
}
.hc-msg__tool-detail > summary {
  padding: 4px 10px;
  font-size: 11px;
  color: var(--hc-text-muted);
  cursor: pointer;
  user-select: none;
}
.hc-msg__tool-detail > pre {
  margin: 0;
  padding: 8px 10px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--hc-text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow-y: auto;
}

/* ─── DeepSeek 风格原位编辑卡片 ───── */
/* Apple HIG: 编辑卡片 — 0.5px 边框, 16px 圆角, 弹簧入场 */
.hc-msg__edit-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 8px;
  padding: 20px;
  border: 0.5px solid var(--hc-accent, #007AFF);
  border-radius: 16px;
  background: var(--hc-bg-input);
  box-shadow: 0 0 0 3px rgba(0, 122, 255, 0.12),
              0 4px 12px rgba(0, 0, 0, 0.08);
  max-width: 100%;
  animation: fadeScaleIn 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
}

.hc-msg__edit-textarea {
  width: 100%;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  color: var(--hc-text-primary, #1D1D1F);
  font-size: 16px;
  line-height: 1.6;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
  padding: 0;
  overflow-y: auto;
  max-height: 200px;
}

.hc-msg__edit-textarea::placeholder { color: var(--hc-text-secondary, #6E6E73); }

.hc-msg__edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.hc-msg__edit-btn {
  padding: 5px 14px;
  border-radius: 8px;
  border: none;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
  transition: background-color 0.3s cubic-bezier(0.16, 1, 0.3, 1),
              transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.hc-msg__edit-btn:active { transform: scale(0.96); }

.hc-msg__edit-btn--cancel {
  background: var(--hc-bg-card, #F5F5F7);
  color: var(--hc-text-secondary, #6E6E73);
  border: 0.5px solid rgba(0, 0, 0, 0.08);
}

.hc-msg__edit-btn--cancel:hover {
  background: var(--hc-bg-hover, #EBEBED);
}

.hc-msg__edit-btn--send {
  background: var(--hc-accent, #007AFF);
  color: var(--hc-text-inverse);
  box-shadow: 0 1px 3px rgba(0, 122, 255, 0.25);
}

.hc-msg__edit-btn--send:hover {
  box-shadow: 0 2px 8px rgba(0, 122, 255, 0.3);
}

@keyframes fadeScaleIn {
  from { opacity: 0; transform: scale(0.96) translateY(8px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
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
  transition: background 0.15s, color 0.15s, box-shadow 0.15s;
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
  gap: 6px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
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
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.hc-chat__mode-btn:hover {
  color: var(--hc-text-secondary);
  border-color: var(--hc-accent);
}

.hc-chat__mode-btn--active {
  background: color-mix(in srgb, var(--hc-accent) 12%, transparent);
  color: var(--hc-accent);
  border-color: color-mix(in srgb, var(--hc-accent) 30%, transparent);
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
  background: color-mix(in srgb, var(--hc-accent) 12%, transparent);
  color: var(--hc-accent);
}

.hc-context-tag--provider {
  background: color-mix(in srgb, var(--hc-accent) 12%, transparent);
  color: var(--hc-accent);
}

/* ─── Model Selector ───── */
/* 胶囊按钮（Apple + DeepSeek 融合风格） */
/* Apple HIG 胶囊按钮: 0.5px 边框, 10px 圆角, 禁止 transition: all */
.hc-chat__research-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 7px 16px;
  border: 0.5px solid rgba(0, 0, 0, 0.1);
  background: var(--hc-bg-card, #F5F5F7);
  color: var(--hc-text-secondary, #6E6E73);
  font-size: 14px;
  font-weight: 500;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
  cursor: pointer;
  border-radius: 10px;
  transition: border-color 0.3s cubic-bezier(0.16, 1, 0.3, 1),
              color 0.3s cubic-bezier(0.16, 1, 0.3, 1),
              background-color 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  white-space: nowrap;
}

.hc-chat__research-btn:hover {
  border-color: rgba(0, 122, 255, 0.3);
  color: var(--hc-accent, #007AFF);
  background: rgba(0, 122, 255, 0.06);
}

.hc-chat__research-btn:active { transform: scale(0.97); }

.hc-chat__research-btn--active {
  border-color: rgba(0, 122, 255, 0.3);
  background: rgba(0, 122, 255, 0.08);
  color: var(--hc-accent, #007AFF);
}

/* 模型选择胶囊 */
.hc-model-selector--inline .hc-model-selector__btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 7px 16px;
  border: 0.5px solid rgba(0, 0, 0, 0.1);
  background: var(--hc-bg-card, #F5F5F7);
  border-radius: 10px;
  font-size: 14px;
  font-weight: 500;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
  color: var(--hc-text-secondary, #6E6E73);
  cursor: pointer;
  transition: border-color 0.3s cubic-bezier(0.16, 1, 0.3, 1),
              color 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  white-space: nowrap;
}

.hc-model-selector--inline .hc-model-selector__btn:hover {
  border-color: rgba(0, 122, 255, 0.3);
  color: var(--hc-accent, #007AFF);
}

.hc-model-selector--inline .hc-model-selector__btn:active { transform: scale(0.97); }

.hc-model-selector--inline .hc-model-selector__dropdown {
  bottom: 100%;
  top: auto;
  margin-bottom: 8px;
  left: 0;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.12), 0 1px 4px rgba(0, 0, 0, 0.06);
  z-index: 100;
}

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
  background: var(--hc-bg-elevated, var(--hc-bg-card, #fff));
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
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
  color: var(--hc-success);
}

.hc-model-selector__cap-icon--video {
  color: var(--hc-warning);
}

.hc-model-selector__cap-icon--audio {
  color: var(--hc-accent);
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

.hc-model-selector__add-link {
  border: none;
  background: none;
  color: var(--hc-accent);
  font-size: 12px;
  cursor: pointer;
  padding: 0;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.hc-model-selector__add-link:hover {
  color: var(--hc-accent-hover);
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
  background: var(--hc-text-primary);
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
  color: var(--hc-text-inverse);
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
  transition: background 0.15s, border-color 0.15s;
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
  max-width: min(94%, 1200px);
  margin: 0 auto;
}

/* ─── Research Mode ───── */
.hc-mode-tab__btn--research.hc-mode-tab__btn--active {
  background: color-mix(in srgb, var(--hc-accent) 12%, transparent);
  color: var(--hc-accent);
}

.hc-research-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--hc-accent) 12%, transparent);
  color: var(--hc-accent);
  white-space: nowrap;
}

/* ─── Document Parsing States ───── */
.hc-chat__attach-type--parsing {
  color: var(--hc-accent) !important;
  animation: hc-parsing-pulse 1.5s ease-in-out infinite;
}

.hc-chat__attach-type--parsed {
  color: var(--hc-success) !important;
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

/* ─── Conversation Automation ───── */
.hc-msg__automation-list {
  display: grid;
  gap: 8px;
  margin-top: 10px;
}

.hc-msg__automation-card {
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-card);
}

.hc-msg__automation-card--running {
  border-color: rgba(59, 130, 246, 0.32);
  background: rgba(59, 130, 246, 0.08);
}

.hc-msg__automation-card--completed {
  border-color: rgba(34, 197, 94, 0.28);
  background: rgba(34, 197, 94, 0.08);
}

.hc-msg__automation-card--failed {
  border-color: rgba(239, 68, 68, 0.28);
  background: rgba(239, 68, 68, 0.08);
}

.hc-msg__automation-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.hc-msg__automation-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--hc-text-primary);
}

.hc-msg__automation-desc {
  margin-top: 2px;
  font-size: 11px;
  color: var(--hc-text-secondary);
  line-height: 1.45;
}

.hc-msg__automation-status {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--hc-bg-hover);
  color: var(--hc-text-muted);
  font-size: 10px;
  font-weight: 600;
}

.hc-msg__automation-result,
.hc-msg__automation-error {
  margin-top: 8px;
}

.hc-msg__automation-summary {
  font-size: 11px;
  color: var(--hc-text-primary);
  line-height: 1.5;
}

.hc-msg__automation-items {
  display: grid;
  gap: 6px;
  margin-top: 8px;
}

.hc-msg__automation-item {
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.45);
  border: 1px solid var(--hc-border);
}

.hc-msg__automation-item-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--hc-text-primary);
}

.hc-msg__automation-item-subtitle {
  margin-top: 2px;
  font-size: 10px;
  color: var(--hc-text-muted);
}

.hc-msg__automation-item-content {
  margin-top: 4px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--hc-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

.hc-msg__automation-error {
  font-size: 11px;
  color: var(--hc-error);
  line-height: 1.45;
}

.hc-msg__automation-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.hc-msg__automation-btn {
  appearance: none;
  border: 1px solid var(--hc-border);
  background: rgba(255, 255, 255, 0.65);
  color: var(--hc-text-secondary);
  border-radius: 9px;
  padding: 6px 10px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: border-color 0.15s cubic-bezier(0.16, 1, 0.3, 1), color 0.15s cubic-bezier(0.16, 1, 0.3, 1);
}

.hc-msg__automation-btn:hover:not(:disabled) {
  border-color: var(--hc-accent-subtle);
  color: var(--hc-text-primary);
}

.hc-msg__automation-btn:disabled {
  opacity: 0.6;
  cursor: progress;
}

.hc-msg__automation-btn--primary {
  background: var(--hc-accent);
  border-color: var(--hc-accent);
  color: var(--hc-text-inverse);
}

.hc-msg__automation-btn--primary:hover:not(:disabled) {
  filter: brightness(1.03);
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
  align-items: center;
  gap: 0;
  margin-top: 8px;
  color: var(--hc-text-muted);
  font-size: 11px;
  opacity: 0.5;
  transition: opacity 0.2s;
}

.hc-msg:hover .hc-msg__meta {
  opacity: 1;
}

.hc-msg__meta > span + span::before {
  content: ' · ';
  opacity: 0.5;
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
  background: color-mix(in srgb, var(--hc-accent) 12%, transparent);
  color: var(--hc-accent);
}

.hc-msg__source-tag--memory {
  background: color-mix(in srgb, var(--hc-accent) 12%, transparent);
  color: var(--hc-accent);
}

.hc-msg__source-tag--agent {
  background: color-mix(in srgb, var(--hc-accent) 12%, transparent);
  color: var(--hc-accent);
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

.hc-msg__memory-saved {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 11px;
  color: var(--hc-accent);
  background: color-mix(in srgb, var(--hc-accent) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--hc-accent) 20%, transparent);
}

.hc-chat__memory-toast {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 14px;
  margin: 0 auto 8px;
  width: fit-content;
  border-radius: 20px;
  font-size: 12px;
  color: var(--hc-accent);
  background: color-mix(in srgb, var(--hc-accent) 10%, var(--hc-bg-card));
  border: 1px solid color-mix(in srgb, var(--hc-accent) 20%, transparent);
}

.hc-fade-enter-active,
.hc-fade-leave-active {
  transition: opacity 0.3s ease;
}
.hc-fade-enter-from,
.hc-fade-leave-to {
  opacity: 0;
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
  transition: background 0.15s, border-color 0.15s;
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
  transition: background 0.15s, border-color 0.15s;
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

/* ─── Message Attachments ───── */
.hc-msg__attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}

.hc-msg__attachment-img {
  max-width: 240px;
  max-height: 180px;
  border-radius: var(--hc-radius-sm, 6px);
  object-fit: cover;
  cursor: zoom-in;
}

.hc-msg__attachment-file {
  font-size: 12px;
  padding: 4px 8px;
  border-radius: var(--hc-radius-sm, 6px);
  background: rgba(255, 255, 255, 0.15);
}

/* ── Thinking / Reasoning block ──────────────────── */
.hc-thinking {
  margin-bottom: 8px;
  max-width: 100%;
}

/* --- Thinking / Reasoning (Apple HIG aligned) --- */

.hc-thinking { margin-bottom: 6px; }

/* Collapsible details (used when reply started or finalized) */
.hc-thinking__details {
  border-radius: 0;
  background: transparent;
  border: none;
}

.hc-thinking__icon {
  font-size: 8px;
  color: var(--hc-accent);
  flex-shrink: 0;
}

.hc-thinking__summary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-secondary);
  user-select: none;
  list-style: none;
}

.hc-thinking__summary::-webkit-details-marker { display: none; }

.hc-thinking__summary::after {
  content: '';
  width: 10px;
  height: 10px;
  background: currentColor;
  opacity: 0.4;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

.hc-thinking__details[open] .hc-thinking__summary::after {
  transform: rotate(180deg);
}

/* Streaming header (visible during active thinking) */
.hc-thinking__header {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-secondary);
}

.hc-thinking__label { flex-shrink: 0; }

.hc-thinking__time {
  font-size: 11px;
  font-weight: 400;
  color: var(--hc-text-muted);
  font-variant-numeric: tabular-nums;
}

.hc-thinking__spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--hc-border);
  border-top-color: var(--hc-accent);
  border-radius: 50%;
  animation: hc-spin 0.7s linear infinite;
  flex-shrink: 0;
}

.hc-thinking__content {
  padding: 8px 0 4px 14px;
  margin-left: 3px;
  border-left: 2px solid var(--hc-border);
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--hc-text-secondary);
  -webkit-font-smoothing: antialiased;
}

/* 流式思考中限制高度防止页面跳动，展开后不限制 */
.hc-thinking__header + .hc-thinking__content {
  max-height: 40vh;
  overflow-y: auto;
}
</style>
