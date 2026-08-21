<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted, watch, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  ChevronDown,
  FileCode,
  MessageSquarePlus,
  Plus,
  Settings,
  Zap,
  BookOpen,
  Brain,
} from 'lucide-vue-next'
import { useChatStore } from '@/stores/chat'
import { useAppStore } from '@/stores/app'
import {
  bindSessionAgent,
  getSessionAgent,
  markSessionAgentOrphaned,
} from '@/stores/session-agent-binding'
import {
  getSessionThinkingPolicy,
  setSessionThinkingPolicy,
} from '@/stores/session-thinking-preference'
import {
  allowedReasoningEfforts,
  nativeReasoningPolicyFromControl,
  resolveReasoningPolicy,
  toReasoningRequest,
  type ReasoningEffort,
  type ReasoningPolicy,
} from '@/utils/reasoning-policy'
import { healLegacySessionTitles } from '@/stores/session-title-heal'
import { useThrottledText } from '@/composables/useThrottledText'
import { isChannelDefaultAgent } from '@/utils/imChannelBinding'
import { removeMessage } from '@/services/messageService'
import { useAgentsStore } from '@/stores/agents'
import {
  scenarioRegistry,
  scenarioMessageAnchorId,
  type ScenarioComposerAction,
  type ScenarioComposerChip,
  type ScenarioComposerCommand,
  type ScenarioComposerImagePayload,
  type ScenarioImageModelRoute,
  type ScenarioTextModelRoute,
} from '@/shell/scenario/registry'
import VerifyBadge from '@/shell/chat/VerifyBadge.vue'
import RecordChip from '@/shell/chat/RecordChip.vue'
import { parseRecordMeta } from '@/shell/chat/recordMeta'
import type { VerifyResult, VerifyVerdict } from '@/contracts'
import { useSettingsStore } from '@/stores/settings'
import {
  setSessionModel,
  getSessionModel,
  resolveSessionModel,
  decideSessionModelAction,
  type SessionModelBinding,
  type KnownNonChatModelIdentity,
} from '@/stores/session-model-binding'
import { getStreamThinkingDuration } from '@/stores/chat-stream-helpers'
import { isChatModelOption } from '@/stores/settings-helpers'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import AssistantRunStatus from '@/components/chat/AssistantRunStatus.vue'
import ThinkingProgress from '@/components/chat/ThinkingProgress.vue'
import MessageText from '@/components/chat/MessageText.vue'
import {
  shouldSendOnEnter,
  imageSrc,
  scrollNavFlags,
  resolveChatScroll,
  videoPosterFromMetadata,
  videoDisplaySrc,
} from '@/utils/chat-compose'
import { sanitizeMessageContent } from '@/utils/messageContent'
import MessageActions from '@/components/chat/MessageActions.vue'
import MessageFooter from '@/components/chat/MessageFooter.vue'
import ChatInput from '@/components/chat/ChatInput.vue'
import { useConversationScrollCoordinator } from '@/composables/useConversationScrollCoordinator'
import SkillCreateDialog from '@/components/skills/SkillCreateDialog.vue'
import SkillIcon from '@/components/common/SkillIcon.vue'
import SessionList from '@/components/chat/SessionList.vue'
import ChatToolbar from '@/components/chat/ChatToolbar.vue'
import {
  resolveChatWorkspaceTransition,
  workspaceAfterRightPanelClose,
  type ChatWorkspaceMode,
} from '@/components/chat/workspace-mode'
import AgentBadge from '@/components/chat/AgentBadge.vue'
import ToolApprovalCard from '@/components/chat/ToolApprovalCard.vue'
import SubAgentPanel from '@/components/chat/SubAgentPanel.vue'
import ToolCallCard from '@/components/chat/ToolCallCard.vue'
import MessageBlocks from '@/components/chat/MessageBlocks.vue'
import InteractiveBlock from '@/components/chat/InteractiveBlock.vue'
import ArtifactsPanel from '@/components/artifacts/ArtifactsPanel.vue'
import ContextMenu from '@/components/common/ContextMenu.vue'
import type { ContextMenuItem } from '@/components/common/ContextMenu.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import {
  useToast,
  useConversationAutomation,
  useChatSend,
  useChatActions,
  useCronCompileLabel,
} from '@/composables'
import type { EditedMessageSubmission } from '@/composables/useChatActions'
import { freezeChatRouteSnapshot, type ChatRouteSnapshot } from '@/stores/chat-route-snapshot'
import { isDocumentFile, parseDocument } from '@/utils/file-parser'
import { waitForOllamaModelVisibility } from '@/utils/ollama-visibility'
import { normalizeAssistantReasoning } from '@/utils/assistant-reply'
import { resolveProviderDisplayName } from '@/utils/provider-display-name'
import { knowledgeHitTitle, knowledgeHitSubtitle } from '@/utils/retrieval-hits'
import { getSubAgentReports, isSubAgentToolCall, type SubAgentReport } from '@/utils/subagents'
import { getSkills, type Skill } from '@/api/skills'
import { getDocuments } from '@/api/knowledge'
import { getConnectionsResult, type ConnectionSummary } from '@/api/im-channels'
import type { KnowledgeDoc } from '@/types'
import { setClipboard } from '@/api/desktop'
import { appendSessionMessage, appendSessionMessagesBatch } from '@/api/chat'
import { inferCapabilitiesFromId } from '@/config/providers'
import { logger } from '@/utils/logger'
import VoiceChatComposer from '@/components/chat/VoiceChatComposer.vue'
import { getImageGenStatus, imageToSrc, type ImageGenResult } from '@/api/imagegen'
import { getVideoGenStatus, videoToSrc, coverToSrc, type VideoTaskStatus } from '@/api/videogen'
import { getVoiceChatStatus, audioToSrc, type VoiceChatResult } from '@/api/voicechat'
import { nanoid } from 'nanoid'
import type {
  ChatAttachment,
  ChatDocumentRef,
  ChatMessage,
  ModelReasoningControl,
  ModelReasoningSupport,
} from '@/types'
import { parseReasoningReceipt, type ReasoningReceipt } from '@/types/chat'
import type { RenderManifest } from '@/contracts/message-content'
import { recordNestedRenderManifest, recordRenderManifest } from '@/contracts/render-evidence'
import { getDocPreviewFile } from '@/utils/doc-preview'
import { uploadDocumentPreview, documentPreviewUrl } from '@/api/documents'
import { openOrDownloadDocument } from '@/utils/download'
import { backendDeletableMessageId } from '@/utils/chat-message-id'
import crabLogo from '@/assets/logo-crab.png'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const chatStore = useChatStore()
const appStore = useAppStore()
const agentsStore = useAgentsStore()
const settingsStore = useSettingsStore()

function captureRenderManifest(message: ChatMessage, manifest: RenderManifest) {
  recordRenderManifest(message, manifest)
}

function captureNestedManifest(message: ChatMessage, manifest: RenderManifest) {
  recordNestedRenderManifest(message, manifest)
}

/**
 * 是否已配置过模型 —— 与路由首屏守卫（router/index.ts）同款判定：有任一 provider，或已
 * 走完欢迎向导（welcomeCompleted），即视为已过首次配置。已配置后空态不再提示「运行首次
 * 配置向导」（按用户要求）。
 */
const hasConfiguredModel = computed(
  () =>
    (settingsStore.config?.llm.providers?.length ?? 0) > 0 ||
    settingsStore.config?.general?.welcomeCompleted === true,
)
const toast = useToast()
const QUERY_MODEL_RETRY_INTERVAL = 1000
const QUERY_MODEL_RETRY_TIMES = 4
let queryModelSelectionAbort: AbortController | null = null
const messagesEndRef = ref<HTMLDivElement>()
const messagesContainerRef = ref<HTMLDivElement>()
const thinkingContentRef = ref<HTMLDivElement>()
function bindThinkingContentRef(element: HTMLDivElement | null) {
  thinkingContentRef.value = element ?? undefined
}
const showScrollToBottom = ref(false)
const userScrolledUp = ref(false)

type ThinkingProgressState = 'running' | 'completed' | 'failed' | 'cancelled'

function messageThinkingElapsed(message: ChatMessage): number {
  const elapsed = Number(message.metadata?.thinking_duration)
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0
}

function messageThinkingState(message: ChatMessage): ThinkingProgressState {
  const state = message.metadata?.thinking_state
  return state === 'running' || state === 'completed' || state === 'failed' || state === 'cancelled'
    ? state
    : 'completed'
}

function messageReasoningVisibility(message: ChatMessage): 'visible' | 'not_exposed' {
  if (message.metadata?.reasoning_visibility === 'not_exposed') return 'not_exposed'
  return message.reasoning ? 'visible' : 'not_exposed'
}

function hasThinkingProgress(message: ChatMessage): boolean {
  const state = message.metadata?.thinking_state
  return (
    !!normalizeAssistantReasoning(message.reasoning ?? '') ||
    messageThinkingElapsed(message) > 0 ||
    state === 'running' ||
    state === 'completed' ||
    state === 'failed' ||
    state === 'cancelled'
  )
}

function messageReasoningReceipt(message: ChatMessage): ReasoningReceipt | null {
  const receipt = message.metadata?.reasoning_receipt
  return receipt === undefined ? null : (parseReasoningReceipt(receipt) ?? null)
}
const unreadScenarioResultCount = ref(0)
const scrollCoordinator = useConversationScrollCoordinator({
  getContainer: () => messagesContainerRef.value,
  getBottomAnchor: () => messagesEndRef.value,
  getRevealTarget: (contentIdentity) =>
    document
      .getElementById(scenarioMessageAnchorId(contentIdentity))
      ?.querySelector<HTMLElement>('[data-testid="blank-worksheet-parent-guide"]') ?? undefined,
  isAtBottom: () => !userScrolledUp.value,
  onFollowBottom: () => {
    userScrolledUp.value = false
    showScrollToBottom.value = false
    unreadScenarioResultCount.value = 0
  },
  onRevealStart: () => {
    if (_scrollTimer) {
      clearTimeout(_scrollTimer)
      _scrollTimer = null
    }
    userScrolledUp.value = true
    showScrollToBottom.value = true
  },
})
const scrollNavigationLabel = computed(() =>
  unreadScenarioResultCount.value > 0
    ? t('chat.newResults', { n: unreadScenarioResultCount.value })
    : t('chat.scrollToBottom', 'Scroll to bottom'),
)
const chatWorkspaceMode = ref<ChatWorkspaceMode>(
  chatStore.showArtifacts ? 'artifacts' : appStore.detailPanelOpen ? 'context' : 'sessions',
)
// 右侧工作区临时挤出会话栏；只有用户点击左侧按钮时才记为明确折叠。
const sessionsCollapsedByUser = ref(false)
const showSessions = computed(() => chatWorkspaceMode.value === 'sessions')
const isConversationOnly = computed(() => chatWorkspaceMode.value === 'focus')

function restoreWorkspaceAfterRightPanelClose() {
  chatWorkspaceMode.value = workspaceAfterRightPanelClose(sessionsCollapsedByUser.value)
}

function onWorkspaceModeChange(next: ChatWorkspaceMode) {
  const transition = resolveChatWorkspaceTransition(
    chatWorkspaceMode.value,
    next,
    sessionsCollapsedByUser.value,
  )
  sessionsCollapsedByUser.value = transition.sessionsCollapsedByUser
  chatWorkspaceMode.value = transition.mode
}

function syncWorkspaceModeProjection(mode: ChatWorkspaceMode) {
  const artifactsOpen = mode === 'artifacts'
  const contextOpen = mode === 'context'
  if (chatStore.showArtifacts !== artifactsOpen) chatStore.showArtifacts = artifactsOpen
  if (appStore.detailPanelOpen !== contextOpen) appStore.setDetailPanelOpen(contextOpen)
}

// ChatWorkspaceMode 是唯一状态源；旧 Store 布尔值只作为跨 Shell 的兼容投影。
watch(chatWorkspaceMode, syncWorkspaceModeProjection, { immediate: true, flush: 'sync' })
// 非工具栏入口（产物卡、持久化的上下文面板）统一归并回同一状态机。
watch(
  () => chatStore.showArtifacts,
  (open) => {
    if (open && chatWorkspaceMode.value !== 'artifacts') chatWorkspaceMode.value = 'artifacts'
    else if (!open && chatWorkspaceMode.value === 'artifacts')
      restoreWorkspaceAfterRightPanelClose()
  },
  { flush: 'sync' },
)
watch(
  () => appStore.detailPanelOpen,
  (open) => {
    if (open && chatWorkspaceMode.value !== 'context') chatWorkspaceMode.value = 'context'
    else if (!open && chatWorkspaceMode.value === 'context') restoreWorkspaceAfterRightPanelClose()
  },
  { flush: 'sync' },
)
const SIDEBAR_DEFAULT_WIDTH = 256
const SIDEBAR_COMPACT_WIDTH = 220
const SIDEBAR_COMPACT_BREAKPOINT = 1040
const sidebarWidth = ref(SIDEBAR_DEFAULT_WIDTH)
const SIDEBAR_WIDTH_STORAGE_KEY = 'hexclaw_chat_sidebar_width'
const SIDEBAR_MIN_WIDTH = SIDEBAR_DEFAULT_WIDTH
const SIDEBAR_MAX_WIDTH = 420
const viewportWidth = ref(typeof window === 'undefined' ? 1280 : window.innerWidth)
const effectiveSidebarWidth = computed(() =>
  viewportWidth.value <= SIDEBAR_COMPACT_BREAKPOINT ? SIDEBAR_COMPACT_WIDTH : sidebarWidth.value,
)
function updateViewportWidth() {
  viewportWidth.value = window.innerWidth
}
onMounted(() => {
  updateViewportWidth()
  window.addEventListener('resize', updateViewportWidth)
})
onUnmounted(() => window.removeEventListener('resize', updateViewportWidth))
const sidebarResizing = ref(false)
let sidebarDragging = false
let sidebarDragStartX = 0
let sidebarDragStartWidth = 0
let sidebarRafId = 0
let bodyCursorBeforeDrag = ''
let bodyUserSelectBeforeDrag = ''

const attachmentPreview = ref<{
  url: string
  name: string
  type: 'image' | 'video' | 'file'
  file: File
} | null>(null)
const showModelSelector = ref(false)
const showThinkingSelector = ref(false)
const isDragging = ref(false)
const availableSkills = ref<Skill[]>([])
const knowledgeDocs = ref<KnowledgeDoc[]>([])
const connections = ref<ConnectionSummary[]>([])
const connectionDirectoryState = ref<'loading' | 'ready' | 'error'>('loading')
let connectionDirectoryGeneration = 0
let connectionDirectoryDisposed = false

async function loadConnectionDirectory() {
  const generation = ++connectionDirectoryGeneration
  if (connectionDirectoryDisposed) return
  connectionDirectoryState.value = 'loading'
  try {
    const result = await getConnectionsResult()
    if (connectionDirectoryDisposed || generation !== connectionDirectoryGeneration) return
    connections.value = result.connections
    connectionDirectoryState.value = result.error ? 'error' : 'ready'
  } catch {
    if (connectionDirectoryDisposed || generation !== connectionDirectoryGeneration) return
    connections.value = []
    connectionDirectoryState.value = 'error'
  }
}

let stopSidecarReadyListener: (() => void) | null = null
let sidecarReadyListenerTimeout: ReturnType<typeof setTimeout> | null = null
let sidecarReadyHandling = false

function clearSidecarReadyListener() {
  if (sidecarReadyListenerTimeout) {
    clearTimeout(sidecarReadyListenerTimeout)
    sidecarReadyListenerTimeout = null
  }
  stopSidecarReadyListener?.()
  stopSidecarReadyListener = null
}

onUnmounted(() => {
  connectionDirectoryDisposed = true
  connectionDirectoryGeneration += 1
  clearSidecarReadyListener()
})

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
    { id: 'delete', label: t('common.delete'), icon: undefined, danger: true },
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
      requestDeleteMessage(msg.id)
      break
    }
  }
}

// 单条消息删除——单一真相源：右键菜单与悬浮工具条「删除」按钮都走这里。
// 删除会 DELETE 后端且 UI 无恢复入口=用户视角不可逆，故先弹二次确认(对齐 deleteSession)。
const pendingDeleteMsgId = ref<string | null>(null)

function requestDeleteMessage(msgId: string | null) {
  if (!msgId) return
  pendingDeleteMsgId.value = msgId
}

function confirmDeleteMessage() {
  const id = pendingDeleteMsgId.value
  pendingDeleteMsgId.value = null
  if (!id) return
  const idx = chatStore.messages.findIndex((item) => item.id === id)
  if (idx >= 0) deleteMessageAt(idx)
}

function deleteMessageAt(idx: number) {
  // AP-094 同类：旧实现 fire-and-forget 吞错→删除失败时后端残留、重载"复活"。
  // 现：乐观移除 + await，失败回滚 UI + 提示；404/410=已不在后端视为删除达成。
  const removed = chatStore.messages.splice(idx, 1)
  if (removed.length === 0) return
  void Promise.all(removed.map((m) => removeMessage(backendDeletableMessageId(m)))).catch(
    (error) => {
      const status = (error as { status?: number })?.status
      if (status === 404 || status === 410) return
      chatStore.messages.splice(idx, 0, ...removed)
      logger.error(
        `[ChatView] delete message failed, rolled back: ${error instanceof Error ? error.message : String(error)}`,
      )
      toast.error(t('chat.deleteMessageFailed'))
    },
  )
}

// ── 消息区窗口化(BUG-20260710 P1)：长会话全量 DOM 是「hex 久用变卡」次因——
// 默认只渲染尾部 60 条,「显示更早」增量展开(带滚动位置补偿),切会话重置。
// 模板内一切绝对索引语义(重试/编辑/上一条比较)必须用 windowOffset + idx 换算。
const MESSAGE_WINDOW_INITIAL = 60
const MESSAGE_WINDOW_STEP = 100
const messageWindow = ref(MESSAGE_WINDOW_INITIAL)
// Stream content remains throttled, but the live projection uses the same stable assistant identity.
const throttledStreamContent = useThrottledText(() => chatStore.isCurrentStreamingContent, 300)
const visibleMessages = computed(() =>
  chatStore.messages.length > messageWindow.value
    ? chatStore.messages.slice(-messageWindow.value)
    : chatStore.messages,
)
const currentLiveStream = computed(() => {
  const sessionId = chatStore.currentSessionId
  return sessionId ? ((chatStore.activeStreams ?? {})[sessionId] ?? null) : null
})
const liveAssistantMessage = computed<ChatMessage | null>(() => {
  const stream = currentLiveStream.value
  if (!stream?.assistantMessageId) return null
  const visibility = stream.visibility ?? 'not_exposed'
  return {
    id: stream.assistantMessageId,
    role: 'assistant',
    content: throttledStreamContent.value,
    reasoning:
      visibility === 'visible'
        ? normalizeAssistantReasoning(stream.reasoning, { trim: false })
        : undefined,
    timestamp: new Date(stream.startedAt ?? Date.now()).toISOString(),
    agent_name: stream.agentDisplayName,
    metadata: {
      thinking_state: stream.thinkingEnabled ? (stream.state ?? 'running') : undefined,
      thinking_duration: stream.thinkingEnabled
        ? stream.reasoningEndTime
          ? (getStreamThinkingDuration(stream) ?? 0)
          : chatStore.streamingThinkingElapsed
        : undefined,
      reasoning_visibility: stream.thinkingEnabled ? visibility : undefined,
      recipient_display_name: stream.recipientDisplayName,
    },
  }
})
const renderedMessages = computed(() => {
  const live = liveAssistantMessage.value
  if (!live || visibleMessages.value.some((message) => message.id === live.id)) {
    return visibleMessages.value
  }
  return [...visibleMessages.value, live]
})
function isLiveAssistantMessage(message: ChatMessage): boolean {
  return liveAssistantMessage.value?.id === message.id
}
const windowOffset = computed(() => chatStore.messages.length - visibleMessages.value.length)
const hiddenEarlierCount = computed(() => windowOffset.value)
function showEarlierMessages() {
  const host = messagesContainerRef.value
  const prevHeight = host?.scrollHeight ?? 0
  messageWindow.value += MESSAGE_WINDOW_STEP
  nextTick(() => {
    // 滚动补偿:顶部插入内容后保持视口停留在原消息上(聊天窗口化惯例)
    if (host) host.scrollTop += host.scrollHeight - prevHeight
  })
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

// sanitizeMessageContent 抽到 @/utils/messageContent（纯函数，可单测）：只截断真正的图像 base64
// （data:image;base64,… 或 600+ 连续裸 base64 run），保留周围正常文字，不误伤长英文/代码回复。

function getMessageAttachments(message: ChatMessage): ChatAttachment[] {
  const attachments = message.metadata?.attachments
  return Array.isArray(attachments) ? (attachments as ChatAttachment[]) : []
}

// ─── 子 Agent 协作面板（orchestrate/spawn 工具结果尾部的 hexclaw-subagents 哨兵块）───
// 一次性按消息 id 建 reports 映射（避免模板里逐帧重复 JSON.parse）；消息流变化时重算。
const subAgentReportsByMsg = computed(() => {
  const map = new Map<string, SubAgentReport[]>()
  for (const m of chatStore.messages) {
    if (m.role !== 'assistant') continue
    const reports = getSubAgentReports(m)
    if (reports.length) map.set(m.id, reports)
  }
  return map
})
// 协作面板已接管 orchestrate/spawn 的展示，故从原始 tool_calls 列表里隐藏它们，避免重复。
function displayToolCalls(message: ChatMessage) {
  const calls = message.tool_calls ?? []
  if (!subAgentReportsByMsg.value.has(message.id)) return calls
  return calls.filter((tc) => !isSubAgentToolCall(tc.name))
}

// ─── 文档卡片（ChatGPT 风格：图标 + 名称 + 类型·大小 + 下载按钮；正文已进隐藏上下文）───
function getMessageDocuments(message: ChatMessage): ChatDocumentRef[] {
  const docs = message.metadata?.documents
  return Array.isArray(docs) ? (docs as ChatDocumentRef[]) : []
}
function docExt(doc: ChatDocumentRef): string {
  const i = doc.name.lastIndexOf('.')
  return i >= 0 ? doc.name.slice(i + 1).toUpperCase() : 'FILE'
}
function formatDocSize(bytes: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
/** 原文件仍在本会话 → 可预览 / 下载（重载后失效，卡片仍展示）。 */
function docActionable(doc: ChatDocumentRef): boolean {
  return !!getDocPreviewFile(doc.id)
}
async function openDocViaSidecar(doc: ChatDocumentRef, download: boolean) {
  // 预览走系统默认应用；下载走应用内 Save 对话框（绝不丢给系统浏览器，BUG-20260626）。
  await openOrDownloadDocument({
    file: getDocPreviewFile(doc.id) ?? null,
    download,
    filename: doc.name,
    uploadPreview: uploadDocumentPreview,
    previewUrl: documentPreviewUrl,
    toast,
    expiredMsg: t('chat.docPreviewExpired'),
    failedMsg: t('chat.docPreviewFailed'),
    savedMsg: (p) => '已保存到 ' + p,
  })
}
function openDocumentPreview(doc: ChatDocumentRef) {
  void openDocViaSidecar(doc, false)
}
function downloadDocument(doc: ChatDocumentRef) {
  void openDocViaSidecar(doc, true)
}

/** 原位编辑卡片里要常驻显示的图片缩略图（编辑文字时图片不消失，BUG-20260625）。 */
function editingImages(message: ChatMessage): ChatAttachment[] {
  return getMessageAttachments(message).filter((a) => a.type === 'image')
}

/** 用户消息发送时挂载的 skill 名（BUG-20260622：气泡需显示这些 skill）。 */
function getMessageSkills(message: ChatMessage): string[] {
  const s = message.metadata?.skills
  return Array.isArray(s) ? (s as string[]).filter((x) => typeof x === 'string') : []
}
/** 用 availableSkills 还原 skill 元信息供 SkillIcon 渲染；缺失则按名兜底。 */
function skillForChip(name: string): {
  name: string
  icon?: string
  tags?: string[]
  display_name?: string
} {
  const found = availableSkills.value.find((s) => s.name === name)
  return found ?? { name }
}

/** D2 交互按钮：从 message.metadata.interactive_buttons 解析。
 *
 * 后端协议（K12 识题确认场景）：
 *   metadata.interactive_buttons = {
 *     prompt?: string,
 *     buttons: [{ label, action, variant?, payload? }],
 *     resolved?: { action, label }   // 用户已点击后由前端写回
 *   }
 */
interface InteractiveButtonsBlock {
  prompt?: string
  buttons: Array<{
    label: string
    action: string
    variant?: 'primary' | 'secondary'
    payload?: string
  }>
  resolved?: { action: string; label: string }
}
function getInteractiveButtons(message: ChatMessage): InteractiveButtonsBlock | null {
  const raw = message.metadata?.interactive_buttons
  if (!raw) return null
  // 后端 reply.Metadata 是 map[string]string，所以 buttons 通常是 JSON 字符串；
  // 前端写回 resolved 时直接保存 object —— 这里同时兼容两种类型
  let block: InteractiveButtonsBlock | null = null
  if (typeof raw === 'string') {
    try {
      block = JSON.parse(raw) as InteractiveButtonsBlock
    } catch {
      return null
    }
  } else if (typeof raw === 'object') {
    block = raw as InteractiveButtonsBlock
  }
  if (!block || !Array.isArray(block.buttons) || block.buttons.length === 0) return null
  return block
}

/**
 * v0.4.0 G3/E6: 统一交互载荷读取入口。
 *  - 优先 message.interactive（新协议，4 type 支持）
 *  - fallback 到 metadata.interactive_buttons（老 JSON 字符串/对象，仅 buttons 类型）
 *
 * 老路径会被透明适配为 InteractivePayload 喂给 InteractiveBlock。
 */
function getInteractivePayload(message: ChatMessage): import('@/types').InteractivePayload | null {
  if (message.interactive) return message.interactive
  const legacy = getInteractiveButtons(message)
  if (!legacy) return null
  return {
    type: 'buttons',
    prompt: legacy.prompt,
    buttons: legacy.buttons,
    resolved: legacy.resolved
      ? { action: legacy.resolved.action, label: legacy.resolved.label }
      : undefined,
  }
}

async function handleInteractiveSelect(
  message: ChatMessage,
  payload: { action: string; label: string; value?: string; payload?: string; approved?: boolean },
) {
  // 1) 把 resolved 写回，禁用其余选项；优先写入新协议字段，否则回写老 metadata
  if (message.interactive) {
    message.interactive = {
      ...message.interactive,
      resolved: {
        action: payload.action,
        label: payload.label,
        value: payload.value,
        approved: payload.approved,
        timestamp: new Date().toISOString(),
      },
    }
  } else {
    const block = getInteractiveButtons(message)
    if (block) {
      block.resolved = { action: payload.action, label: payload.label }
      if (!message.metadata) message.metadata = {}
      message.metadata.interactive_buttons = block
    }
  }
  // 2) 用用户身份把选择回传到对话流，后端可从 metadata.interactive_action 路由处理
  // 文本格式：approval 类→直接 label；select 类→label (value)；其他→label (payload?)
  let text = payload.label
  if (typeof payload.approved === 'boolean') {
    text = payload.label
  } else if (payload.value) {
    text = `${payload.label} (${payload.value})`
  } else if (payload.payload) {
    text = `${payload.label} (${payload.payload})`
  }
  try {
    await chatStore.sendMessage(text, undefined, {
      backendText: text,
    })
  } catch (e) {
    logger.warn('[HexClaw] G3 交互回传失败:', e)
  }
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
/** 新会话尚未取得 ID 前的临时显式选择；分配 ID 后立即写回会话偏好。 */
const draftThinkingPolicy = ref<ReasoningPolicy>({ mode: 'inherit' })
/** localStorage 偏好不是响应式数据源，版本号仅用于让当前会话解析重新取值。 */
const thinkingPolicyRevision = ref(0)
/** true when user explicitly picks a model via selectModel(), reset on agent/session switch */
const userOverrodeModel = ref(false)
/** 深度思考只改变推理能力，不改变已有收件人的模型所有权。
 *  普通 research 的内部 researcher 仍沿用既有全局模型路由。 */
const usesBoundAgentModel = computed(
  () =>
    !userOverrodeModel.value &&
    !!chatStore.agentRole &&
    chatStore.agentRole !== 'researcher' &&
    (chatStore.chatMode === 'agent' || chatStore.chatMode === 'research'),
)
/** 绑定模型暂不在 availableModels 时的自足元信息（名/能力来自会话绑定）：让显示与能力门控
 *  不依赖列表加载（修复 BUG-20260626）。模型一旦进入 availableModels，下面 computed 优先用列表
 *  里的 found，本 ref 即被忽略；进入「列表里有」的选择/恢复路径时清空，避免残留。 */
const pendingModelMeta = ref<{ name: string; capabilities: string[] } | null>(null)

function projectedAgentDisplay(agentId: string, candidate?: string | null): string {
  const cfg = agentsStore.findAgent(agentId)
  const fallback = candidate?.trim() || cfg?.display_name?.trim() || cfg?.name || agentId
  if (!cfg) return fallback
  return scenarioRegistry.projectInstanceDisplayName(
    {
      agentId: cfg.name,
      agentName: cfg.display_name,
      metadata: cfg.metadata,
    },
    fallback,
  )
}

// 当前模型的显示名
const selectedModelDisplay = computed(() => {
  // 已绑定 Agent 开启深度思考后仍显示同一 Agent 偏好模型；research 不等于换收件人。
  if (usesBoundAgentModel.value) {
    const cfg = agentsStore.findAgent(chatStore.agentRole)
    if (cfg?.model) {
      return cfg.model
    }
  }
  if (selectedModel.value === 'auto') return t('chat.modelAuto')
  if (!selectedModel.value) return t('chat.selectModel')
  const found = settingsStore.availableModels.find(
    (m) =>
      m.modelId === selectedModel.value &&
      (!selectedProviderId.value || m.providerId === selectedProviderId.value),
  )
  // 列表里有 → 用最新名；否则用绑定自带的显示名（自足），最后才退化到 modelId（绝不退化成"默认模型"）。
  return found ? `${found.modelName}` : pendingModelMeta.value?.name || selectedModel.value
})

// 收件人显示名（BUG-20260704）：agentRole 存内部 name 作后端收件人键，展示时解析成
// display_name，让收件人徽章呈现人看得懂的名字而非英文 name。
const agentRoleDisplay = computed(() => {
  if (!chatStore.agentRole) return ''
  return projectedAgentDisplay(chatStore.agentRole)
})

// 场景包会话增强（架构 §8.4）：由后端/registry 决定当前实例是否有增强视图，
// chat shell 只解析描述符 + 渲染 registry 提供的组件，**不认识任何场景领域概念**（回归锁）。
const chatEnhancement = scenarioRegistry.chatEnhancement
const scenarioRecordsActive = ref(false)
// 场景增强上交的 composer 预设 chips（BUG-20260709：数据流替代 Teleport 锚点）。
// shell 只投影结构化 label/actionId，不解释 action 领域含义。
const scenarioComposerChips = ref<Array<string | ScenarioComposerChip>>([])
const scenarioComposerAction = ref<ScenarioComposerAction>()
let scenarioComposerActionSequence = 0
function handleScenarioComposerAction(actionId: string) {
  scenarioComposerAction.value = {
    id: actionId,
    sequence: ++scenarioComposerActionSequence,
  }
}
const chatInputRef = ref<InstanceType<typeof ChatInput>>()
function handleScenarioComposerCommand(command: ScenarioComposerCommand) {
  const composer = chatInputRef.value
  if (!composer) return
  if (command.type === 'focus') composer.focus()
  if (command.type === 'set-input') composer.setInput(command.text, command.focus !== false)
}
// 场景会话下 composer 拦截的图片：ChatInput 产出 original File/grant + session-local blob
// preview；shell 负责形成一次可见用户消息，并在场景资产 receipt 后持久同一消息、冻结
// 该次提交的 request_id + 实际会话路由。
const scenarioComposerImage = ref<ScenarioComposerImagePayload | ''>('')
interface PendingScenarioImageProjection {
  message: ChatMessage
  payload: ScenarioComposerImagePayload
}
// 编辑图片在 source 仍可见时先写入目标分支；只有该分支真正成为 current 后才允许
// 投影给场景组件。Map 以 session 为所有权边界，杜绝“同 Agent 即同会话”的错误假设。
const pendingScenarioImageProjections = new Map<string, PendingScenarioImageProjection[]>()
function activateScenarioImageProjection(sessionId: string): void {
  if (chatStore.currentSessionId !== sessionId) return
  if (scenarioComposerImage.value) return
  const queue = pendingScenarioImageProjections.get(sessionId)
  const pending = queue?.shift()
  if (!pending || pending.payload.sourceSessionId !== sessionId) return
  if (!chatStore.messages.some((message) => message.id === pending.message.id)) {
    chatStore.messages.push(pending.message)
  }
  scenarioComposerImage.value = pending.payload
  if (!queue?.length) pendingScenarioImageProjections.delete(sessionId)
  void nextTick(scrollToBottom)
}
function handleScenarioComposerImageConsumed(): void {
  scenarioComposerImage.value = ''
  const sessionId = chatStore.currentSessionId
  if (sessionId) void nextTick(() => activateScenarioImageProjection(sessionId))
}
function scenarioImageRoute(
  providerValue: string | undefined,
  modelValue: string | undefined,
): ScenarioImageModelRoute | undefined {
  const provider = providerValue?.trim() ?? ''
  const model = modelValue?.trim() ?? ''
  if (!provider || !model || model === 'auto') return undefined
  return { provider, model, capability: 'vision' }
}
function scenarioTextRoute(
  providerValue: string | undefined,
  modelValue: string | undefined,
): ScenarioTextModelRoute | undefined {
  const provider = providerValue?.trim() ?? ''
  const model = modelValue?.trim() ?? ''
  if (!provider || !model || model === 'auto') return undefined
  return { provider, model, capability: 'text' }
}
function currentScenarioTextRoute(): ScenarioTextModelRoute | undefined {
  // 文本场景任务与普通发送/视觉任务遵循同一模型所有权：未手动覆盖时优先 Agent
  // 绑定；只有 Agent 明确跟随全局默认时才使用 composer 当前选择。
  if (usesBoundAgentModel.value) {
    const cfg = agentsStore.findAgent(chatStore.agentRole)
    const bound = scenarioTextRoute(cfg?.provider, cfg?.model)
    if (bound) return bound
    if (cfg?.model?.trim()) {
      const matched = settingsStore.availableModels.find(
        (candidate) => candidate.modelId === cfg.model,
      )
      const resolved = scenarioTextRoute(matched?.providerKey, cfg.model)
      if (resolved) return resolved
    }
  }
  return scenarioTextRoute(selectedProviderKey.value, selectedModel.value)
}
function currentScenarioImageRoute(): ScenarioImageModelRoute | undefined {
  // Agent 模式未手动覆盖时，输入框展示的是 Agent 绑定模型；不能拿 selected* 中的
  // 全局默认冒充它。Agent 明确跟随全局默认（provider/model 为空）时再落到 selected*。
  if (usesBoundAgentModel.value) {
    const cfg = agentsStore.findAgent(chatStore.agentRole)
    const bound = scenarioImageRoute(cfg?.provider, cfg?.model)
    if (bound) return bound
    if (cfg?.model?.trim()) {
      const matched = settingsStore.availableModels.find(
        (candidate) => candidate.modelId === cfg.model,
      )
      const resolved = scenarioImageRoute(matched?.providerKey, cfg.model)
      if (resolved) return resolved
    }
  }
  return scenarioImageRoute(selectedProviderKey.value, selectedModel.value)
}
async function persistScenarioImageMessage(
  message: ChatMessage,
  sessionId: string,
): Promise<boolean> {
  try {
    await appendSessionMessage(sessionId, {
      id: message.id,
      role: 'user',
      content: message.content,
      metadata: message.metadata,
    })
    return true
  } catch (errorValue) {
    logger.error('[ChatView] persist scenario image message failed', errorValue)
    toast.error?.(t('chat.persistFailed', '消息保存失败，刷新会话后可能丢失'))
    return false
  }
}
async function handleScenarioImage(
  payload: ScenarioComposerImagePayload,
  targetSessionId?: string,
  frozenRoute?: ScenarioImageModelRoute | null,
): Promise<boolean> {
  const intendedSessionId = targetSessionId?.trim() || chatStore.currentSessionId?.trim() || ''
  if (intendedSessionId && chatStore.isSessionExecuting(intendedSessionId)) {
    return false
  }
  const message: ChatMessage = {
    id: nanoid(12),
    role: 'user',
    content: payload.contextText ?? '',
    timestamp: new Date().toISOString(),
    metadata: { attachments: [payload.attachment] },
  }
  // request_id 与可见/持久消息使用同一身份；模型选择也在用户动作发生时冻结，
  // 不能在 await 创建会话期间被后续 UI 操作改写。
  // undefined = ordinary composer submission resolves the current route now;
  // null/route = an edited submission already froze auto/explicit routing at confirmation.
  const route = frozenRoute === undefined ? currentScenarioImageRoute() : (frozenRoute ?? undefined)
  const directedSessionId = targetSessionId?.trim() || ''
  if (!directedSessionId) {
    chatStore.messages.push(message)
    void nextTick(scrollToBottom)
  }
  // 新会话首图必须先建立稳定 session，再启动场景；否则 source_session 为空，
  // 随后的会话 watcher 还会重建并清掉刚启动的识题面板。
  const sessionId = directedSessionId || (await chatStore.ensureSession())
  const routedPayload: ScenarioComposerImagePayload = {
    attachment: payload.attachment,
    ...(payload.file ? { file: payload.file } : {}),
    ...(payload.previewUrl ? { previewUrl: payload.previewUrl } : {}),
    ...(payload.dataUrl ? { dataUrl: payload.dataUrl } : {}),
    ...(payload.contextText !== undefined ? { contextText: payload.contextText } : {}),
    requestId: message.id,
    sourceSessionId: sessionId,
    ...(route ? { route } : {}),
  }
  // 新选图片必须先由场景侧拿到 immutable asset receipt。此处只把同一条本地消息替换成
  // 稳定资产 URL 后持久化；回调失败会阻止 ImageTask 创建并撤掉这条未持久消息。
  if (payload.file) {
    routedPayload.onSourceStored = async (receipt) => {
      const displayUrl = receipt.displayUrl.trim()
      if (!displayUrl) return false
      const persistentAttachment: ChatAttachment = {
        ...routedPayload.attachment,
        data: displayUrl,
      }
      routedPayload.attachment = persistentAttachment
      const currentMessage = chatStore.messages.find((candidate) => candidate.id === message.id)
      if (currentMessage) {
        currentMessage.metadata = {
          ...currentMessage.metadata,
          attachments: [persistentAttachment],
        }
      }
      message.metadata = {
        ...message.metadata,
        attachments: [persistentAttachment],
      }
      const persisted = await persistScenarioImageMessage(message, sessionId)
      if (!persisted) {
        if (chatStore.currentSessionId === sessionId) {
          const messageIndex = chatStore.messages.findIndex(
            (candidate) => candidate.id === message.id,
          )
          if (messageIndex >= 0) chatStore.messages.splice(messageIndex, 1)
        }
        chatStore.clearSessionExecution(sessionId, message.id)
      }
      return persisted
    }
  } else if (!(await persistScenarioImageMessage(message, sessionId))) {
    if (chatStore.currentSessionId === sessionId) {
      const messageIndex = chatStore.messages.findIndex((candidate) => candidate.id === message.id)
      if (messageIndex >= 0) chatStore.messages.splice(messageIndex, 1)
    }
    return false
  }
  chatStore.setSessionExecution(sessionId, {
    executionId: message.id,
    state: 'routing',
  })
  const queue = pendingScenarioImageProjections.get(sessionId) ?? []
  queue.push({ message, payload: routedPayload })
  pendingScenarioImageProjections.set(sessionId, queue)
  activateScenarioImageProjection(sessionId)
  return true
}
// 场景失败卡片的“重新提交”是一次新的用户 attempt，不是对旧 Job 原地换绑模型。
// feature 只把原始图片事实上交；shell 在点击时重新冻结当前路由，并用新的持久消息 ID
// 作为 request_id。相同旧 attempt 的并发事件只允许一个穿过边界，避免双击创建两个 Job。
const resubmittingScenarioAttempts = new Set<string>()
async function handleScenarioImageAttempt(payload: ScenarioComposerImagePayload) {
  const previousAttempt = payload.requestId?.trim()
  if (!previousAttempt || resubmittingScenarioAttempts.has(previousAttempt)) return
  resubmittingScenarioAttempts.add(previousAttempt)
  try {
    await handleScenarioImage(payload)
  } finally {
    resubmittingScenarioAttempts.delete(previousAttempt)
  }
}
// 场景内联内容是否活动。通用 shell 只据布尔状态隐藏空态、滚到会话末尾，不解析场景内容。
const scenarioInlineActive = ref(false)
function handleScenarioInlineActive(active: boolean) {
  scenarioInlineActive.value = active
  if (active) nextTick(() => scrollToBottom(true))
}

function handleScenarioContentUpdated(payload?: { sourceMessageId?: string; reveal?: 'start' }) {
  const contentIdentity =
    payload?.sourceMessageId?.trim() ||
    (typeof scenarioComposerImage.value === 'object'
      ? (scenarioComposerImage.value.requestId ?? 'scenario-inline')
      : 'scenario-inline')
  const update = scrollCoordinator.publishContentUpdated({
    conversationId: chatStore.currentSessionId ?? '',
    contentIdentity,
    reason: 'scenario-content-updated',
    reveal: payload?.reveal,
  })
  if (!update.atBottom) {
    unreadScenarioResultCount.value += 1
    showScrollToBottom.value = true
  }
}

function handleScenarioSessionExecution(payload: {
  sessionId: string
  executionId: string
  state: string
  automaticBudgetSeconds?: number
  automaticStartedAt?: number
  automaticDeadlineAt?: number
  operationDeadlineAt?: number
}) {
  chatStore.setSessionExecution(payload.sessionId, {
    executionId: payload.executionId,
    state: payload.state,
    automaticBudgetSeconds: payload.automaticBudgetSeconds,
    automaticStartedAt: payload.automaticStartedAt,
    automaticDeadlineAt: payload.automaticDeadlineAt,
    operationDeadlineAt: payload.operationDeadlineAt,
  })
}
const scenarioCtx = computed(() => {
  const name = chatStore.agentRole
  if (!name) return null
  const cfg = agentsStore.findAgent(name)
  const agentDisplayName = projectedAgentDisplay(name)
  const descriptor = scenarioRegistry.resolveDescriptor({
    agentId: name,
    agentName: agentDisplayName,
    metadata: cfg?.metadata,
  })
  if (!descriptor.headerTabs.length) return null
  return {
    agentId: name,
    agentName: agentDisplayName,
    sessionId: chatStore.currentSessionId ?? '',
    // 透传通用 metadata，场景专属字段由场景增强组件自行解析（ChatView 零场景知识）
    metadata: cfg?.metadata ?? {},
    descriptor,
    modelRoute: currentScenarioTextRoute(),
    messageIds: visibleMessages.value.map((message) => message.id),
  }
})
// Shell 只读取 descriptor 合同；任何场景都可声明自己的已批准头部，普通会话默认保留通用工具栏。
const scenarioOwnsHeader = computed(() => scenarioCtx.value?.descriptor.headerOwner === 'scenario')
watch([() => scenarioCtx.value?.agentId, () => scenarioCtx.value?.sessionId], ([, sessionId]) => {
  // 切孩子、切同一孩子的会话或离开场景时，上一会话的离散图片 attempt 均不得泄漏。
  scenarioInlineActive.value = false
  scenarioComposerImage.value = ''
  scenarioComposerAction.value = undefined
  if (sessionId) activateScenarioImageProjection(sessionId)
})

// 消息头/meta 里的 agent 名解析为可读 display_name（后端 msg.agent_name 常是内部 id，如
// k12-tutor-KKE5v8zQ，家长看不懂）。命中注册 agent 显示 display_name，否则回退原值（BUG-20260708）。
const INTERNAL_AGENT_ROLES = new Set(['assistant', 'default', 'researcher', 'writer', 'coder'])
function msgAgentDisplay(raw?: string | null): string {
  const name = (raw ?? '').trim()
  if (!name) return ''
  const registered = agentsStore.findAgent(name)
  if (registered) return projectedAgentDisplay(name)
  // researcher 等是路由/协作角色，不是产品里的智能体名称。场景会话优先显示绑定实例名，
  // 普通会话回退默认助手名，避免把后端内部标识泄漏给用户。
  if (INTERNAL_AGENT_ROLES.has(name)) return scenarioCtx.value?.agentName || t('chat.botName')
  return name
}

// 场景化空态（P0-20260708 P0-3）：实例声明了 emptyState 则替换通用「选择一个智能体」引导。
const scenarioEmptyState = computed(() => scenarioCtx.value?.descriptor.emptyState ?? null)
const scenarioComposerPlaceholder = computed(() => {
  const key = scenarioCtx.value?.descriptor.composer?.placeholderKey
  return key ? t(key) : undefined
})
const scenarioComposerHint = computed(() => {
  const hint = scenarioCtx.value?.descriptor.composer?.hint
  if (!hint) return undefined
  return { emphasis: t(hint.emphasisKey), detail: t(hint.detailKey) }
})

// 会话→Agent 绑定的标题兜底恢复（BUG-20260708）：早于绑定机制创建的老会话没存 localStorage 绑定，
// 但深链建会话时标题即被设为 agent 内部名（k12-tutor-xxx）。选中会话若无绑定，用标题解析出 Agent →
// 恢复 role + 场景增强 + 正确辅导人设，并回写绑定（此后不再依赖标题、抗改名）。依赖 agents 已加载，
// 故同时观察加载完成标志与 agent 名称集合；只看长度会漏掉 A→B 的同数量替换。
watch(
  // 字符串 key 形式（非裸 session-id getter）——避免与「滚动重置」watcher 的源码扫描锚点碰撞
  // （bug-20260628-newsession-scroll-arrow 用 indexOf 首个裸 getter 定位那个 watcher）。
  () =>
    JSON.stringify([
      chatStore.currentSessionId ?? '',
      agentsStore.agentsLoaded,
      agentsStore.registeredAgents.map((agent) => agent.name).sort(),
    ]),
  () => {
    const sid = chatStore.currentSessionId
    if (!sid) return
    // 孤儿绑定守卫（BUG-20260710）：绑定/恢复的 agent 已被删除（agents 加载完成后仍查无此人）
    // → 清 agentRole + 清绑定，会话诚实降级为普通展示。否则前端渲染场景皮肤、后端 role 查无此人
    // 回落默认助理（真机取证：孤儿辅导会话里小蟹自我介绍），双端呈现撕裂；后端同轮已加 fail-loud
    // guard（engine guardExplicitRoleExists），此守卫让前端不再发出注定失败的 role。
    // @im/ 频道默认 agent 恒不在可见列表（registeredAgents 过滤），豁免不清（AP-108 同源约定）。
    const role = chatStore.agentRole
    if (
      role &&
      agentsStore.agentsLoaded &&
      !isChannelDefaultAgent(role) &&
      !agentsStore.findAgent(role)
    ) {
      chatStore.agentRole = ''
      chatStore.chatMode = 'chat'
      // 墓碑化而非删除（BUG-20260712 治标）：活绑定语义失效（不再恢复死 role），
      // 但名字留给 SessionList 显示「已删除的智能体」——删绑定会连孤儿信号一起丢。
      if (getSessionAgent(sid) === role) markSessionAgentOrphaned(sid)
      toast.info(t('chat.orphanAgentCleared', '该智能体已删除，本会话回退为默认助理'))
      return
    }
    if (chatStore.agentRole) return
    if (getSessionAgent(sid)) return // 已有绑定，selectSession 已恢复
    const session = chatStore.sessions.find((s) => s.id === sid)
    const title = (session?.title ?? '').trim()
    if (!title) return
    // 据标题反查绑定 agent：标题可能是内部名（存量未自愈）或**显示名**（已被 session-title-heal
    // 自愈）——必须两者都能反查，否则从「会话」列表打开已自愈的 K12 会话恢复不出 agentRole →
    // 辅导 UI 不显示（BUG-20260712 #A）。
    const cfg = agentsStore.findAgentByNameOrDisplay(title)
    if (!cfg) return // 标题既非内部名也非显示名 → 普通会话，不动
    chatStore.agentRole = cfg.name
    chatStore.chatMode = 'agent'
    bindSessionAgent(sid, cfg.name)
  },
  { immediate: true },
)

// 存量标题自愈（BUG-20260712 治本终章）：趁 agent 还活着，把「标题=内部名」的旧会话落库为
// 显示名 + 补绑定（运行时反查 → 持久快照；未来删除走墓碑链路）。
// 触发是**数据就绪驱动**而非挂载时序驱动（BUG-20260712-K）：冷启动 sidecar 未就绪时
// onMounted 一次性触发会对空列表空跑、永不生效——首启左侧栏仍显示内部 ID 的根因。
// 自愈幂等（愈后标题不再命中），列表刷新多次触发零副作用。
watch(
  () => [chatStore.sessions.length, agentsStore.agentsLoaded] as const,
  ([sessionCount, agentsLoaded]) => {
    if (!sessionCount || !agentsLoaded) return
    void healLegacySessionTitles(chatStore.sessions, agentsStore.findAgent)
  },
  { immediate: true },
)

// 验算徽章（M1-7 · AP-5）：优先读结构化 verify 值对象（契约先行）；
// 回退把 solve 引擎的 solve_verdict 元数据映射成保守弱证据结论（不冒充"已程序验算"）。
// shell 只认 VerifyResult 数据契约，本函数是通用消息装饰接线，零场景领域词。
function messageVerify(msg: { metadata?: Record<string, unknown> | null }): VerifyResult | null {
  const meta = msg.metadata
  if (!meta) return null
  const structured = meta.verify
  if (structured && typeof structured === 'object') return structured as VerifyResult
  const verdict = meta.solve_verdict
  if (
    verdict === 'agree' ||
    verdict === 'disagree' ||
    verdict === 'unverifiable' ||
    verdict === 'out_of_scope'
  ) {
    return { verdict: verdict as VerifyVerdict, evidence: 'model_review' }
  }
  return null
}

// 入库徽章（record-chip）：判错入库时后端在 message.metadata.record 标注 { collection, fields, status }，
// shell 据 registry schema 渲染集合名/字段 chip/状态名——零场景领域词（回归锁）。
function messageRecordChip(msg: {
  metadata?: Record<string, unknown> | null
}): { collectionLabel: string; chips: string[]; statusLabel?: string } | null {
  // BUG-1：record 由后端以 map[string]string 透传，通常是 JSON 字符串；parseRecordMeta
  // 容忍字符串/对象两形态并校验 collection。
  const rec = parseRecordMeta(msg.metadata)
  if (!rec?.collection) return null
  const schema = scenarioRegistry.getSchema(rec.collection)
  if (!schema) return null
  const fields = rec.fields ?? {}
  const chips = schema.fields
    .filter((f) => f.role === 'chip' || f.role === 'meta')
    .map((f) => ({ label: t(f.labelKey), value: fields[f.key] }))
    .filter((c) => c.value != null && c.value !== '')
    .map((c) => `${c.label}【${String(c.value)}】`)
  const state = schema.states?.find((s) => s.id === rec.status)
  return {
    collectionLabel: t(schema.labelKey),
    chips,
    statusLabel: state ? t(state.labelKey) : undefined,
  }
}

// 按 Provider 分组的模型列表
/**
 * 渲染时计算模型有效能力（render-time inference 兜底，兼容存量 ['text']）。
 * 与 SettingsView.displayCapabilities 同源逻辑。
 */
function effectiveCaps(
  modelId: string,
  stored?: import('@/types').ModelCapability[],
): import('@/types').ModelCapability[] {
  const arr = stored ?? ['text']
  const isTextOnly = arr.length === 1 && arr[0] === 'text'
  return isTextOnly ? inferCapabilitiesFromId(modelId) : arr
}

/**
 * 模型下拉显示的单个 emoji 前缀 — 一眼识别"选中会切换 composer 吗"。
 * 优先级：纯生成 > 语音对话 > 视觉 > 音频工具 > 文本
 */
function modelKindEmoji(modelId: string, caps: import('@/types').ModelCapability[]): string {
  if (caps.includes('image_generation') && !caps.includes('text')) return '🎨'
  if (caps.includes('video_generation') && !caps.includes('text')) return '📹'
  if (backendVoiceChatModels.value.has(modelId)) return '🎤'
  if (caps.includes('vision')) return '👁'
  if (caps.includes('audio')) return '🎤'
  if (caps.includes('code')) return '💻'
  return '💬'
}

/** emoji 对应的可读文案 — 用作 title 提示，辅助屏阅读器 + 无 emoji 字体环境 */
function modelKindLabel(modelId: string, caps: import('@/types').ModelCapability[]): string {
  if (caps.includes('image_generation') && !caps.includes('text')) return '图像生成模型'
  if (caps.includes('video_generation') && !caps.includes('text')) return '视频生成模型'
  if (backendVoiceChatModels.value.has(modelId)) return '语音对话模型'
  if (caps.includes('vision')) return '视觉对话模型'
  if (caps.includes('audio')) return '音频工具模型'
  if (caps.includes('code')) return '代码专项模型'
  return '文本对话模型'
}

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
  // 全模型可见 — 选中后由 ChatView 按 capability 切换 composer
  // （chat / image-gen / video-gen 三种模式共用同一个会话流）。
  for (const m of settingsStore.availableModels) {
    const caps = effectiveCaps(m.modelId, m.capabilities)
    if (!groups[m.providerId]) {
      groups[m.providerId] = { providerName: m.providerName, models: [] }
    }
    groups[m.providerId]!.models.push({
      providerKey: m.providerKey,
      modelId: m.modelId,
      modelName: m.modelName,
      capabilities: caps,
    })
  }
  return groups
})

// 当前选中的模型类别。voice_chat 优先级高于 chat — 一旦后端注册了语音对话 Provider
// 且当前模型在白名单（gpt-4o-audio-preview 等），即使有 text 能力也走 voice_chat 模式。
const selectedModelKind = computed<
  'chat' | 'image_gen' | 'video_gen' | 'voice_chat' | 'audio_tool'
>(() => {
  const caps = selectedModelCapabilities.value
  const id = selectedModel.value || ''
  if (caps.includes('image_generation') && !caps.includes('text')) return 'image_gen'
  if (caps.includes('video_generation') && !caps.includes('text')) return 'video_gen'
  if (backendVoiceChatModels.value.has(id)) return 'voice_chat'
  if (caps.includes('text')) return 'chat'
  if (caps.includes('audio')) return 'audio_tool'
  return 'chat'
})

const isImageGenModel = computed(() => selectedModelKind.value === 'image_gen')
const isVideoGenModel = computed(() => selectedModelKind.value === 'video_gen')
const isVoiceChatModel = computed(() => selectedModelKind.value === 'voice_chat')

// 后端注册的生成模型集合 — 不在这里面的生成模型选了会失败，UI 灰掉。
// onMounted 时通过 /api/v1/{images,videos,voicechat}/status 一次性拉取。
/** 当前预览图（in-app modal）— Tauri WKWebView 不支持 window.open，必须走内嵌 */
const previewImageSrc = ref('')
function openImagePreview(src: string) {
  previewImageSrc.value = src
}
function closeImagePreview() {
  previewImageSrc.value = ''
}

/**
 * 为下载生成唯一文件名：`HexClaw-{ISO时间}-{4位随机}.{ext}`
 *
 * 避免 name 来自 content hash 导致多张图同名（同一 prompt 生成的相同内容会复用文件），
 * 也避免 Date.now() 在同秒内冲突。
 */
function makeUniqueDownloadName(hintName: string, src: string): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const ts =
    now.getFullYear() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    '-' +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  const rand = Math.random().toString(36).slice(2, 6)

  // 推断扩展名：hintName > URL 路径 > 默认 png
  let ext = 'png'
  const fromHint = hintName?.match(/\.([a-zA-Z0-9]{2,5})$/)?.[1]
  if (fromHint) ext = fromHint.toLowerCase()
  else {
    const fromSrc = src.match(/\.([a-zA-Z0-9]{2,5})(?:\?|$)/)?.[1]
    if (fromSrc) ext = fromSrc.toLowerCase()
    else if (src.startsWith('data:image/')) {
      ext = src.slice(11, src.indexOf(';')) || 'png'
    }
  }

  return `HexClaw-${ts}-${rand}.${ext}`
}

/**
 * 下载图片 — Tauri WKWebView 下 <a download> / blob URL 不可靠，走原生 Save 对话框。
 * 用户选择保存路径后，由 Rust 侧写盘（http/s 走 save_file_from_url，data: 走
 * save_bytes_to_path）。
 */
async function downloadImage(src: string, name: string) {
  const filename = makeUniqueDownloadName(name, src)
  try {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const { invoke } = await import('@tauri-apps/api/core')

    const chosen = await save({ defaultPath: filename })
    if (!chosen) return // 用户取消

    if (src.startsWith('http')) {
      await invoke<number>('save_file_from_url', { url: src, path: chosen })
    } else if (src.startsWith('data:')) {
      const commaIdx = src.indexOf(',')
      if (commaIdx < 0) throw new Error('invalid data URL')
      const base64 = src.slice(commaIdx + 1)
      await invoke<number>('save_bytes_to_path', { base64Data: base64, path: chosen })
    } else {
      throw new Error(`unsupported src: ${src.slice(0, 32)}`)
    }
    toast.success?.('已保存到 ' + chosen)
  } catch (e) {
    console.error('[ChatView] download failed', e)
    toast.error?.('下载失败：' + (e instanceof Error ? e.message : String(e)))
  }
}

/** 重新探测后端 gen Provider 状态 — 用户更新 API Key 后可立即解除灰显 */
async function refreshBackendGenStatus() {
  await Promise.all([
    getImageGenStatus()
      .then((s) => {
        backendImageModels.value = new Set(s.models)
      })
      .catch(() => {}),
    getVideoGenStatus()
      .then((s) => {
        backendVideoModels.value = new Set(s.models)
      })
      .catch(() => {}),
    getVoiceChatStatus()
      .then((s) => {
        backendVoiceChatModels.value = new Set(s.models)
      })
      .catch(() => {}),
  ])
}

const backendImageModels = ref<Set<string>>(new Set())
const backendVideoModels = ref<Set<string>>(new Set())
const backendVoiceChatModels = ref<Set<string>>(new Set())

/**
 * 模型在当前会话能否真正使用。
 * - voice_chat 模型（gpt-4o-audio）: 后端注册即可用
 * - text 模型: 永远 true（chat handler 兜底走 OpenAI 兼容协议）
 * - image_gen / video_gen: 必须在后端注册的模型集合里
 * - 纯 audio_tool（whisper / tts-1）: 不可用 — 不是 chat 入口
 */
function isModelUsable(modelId: string, caps: import('@/types').ModelCapability[]): boolean {
  if (backendVoiceChatModels.value.has(modelId)) return true
  if (caps.includes('text')) return true
  if (caps.includes('image_generation')) return backendImageModels.value.has(modelId)
  if (caps.includes('video_generation')) return backendVideoModels.value.has(modelId)
  if (caps.includes('audio')) return false
  return true
}

// 当前选中模型的能力
const selectedModelCapabilities = computed(() => {
  const found = settingsStore.availableModels.find(
    (m) =>
      m.modelId === selectedModel.value &&
      (!selectedProviderId.value || m.providerId === selectedProviderId.value),
  )
  // 列表里有 → 用列表能力；否则用绑定自带的能力（自足，pending 期也正确门控 vision/image）。
  const caps =
    found?.capabilities ??
    (pendingModelMeta.value?.capabilities as import('@/types').ModelCapability[] | undefined)
  return effectiveCaps(selectedModel.value || '', caps)
})

// 推理能力只读取当前实际路由模型的显式配置，未知时不按模型名或地址猜测。
const selectedReasoningModel = computed(() => {
  if (usesBoundAgentModel.value) {
    const agent = agentsStore.findAgent(chatStore.agentRole)
    return settingsStore.availableModels.find(
      (model) =>
        model.modelId === agent?.model &&
        (!agent?.provider ||
          model.providerId === agent.provider ||
          model.providerKey === agent.provider),
    )
  }
  return settingsStore.availableModels.find(
    (model) =>
      model.modelId === selectedModel.value &&
      (!selectedProviderId.value || model.providerId === selectedProviderId.value),
  )
})
const selectedModelReasoningSupport = computed<ModelReasoningSupport>(
  () => selectedReasoningModel.value?.reasoningSupport ?? 'unknown',
)
const selectedModelReasoningControl = computed<ModelReasoningControl | undefined>(
  () => selectedReasoningModel.value?.reasoningControl,
)
const selectedReasoningEfforts = computed(() =>
  allowedReasoningEfforts(selectedModelReasoningControl.value),
)
const deepThinkingUnsupported = computed(
  () => selectedModelReasoningSupport.value !== 'supported' || !selectedModelReasoningControl.value,
)

// 当前模型是否支持视觉/视频上传
const supportsVision = computed(() => selectedModelCapabilities.value.includes('vision'))
const supportsVideo = computed(() => selectedModelCapabilities.value.includes('video'))

const activeSessionThinkingPolicy = computed<ReasoningPolicy>(() => {
  void thinkingPolicyRevision.value
  const sessionId = chatStore.currentSessionId
  return sessionId ? getSessionThinkingPolicy(sessionId) : draftThinkingPolicy.value
})
const effectiveReasoningPolicy = computed(() =>
  resolveReasoningPolicy({
    sessionPolicy: activeSessionThinkingPolicy.value,
    agentPolicy: chatStore.agentRole
      ? agentsStore.findAgent(chatStore.agentRole)?.reasoning_policy
      : undefined,
    globalPolicy: settingsStore.config?.llm.defaultReasoningPolicy,
    nativePolicy: nativeReasoningPolicyFromControl(
      selectedModelReasoningSupport.value,
      selectedModelReasoningControl.value,
    ),
  }),
)
const effectiveReasoningRequest = computed(() =>
  toReasoningRequest(
    effectiveReasoningPolicy.value.policy,
    selectedModelReasoningSupport.value,
    selectedModelReasoningControl.value,
  ),
)
const isDeepThinking = computed(() => effectiveReasoningRequest.value.thinkingEnabled)
const selectedThinkingEffort = computed(() => effectiveReasoningRequest.value.thinkingEffort)
const thinkingControlLabel = computed(() => {
  if (selectedModelReasoningSupport.value !== 'supported' || !isDeepThinking.value) {
    return t('chat.reasoning.trigger')
  }
  const value = selectedThinkingEffort.value
    ? t(`chat.reasoning.effortOption.${selectedThinkingEffort.value}`)
    : t('chat.reasoning.on')
  return t('chat.reasoning.display', { value })
})
const thinkingControlTitle = computed(() => {
  if (deepThinkingUnsupported.value) return t('chat.reasoning.unavailable')
  return selectedReasoningEfforts.value.length > 0
    ? t('chat.reasoning.configureEffort')
    : t('chat.reasoning.configureMode')
})

function applyThinkingRequestState(enabled: boolean) {
  chatStore.chatMode = enabled ? 'research' : chatStore.agentRole ? 'agent' : 'chat'
  chatStore.thinkingEnabled = enabled
  syncChatParams()
}

function setActiveSessionThinkingPolicy(policy: ReasoningPolicy) {
  const sessionId = chatStore.currentSessionId
  if (sessionId) {
    setSessionThinkingPolicy(sessionId, policy)
  } else {
    draftThinkingPolicy.value = policy
  }
  thinkingPolicyRevision.value += 1
}

function preferredEnabledThinkingPolicy(): ReasoningPolicy {
  const sessionPolicy = activeSessionThinkingPolicy.value
  if (
    sessionPolicy.mode === 'effort' &&
    selectedReasoningEfforts.value.includes(sessionPolicy.effort)
  ) {
    return sessionPolicy
  }
  const resolvedPolicy = effectiveReasoningPolicy.value.policy
  if (
    resolvedPolicy.mode === 'effort' &&
    selectedReasoningEfforts.value.includes(resolvedPolicy.effort)
  ) {
    return resolvedPolicy
  }
  return nativeReasoningPolicyFromControl(
    selectedModelReasoningSupport.value,
    selectedModelReasoningControl.value,
  )
}

function toggleDeepThinking() {
  if (deepThinkingUnsupported.value) return
  const enabled = !isDeepThinking.value
  const policy = enabled ? preferredEnabledThinkingPolicy() : { mode: 'off' as const }
  setActiveSessionThinkingPolicy(policy)
  applyThinkingRequestState(enabled)
}

function selectThinkingEffort(effort: ReasoningEffort) {
  if (!selectedReasoningEfforts.value.includes(effort)) return
  setActiveSessionThinkingPolicy({ mode: 'effort', effort })
  applyThinkingRequestState(true)
}

function toggleThinkingSelector() {
  if (deepThinkingUnsupported.value) return
  showThinkingSelector.value = !showThinkingSelector.value
  if (showThinkingSelector.value) showModelSelector.value = false
}

watch(
  () => effectiveReasoningRequest.value.thinkingEnabled,
  (enabled) => {
    if (
      chatStore.thinkingEnabled === enabled &&
      (enabled ? chatStore.chatMode === 'research' : chatStore.chatMode !== 'research')
    ) {
      return
    }
    applyThinkingRequestState(enabled)
  },
  { immediate: true },
)

import { formatClockTime, formatElapsedSeconds } from '@/utils/time'
import { on } from '@/utils/eventBus'
import { hexclawWS } from '@/api/websocket'

function cancelQueryModelSelection() {
  if (queryModelSelectionAbort) {
    queryModelSelectionAbort.abort()
    queryModelSelectionAbort = null
  }
}

async function applyQueryModelSelection(modelQuery: string): Promise<boolean> {
  const trySelect = () => {
    // Ollama 模型名可能带 :latest 后缀（用户输入 "qwen3" → 存为 "qwen3:latest"）
    const matched = settingsStore.availableModels.find(
      (m) =>
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

  pendingModelMeta.value = null // 回退默认走 availableModels（matched 在列表里），无 pending 元信息
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

/**
 * 初始化/重挂载时按「会话绑定 > Agent > 全局默认」确定性落地模型选择。
 *
 * ★为什么必要：ChatView 在 App.vue 里以 `:key="route.path"` 渲染、**无 keep-alive** —— 切到别的
 *   页面（设置/记忆/知识库…）再返回会**完整重挂载**，onMounted 重跑。chatStore（Pinia 单例，含
 *   currentSessionId）跨视图存活，但若此处只调 `loadLLMConfig()` 落全局默认，当前会话的绑定恢复就
 *   只能寄望 `availableModels` watcher 偶发触发（列表无异步变化时根本不触发）→ 绑定被默认静默覆盖
 *   （BUG-20260626-2）。改由本函数复用 applySessionModel 的同一优先级决策：有会话 → 按绑定恢复
 *   （含 unavailable 乐观恢复），无会话 → 才回退全局默认。
 */
function initLLMModelForCurrentSession() {
  const sid = chatStore.currentSessionId
  if (sid) applySessionModel(sid, sid)
  else loadLLMConfig()
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

  // 先按优先级同步当前会话的模型（重挂载时恢复其绑定，冷启动落默认），避免首屏在会话/恢复请求
  // 未完成前出现“发送按钮可点但消息被静默吞掉”的初始化竞态，同时消除返回会话时的默认模型闪现。
  initLLMModelForCurrentSession()

  refreshBackendGenStatus()
  // 窗口聚焦时重查（用户可能在 Settings 更新了 API Key 切回来）
  window.addEventListener('focus', refreshBackendGenStatus)

  // 会话列表的固定身份、头像和场景元数据依赖智能体目录。冷启动必须先把身份依赖加载完整，
  // 再投影会话；否则同一会话会在首次点击前暂时退化成普通会话。
  agentsStore.loadRoles()
  await agentsStore.loadAgents()
  await chatStore.loadSessions()
  chatStore.initApprovalListener()
  await chatStore.recoverActiveStreams()
  // best-effort 预载：用 Promise.resolve 兜底，避免 API 同步返回 undefined 时
  // 在 .then 之前抛出未捕获 TypeError（'失败不阻塞会话' 的契约要落到实处）。
  Promise.resolve(getSkills())
    .then((r) => {
      availableSkills.value = r?.skills || []
    })
    .catch(() => {})

  // `@` 召唤上下文实体：知识库文档 + 连接（best-effort，失败不阻塞会话）
  Promise.resolve(getDocuments())
    .then((r) => {
      knowledgeDocs.value = r?.documents || []
    })
    .catch(() => {})
  void loadConnectionDirectory()

  // 从 Agent 管理页跳转过来：复用已有同角色会话 或 新建
  const roleQuery = route.query.role as string | undefined
  const roleTitleQuery = route.query.roleTitle as string | undefined
  if (roleQuery) {
    // 汇点兜底：调用方漏传 roleTitle 时按已加载的 agents 解析 display_name，绝不把内部
    // name 写进会话标题——标题落库后是会话自己的资产，智能体删除也不回退成 ID
    // （BUG-20260711；loadAgents 已在上方 await，此处可同步查）。
    const roleTitle = projectedAgentDisplay(roleQuery, roleTitleQuery)
    // 查找是否已有同名会话；兼容存量旧会话（修复前标题 = agent 内部名），避免重复建会话
    const existing = chatStore.sessions.find(
      (s) => projectedAgentDisplay(roleQuery, s.title) === roleTitle || s.title === roleQuery,
    )
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
    // 持久化会话→Agent 绑定：切走再切回该会话时确定性恢复辅导老师人设 + 场景增强（BUG-20260708）。
    if (chatStore.currentSessionId) bindSessionAgent(chatStore.currentSessionId, roleQuery)
    // 只消费本段负责的 Agent 深链参数；`scenarioTab` 等同路由状态属于场景增强，
    // 必须继续交给对应组件处理，不能在绑定 Agent 后一并清空。
    const remainingQuery = { ...route.query }
    delete remainingQuery.role
    delete remainingQuery.roleTitle
    router.replace({
      path: '/chat',
      ...(Object.keys(remainingQuery).length > 0 ? { query: remainingQuery } : {}),
    })
  }

  // 先同步 Ollama 列表再初始化模型 —— 否则 loadLLMConfig 在 ollamaModelsCache 仍空时会把默认模型判空
  await settingsStore.syncOllamaModels()

  // 初始化模型选择（config 由路由守卫保证已就绪）——按「会话绑定 > Agent > 默认」确定性恢复，
  // 不再依赖 availableModels watcher 偶发触发（修复 BUG-20260626-2：切页面再返回模型被默认覆盖）。
  initLLMModelForCurrentSession()

  // 从设置页跳转：预选指定模型
  const modelQuery = route.query.model as string | undefined
  if (modelQuery) {
    const selected = await applyQueryModelSelection(modelQuery)
    if (selected) {
      router.replace({ path: '/chat' })
    }
  }

  // 无 role 深链时回落默认助理——但**当前会话有 Agent 绑定时不得清**（审计单-20260709 High-1）：
  // loadSessions→selectSession 刚按 session-agent-binding 恢复的辅导老师会被这里无条件清空，
  // 且清空后标题兜底 watcher 因「已有绑定」early return 无法救回 → K12 场景增强永久消失。
  if (!roleQuery && !getSessionAgent(chatStore.currentSessionId ?? '')) {
    chatStore.agentRole = ''
  }

  // sidecar-ready 事件：后端延迟就绪时重新同步 providers
  try {
    const { listen } = await import('@tauri-apps/api/event')
    const unlisten = await listen('sidecar-ready', async () => {
      if (connectionDirectoryDisposed || sidecarReadyHandling) return
      sidecarReadyHandling = true
      clearSidecarReadyListener()
      // 各数据域独立恢复：Provider/Ollama、Agent/会话或连接中的任意一个失败，
      // 都不得短路另外两个。尤其 @连接必须在 sidecar-ready 后获得自己的第二次加载机会。
      await Promise.allSettled([
        (async () => {
          await settingsStore.loadConfig({ force: true })
          await settingsStore.syncOllamaModels()
        })(),
        (async () => {
          // 冷启动补拉（BUG-20260712-K 同类根因）：挂载时引擎未就绪 → 会话/agents 全空，
          // 就绪后必须按依赖顺序重拉，否则标题自愈/孤儿文案层拿不到稳定身份。
          await agentsStore.loadAgents()
          await chatStore.loadSessions()
        })(),
        // 连接目录与会话/智能体使用同一 sidecar readiness 边界。挂载期的旧失败可能晚于
        // 本次成功返回；loadConnectionDirectory 内部的 generation 保证只有最新代次可投影。
        loadConnectionDirectory(),
      ])
      if (!connectionDirectoryDisposed) {
        // 后端延迟就绪后同样按优先级恢复当前会话模型，避免覆盖会话绑定（同 BUG-20260626-2 根因）。
        initLLMModelForCurrentSession()
      }
    })
    if (connectionDirectoryDisposed) {
      unlisten()
    } else {
      stopSidecarReadyListener = unlisten
      sidecarReadyListenerTimeout = setTimeout(clearSidecarReadyListener, 30000)
    }
  } catch {
    // 非 Tauri 环境忽略
  }
})

async function toggleModelSelector() {
  showModelSelector.value = !showModelSelector.value
  if (showModelSelector.value) {
    showThinkingSelector.value = false
    await settingsStore.loadConfig({ force: true })
    await settingsStore.syncOllamaModels()
    // 同时重新探测后端 gen Provider 状态 — 用户在设置里加了 API Key 后
    // 回到聊天页打开下拉时应立即解除绘图/视频生成模型的灰显
    refreshBackendGenStatus()
  }
}

function openProviderSettings() {
  showModelSelector.value = false
  showThinkingSelector.value = false
  router.push('/settings')
}

function asToolApprovalRisk(risk: string): 'safe' | 'sensitive' | 'dangerous' {
  return risk as 'safe' | 'sensitive' | 'dangerous'
}

function selectModel(modelId: string, providerId = '', providerKey = '', providerName = '') {
  selectedModel.value = modelId
  selectedProviderId.value = modelId === 'auto' ? '' : providerId
  selectedProviderKey.value = modelId === 'auto' ? '' : providerKey
  selectedProviderName.value = modelId === 'auto' ? '' : providerName
  pendingModelMeta.value = null // 从下拉里选的，模型必在 availableModels
  showModelSelector.value = false
  showThinkingSelector.value = false
  userOverrodeModel.value = true
  syncChatParams()
  // 会话级模型绑定：用户在本会话显式选模型 → 持久化，切走再切回不被重置。
  // 新会话尚无 id（首条消息发送前）时由 currentSessionId watcher 在会话创建后补绑。
  if (chatStore.currentSessionId) {
    setSessionModel(chatStore.currentSessionId, currentModelBinding())
  }
}

/** 当前 UI 选中模型 → 绑定结构。★捕获显示名 + 能力，使绑定自足（脱离 availableModels 也能正确显示/门控）。 */
function currentModelBinding(): SessionModelBinding {
  const found = settingsStore.availableModels.find(
    (m) =>
      m.modelId === selectedModel.value &&
      (!selectedProviderId.value || m.providerId === selectedProviderId.value),
  )
  return {
    model: selectedModel.value,
    providerId: selectedProviderId.value,
    providerKey: selectedProviderKey.value,
    providerName: selectedProviderName.value || undefined,
    modelName: found?.modelName || pendingModelMeta.value?.name || undefined,
    capabilities: found?.capabilities ?? pendingModelMeta.value?.capabilities ?? undefined,
  }
}

/**
 * 只有当前配置已明确标成非聊天能力的模型进入阻断集合。未出现在配置里的 Ollama/异步目录
 * 模型仍属于 unknown，继续走既有 restore-pending 乐观恢复。
 */
const knownNonChatModels = computed<KnownNonChatModelIdentity[]>(() =>
  (settingsStore.config?.llm.providers ?? []).flatMap((provider) =>
    provider.models
      .filter((model) => !isChatModelOption(model))
      .map((model) => ({
        modelId: model.id,
        providerId: provider.id,
        providerKey: provider.backendKey || provider.name || provider.id,
      })),
  ),
)

/**
 * 进入某会话时按「会话绑定 > Agent > 默认」解析并落地模型选择。
 * 决策抽到纯函数 decideSessionModelAction（可单测，跨会话串模型 bug 落在这层）。
 * - restore/auto：恢复用户为该会话固定的模型（置 userOverrodeModel=true 使其生效且优先于 Agent）
 * - fallback：绑定的模型当前不在可用列表 → 仅 UI 回退默认，【不清绑定、不提示】。
 *     绑定的模型可能是「真删了」也可能是「Ollama/provider 仍在异步同步」（启动期 loadSessions
 *     先于 syncOllamaModels）。保守处理：列表补齐后由 availableModels watcher 自动复解析恢复。
 * - bind-current：新会话首发（null → 真实 id）且用户已选模型 → 把选择固定到这条新会话。
 * - reset-default：无绑定会话 → 回退全局默认、清 override。【关键】从「绑定了模型的会话」
 *     切到「无绑定会话」必须回退默认，不得静默沿用上一会话的模型（修复 BUG-20260625）。
 */
function applySessionModel(newId: string, prevId: string | null) {
  const action = decideSessionModelAction({
    resolution: resolveSessionModel(newId, settingsStore.availableModels, knownNonChatModels.value),
    prevId,
    userOverrodeModel: userOverrodeModel.value,
    hasSelectedModel: !!selectedModel.value,
  })
  switch (action.kind) {
    case 'restore':
      selectedModel.value = action.model.modelId
      selectedProviderId.value = action.model.providerId
      selectedProviderKey.value = action.model.providerKey
      selectedProviderName.value = action.model.providerName
      pendingModelMeta.value = null // 列表里有 → 元信息走 availableModels
      userOverrodeModel.value = true
      syncChatParams()
      break
    case 'auto':
      selectedModel.value = 'auto'
      selectedProviderId.value = ''
      selectedProviderKey.value = ''
      selectedProviderName.value = ''
      pendingModelMeta.value = null
      userOverrodeModel.value = true
      syncChatParams()
      break
    case 'restore-pending':
      // BUG-20260626：绑定模型此刻不在 availableModels（provider/Ollama 异步未加载）→ 乐观恢复
      // 绑定本身，绝不静默回退默认。名/能力取自绑定（自足），列表补齐后 availableModels watcher
      // 复解析为 restore，自动精修为列表里的最新元信息。
      selectedModel.value = action.binding.model
      selectedProviderId.value = action.binding.providerId
      selectedProviderKey.value = action.binding.providerKey
      selectedProviderName.value = action.binding.providerName ?? ''
      pendingModelMeta.value = {
        name: action.binding.modelName || action.binding.model,
        capabilities: action.binding.capabilities ?? ['text'],
      }
      userOverrodeModel.value = true
      syncChatParams()
      break
    case 'reset-default':
      // 无绑定会话 → 回退全局默认（loadLLMConfig 内含 syncChatParams）+ 清 override。
      userOverrodeModel.value = false
      loadLLMConfig()
      break
    case 'bind-current':
      setSessionModel(newId, currentModelBinding())
      break
  }
}

/** 同步模型和参数到 chatStore
 *
 * 仅在显式 Agent 模式（chatMode=agent + agentRole）且用户没有手动选模型时，
 * 不发 provider/model，让后端根据 Agent 配置决策。
 * 普通聊天始终使用用户设置的默认模型。
 */
function syncChatParams() {
  const letBackendDecide = usesBoundAgentModel.value

  chatStore.chatParams.provider = letBackendDecide
    ? undefined
    : selectedModel.value === 'auto'
      ? undefined
      : selectedProviderKey.value || undefined
  chatStore.chatParams.model = letBackendDecide
    ? undefined
    : selectedModel.value === 'auto'
      ? 'auto'
      : selectedModel.value
  chatStore.chatParams.temperature = chatTemperature.value
  chatStore.chatParams.maxTokens = chatMaxTokens.value
}

/** 获取某条消息关联的 artifacts */
function getMessageArtifacts(messageId: string) {
  return chatStore.artifacts.filter((a) => a.messageId === messageId)
}

// 会话「刚打开/切换」标记：由 currentSessionId watcher 置真（早于消息异步落地），消息数组整体
// 替换落地后由 messages 引用 watcher 消费成「瞬时跳底」，并让 length watcher 跳过该帧避免平滑重复。
let sessionJustOpened = false

// 会话级：打开/切换会话、重载历史时，瞬时无条件到底（behavior='auto'，不节流、不受上滚闸）。
// 决策走 resolveChatScroll(opening:true) 单一真相源；落点即最新一轮+输入框，无「唰」地滚的动画。
function jumpToBottomInstant() {
  if (_scrollTimer) {
    clearTimeout(_scrollTimer)
    _scrollTimer = null
  }
  const { behavior } = resolveChatScroll({
    opening: true,
    force: true,
    userScrolledUp: userScrolledUp.value,
  })
  messagesEndRef.value?.scrollIntoView({ behavior })
  userScrolledUp.value = false
  showScrollToBottom.value = false
  unreadScenarioResultCount.value = 0
}

let _scrollTimer: ReturnType<typeof setTimeout> | null = null
function scrollToBottom(force = false) {
  // 会话内：平滑 + 尊重用户当前滚动位置（上滚阅读历史时不跟随，除非 force=点下翻浮标）。
  if (
    !resolveChatScroll({ opening: false, force, userScrolledUp: userScrolledUp.value }).shouldScroll
  )
    return
  if (_scrollTimer) {
    // BUG-20260626：force（点下翻箭头）必须抢占挂起的非 force 节流定时器——否则点击被吞，
    // 且那个旧定时器到点会用 force=false 复判、在「已上滚」态下 bail，导致点了箭头却纹丝不动。
    if (!force) return // 非 force：节流合并，max 1 scroll / 100ms
    clearTimeout(_scrollTimer)
    _scrollTimer = null
  }
  _scrollTimer = setTimeout(() => {
    _scrollTimer = null
    // #2 2026-06-23：节流窗口内用户可能刚上滚，到点必须再判一次，否则把用户从历史处拽回底部。
    const decision = resolveChatScroll({
      opening: false,
      force,
      userScrolledUp: userScrolledUp.value,
    })
    if (!decision.shouldScroll) return
    messagesEndRef.value?.scrollIntoView({ behavior: decision.behavior })
    userScrolledUp.value = false
    // BUG-20260626：既然已把视口对齐到最底，「跳到底部」的提示一定无意义——权威清空，
    // 不再依赖一个不保证到来的终态 scroll 事件去纠正（头像图片/markdown 异步重排会吃掉它，
    // 导致箭头卡在加载动画中途的残留几何上，默认打开会话即误显下翻箭头）。
    showScrollToBottom.value = false
    unreadScenarioResultCount.value = 0
  }, 100)
}

function handleMessagesScroll() {
  const el = messagesContainerRef.value
  if (!el) return
  // BUG-20260626：导航箭头/已上滚标记交由 scrollNavFlags 统一判定——加"有消息 + 真实溢出够大"两道闸，
  // 避免输入框变高压缩视口时，新/短会话误显下翻箭头、误停自动跟随。
  const flags = scrollNavFlags({
    scrollHeight: el.scrollHeight,
    scrollTop: el.scrollTop,
    clientHeight: el.clientHeight,
    hasMessages: chatStore.messages.length > 0,
  })
  userScrolledUp.value = flags.userScrolledUp
  showScrollToBottom.value = flags.showScrollToBottom
  if (!flags.userScrolledUp) unreadScenarioResultCount.value = 0
  scrollCoordinator.recordScrollState()
}

function markMessagesUserIntent() {
  scrollCoordinator.markUserIntent()
}

// BUG-20260626：消息容器内容重排（头像图片/markdown/代码块异步加载）不触发 scroll 事件，
// 只靠 @scroll 重算会把导航箭头卡在加载动画中途的残留几何上。用 ResizeObserver 在每次重排后
// 按真实几何重算；若处于「跟随态」（用户未主动上滚）则顺势贴底，行为对齐 ChatGPT。
let _msgsResizeObserver: ResizeObserver | null = null
function observeMessagesResize() {
  if (typeof ResizeObserver === 'undefined') return // jsdom / 旧环境无该 API
  _msgsResizeObserver?.disconnect()
  const el = messagesContainerRef.value
  if (!el) return
  scrollCoordinator.recordScrollState()
  _msgsResizeObserver = new ResizeObserver(() => {
    scrollCoordinator.notifyLayoutObserved()
  })
  _msgsResizeObserver.observe(el)
}
onMounted(observeMessagesResize)
onUnmounted(() => {
  _msgsResizeObserver?.disconnect()
  _msgsResizeObserver = null
})

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

const { stageLabel: cronStageLabel } = useCronCompileLabel()

// 1Hz tick driving the elapsed-time label on running automation cards.
const automationNowTick = ref(Date.now())
let automationTickTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  automationTickTimer = setInterval(() => {
    automationNowTick.value = Date.now()
  }, 1000)
})
onUnmounted(() => {
  if (automationTickTimer) clearInterval(automationTickTimer)
  // Matches the addEventListener in onMounted — without this the handler
  // leaks and keeps firing backend probes after the view is gone.
  window.removeEventListener('focus', refreshBackendGenStatus)
})

function automationElapsedSeconds(startedAt?: number): number | null {
  if (!startedAt) return null
  return Math.max(0, Math.floor((automationNowTick.value - startedAt) / 1000))
}

/** "42s" under a minute, "3:03" past it — raw seconds read poorly on long compiles. */
function automationElapsedLabel(startedAt?: number): string | null {
  const seconds = automationElapsedSeconds(startedAt)
  return seconds === null ? null : formatElapsedSeconds(seconds)
}

const { handleSend } = useChatSend({
  chatStore,
  parsedDocument,
  attachmentPreview,
  clearAttachmentPreview,
  scrollToBottom,
  attachConversationAutomationActions,
  captureRouteSnapshot: () => captureCurrentMessageRoute(),
})

function routeDisplaySnapshot(agentRole: string): {
  agentDisplayName: string
  recipientDisplayName: string
} {
  const scenario = scenarioCtx.value
  const agentDisplayName =
    scenario?.agentName ||
    (agentRole && !INTERNAL_AGENT_ROLES.has(agentRole)
      ? projectedAgentDisplay(agentRole)
      : t('chat.botName'))
  const k12 = scenario?.metadata?.k12 as Record<string, unknown> | undefined
  const recipientDisplayName =
    typeof k12?.child_name === 'string' && k12.child_name.trim()
      ? k12.child_name.trim()
      : agentDisplayName
  return { agentDisplayName, recipientDisplayName }
}

function routeReasoningModel(model?: string, provider?: string) {
  return settingsStore.availableModels.find(
    (candidate) =>
      candidate.modelId === model &&
      (!provider || candidate.providerId === provider || candidate.providerKey === provider),
  )
}

function resolveRouteReasoning(
  sessionId: string,
  agentRole: string,
  model?: string,
  provider?: string,
) {
  const routeModel = routeReasoningModel(model, provider)
  const reasoningSupport: ModelReasoningSupport = routeModel?.reasoningSupport ?? 'unknown'
  const reasoningControl = routeModel?.reasoningControl
  const reasoningPolicy = resolveReasoningPolicy({
    sessionPolicy: getSessionThinkingPolicy(sessionId),
    agentPolicy: agentRole ? agentsStore.findAgent(agentRole)?.reasoning_policy : undefined,
    globalPolicy: settingsStore.config?.llm.defaultReasoningPolicy,
    nativePolicy: nativeReasoningPolicyFromControl(reasoningSupport, reasoningControl),
  }).policy
  const reasoningRequest = toReasoningRequest(reasoningPolicy, reasoningSupport, reasoningControl)
  return {
    thinkingEnabled: reasoningRequest.thinkingEnabled,
    reasoningSupport,
    reasoningPolicy,
    reasoningControl,
  }
}

function captureCurrentMessageRoute(): ChatRouteSnapshot {
  const display = routeDisplaySnapshot(chatStore.agentRole || '')
  return freezeChatRouteSnapshot({
    agentRole: chatStore.agentRole || '',
    chatParams: chatStore.chatParams,
    thinkingEnabled: effectiveReasoningRequest.value.thinkingEnabled,
    reasoningSupport: selectedModelReasoningSupport.value,
    reasoningPolicy: effectiveReasoningPolicy.value.policy,
    reasoningControl: selectedModelReasoningControl.value,
    ...display,
  })
}

function captureEditedMessageRoute(sourceSessionId: string): ChatRouteSnapshot {
  const sourceAgentRole = getSessionAgent(sourceSessionId) || chatStore.agentRole || ''
  const sourceSessionModel = getSessionModel(sourceSessionId)
  const sourceAgent = sourceAgentRole ? agentsStore.findAgent(sourceAgentRole) : undefined
  const effectiveChatParams = sourceSessionModel
    ? chatStore.chatParams
    : {
        ...chatStore.chatParams,
        provider: chatStore.chatParams.provider || sourceAgent?.provider,
        model: chatStore.chatParams.model || sourceAgent?.model,
      }
  const display = routeDisplaySnapshot(sourceAgentRole)
  const routeModel = sourceSessionModel?.model ?? effectiveChatParams.model
  const routeProvider =
    sourceSessionModel?.providerId ||
    sourceSessionModel?.providerKey ||
    effectiveChatParams.provider
  const reasoning = resolveRouteReasoning(
    sourceSessionId,
    sourceAgentRole,
    routeModel,
    routeProvider,
  )
  return freezeChatRouteSnapshot({
    agentRole: sourceAgentRole,
    chatParams: effectiveChatParams,
    thinkingEnabled: reasoning.thinkingEnabled,
    reasoningSupport: reasoning.reasoningSupport,
    reasoningPolicy: reasoning.reasoningPolicy,
    reasoningControl: reasoning.reasoningControl,
    sessionModel: sourceSessionModel,
    ...display,
  })
}

async function submitEditedMessage(submission: EditedMessageSubmission): Promise<boolean> {
  const attachments = submission.carry?.attachments ?? []
  // 场景会话的单图消息（含可选说明文字）必须回到与 composer 上传/粘贴相同的图片入口；
  // handleScenarioImage 会分配全新的消息/request_id，并保留旧消息及其后续历史。
  if (
    scenarioCtx.value &&
    chatEnhancement &&
    attachments.length === 1 &&
    attachments[0]?.type === 'image'
  ) {
    const attachment = attachments[0]
    return handleScenarioImage(
      {
        dataUrl: imageSrc(attachment),
        attachment,
        contextText: submission.content,
      },
      submission.targetSessionId,
      scenarioImageRoute(
        submission.routeSnapshot?.chatParams.provider,
        submission.routeSnapshot?.chatParams.model,
      ) ?? null,
    )
  }
  return submission.carry
    ? handleSend(submission.content, undefined, {
        ...submission.carry,
        targetSessionId: submission.targetSessionId,
        routeSnapshot: submission.routeSnapshot,
      })
    : handleSend(submission.content, undefined, {
        targetSessionId: submission.targetSessionId,
        routeSnapshot: submission.routeSnapshot,
      })
}

const {
  editingMsgId,
  editingText,
  handleRetry,
  handleFork,
  handleLike,
  handleDislike,
  handleEdit,
  confirmEdit,
  cancelEdit,
} = useChatActions(chatStore, toast, handleSend, submitEditedMessage, captureEditedMessageRoute)

// 编辑卡回车的 IME 合成态守卫（与 ChatInput 同源 shouldSendOnEnter）：中文/日文 IME 回车是
// 「确认候选词」，不能误当「提交编辑」。compositionstart/end 跟踪 + 兜底 WKWebView 早结束竞态。
const editComposing = ref(false)
let editLastCompositionEnd = 0
function onEditCompositionStart() {
  editComposing.value = true
}
function onEditCompositionEnd() {
  editComposing.value = false
  editLastCompositionEnd = Date.now()
}
function onEditEnter(e: KeyboardEvent, msgId: string) {
  const ok = shouldSendOnEnter(e, {
    composing: editComposing.value,
    msSinceCompositionEnd: Date.now() - editLastCompositionEnd,
  })
  if (!ok) return // 合成态 → 让 IME 处理，不提交
  e.preventDefault()
  confirmEdit(msgId)
}

// 会话内：消息条数变化（追加用户/助手消息，push 同引用）→ 平滑 + 尊重滚动位置。
// 打开会话帧（sessionJustOpened）交给下方 messages 引用 watcher 瞬时跳底，这里跳过避免平滑重复。
watch(
  () => chatStore.messages.length,
  () => {
    if (sessionJustOpened) return
    nextTick(scrollToBottom)
  },
)

// 会话级：消息数组被**整体替换**（打开/切换会话、重载历史时 store 的 `messages.value = nextMessages`）
// → 瞬时无条件到底。区别于会话内的 push 追加（同引用、仅 length 变，不触发本 watcher）。
// flush:'post' 确保在 DOM patch 后量到最新底部几何；仅在「刚打开」帧消费，普通替换不误触。
watch(
  () => chatStore.messages,
  () => {
    if (!sessionJustOpened) return
    sessionJustOpened = false
    nextTick(jumpToBottomInstant)
  },
  { flush: 'post' },
)

// currentSessionId 早于消息异步落地变化：在此置「刚打开」标记并重置上滚态，
// 使随后整体替换的消息落地走「瞬时到底」，且不被上一会话遗留的 userScrolledUp 卡住。
watch(
  () => chatStore.currentSessionId,
  (newId) => {
    // 任何会话切换/新建：重置上滚态 + 下翻箭头。新空会话不产生 scroll 事件、handleMessagesScroll
    // 不触发，若不在此重置，上个会话遗留的 showScrollToBottom=true 会残留到新会话（BUG-20260628）。
    userScrolledUp.value = false
    showScrollToBottom.value = false
    unreadScenarioResultCount.value = 0
    scrollCoordinator.reset()
    // 消息窗口重置(BUG-20260710 P1 窗口化):新会话从尾部 60 条起
    messageWindow.value = MESSAGE_WINDOW_INITIAL
    if (newId) {
      sessionJustOpened = true
    }
  },
)

/**
 * 持久化生成模式消息 — 走 batch 接口单事务落库，避免 user 写成功但 assistant 失败的不一致。
 * 失败时 toast 通知用户（UI 保留消息不阻断），引导其在下次刷新前知晓可能丢失。
 */
async function persistGenMessages(userMsg: ChatMessage, assistantMsg: ChatMessage) {
  const sid = chatStore.currentSessionId
  if (!sid) {
    logger.warn('[ChatView] no currentSessionId, skipping persist')
    return
  }
  try {
    await appendSessionMessagesBatch(sid, [
      {
        id: userMsg.id,
        role: 'user',
        content: userMsg.content,
        metadata: userMsg.metadata,
        model_name: (userMsg.metadata?.model as string) || undefined,
      },
      {
        id: assistantMsg.id,
        role: 'assistant',
        content: assistantMsg.content,
        metadata: assistantMsg.metadata,
        model_name: (assistantMsg.metadata?.model as string) || undefined,
        parent_id: userMsg.id,
      },
    ])
  } catch (e) {
    logger.error('[ChatView] persist gen messages failed', e)
    toast.error?.(t('chat.persistFailed', '消息已生成但保存失败，刷新会话后可能丢失'))
  }
}

/**
 * 乐观占位（BUG-20260711-C）：generation:start 即上屏 用户气泡 + assistant「生成中」占位，
 * 完成/失败原位替换。视频生成要轮询数分钟，此前全程零反馈，用户以为消息发不出去。
 * 媒体生成不走 streaming 状态机（见 handleImageGenerated 注释），占位对由本地引用配对。
 */
let pendingGen: { userMsg: ChatMessage; assistantMsg: ChatMessage } | null = null

async function handleGenerationStart(kind: 'image' | 'video', prompt: string) {
  if (!chatStore.currentSessionId) {
    await chatStore.ensureSession()
  }
  const ts = new Date().toISOString()
  const mode = kind === 'image' ? 'image_gen' : 'video_gen'
  const userMsg: ChatMessage = {
    id: nanoid(12),
    role: 'user',
    content: prompt,
    timestamp: ts,
    metadata: { mode },
  }
  const assistantMsg: ChatMessage = {
    id: nanoid(12),
    role: 'assistant',
    content:
      kind === 'image'
        ? t('chat.generate.generatingImage', '正在生成图像…')
        : t('chat.generate.generatingVideo', '正在生成视频，通常需要几分钟…'),
    timestamp: ts,
    metadata: { mode, generating: true },
  }
  chatStore.messages.push(userMsg, assistantMsg)
  pendingGen = { userMsg, assistantMsg }
  await nextTick(scrollToBottom)
}

/** 认领本轮占位对；start 事件缺失（防御）时按旧行为补插整对，保证完成回调永远有落点。 */
function claimPendingGen(
  mode: 'image_gen' | 'video_gen',
  prompt: string,
): { userMsg: ChatMessage; assistantMsg: ChatMessage } {
  const claimed = pendingGen
  pendingGen = null
  if (claimed) return claimed
  const ts = new Date().toISOString()
  const userMsg: ChatMessage = {
    id: nanoid(12),
    role: 'user',
    content: prompt,
    timestamp: ts,
    metadata: { mode },
  }
  const assistantMsg: ChatMessage = {
    id: nanoid(12),
    role: 'assistant',
    content: '',
    timestamp: ts,
    metadata: { mode },
  }
  chatStore.messages.push(userMsg, assistantMsg)
  return { userMsg, assistantMsg }
}

/**
 * 图像生成完成回调 — 原位替换占位（BUG-20260711-C 前为整对 push）。
 *
 * 与 chat 流的差异：图像生成不走 WebSocket / 不走 LLM router，所以不进入 chatStore
 * 的 sending / streaming 状态机；直接操作 messages ref 即可。
 *
 * 持久化：替换后显式批量落库，确保 reload 会话仍能看到。
 */
async function handleImageGenerated(result: ImageGenResult, prompt: string) {
  // 确保有会话 ID（首次点击生成时用户可能还在欢迎页面）
  if (!chatStore.currentSessionId) {
    await chatStore.ensureSession()
  }
  const attachments: ChatAttachment[] = []
  result.images.forEach((img, idx) => {
    const src = imageToSrc(img)
    // imageToSrc 三字段全空时返回 ''（Provider 占位项 / 后端落盘失败留下的空壳）。
    // 跳过空壳，避免渲染 <img src=''> 破图。
    if (!src) return
    // src 形如 "data:image/png;base64,xxx" 或 "https://..."
    const isBase64 = src.startsWith('data:')
    attachments.push({
      type: 'image',
      name: `generated-${result.model}-${idx + 1}.png`,
      mime: 'image/png',
      data: isBase64 ? src.split(',')[1] || '' : src,
    })
  })
  const revisedPrompt = result.images.find((i) => i.revised_prompt)?.revised_prompt
  const { userMsg, assistantMsg } = claimPendingGen('image_gen', prompt)
  userMsg.metadata = { ...userMsg.metadata, model: result.model }
  // DALL-E 3 会返回 revised_prompt（自动改写），优先展示给用户看
  assistantMsg.content = revisedPrompt
    ? `已生成 ${result.images.length} 张图像（提示词已优化为：${revisedPrompt}）`
    : `已生成 ${result.images.length} 张图像`
  assistantMsg.timestamp = new Date().toISOString()
  // ChatView.getMessageAttachments() 从 metadata.attachments 读取
  assistantMsg.metadata = {
    mode: 'image_gen',
    provider: result.provider,
    model: result.model,
    usage_ms: result.usage_ms,
    attachments,
  }
  void persistGenMessages(userMsg, assistantMsg)
  await nextTick(scrollToBottom)
}

// 通用生成错误（图像/视频共用 — ChatInput 统一 emit 'generation:error'）：
// 占位对已上屏时原位置为失败态（用户气泡保留，assistant 占位改失败文案），另 toast 提示。
function handleImageGenError(message: string) {
  const claimed = pendingGen
  pendingGen = null
  if (claimed) {
    claimed.assistantMsg.content = t('chat.generate.failedInline', '生成失败：{msg}').replace(
      '{msg}',
      message,
    )
    claimed.assistantMsg.metadata = {
      ...claimed.assistantMsg.metadata,
      generating: undefined,
      error: message,
    }
  }
  toast.error?.(`生成失败：${message}`)
}

/**
 * 视频生成完成回调 — 与 image_gen 同模式：user prompt + assistant video。
 * VideoTaskStatus 的 video_url 是 Provider 给的临时 URL（CogVideoX 24h 有效），
 * 当前直接以 URL 形式存入 attachment.data，由前端 <video src> 直接加载；
 * URL 失效后旧消息播放失败 — 后续可加"生成时下载 + 持久化到本地"流程。
 */
async function handleVideoGenerated(status: VideoTaskStatus, prompt: string) {
  if (!chatStore.currentSessionId) {
    await chatStore.ensureSession()
  }
  const attachments: ChatAttachment[] = []
  const videoSrc = videoToSrc(status)
  if (videoSrc) {
    attachments.push({
      type: 'video',
      name: `generated-${status.model}.mp4`,
      mime: 'video/mp4',
      // 优先后端持久化 URL（永不过期），回退到 Provider 临时 URL
      data: videoSrc,
    })
  }
  // 封面优先用后端持久化路径（永不过期）；cover_url 是 Provider 临时 URL（24h 过期），
  // 不内联进消息正文文本（否则失效后正文残留死链文本）。封面只放 metadata 供 <video poster> 消费。
  const coverSrc = coverToSrc(status)
  const { userMsg, assistantMsg } = claimPendingGen('video_gen', prompt)
  userMsg.metadata = { ...userMsg.metadata, model: status.model }
  assistantMsg.content = '视频已生成'
  assistantMsg.timestamp = new Date().toISOString()
  assistantMsg.metadata = {
    mode: 'video_gen',
    provider: status.provider,
    model: status.model,
    usage_ms: status.usage_ms,
    video_url: status.video_url,
    cover_url: status.cover_url,
    cover_file_path: status.cover_file_path,
    poster: coverSrc || undefined,
    attachments,
  }
  void persistGenMessages(userMsg, assistantMsg)
  await nextTick(scrollToBottom)
}

/**
 * 语音对话回合完成 — user 输入（语音转写 or 文字） + assistant 音频/转写。
 * 音频走 file_path 持久化（同 image/video gen），24h 后旧消息仍能播放。
 */
async function handleVoiceChatExchanged(result: VoiceChatResult, userPrompt: string) {
  if (!chatStore.currentSessionId) {
    await chatStore.ensureSession()
  }
  const ts = new Date().toISOString()
  const userMsg: ChatMessage = {
    id: nanoid(12),
    role: 'user',
    content: userPrompt,
    timestamp: ts,
    metadata: { mode: 'voice_chat', model: result.model },
  }
  const attachments: ChatAttachment[] = []
  const audioSrc = audioToSrc(result)
  if (audioSrc) {
    attachments.push({
      type: 'audio',
      name: `response.${result.format || 'wav'}`,
      mime: result.format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
      data: audioSrc,
    })
  }
  const assistantMsg: ChatMessage = {
    id: nanoid(12),
    role: 'assistant',
    content: result.transcript || '[语音回应]',
    timestamp: new Date().toISOString(),
    metadata: {
      mode: 'voice_chat',
      provider: result.provider,
      model: result.model,
      usage_ms: result.usage_ms,
      audio_src: audioSrc,
      attachments,
    },
  }
  chatStore.messages.push(userMsg, assistantMsg)
  void persistGenMessages(userMsg, assistantMsg)
  await nextTick(scrollToBottom)
}

function handleVoiceChatError(message: string) {
  toast.error?.(`语音对话失败：${message}`)
}

watch(
  () => chatStore.isCurrentStreamingContent,
  () => {
    nextTick(scrollToBottom)
  },
)

// 思考框「贴底才跟随」阈值：用户在思考框里上滚超过此距离即视为正在阅读上文，
// 后续流式 reasoning chunk 不再把滚动条抢回底部（BUG-20260626：思考时无法上滚看上面的内容）。
const THINKING_STICK_THRESHOLD_PX = 32

watch(
  () => chatStore.isCurrentStreamingReasoning,
  () => {
    // 必须在 DOM patch 前量「这次更新前」的几何：内容向下追加时 scrollTop 不变、scrollHeight 增大，
    // 若在追加后再判距底，刚冒出的高度会被误当成「用户上滚」。flush:'pre' 的 watcher 同步段正是 patch 前。
    const box = thinkingContentRef.value
    const wasAtBottom =
      !box || box.scrollHeight - box.scrollTop - box.clientHeight <= THINKING_STICK_THRESHOLD_PX
    nextTick(() => {
      // 仅在用户原本就贴底时才跟随贴底；上滚阅读时保持其滚动位置不被打扰。
      if (thinkingContentRef.value && wasAtBottom) {
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

// 会话切换 / 创建时按「会话绑定 > Agent > 默认」恢复模型选择（覆盖各入口的默认回退）。
// 覆盖：openHistorySession、启动自动选中上次会话、ensureSession 创建新会话。
watch(
  () => chatStore.currentSessionId,
  (newId, prevId) => {
    if (!newId) {
      // 离开当前会话（删除当前会话 / 进入新会话空白态）：清掉上一会话遗留的手动模型覆盖并回退全局默认。
      // 否则下次选中「无绑定会话」时，残留的 userOverrodeModel 会被误判为「新会话首发」，
      // 把上一会话的模型偷偷绑过去（BUG-20260625 跨会话串模型）。
      userOverrodeModel.value = false
      draftThinkingPolicy.value = { mode: 'inherit' }
      thinkingPolicyRevision.value += 1
      chatStore.chatMode = 'chat'
      chatStore.thinkingEnabled = false
      loadLLMConfig()
      return
    }
    // 空白新会话可在首发前设置显式思考策略；ensureSession 分配 ID 后仅持久化该覆盖。
    if (prevId === null && draftThinkingPolicy.value.mode !== 'inherit') {
      setSessionThinkingPolicy(newId, draftThinkingPolicy.value)
    }
    draftThinkingPolicy.value = { mode: 'inherit' }
    thinkingPolicyRevision.value += 1
    applySessionModel(newId, prevId ?? null)
  },
)

// 模型列表补齐（Ollama 异步同步完成 / provider 启用）后，对当前会话复解析绑定。
// 解决启动竞态：loadSessions 先于 syncOllamaModels，本地模型绑定首解析会落空，此处恢复。
// 传 prevId=sid（非 null）以跳过「新会话首发补绑」分支，仅做恢复，不写新绑定。
watch(
  () => settingsStore.availableModels,
  () => {
    const sid = chatStore.currentSessionId
    if (sid) applySessionModel(sid, sid)
  },
)

function newSession() {
  draftThinkingPolicy.value = { mode: 'inherit' }
  thinkingPolicyRevision.value += 1
  chatStore.chatMode = 'chat'
  chatStore.thinkingEnabled = false
  chatStore.agentRole = ''
  userOverrodeModel.value = false
  chatStore.newSession()
}

/** 会话框 ✨「PROMPT 模板 → 新建模板」：跳到 Prompt 库 并自动打开新建表单（带 new=1 query）。 */
function handleCreateTemplate() {
  router.push({ path: '/integration/prompts', query: { new: '1' } })
}

// 扣子式技能子菜单底部三入口：AI 创建走内联弹层；上传/市场跳转 Skill 管理页并自动打开对应面板。
const showSkillCreate = ref(false)
function handleSkillAction(action: 'ai-create' | 'upload-local' | 'add-market') {
  if (action === 'ai-create') {
    showSkillCreate.value = true
  } else if (action === 'upload-local') {
    router.push({ path: '/integration', query: { action: 'skill-install' } })
  } else {
    router.push({ path: '/integration', query: { action: 'skill-hub' } })
  }
}
async function handleSkillCreated() {
  // 新建成功后刷新会话可用 skill 列表
  try {
    const r = await getSkills()
    availableSkills.value = r.skills || []
  } catch {
    /* 忽略：下次进入会话会重新拉取 */
  }
}

function metadataValue(message: import('@/types').ChatMessage, key: string): string | null {
  const value = message.metadata?.[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function messageProviderDisplay(message: ChatMessage): string {
  return resolveProviderDisplayName(
    metadataValue(message, 'provider'),
    settingsStore.config?.llm.providers ?? [],
    metadataValue(message, 'provider_display_name'),
  )
}

function messageSourceDisplay(message: ChatMessage): string | null {
  const provider = messageProviderDisplay(message)
  const model = metadataValue(message, 'model')
  const isBuiltinSkill =
    message.message_content?.producer_kind === 'skill' ||
    metadataValue(message, 'producer_kind') === 'skill'
  if (!provider && !model && isBuiltinSkill) return t('chat.builtinSkillNoModel')
  return [provider, model].filter(Boolean).join(' · ') || null
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

// 命中卡展示走 utils/retrieval-hits（BUG-20260711-B：doc_title/source 皆空是后端合法形态，
// 标题兜底链必须落到 content 摘要，不能整排渲染成「知识库命中」占位卡）。
function getHitTitle(hit: Record<string, unknown>) {
  return knowledgeHitTitle(hit, t)
}

function getHitSubtitle(hit: Record<string, unknown>) {
  return knowledgeHitSubtitle(hit, t)
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

// Memory update notification — shows a transient toast when memory is modified elsewhere
const memoryJustUpdated = ref(false)
let memoryToastTimer: ReturnType<typeof setTimeout> | null = null
function showMemoryToast(content?: string) {
  memoryToastContent.value = content || ''
  memoryJustUpdated.value = true
  if (memoryToastTimer) clearTimeout(memoryToastTimer)
  memoryToastTimer = setTimeout(() => {
    memoryJustUpdated.value = false
  }, 4000)
}

const memoryToastContent = ref('')
const offMemoryBus = on('memory:updated', () => showMemoryToast())
const offMemoryWS = hexclawWS.onMemorySaved((content) => showMemoryToast(content))

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
  if (event.button !== 0 || viewportWidth.value <= SIDEBAR_COMPACT_BREAKPOINT) return
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
  <div
    class="hc-chat"
    :class="{ 'hc-chat--conversation-only': isConversationOnly }"
    :data-workspace-mode="chatWorkspaceMode"
  >
    <!-- Session sidebar -->
    <div
      class="hc-chat__sidebar"
      :class="{
        'hc-chat__sidebar--resizing': sidebarResizing,
        'hc-chat__sidebar--hidden': !showSessions,
      }"
      :style="{ width: showSessions ? `${effectiveSidebarWidth}px` : '0px' }"
      :aria-hidden="!showSessions"
      :inert="!showSessions"
    >
      <div class="hc-chat__sidebar-content" :style="{ width: `${effectiveSidebarWidth}px` }">
        <!-- 品牌化「新建会话」主操作（对齐原型 .newconv，去掉冗余「会话」标题头） -->
        <div class="hc-chat__sidebar-header">
          <button class="hc-chat__newconv" :title="t('chat.newSession')" @click="newSession">
            <Plus :size="16" />
            {{ t('chat.newSession') }}
          </button>
        </div>
        <SessionList />
      </div>
    </div>
    <div
      class="hc-chat__sidebar-resizer"
      :class="{
        'hc-chat__sidebar-resizer--active': sidebarResizing,
        'hc-chat__sidebar-resizer--hidden': !showSessions,
      }"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sessions sidebar"
      :aria-hidden="!showSessions"
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
        v-if="!scenarioOwnsHeader"
        :workspace-mode="chatWorkspaceMode"
        :message-count="chatStore.messages.length"
        :token-badge="t('chat.aboutTokens', { n: formatTokenCount(estimatedTokens) })"
        @update:workspace-mode="onWorkspaceModeChange"
      />

      <!-- 场景包会话增强（场景实例声明的头部 tab / 记录视图 / 侧栏产物）；shell 只渲染 registry 组件 -->
      <component
        :is="chatEnhancement"
        v-if="scenarioCtx && chatEnhancement"
        v-bind="scenarioCtx"
        v-model:records-active="scenarioRecordsActive"
        :composer-action="scenarioComposerAction"
        :composer-image="scenarioComposerImage"
        @update:composer-chips="scenarioComposerChips = $event"
        @update:composer-image="handleScenarioComposerImageConsumed"
        @update:inline-active="handleScenarioInlineActive"
        @content-updated="handleScenarioContentUpdated"
        @composer-command="handleScenarioComposerCommand"
        @scenario-image-attempt="handleScenarioImageAttempt"
        @update:session-execution="handleScenarioSessionExecution"
      />

      <!-- Messages -->
      <div
        v-show="!(scenarioCtx && scenarioRecordsActive)"
        ref="messagesContainerRef"
        class="hc-chat__messages"
        @scroll="handleMessagesScroll"
        @wheel.passive="markMessagesUserIntent"
        @touchstart.passive="markMessagesUserIntent"
        @pointerdown="markMessagesUserIntent"
      >
        <div
          v-if="
            chatStore.messages.length === 0 &&
            !chatStore.isCurrentStreaming &&
            !scenarioInlineActive
          "
          class="hc-chat__empty"
        >
          <EmptyState
            :icon="MessageSquarePlus"
            :title="scenarioEmptyState ? t(scenarioEmptyState.titleKey) : t('chat.startChat')"
            :description="
              scenarioEmptyState ? t(scenarioEmptyState.subtitleKey) : t('chat.startChatDesc')
            "
          >
            <!-- 还没配置好？运行首次配置向导（对齐原型 .btnlink）—— 已配置过模型则隐藏 -->
            <button
              v-if="!hasConfiguredModel"
              class="hc-chat__setup-link"
              @click="router.push('/welcome')"
            >
              <Settings :size="13" />
              {{ t('chat.runSetupWizard') }}
            </button>
          </EmptyState>
        </div>

        <div v-else class="hc-chat__thread">
          <!-- 显示更早(窗口化入口):仅当有窗外历史时出现 -->
          <button
            v-if="hiddenEarlierCount > 0"
            class="hc-chat__show-earlier"
            data-testid="chat-show-earlier"
            @click="showEarlierMessages"
          >
            {{ t('chat.showEarlier', { n: hiddenEarlierCount }) }}
          </button>

          <!-- Message list -->
          <template v-for="(msg, idx) in renderedMessages" :key="msg.id">
            <div
              :id="`msg-${msg.id}`"
              class="hc-msg"
              :class="msg.role === 'user' ? 'hc-msg--user' : 'hc-msg--assistant'"
              :tabindex="0"
              :data-scroll-anchor-id="msg.id"
              :data-testid="
                msg.role === 'user'
                  ? 'chat-message-user'
                  : isLiveAssistantMessage(msg)
                    ? 'chat-assistant-pending'
                    : 'chat-message-assistant'
              "
              :data-assistant-message-id="msg.role === 'assistant' ? msg.id : undefined"
              @contextmenu="
                !isLiveAssistantMessage(msg) &&
                handleMsgContextMenu($event, windowOffset + idx, msg.role as 'user' | 'assistant')
              "
            >
              <!-- Assistant message (Feishu style: avatar left + bubble) -->
              <template v-if="msg.role === 'assistant'">
                <div class="hc-msg__avatar">
                  <img :src="crabLogo" alt="HC" class="hc-msg__avatar-img" />
                  <span class="hc-msg__avatar-badge" />
                </div>
                <div class="hc-msg__body">
                  <div class="hc-msg__name">
                    {{ msgAgentDisplay(msg.agent_name) || t('chat.botName') }}
                  </div>
                  <!-- AgentBadge 仅在多智能体 handoff（本条 agent ≠ 上一条）时显,标示「换人接管」；
                       非 handoff 时与 hc-msg__name 重复,故隐藏（BUG-20260708 原型只一个名字）。名字解析 display_name。 -->
                  <AgentBadge
                    v-if="
                      windowOffset + idx > 0 &&
                      chatStore.messages[windowOffset + idx - 1]?.role === 'assistant' &&
                      chatStore.messages[windowOffset + idx - 1]?.agent_name !== msg.agent_name &&
                      (msg.agent_name || (msg.metadata?.agent_name as string))
                    "
                    :agent-name="
                      msgAgentDisplay(msg.agent_name || (msg.metadata?.agent_name as string)) || ''
                    "
                    :is-handoff="true"
                  />
                  <AssistantRunStatus
                    v-if="isLiveAssistantMessage(msg) || messageReasoningReceipt(msg)"
                    :reasoning-request="
                      isLiveAssistantMessage(msg)
                        ? currentLiveStream?.thinkingEnabled
                          ? 'on'
                          : 'off'
                        : (messageReasoningReceipt(msg)?.reasoning_request ?? 'off')
                    "
                    :reasoning-support="
                      isLiveAssistantMessage(msg)
                        ? (currentLiveStream?.reasoningSupport ?? 'unknown')
                        : (messageReasoningReceipt(msg)?.reasoning_support ?? 'unknown')
                    "
                    :reasoning-execution="
                      isLiveAssistantMessage(msg)
                        ? (currentLiveStream?.reasoningExecution ?? 'unknown')
                        : (messageReasoningReceipt(msg)?.reasoning_execution ?? 'unknown')
                    "
                    :has-visible-answer="Boolean(msg.content.trim())"
                    :elapsed-seconds="messageThinkingElapsed(msg)"
                    :reasoning="normalizeAssistantReasoning(msg.reasoning ?? '')"
                    :visibility="messageReasoningVisibility(msg)"
                    :runtime-events="msg.metadata?.runtime_events ?? []"
                    :default-open="true"
                    :content-ref="bindThinkingContentRef"
                  />
                  <ThinkingProgress
                    v-else-if="hasThinkingProgress(msg)"
                    :state="messageThinkingState(msg)"
                    :elapsed-seconds="messageThinkingElapsed(msg)"
                    :reasoning="normalizeAssistantReasoning(msg.reasoning ?? '')"
                    :visibility="messageReasoningVisibility(msg)"
                    :runtime-events="msg.metadata?.runtime_events ?? []"
                    :default-open="isLiveAssistantMessage(msg)"
                    :content-ref="isLiveAssistantMessage(msg) ? bindThinkingContentRef : undefined"
                  />
                  <!-- 子 Agent 协作面板（orchestrate/spawn fan-out 完成后结构化展示） -->
                  <SubAgentPanel
                    v-if="subAgentReportsByMsg.get(msg.id)?.length"
                    :reports="subAgentReportsByMsg.get(msg.id)!"
                  />
                  <!-- 工具调用卡：因果位 think → act → answer（P0-1）。
                       有有序内容块时改由气泡内 MessageBlocks 按真实交错序渲染，这里不再单独堆叠（避免重复）。 -->
                  <div
                    v-if="!msg.blocks?.length && displayToolCalls(msg).length"
                    class="hc-msg__tools"
                  >
                    <ToolCallCard
                      v-for="tc in displayToolCalls(msg)"
                      :key="tc.id"
                      :call="tc"
                      @rendered="captureNestedManifest(msg, $event)"
                    />
                  </div>
                  <div
                    v-if="!isLiveAssistantMessage(msg) || Boolean(msg.content.trim())"
                    class="hc-msg__bubble-wrap"
                  >
                    <div
                      class="hc-msg__bubble hc-msg__bubble--assistant"
                      :class="{
                        'hc-msg__bubble--empty':
                          !isLiveAssistantMessage(msg) && isEmptyReply(msg.content),
                      }"
                    >
                      <template v-if="isLiveAssistantMessage(msg)">
                        <MarkdownRenderer
                          v-if="msg.content"
                          :content="sanitizeMessageContent(msg.content)"
                          surface="desktop"
                        />
                      </template>
                      <template v-else>
                        <!-- 验算徽章（solve 结论透传，三态诚实 · shell 通用组件） -->
                        <VerifyBadge v-if="messageVerify(msg)" :result="messageVerify(msg)!" />
                        <!-- 图像 / 视频 / 音频附件 -->
                        <div v-if="getMessageAttachments(msg).length" class="hc-msg__attachments">
                          <template v-for="(att, ai) in getMessageAttachments(msg)" :key="ai">
                            <span v-if="att.type === 'image'" class="hc-msg__img-wrap">
                              <img
                                class="hc-msg__attachment-img"
                                :src="imageSrc(att)"
                                :alt="att.name"
                                @click="openImagePreview(imageSrc(att))"
                              />
                              <button
                                class="hc-msg__media-download"
                                :title="t('chat.downloadImage', '下载图片')"
                                @click.stop="downloadImage(imageSrc(att), att.name)"
                              >
                                ⬇
                              </button>
                            </span>
                            <span v-else-if="att.type === 'video'" class="hc-msg__video-wrap">
                              <!-- poster=后端持久化封面（BUG-20260712-J：数据一直在，此前未绑定→黑矩形）；
                                 无封面回退 #t=0.1 强制 WebKit 渲染首帧 -->
                              <video
                                controls
                                preload="metadata"
                                class="hc-msg__video"
                                :poster="videoPosterFromMetadata(msg.metadata)"
                                :src="
                                  videoDisplaySrc(
                                    imageSrc(att),
                                    videoPosterFromMetadata(msg.metadata),
                                  )
                                "
                              />
                              <button
                                class="hc-msg__media-download"
                                :title="t('chat.downloadVideo', '下载视频')"
                                @click.stop="downloadImage(imageSrc(att), att.name)"
                              >
                                ⬇
                              </button>
                            </span>
                            <audio
                              v-else-if="att.type === 'audio' || att.mime?.startsWith('audio/')"
                              controls
                              preload="metadata"
                              class="hc-msg__audio"
                              :src="imageSrc(att)"
                            />
                            <div v-else class="hc-msg__attachment-file">📎 {{ att.name }}</div>
                          </template>
                        </div>
                        <!-- 有有序内容块 → 按真实执行序交错渲染 text↔工具卡（多步 ReAct 保真）；
                           否则回退单串正文（兼容旧消息 / 重载 / 非流式）。 -->
                        <MessageBlocks
                          v-if="msg.blocks?.length"
                          :blocks="msg.blocks"
                          :tool-calls="msg.tool_calls"
                          :fallback-content="sanitizeMessageContent(msg.content)"
                          @rendered="captureNestedManifest(msg, $event)"
                        />
                        <MarkdownRenderer
                          v-else
                          :content="msg.message_content ?? sanitizeMessageContent(msg.content)"
                          surface="desktop"
                          @rendered="captureRenderManifest(msg, $event)"
                        />
                        <!-- v0.4.0 G3/E6 通用交互块（buttons/select/approval/card 4 type）；
                           优先 message.interactive 新协议，fallback 到 metadata.interactive_buttons 老路径 -->
                        <InteractiveBlock
                          v-if="getInteractivePayload(msg)"
                          :payload="getInteractivePayload(msg)!"
                          @select="(p) => handleInteractiveSelect(msg, p)"
                        />
                        <!-- 旧版兼容：metadata.source = 'video_generation' + metadata.video_url -->
                        <video
                          v-if="
                            msg.metadata?.source === 'video_generation' &&
                            msg.metadata?.video_url &&
                            !getMessageAttachments(msg).some((a) => a.type === 'video')
                          "
                          controls
                          preload="metadata"
                          class="hc-msg__video"
                          :poster="videoPosterFromMetadata(msg.metadata)"
                          :src="
                            videoDisplaySrc(
                              String(msg.metadata.video_url),
                              videoPosterFromMetadata(msg.metadata),
                            )
                          "
                        />
                        <!-- 入库徽章（判错入库确认，schema 驱动 · shell 通用组件） -->
                        <RecordChip
                          v-if="messageRecordChip(msg)"
                          v-bind="messageRecordChip(msg)!"
                        />
                      </template>
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
                    v-if="msg.metadata?.knowledge_hits || msg.metadata?.memory_hits"
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
                    v-if="
                      typeof msg.metadata?.memory_saved === 'string' && msg.metadata.memory_saved
                    "
                    class="hc-msg__memory-saved"
                  >
                    <Brain :size="12" />
                    <span>{{ t('chat.memorySaved') }}: {{ msg.metadata.memory_saved }}</span>
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
                      <div
                        v-if="action.kind === 'create_task' && action.status === 'running'"
                        class="hc-msg__automation-progress"
                        data-testid="automation-progress"
                      >
                        <span class="hc-msg__automation-progress-dot" />
                        <span class="hc-msg__automation-progress-text">
                          {{
                            action.progress
                              ? cronStageLabel(action.progress.stage)
                              : t('chat.cronStageStarting', '准备编译脚本…')
                          }}
                        </span>
                        <span
                          v-if="automationElapsedLabel(action.startedAt) !== null"
                          class="hc-msg__automation-progress-elapsed"
                        >
                          {{ automationElapsedLabel(action.startedAt) }}
                        </span>
                        <span class="hc-msg__automation-progress-hint">
                          <!-- Server progress messages carry richer detail than the
                               stage label (e.g. the self-correction retry notice). -->
                          {{
                            action.progress?.message ||
                            t('chat.cronCompileHint', '正在编译，无需重复点击')
                          }}
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
                  <MessageFooter v-if="!isLiveAssistantMessage(msg)" class="hc-msg__footer">
                    <div class="hc-msg__meta">
                      <span v-if="messageSourceDisplay(msg)">{{ messageSourceDisplay(msg) }}</span>
                    </div>
                    <div class="hc-msg__actions-inline">
                      <MessageActions
                        role="assistant"
                        :content="msg.content"
                        :feedback="messageFeedbackValue(msg)"
                        @retry="handleRetry(windowOffset + idx)"
                        @fork="handleFork(windowOffset + idx)"
                        @like="handleLike(msg.id)"
                        @dislike="handleDislike(msg.id)"
                      />
                    </div>
                    <span class="hc-msg__time">{{ formatClockTime(msg.timestamp) }}</span>
                  </MessageFooter>
                </div>
              </template>

              <!-- User message (Feishu style: right-aligned blue bubble, no avatar) -->
              <template v-else-if="msg.role === 'user'">
                <div class="hc-msg__body hc-msg__body--user">
                  <div class="hc-msg__bubble-wrap hc-msg__bubble-wrap--user">
                    <div v-if="editingMsgId !== msg.id" class="hc-msg__bubble hc-msg__bubble--user">
                      <div v-if="getMessageAttachments(msg).length" class="hc-msg__attachments">
                        <template v-for="(att, ai) in getMessageAttachments(msg)" :key="ai">
                          <!-- BUG-20260709：CSS zoom-in 承诺可放大，与助手气泡同走 openImagePreview -->
                          <img
                            v-if="att.type === 'image'"
                            class="hc-msg__attachment-img"
                            :src="imageSrc(att)"
                            :alt="att.name"
                            @click="openImagePreview(imageSrc(att))"
                          />
                          <div v-else class="hc-msg__attachment-file">📎 {{ att.name }}</div>
                        </template>
                      </div>
                      <!-- 文档卡片（ChatGPT 风格）：彩色类型图标 + 名称 + 类型·大小 + 下载按钮；正文进隐藏上下文不灌气泡 -->
                      <div v-if="getMessageDocuments(msg).length" class="hc-docfiles">
                        <div
                          v-for="(doc, di) in getMessageDocuments(msg)"
                          :key="di"
                          class="hc-docfile"
                          :class="{ 'hc-docfile--actionable': docActionable(doc) }"
                        >
                          <button
                            type="button"
                            class="hc-docfile__open"
                            :title="docActionable(doc) ? '点击打开原文件' : doc.name"
                            @click="openDocumentPreview(doc)"
                          >
                            <span class="hc-docfile__icon" :data-ext="docExt(doc)">{{
                              docExt(doc)
                            }}</span>
                            <span class="hc-docfile__meta">
                              <span class="hc-docfile__name">{{ doc.name }}</span>
                              <span class="hc-docfile__sub"
                                >{{ docExt(doc) }} · {{ formatDocSize(doc.size) }}</span
                              >
                            </span>
                          </button>
                          <button
                            v-if="docActionable(doc)"
                            type="button"
                            class="hc-docfile__dl"
                            title="下载"
                            @click.stop="downloadDocument(doc)"
                          >
                            <svg
                              width="16"
                              height="16"
                              viewBox="0 0 16 16"
                              fill="none"
                              aria-hidden="true"
                            >
                              <path
                                d="M8 2.5v7m0 0L5.2 6.7M8 9.5l2.8-2.8M3 11.5v1A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5v-1"
                                stroke="currentColor"
                                stroke-width="1.4"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                              />
                            </svg>
                          </button>
                        </div>
                      </div>
                      <!-- BUG-20260622：发送时挂载的 skill 在气泡内显示 -->
                      <div
                        v-if="getMessageSkills(msg).length"
                        style="display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px"
                      >
                        <span
                          v-for="sn in getMessageSkills(msg)"
                          :key="sn"
                          style="
                            display: inline-flex;
                            align-items: center;
                            gap: 4px;
                            padding: 2px 8px;
                            border-radius: 12px;
                            background: rgba(255, 255, 255, 0.2);
                            font-size: 12px;
                            line-height: 1.4;
                          "
                        >
                          <SkillIcon :skill="skillForChip(sn)" :size="13" />
                          <span>{{ skillForChip(sn).display_name || sn }}</span>
                        </span>
                      </div>
                      <MessageText :content="msg.content" />
                    </div>
                    <!-- DeepSeek 风格原位编辑框（独立圆角卡片） -->
                    <div v-if="editingMsgId === msg.id" class="hc-msg__edit-card">
                      <!-- 编辑时图片缩略图常驻顶部（编辑文字不丢图，BUG-20260625） -->
                      <div v-if="editingImages(msg).length" class="hc-msg__edit-attachments">
                        <img
                          v-for="(att, ai) in editingImages(msg)"
                          :key="ai"
                          class="hc-msg__edit-att-img"
                          :src="imageSrc(att)"
                          :alt="att.name"
                        />
                      </div>
                      <!-- 编辑时挂载的 skill 同样常驻（编辑文字不丢技能，confirmEdit 已带回 carry）。 -->
                      <div v-if="getMessageSkills(msg).length" class="hc-msg__edit-skills">
                        <span
                          v-for="sn in getMessageSkills(msg)"
                          :key="sn"
                          class="hc-msg__edit-skill-chip"
                        >
                          <SkillIcon :skill="skillForChip(sn)" :size="13" />
                          <span>{{ skillForChip(sn).display_name || sn }}</span>
                        </span>
                      </div>
                      <HcClearableField>
                        <MessageText
                          v-model:content="editingText"
                          class="hc-msg__edit-textarea"
                          editable
                          autofocus
                          @keydown.enter.exact="onEditEnter($event, msg.id)"
                          @keydown.escape="cancelEdit"
                          @compositionstart="onEditCompositionStart"
                          @compositionend="onEditCompositionEnd"
                        />
                      </HcClearableField>
                      <div class="hc-msg__edit-actions">
                        <button
                          class="hc-msg__edit-btn hc-msg__edit-btn--cancel"
                          @click="cancelEdit"
                        >
                          {{ t('common.cancel') }}
                        </button>
                        <button
                          class="hc-msg__edit-btn hc-msg__edit-btn--send"
                          @click="confirmEdit(msg.id)"
                        >
                          {{ t('chat.send') }}
                        </button>
                      </div>
                    </div>
                  </div>
                  <MessageFooter class="hc-msg__footer hc-msg__footer--right">
                    <div class="hc-msg__actions-float hc-msg__actions-float--right">
                      <span class="hc-msg__time hc-msg__time--right">{{
                        formatClockTime(msg.timestamp)
                      }}</span>
                      <MessageActions
                        role="user"
                        :content="msg.content"
                        @edit="handleEdit(windowOffset + idx)"
                      />
                    </div>
                  </MessageFooter>
                </div>
              </template>
            </div>
            <div
              :id="scenarioMessageAnchorId(msg.id)"
              class="hc-chat__scenario-inline"
              :data-source-message-id="msg.id"
            />
          </template>

          <!-- 工具审批卡片 -->
          <ToolApprovalCard
            v-if="chatStore.pendingApproval"
            :class="{ 'hc-approval--message-track': !isConversationOnly }"
            :request-id="chatStore.pendingApproval.requestId"
            :tool-name="chatStore.pendingApproval.toolName"
            :risk="asToolApprovalRisk(chatStore.pendingApproval.risk)"
            :reason="chatStore.pendingApproval.reason"
            :deadline-at="chatStore.pendingApproval.deadlineAt"
            @respond="chatStore.respondApproval"
          />
        </div>

        <!-- 场景包内联内容锚点：识题护栏、辅导卡等属于会话内容，必须随消息区滚动，
               不能作为 .hc-chat__main 的独立 flex 项覆盖或挤走历史消息。通用 Shell 只提供槽位。 -->
        <div id="hc-chat-scenario-inline" class="hc-chat__scenario-inline" />
        <!-- 所有滚到底动作必须落在场景内联内容之后，否则打开面板只会停在面板上方。 -->
        <div
          v-if="
            chatStore.messages.length > 0 || chatStore.isCurrentStreaming || scenarioInlineActive
          "
          ref="messagesEndRef"
        />
      </div>

      <!-- Memory update toast -->
      <Transition name="hc-fade">
        <div v-if="memoryJustUpdated" class="hc-chat__memory-toast">
          <Brain :size="13" />
          {{
            memoryToastContent
              ? `${t('chat.memorySaved')}: ${memoryToastContent}`
              : t('chat.memoryUpdated')
          }}
        </div>
      </Transition>

      <!-- 场景包会话页脚锚点（如辅导「扩展桥」Teleport 落点；通用空锚，无场景知识） -->
      <div v-show="!(scenarioCtx && scenarioRecordsActive)" id="hc-chat-scenario-footer" />
      <!-- composer 上方场景锚点（如 composer_chips 预设；从 descriptor 数据渲染，无场景硬编码） -->
      <div v-show="!(scenarioCtx && scenarioRecordsActive)" id="hc-chat-scenario-composer-top" />

      <!-- Input area -->
      <div
        v-show="!(scenarioCtx && scenarioRecordsActive)"
        class="hc-chat__input-area"
        data-layout-contract="shared-chat-composer-no-divider"
      >
        <!-- 滚动到底部箭头（ChatGPT 风格：锚定输入框正上方居中；仅在往上翻离开底部时出现，贴底隐藏） -->
        <Transition name="hc-scrollbtn">
          <button
            v-if="showScrollToBottom"
            class="hc-chat__scroll-btn hc-chat__scroll-btn--bottom"
            :class="{ 'hc-chat__scroll-btn--unread': unreadScenarioResultCount > 0 }"
            :title="scrollNavigationLabel"
            :aria-label="scrollNavigationLabel"
            @click="scrollToBottom(true)"
          >
            <span v-if="unreadScenarioResultCount > 0">{{ scrollNavigationLabel }}</span>
            <ChevronDown :size="18" :stroke-width="2.25" />
          </button>
        </Transition>

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
            v-if="connectionDirectoryState === 'error'"
            data-testid="chat-connections-error"
            class="hc-chat__connection-state hc-chat__connection-state--error"
            role="status"
          >
            <span>{{ t('chat.connectionsUnavailable') }}</span>
            <button class="hc-chat__connection-retry" type="button" @click="loadConnectionDirectory">
              {{ t('common.retry', '重试') }}
            </button>
          </div>
          <div
            v-else-if="connectionDirectoryState === 'ready' && connections.length === 0"
            data-testid="chat-connections-empty"
            class="hc-chat__connection-state"
            role="status"
          >
            {{ t('chat.connectionsEmpty') }}
          </div>
          <!-- 语音对话模式（audio-to-audio）— 独立媒介，不属于 composer mode 切换范畴 -->
          <VoiceChatComposer
            v-if="isVoiceChatModel"
            :model-id="selectedModel"
            :model-name="selectedModelDisplay"
            @exchanged="handleVoiceChatExchanged"
            @error="handleVoiceChatError"
          />
          <!--
              统一文本对话框（image_generate / video_generate / vision 由 ChatInput 内部
              的 ComposerMode 状态机显式区分；不依赖关键词推断，K12 友好。
            -->
          <ChatInput
            v-else
            ref="chatInputRef"
            :streaming="chatStore.isCurrentStreaming || chatStore.isCurrentSessionExecuting"
            :disabled="chatStore.sending || chatStore.isCurrentSessionExecuting"
            :agents="agentsStore.mentionableAgents"
            :skills="availableSkills"
            :knowledge-docs="knowledgeDocs"
            :connections="connections"
            :sessions="chatStore.sessions"
            :allow-image="supportsVision"
            :allow-video="supportsVideo"
            :recipient-name="agentRoleDisplay || t('chat.defaultAgent', '小蟹')"
            :preset-chips="scenarioCtx ? scenarioComposerChips : []"
            :scenario-placeholder="scenarioComposerPlaceholder"
            :scenario-hint="scenarioComposerHint"
            :scenario-image-intercept="!!(scenarioCtx && chatEnhancement)"
            @scenario-image="handleScenarioImage"
            @preset-chip-action="handleScenarioComposerAction"
            :send-handler="handleSend"
            :gen-model-id="selectedModel"
            :gen-model-name="selectedModelDisplay"
            :gen-provider-key="selectedProviderKey"
            :supports-image-gen="isImageGenModel"
            :supports-video-gen="isVideoGenModel"
            @stop="chatStore.stopStreaming()"
            @generation:start="handleGenerationStart"
            @generated:image="handleImageGenerated"
            @generated:video="handleVideoGenerated"
            @generation:error="handleImageGenError"
            @create-template="handleCreateTemplate"
            @skill-action="handleSkillAction"
          >
            <!-- 模型选择器 + 深度研究（ChatGPT 风格，在输入框内底部工具栏） -->
            <template #tools>
              <div class="hc-model-selector hc-model-selector--inline">
                <button
                  class="hc-model-selector__btn"
                  :title="selectedModelDisplay"
                  @click="toggleModelSelector"
                >
                  <span class="hc-model-selector__name">{{ selectedModelDisplay }}</span>
                  <ChevronDown :size="12" />
                </button>
                <div
                  v-if="showModelSelector"
                  class="hc-model-selector__dropdown hc-model-selector__dropdown--up"
                  @mouseleave="showModelSelector = false"
                >
                  <button
                    class="hc-model-selector__item hc-model-selector__item--auto"
                    :class="{ 'hc-model-selector__item--active': selectedModel === 'auto' }"
                    @click="selectModel('auto')"
                  >
                    <Zap :size="12" style="color: var(--hc-accent); margin-right: 4px" />
                    <span class="hc-model-selector__item-name">Auto</span>
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
                        :class="{
                          'hc-model-selector__item--active':
                            selectedModel === m.modelId && selectedProviderId === pid,
                          'hc-model-selector__item--disabled': !isModelUsable(
                            m.modelId,
                            m.capabilities,
                          ),
                        }"
                        :disabled="!isModelUsable(m.modelId, m.capabilities)"
                        :title="
                          !isModelUsable(m.modelId, m.capabilities)
                            ? '该生成模型暂未接入后端 Provider'
                            : modelKindLabel(m.modelId, m.capabilities)
                        "
                        @click="
                          isModelUsable(m.modelId, m.capabilities) &&
                          selectModel(m.modelId, String(pid), m.providerKey, group.providerName)
                        "
                      >
                        <span
                          class="hc-model-selector__item-kind"
                          role="img"
                          :aria-label="modelKindLabel(m.modelId, m.capabilities)"
                          >{{ modelKindEmoji(m.modelId, m.capabilities) }}</span
                        >
                        <span class="hc-model-selector__item-name">{{ m.modelName }}</span>
                        <span
                          v-if="!isModelUsable(m.modelId, m.capabilities)"
                          class="hc-model-selector__item-tag"
                          >暂未支持</span
                        >
                        <span
                          v-else-if="selectedModel === m.modelId && selectedProviderId === pid"
                          style="color: var(--hc-accent); margin-left: auto"
                          >✓</span
                        >
                      </button>
                    </div>
                  </template>
                  <div v-else class="hc-model-selector__empty">
                    <template v-if="settingsStore.enabledProviders.length > 0">{{
                      t('chat.noModels')
                    }}</template>
                    <button
                      v-else
                      class="hc-model-selector__add-link"
                      @click="openProviderSettings"
                    >
                      {{ t('settings.llm.noProvidersDesc') }}
                    </button>
                  </div>
                </div>
              </div>
              <div class="hc-thinking-selector">
                <button
                  class="hc-chat__research-btn hc-chat__thinking-control"
                  :class="{ 'hc-chat__research-btn--active': isDeepThinking }"
                  :aria-pressed="isDeepThinking"
                  :aria-disabled="deepThinkingUnsupported"
                  :aria-expanded="showThinkingSelector"
                  aria-haspopup="dialog"
                  :disabled="deepThinkingUnsupported"
                  :title="thinkingControlTitle"
                  @click="toggleThinkingSelector"
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M9.5 2a4.5 4.5 0 0 0-4.42 5.34A4 4 0 0 0 6 15h.5" />
                    <path d="M14.5 2a4.5 4.5 0 0 1 4.42 5.34A4 4 0 0 1 18 15h-.5" />
                    <path d="M12 2v20M9 22h6" />
                  </svg>
                  <span>{{ thinkingControlLabel }}</span>
                  <ChevronDown class="hc-thinking-selector__caret" :size="12" aria-hidden="true" />
                </button>
                <div
                  v-if="showThinkingSelector"
                  class="hc-thinking-selector__dropdown"
                  role="dialog"
                  :aria-label="t('chat.reasoning.settingsAriaLabel')"
                  data-testid="chat-thinking-settings"
                  @keydown.esc="showThinkingSelector = false"
                >
                  <div class="hc-thinking-selector__mode-row">
                    <span class="hc-thinking-selector__label">{{ t('chat.reasoning.mode') }}</span>
                    <button
                      class="hc-thinking-selector__switch"
                      type="button"
                      role="switch"
                      :aria-checked="isDeepThinking"
                      :aria-label="t('chat.reasoning.modeAriaLabel')"
                      data-testid="chat-thinking-mode"
                      @click="toggleDeepThinking"
                    >
                      <span class="hc-thinking-selector__switch-thumb" />
                    </button>
                  </div>
                  <template v-if="isDeepThinking && selectedReasoningEfforts.length > 0">
                    <div class="hc-thinking-selector__divider" />
                    <div class="hc-thinking-selector__section">
                      {{ t('chat.reasoning.effort') }}
                    </div>
                    <div role="radiogroup" :aria-label="t('chat.reasoning.effortAriaLabel')">
                      <button
                        v-for="effort in selectedReasoningEfforts"
                        :key="effort"
                        class="hc-thinking-selector__effort"
                        type="button"
                        role="radio"
                        :aria-checked="selectedThinkingEffort === effort"
                        :data-testid="`chat-thinking-effort-${effort}`"
                        @click="selectThinkingEffort(effort)"
                      >
                        <span>{{ t(`chat.reasoning.effortOption.${effort}`) }}</span>
                        <span
                          v-if="selectedThinkingEffort === effort"
                          class="hc-thinking-selector__check"
                          aria-hidden="true"
                          >✓</span
                        >
                      </button>
                    </div>
                  </template>
                </div>
              </div>
            </template>
          </ChatInput>
        </div>
      </div>
    </div>

    <!-- Message context menu -->
    <ContextMenu ref="msgCtxMenu" :items="msgContextItems" @select="handleMsgCtxAction" />

    <!-- 场景侧栏锚点（`.hc-chat` 行级 flex 子，与 ArtifactsPanel 同层）：场景包侧栏（如 K12 辅导要点）
         Teleport 落此，作为右侧停靠面板挤压主区、而非在主区内 absolute 覆盖会话头部（BUG-20260708 B4）。
         display:contents 让 teleport 进来的面板自身成为行级 flex 项。
         与产物面板互斥（右侧只挂一个停靠面板）：产物开则隐藏场景侧栏，避免两个面板把主区挤成 0 宽
         文字竖排崩坏（BUG-20260708）。v-show 保留锚点在 DOM,Teleport 目标始终有效。 -->
    <div
      v-show="chatWorkspaceMode !== 'artifacts'"
      id="hc-chat-scenario-sidepanel"
      class="hc-chat__scenario-sidepanel"
    />

    <!-- Artifacts Panel (right side) -->
    <Transition name="hc-chat-panel">
      <ArtifactsPanel
        v-if="chatWorkspaceMode === 'artifacts'"
        :artifacts="chatStore.artifacts"
        :selected-id="chatStore.selectedArtifactId"
        @close="restoreWorkspaceAfterRightPanelClose"
        @select="chatStore.selectArtifact($event)"
      />
    </Transition>

    <!-- 图片预览 Modal — Apple HIG: 毛玻璃覆盖 + 居中大图 + 点击外部关闭 -->
    <Transition name="hc-preview">
      <div v-if="previewImageSrc" class="hc-img-preview__backdrop" @click="closeImagePreview">
        <img class="hc-img-preview__img" :src="previewImageSrc" @click.stop />
        <button class="hc-img-preview__close" @click="closeImagePreview">×</button>
      </div>
    </Transition>

    <!-- 与 AI 对话创建 Skill（扣子式技能子菜单入口） -->
    <SkillCreateDialog
      :visible="showSkillCreate"
      @close="showSkillCreate = false"
      @created="handleSkillCreated"
    />

    <!-- 单条消息删除二次确认（后端 DELETE 且 UI 无恢复入口=用户视角不可逆，对齐删除会话惯例） -->
    <ConfirmDialog
      :open="!!pendingDeleteMsgId"
      :title="t('chat.deleteMessageConfirmTitle')"
      :message="t('chat.deleteMessageConfirmMessage')"
      :confirm-text="t('agents.delete', '删除')"
      :cancel-text="t('common.cancel', '取消')"
      :confirmation-key="pendingDeleteMsgId"
      danger
      @confirm="confirmDeleteMessage"
      @cancel="pendingDeleteMsgId = null"
    />
  </div>
</template>

<style scoped>
.hc-chat {
  display: flex;
  height: 100%;
  background: var(--hc-bg-main);
}

/* 场景侧栏锚点：display:contents → teleport 进来的场景侧栏（K12 辅导要点）自身成为 .hc-chat 行级 flex 项 */
.hc-chat__scenario-sidepanel {
  display: contents;
}

.hc-chat-panel-enter-active,
.hc-chat-panel-leave-active {
  overflow: hidden;
  transition:
    width 0.24s var(--hc-ease-smooth),
    opacity 0.24s var(--hc-ease-smooth);
}

.hc-chat-panel-enter-from,
.hc-chat-panel-leave-to {
  width: 0;
  opacity: 0;
}

/* ─── Sidebar ───── */
.hc-chat__sidebar {
  flex-shrink: 0;
  min-width: 0;
  border-right: 1px solid var(--hc-border-subtle);
  background: var(--hc-bg-sidebar);
  backdrop-filter: saturate(180%) blur(var(--hc-blur));
  -webkit-backdrop-filter: saturate(180%) blur(var(--hc-blur));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  opacity: 1;
  transition:
    width 0.22s var(--hc-ease-smooth),
    opacity 0.16s var(--hc-ease-out),
    border-color 0.16s var(--hc-ease-out);
}
.hc-chat__sidebar--hidden {
  opacity: 0;
  pointer-events: none;
  border-right-width: 0;
  border-right-color: transparent;
}
.hc-chat__sidebar-content {
  height: 100%;
  flex: none;
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
  opacity: 1;
  transition:
    width 0.22s var(--hc-ease-smooth),
    opacity 0.16s var(--hc-ease-out);
}

.hc-chat__sidebar-resizer--hidden {
  width: 0;
  opacity: 0;
  pointer-events: none;
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
  padding: 14px 12px 2px;
}

/* 品牌化「新建会话」主操作（对齐原型 .newconv） */
.hc-chat__newconv {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  width: 100%;
  padding: 10px 12px;
  border-radius: 10px;
  border: 0.5px solid transparent;
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  cursor: pointer;
  transition:
    background 0.15s var(--hc-ease-out, ease-out),
    border-color 0.15s var(--hc-ease-out, ease-out),
    transform 0.12s var(--hc-ease-out, ease-out);
}

.hc-chat__newconv:hover {
  border-color: var(--hc-border-hl);
  transform: translateY(-1px);
}

.hc-chat__newconv:active {
  transform: scale(0.98);
}

/* 空态「运行首次配置向导」链接（对齐原型 .btnlink） */
.hc-chat__setup-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  color: var(--hc-accent);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
  padding: 2px 0;
  margin-top: 2px;
}

.hc-chat__setup-link:hover {
  text-decoration: underline;
}

/* ─── Main ───── */
.hc-chat__main {
  flex: 1;
  display: flex;
  flex-direction: column;
  /* 兜底最小宽：防止右侧同时挂两个停靠面板（辅导要点侧栏 + 产物面板）时主区被挤成 0 宽、
     消息文字竖排逐字换行（BUG-20260708）。内部子元素各自 min-width:0 保留 ellipsis。 */
  min-width: 340px;
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
  /* HIG: 1.5px dashed 仍清晰可见，避免 2px 粗边框 */
  border: 1.5px dashed var(--hc-accent);
  background: var(--hc-bg-elevated);
  color: var(--hc-accent);
  font-size: 14px;
  font-weight: 500;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.hc-chat__messages {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px 10px;
}

/* ─── Scroll-to-bottom 按钮（ChatGPT 风格 · 磨玻璃材质 · 输入框正上方居中） ─────
   设计语言（HIG materials + 现代 glassmorphism）：
   · 材质：半透明底 + backdrop blur + saturate(vibrancy)，背景内容透出并被柔化 → 玻璃感；
   · 光：0.5px 发丝边 + 顶部内高光，模拟光打在玻璃上缘；底部内阴影收一点厚度；
   · 影：贴近实影 + 远处扩散影 双层柔影 = 悬浮高级感（非一刀切硬阴影）；
   · 动：进入弹入(回弹缓动)、hover 上浮、active 轻压，全程 transform 不与居中冲突。
   居中改用 margin-left(半宽)，把 transform 留给交互动画。锚定 .hc-chat__input-area(relative)。 */
.hc-chat__scroll-btn {
  position: absolute;
  left: 50%;
  margin-left: -16px; /* 半宽居中；transform 让位给 hover/active/过渡 */
  z-index: 10;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--hc-text-primary); /* chevron 取主色：磨玻璃半透下仍清晰可辨 */
  /* 磨玻璃材质：58% 底=既有按钮"身"又够透糊出磨砂；blur+saturate+brightness=Apple vibrancy；
     仅顶部 45% 一层淡高光渐变=玻璃上缘受光(不铺满，否则变实心玻璃白)；
     0.5px 发丝边 + 外白环=繁忙文字背景上仍勾出清晰圆边；上缘内高光给厚度。 */
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.35) 0%, rgba(255, 255, 255, 0) 45%),
    color-mix(in srgb, var(--hc-bg-elevated) 58%, transparent);
  -webkit-backdrop-filter: blur(20px) saturate(180%) brightness(1.05);
  backdrop-filter: blur(20px) saturate(180%) brightness(1.05);
  border: 0.5px solid color-mix(in srgb, var(--hc-text-primary) 12%, transparent);
  box-shadow:
    0 4px 14px rgba(15, 23, 42, 0.16),
    0 0 0 0.5px rgba(255, 255, 255, 0.45),
    /* 外白环：繁忙背景上勾出圆边 */ inset 0 1px 0 rgba(255, 255, 255, 0.65); /* 上缘内高光 */
  transition:
    transform 0.24s cubic-bezier(0.34, 1.56, 0.64, 1),
    box-shadow 0.2s ease,
    background 0.18s ease,
    color 0.18s ease;
}
.hc-chat__scroll-btn:hover {
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.42) 0%, rgba(255, 255, 255, 0) 45%),
    color-mix(in srgb, var(--hc-bg-elevated) 70%, transparent);
  transform: translateY(-2px);
  box-shadow:
    0 7px 22px rgba(15, 23, 42, 0.2),
    0 0 0 0.5px rgba(255, 255, 255, 0.55),
    inset 0 1px 0 rgba(255, 255, 255, 0.75);
}
.hc-chat__scroll-btn:active {
  transform: scale(0.9);
  transition-duration: 0.09s;
}
.hc-chat__scroll-btn--bottom {
  bottom: calc(100% + 14px);
}
.hc-chat__scroll-btn--unread {
  width: auto;
  min-width: 112px;
  height: 36px;
  margin-left: -56px;
  padding: 0 12px;
  gap: 6px;
  border-radius: 999px;
  white-space: nowrap;
}

/* 进入/退出：弹入(回弹) + 轻微上移缩放，对齐 ChatGPT 那种"冒出来"的轻盈感 */
.hc-scrollbtn-enter-active {
  transition:
    opacity 0.26s ease,
    transform 0.26s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.hc-scrollbtn-leave-active {
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}
.hc-scrollbtn-enter-from {
  opacity: 0;
  transform: translateY(10px) scale(0.8);
}
.hc-scrollbtn-leave-to {
  opacity: 0;
  transform: translateY(6px) scale(0.9);
}

.hc-chat__empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.hc-chat__thread {
  width: 100%;
  max-width: none;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 22px;
}

/* 普通会话的审批卡跟随助手消息轨道；focus 会话保持完整可用宽度。 */
.hc-chat:not(.hc-chat--conversation-only) .hc-chat__thread > :deep(.hc-approval--message-track) {
  box-sizing: border-box;
  width: min(780px, calc(100% - 46px));
  margin-left: 46px;
  margin-right: 0;
  align-self: flex-start;
}

.hc-chat__scenario-inline {
  width: 100%;
  max-width: none;
  margin: 0;
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
  border: 1.5px solid var(--hc-bg-main);
  box-sizing: border-box;
}

/* ─── Message body ───── */
.hc-msg__body {
  max-width: 780px;
  min-width: 0;
  flex: 1;
}

.hc-chat--conversation-only .hc-msg--assistant .hc-msg__body {
  max-width: none;
}

.hc-msg__body--user {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  max-width: 70%;
  position: relative;
  padding-bottom: 36px;
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
  min-width: 0;
  max-width: 100%;
}

.hc-msg__bubble-wrap--user {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

/* 助手操作与时间保持单行；用户时间与操作组共同靠右渐显，时间排在复制按钮之前。 */
.hc-msg__footer {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
  margin-top: 7px;
}

.hc-msg__footer--right {
  position: absolute;
  right: 0;
  bottom: 0;
  gap: 8px;
  justify-content: flex-end;
  width: max-content;
  margin-top: 0;
}

.hc-msg__actions-inline {
  display: inline-flex;
  margin-left: 0;
  flex: none;
  z-index: var(--hc-z-dropdown);
}

.hc-msg__actions-float {
  margin-left: 0;
  z-index: var(--hc-z-dropdown);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: translateY(2px);
  transition:
    opacity 0.14s var(--hc-ease-out),
    transform 0.14s var(--hc-ease-out),
    visibility 0s linear 0.25s;
  transition-delay: 0.25s;
}

.hc-msg:hover .hc-msg__actions-float,
.hc-msg:focus-within .hc-msg__actions-float {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transform: translateY(0);
  transition-delay: 0s;
}

.hc-msg__actions-float--right {
  margin-left: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

@media (max-width: 760px) {
  .hc-msg__footer:not(.hc-msg__footer--right) {
    align-items: center;
    flex-wrap: wrap;
    row-gap: 4px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .hc-msg__actions-float,
  .hc-chat__sidebar,
  .hc-chat__sidebar-resizer,
  .hc-chat-panel-enter-active,
  .hc-chat-panel-leave-active {
    transition: none;
  }
}

/* ─── Bubble ───── */
.hc-msg__bubble {
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
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

.hc-msg__video {
  max-width: 100%;
  max-height: 360px;
  border-radius: var(--hc-radius-md);
  margin-top: 0.5em;
}

/* ─── 空回复 fallback（Apple HIG：温和系统提示卡片） ───
 * 设计原则：
 *   清晰 — 左侧 info 图标明确告知是"系统提示"而非对话内容
 *   服从 — 弱化但不消失：次要色 + 轻量背景层级
 *   深度 — 0.5px 细边框 + 极轻阴影替代 HIG 禁忌的粗 dashed 边框
 * 用 `.hc-msg__bubble.hc-msg__bubble--empty` 双类提升 specificity，
 * 覆盖 `.hc-msg__bubble--assistant` 的 padding=0 / border=none / border-radius=0。
 */
.hc-msg__bubble.hc-msg__bubble--empty {
  display: inline-flex;
  align-items: flex-start;
  gap: 10px;
  max-width: 100%;
  padding: 12px 16px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--hc-text-secondary) 6%, var(--hc-bg-card));
  border: 0.5px solid color-mix(in srgb, var(--hc-text-secondary) 14%, transparent);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
  color: var(--hc-text-secondary);
  font-size: 13px;
  font-weight: 400;
  font-style: normal;
  line-height: 1.55;
  letter-spacing: 0;
  animation: hc-empty-reply-in 280ms cubic-bezier(0.16, 1, 0.3, 1);
}

/* SF Symbols 风格 info.circle 图标（线性 2px stroke / 18×18 / mask 注入便于跟随文字色） */
.hc-msg__bubble.hc-msg__bubble--empty::before {
  content: '';
  flex: 0 0 18px;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  background-color: currentColor;
  opacity: 0.55;
  -webkit-mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='9'/><line x1='12' y1='8' x2='12' y2='12'/><line x1='12' y1='16' x2='12.01' y2='16'/></svg>")
    center/contain no-repeat;
  mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='9'/><line x1='12' y1='8' x2='12' y2='12'/><line x1='12' y1='16' x2='12.01' y2='16'/></svg>")
    center/contain no-repeat;
}

@keyframes hc-empty-reply-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* HIG 无障碍：尊重系统"减弱动效"偏好 */
@media (prefers-reduced-motion: reduce) {
  .hc-msg__bubble.hc-msg__bubble--empty {
    animation: none;
  }
}

.hc-msg__bubble--user {
  background: var(--hc-bg-card);
  color: var(--hc-text-primary);
  border-bottom-right-radius: 4px;
  border: 0.5px solid var(--hc-border);
}

/* ─── Tool call 卡片容器（因果位：thinking 之后、回答气泡之前）────
   卡片本体样式见 ToolCallCard.vue（scoped）。 */
.hc-msg__tools {
  margin: 4px 0 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* ─── DeepSeek 风格原位编辑卡片 ───── */
/* Apple HIG: 编辑卡片 — 0.5px 边框, 16px 圆角, 弹簧入场 */
.hc-msg__edit-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 8px auto 0;
  padding: 20px;
  border: 0.5px solid var(--hc-accent, #007aff);
  border-radius: 16px;
  background: var(--hc-bg-input);
  box-shadow:
    0 0 0 3px rgba(0, 122, 255, 0.12),
    0 4px 12px rgba(0, 0, 0, 0.08);
  /* ChatGPT 风格：撑满会话区，与下方 composer 同宽（min(94%, 1200px)）并居中 */
  width: min(94%, 1200px);
  max-width: 100%;
  box-sizing: border-box;
  animation: fadeScaleIn 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
}

/* 编辑态：解除用户气泡 70% 宽度限制，让编辑卡片占满会话区（与 composer 一致） */
.hc-msg__body--user:has(.hc-msg__edit-card),
.hc-msg__bubble-wrap--user:has(.hc-msg__edit-card) {
  max-width: 100%;
  width: 100%;
  align-items: stretch;
}

/* 编辑卡片内的图片缩略图行：编辑文字时图片常驻、可见、不丢失 */
.hc-msg__edit-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.hc-msg__edit-att-img {
  width: 64px;
  height: 64px;
  object-fit: cover;
  border-radius: 10px;
  border: 0.5px solid var(--hc-border, rgba(0, 0, 0, 0.1));
}

/* 编辑卡片内的 skill chip 行：编辑时挂载的技能可见、不丢失 */
.hc-msg__edit-skills {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.hc-msg__edit-skill-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 12px;
  background: var(--hc-fill-secondary, rgba(0, 0, 0, 0.05));
  color: var(--hc-text-secondary, #6e6e73);
  font-size: 12px;
  line-height: 1.4;
}

.hc-msg__edit-textarea {
  width: 100%;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  color: var(--hc-text-primary, #1d1d1f);
  font-size: 16px;
  line-height: 1.6;
  font-family: inherit;
  padding: 0;
  overflow-y: auto;
  min-height: 56px;
  max-height: 320px;
}

.hc-msg__edit-textarea::placeholder {
  color: var(--hc-text-secondary, #6e6e73);
}

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
  transition:
    background-color 0.3s cubic-bezier(0.16, 1, 0.3, 1),
    transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.hc-msg__edit-btn:active {
  transform: scale(0.96);
}

.hc-msg__edit-btn--cancel {
  background: var(--hc-bg-card, #f5f5f7);
  color: var(--hc-text-secondary, #6e6e73);
  border: 0.5px solid rgba(0, 0, 0, 0.08);
}

.hc-msg__edit-btn--cancel:hover {
  background: var(--hc-bg-hover, #ebebed);
}

.hc-msg__edit-btn--send {
  background: var(--hc-accent, #007aff);
  color: var(--hc-text-inverse);
  box-shadow: 0 1px 3px rgba(0, 122, 255, 0.25);
}

.hc-msg__edit-btn--send:hover {
  /* HIG accent glow: alpha ≤ 0.18，柔和发光 */
  box-shadow: 0 2px 8px rgba(0, 122, 255, 0.18);
}

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

/* ─── Time ───── */
.hc-msg__time {
  font-size: 11px;
  color: var(--hc-text-muted);
  white-space: nowrap;
  margin-top: 0;
  padding-left: 0;
  opacity: 0.6;
}

.hc-msg__time--right {
  text-align: right;
  padding-left: 0;
  padding-right: 0;
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
  transition:
    background 0.15s,
    color 0.15s,
    box-shadow 0.15s;
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
  transition:
    background 0.15s,
    color 0.15s,
    border-color 0.15s;
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
/* 深度思考：Claude 式轻量 ghost（无常驻底，hover 浮起；开启 → 主色药丸） */
.hc-chat__research-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 9px;
  height: 30px;
  border: none;
  background: transparent;
  color: var(--hc-text-secondary);
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  border-radius: 9px;
  transition:
    color 0.15s cubic-bezier(0.16, 1, 0.3, 1),
    background-color 0.15s cubic-bezier(0.16, 1, 0.3, 1),
    transform 0.12s cubic-bezier(0.34, 1.56, 0.64, 1);
  white-space: nowrap;
}

.hc-chat__research-btn:hover {
  color: var(--hc-text-primary);
  background: var(--hc-bg-hover);
}

.hc-chat__research-btn:active {
  transform: scale(0.96);
}

.hc-chat__research-btn--active {
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  font-weight: 600;
}

.hc-chat__research-btn:disabled {
  background: transparent;
  color: var(--hc-text-muted);
  cursor: not-allowed;
  opacity: 0.55;
  transform: none;
}

/* 思考菜单复用 composer 的轻量浮层，不叠加额外蓝色光晕。 */
.hc-thinking-selector {
  position: relative;
}

.hc-thinking-selector__caret {
  width: 13px;
  height: 13px;
  opacity: 0.5;
}

.hc-thinking-selector__dropdown {
  position: absolute;
  z-index: 100;
  right: 0;
  bottom: 100%;
  width: 236px;
  margin-bottom: 8px;
  padding: 10px;
  border: 1px solid var(--hc-border);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  box-shadow:
    0 4px 24px rgba(0, 0, 0, 0.12),
    0 1px 4px rgba(0, 0, 0, 0.06);
}

.hc-thinking-selector__mode-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 3px 3px 10px;
}

.hc-thinking-selector__label {
  font-size: 14px;
  font-weight: 600;
  color: var(--hc-text-primary);
}

.hc-thinking-selector__switch {
  position: relative;
  width: 34px;
  height: 20px;
  flex: none;
  padding: 0;
  border: 0;
  border-radius: 10px;
  background: var(--hc-bg-active);
  cursor: pointer;
  transition: background-color 0.2s;
}

.hc-thinking-selector__switch[aria-checked='true'] {
  background: var(--hc-accent);
}

.hc-thinking-selector__switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  transition: transform 0.2s;
}

.hc-thinking-selector__switch[aria-checked='true'] .hc-thinking-selector__switch-thumb {
  transform: translateX(14px);
}

.hc-thinking-selector__divider {
  height: 1px;
  margin: 0 -4px 10px;
  background: var(--hc-divider);
}

.hc-thinking-selector__section {
  padding: 0 4px 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--hc-text-muted);
}

.hc-thinking-selector__effort {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-height: 36px;
  gap: 8px;
  padding: 0 8px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--hc-text-primary);
  font: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
}

.hc-thinking-selector__effort:hover,
.hc-thinking-selector__effort[aria-checked='true'] {
  background: var(--hc-bg-hover);
}

.hc-thinking-selector__effort[aria-checked='true'] {
  font-weight: 600;
}

.hc-thinking-selector__check {
  color: var(--hc-accent);
  font-size: 17px;
  line-height: 1;
}

/* 模型选择器：Claude 式轻量 ghost（纯文字 + 浅 caret，无常驻边框） */
.hc-model-selector--inline .hc-model-selector__btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 9px;
  height: 30px;
  border: none;
  background: transparent;
  border-radius: 9px;
  font-size: 13px;
  font-weight: 500;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
  color: var(--hc-text-primary);
  cursor: pointer;
  transition:
    color 0.15s,
    background-color 0.15s,
    transform 0.12s cubic-bezier(0.34, 1.56, 0.64, 1);
  white-space: nowrap;
}

.hc-model-selector--inline .hc-model-selector__btn:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}

.hc-model-selector--inline .hc-model-selector__btn:active {
  transform: scale(0.96);
}

.hc-model-selector--inline .hc-model-selector__dropdown {
  bottom: 100%;
  top: auto;
  margin-bottom: 8px;
  right: 0;
  left: auto;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  box-shadow:
    0 4px 24px rgba(0, 0, 0, 0.12),
    0 1px 4px rgba(0, 0, 0, 0.06);
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

.hc-model-selector__item--disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.hc-model-selector__item--disabled:hover {
  background: transparent;
  color: var(--hc-text-secondary);
}

.hc-model-selector__item-kind {
  flex-shrink: 0;
  width: 18px;
  font-size: 12px;
  line-height: 1;
  margin-right: 6px;
  opacity: 0.85;
}

.hc-model-selector__item-tag {
  margin-left: auto;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--hc-warning, #f59e0b) 14%, transparent);
  color: var(--hc-warning, #f59e0b);
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
  transition:
    background 0.15s,
    border-color 0.15s;
}

.hc-msg__artifact-card:hover {
  border-color: var(--hc-accent);
  background: var(--hc-accent-subtle);
}

/* ─── Input area ───── */
.hc-chat__input-area {
  padding: 8px 24px 10px;
  flex-shrink: 0;
  /* 作为滚动导航箭头的定位锚点：箭头 bottom:100% 即悬于输入框正上方 */
  position: relative;
}

.hc-chat__input-wrap {
  max-width: none;
  margin: 0;
}

.hc-chat__connection-state {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0 4px 6px;
  color: var(--hc-text-muted);
  font-size: 11px;
}

.hc-chat__connection-state--error {
  color: var(--hc-warning, #b45309);
}

.hc-chat__connection-state button {
  color: inherit;
  text-decoration: underline;
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

.hc-msg__automation-progress {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--hc-bg-hover);
  font-size: 12px;
  color: var(--hc-text-secondary);
}

.hc-msg__automation-progress-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--hc-accent);
  animation: hc-automation-pulse 1.2s ease-in-out infinite;
  flex-shrink: 0;
}

@keyframes hc-automation-pulse {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.7);
  }
  50% {
    opacity: 1;
    transform: scale(1.2);
  }
}

.hc-msg__automation-progress-text {
  font-weight: 500;
  color: var(--hc-text-primary);
}

.hc-msg__automation-progress-elapsed {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  opacity: 0.72;
}

.hc-msg__automation-progress-hint {
  flex-basis: 100%;
  margin-left: 16px;
  font-size: 11px;
  opacity: 0.72;
  line-height: 1.4;
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
  transition:
    border-color 0.15s cubic-bezier(0.16, 1, 0.3, 1),
    color 0.15s cubic-bezier(0.16, 1, 0.3, 1);
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
  margin-top: 0;
  color: var(--hc-text-muted);
  font-size: 11px;
  opacity: 0.64;
  white-space: nowrap;
  min-width: 0;
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

.hc-msg__img-wrap,
.hc-msg__video-wrap {
  position: relative;
  display: inline-block;
}

/* 媒体下载按钮（图片/视频统一）— 始终可见 0.85，hover 1.0；RTL 安全用 inset-inline-end */
.hc-msg__media-download {
  position: absolute;
  top: 6px;
  inset-inline-end: 6px;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: none;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 14px;
  cursor: pointer;
  opacity: 0.85;
  transition:
    opacity 0.15s cubic-bezier(0.16, 1, 0.3, 1),
    background-color 0.15s cubic-bezier(0.16, 1, 0.3, 1),
    transform 0.12s cubic-bezier(0.16, 1, 0.3, 1);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  z-index: 2;
}

/* ── Apple HIG 图片预览 Modal ── */
.hc-img-preview__backdrop {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  cursor: zoom-out;
}
.hc-img-preview__img {
  max-width: 92vw;
  max-height: 92vh;
  border-radius: 12px;
  /* HIG --shadow-lg: 柔和多层阴影，alpha ≤ 0.12 */
  box-shadow:
    0 20px 40px rgba(0, 0, 0, 0.12),
    0 8px 16px rgba(0, 0, 0, 0.06);
  cursor: default;
}
.hc-img-preview__close {
  position: absolute;
  top: 20px;
  right: 20px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 0.5px solid rgba(255, 255, 255, 0.3);
  background: rgba(28, 28, 30, 0.72);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  color: #fff;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  transition:
    background 0.15s,
    transform 0.12s;
}
.hc-img-preview__close:hover {
  background: rgba(60, 60, 67, 0.85);
  transform: scale(1.05);
}
.hc-preview-enter-active,
.hc-preview-leave-active {
  transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.hc-preview-enter-from,
.hc-preview-leave-to {
  opacity: 0;
}

.hc-msg__media-download:hover {
  opacity: 1;
  background: rgba(0, 0, 0, 0.75);
  transform: scale(1.08);
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

/* ─── 文档文件卡片（ChatGPT 风格：彩色类型图标 + 名称 + 类型·大小 + 下载）─── */
.hc-docfiles {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}
.hc-docfile {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 300px;
  padding: 6px 6px 6px 8px;
  background: var(--hc-bg-elevated, #fff);
  border: 0.5px solid rgba(0, 0, 0, 0.08);
  border-radius: 14px;
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.05),
    0 6px 16px rgba(0, 0, 0, 0.06);
  color: var(--hc-text-primary, #1d1d1f);
  transition:
    transform 0.18s ease,
    box-shadow 0.18s ease;
}
.hc-docfile--actionable:hover {
  transform: translateY(-1px);
  box-shadow:
    0 2px 4px rgba(0, 0, 0, 0.07),
    0 10px 24px rgba(0, 0, 0, 0.1);
}
.hc-docfile__open {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 4px 4px 4px 2px;
  background: transparent;
  border: none;
  text-align: left;
  color: inherit;
  cursor: default;
}
.hc-docfile--actionable .hc-docfile__open {
  cursor: pointer;
}
/* 彩色"文档"图标（圆角方块 + 折角 + 类型缩写） */
.hc-docfile__icon {
  position: relative;
  flex-shrink: 0;
  width: 36px;
  height: 44px;
  border-radius: 8px;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding-bottom: 6px;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.3px;
  color: #fff;
  background: #8a8a8e;
}
.hc-docfile__icon::after {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  width: 0;
  height: 0;
  border-style: solid;
  border-width: 0 0 10px 10px;
  border-color: transparent transparent rgba(255, 255, 255, 0.4) transparent;
  border-top-right-radius: 8px;
}
.hc-docfile__icon[data-ext='PDF'] {
  background: #e5484d;
}
.hc-docfile__icon[data-ext='DOC'],
.hc-docfile__icon[data-ext='DOCX'] {
  background: #2563eb;
}
.hc-docfile__icon[data-ext='XLS'],
.hc-docfile__icon[data-ext='XLSX'],
.hc-docfile__icon[data-ext='CSV'] {
  background: #16a34a;
}
.hc-docfile__icon[data-ext='PPT'],
.hc-docfile__icon[data-ext='PPTX'] {
  background: #ea580c;
}
.hc-docfile__meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}
.hc-docfile__name {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.25;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hc-docfile__sub {
  font-size: 11px;
  color: var(--hc-text-secondary, #8a8a8e);
}
.hc-docfile__dl {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--hc-text-secondary, #6e6e73);
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}
.hc-docfile__dl:hover {
  background: var(--hc-bg-card, #f1f1f3);
  color: var(--hc-text-primary, #1d1d1f);
}

.hc-msg__video {
  max-width: 480px;
  max-height: 360px;
  width: 100%;
  border-radius: var(--hc-radius-sm, 6px);
  background: #000;
}

.hc-msg__audio {
  display: block;
  width: 320px;
  max-width: 100%;
  height: 36px;
}

/* ── Thinking / Reasoning block ──────────────────── */
.hc-thinking {
  margin-bottom: 8px;
  max-width: 100%;
}

/* --- Thinking / Reasoning (Apple HIG aligned) --- */

.hc-thinking {
  margin-bottom: 6px;
}

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

.hc-thinking__summary::-webkit-details-marker {
  display: none;
}

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

.hc-thinking__label {
  flex-shrink: 0;
}

.hc-thinking__time {
  font-size: 11px;
  font-weight: 400;
  color: var(--hc-text-muted);
  font-variant-numeric: tabular-nums;
}

.hc-thinking__spinner {
  width: 14px;
  height: 14px;
  /* HIG: 1.5px spinner 仍清晰，避免 2px 粗边框 */
  border: 1.5px solid var(--hc-border);
  border-top-color: var(--hc-accent);
  border-radius: 50%;
  animation: hc-spin 0.7s linear infinite;
  flex-shrink: 0;
}

.hc-thinking__content {
  /* logical properties：RTL 时浏览器自动把 inline-start/end 镜像到正确侧 */
  padding-block: 8px 4px;
  padding-inline-start: 14px;
  padding-inline-end: 14px; /* 两侧对称，防 LTR 内容（中文）贴边 */
  margin-inline-start: 3px;
  /* HIG: 1px 细边框形成 quote 视觉，避免 2px 粗边框 */
  border-inline-start: 1px solid var(--hc-border);
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
.hc-chat__show-earlier {
  display: block;
  margin: 4px auto 12px;
  padding: 6px 14px;
  font-size: 12px;
  border: 0.5px solid var(--hc-border);
  border-radius: 999px;
  cursor: pointer;
  background: var(--hc-bg-input);
  color: var(--hc-text-secondary);
}
.hc-chat__show-earlier:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}
</style>
