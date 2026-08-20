<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatSessionDate } from '@/utils/time'
import { Trash2, MoreHorizontal, Pencil, Pin, PinOff, GitBranch } from 'lucide-vue-next'
import { useChatStore } from '@/stores/chat'
import { useAgentsStore } from '@/stores/agents'
import { getSessionAgent, getSessionAgentTombstone } from '@/stores/session-agent-binding'
import { scenarioRegistry } from '@/shell/scenario/registry'
import {
  listSessions,
  searchMessages,
  getSessionBranches,
  updateSessionTitle as apiUpdateSessionTitle,
  type SessionMessageSearchResult,
} from '@/api/chat'
import ContextMenu from '@/components/common/ContextMenu.vue'
import type { ContextMenuItem } from '@/components/common/ContextMenu.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import SearchInput from '@/components/common/SearchInput.vue'
import type { ChatSession } from '@/types'

const { t } = useI18n()
const chatStore = useChatStore()
const agentsStore = useAgentsStore()
const ctxMenu = ref<InstanceType<typeof ContextMenu>>()
const ctxSessionId = ref<string | null>(null)
const openMenuSessionId = ref<string | null>(null)

const renamingId = ref<string | null>(null)
const renameValue = ref('')
const renameInputRef = ref<HTMLInputElement | HTMLInputElement[] | null>(null)
const renameRequestSeq = new Map<string, number>()
const deletingSessionIds = ref<Set<string>>(new Set())
const extraSessions = ref<ChatSession[]>([])
const hasMoreSessions = ref(true)
const loadingMoreSessions = ref(false)
const contentSearchResults = ref<SessionMessageSearchResult[]>([])
const searchingHistory = ref(false)
const showAllConversations = ref(false)
const SESSION_PAGE_SIZE = 50
let filterDebounceTimer: ReturnType<typeof setTimeout> | null = null
let filterRequestSeq = 0
let filterAbortController: AbortController | null = null

// Pin state
const pinnedIds = ref<Set<string>>(new Set())

// “查看分支”不能靠标题、parent_session_id 或当前分页内容猜测；菜单每次打开都以
// GET /sessions/:id/branches 的真实结果刷新。未知/加载中/失败/空列表都保持禁用，
// 只有当前目标被后端证明至少有一个子分支时才启用。
type BranchAvailability = 'unknown' | 'loading' | 'available' | 'empty' | 'error'
const branchAvailability = ref<Map<string, BranchAvailability>>(new Map())
const branchCache = ref<Map<string, ChatSession[]>>(new Map())
const branchAvailabilityRequestSeq = new Map<string, number>()

function setBranchAvailability(
  sessionId: string,
  availability: BranchAvailability,
  branches?: ChatSession[],
) {
  const nextAvailability = new Map(branchAvailability.value)
  nextAvailability.set(sessionId, availability)
  branchAvailability.value = nextAvailability
  if (branches) {
    const nextCache = new Map(branchCache.value)
    nextCache.set(sessionId, branches)
    branchCache.value = nextCache
  }
}

async function refreshBranchAvailability(sessionId: string) {
  const requestSeq = (branchAvailabilityRequestSeq.get(sessionId) ?? 0) + 1
  branchAvailabilityRequestSeq.set(sessionId, requestSeq)
  setBranchAvailability(sessionId, 'loading')
  try {
    const result = await getSessionBranches(sessionId)
    if (branchAvailabilityRequestSeq.get(sessionId) !== requestSeq) return
    const branches = result.branches ?? []
    setBranchAvailability(sessionId, branches.length > 0 ? 'available' : 'empty', branches)
  } catch {
    if (branchAvailabilityRequestSeq.get(sessionId) !== requestSeq) return
    setBranchAvailability(sessionId, 'error', [])
  }
}

// 会话身份只在这里解析一次：稳定后端 agent_id > 本地持久绑定 > 遗留 agent_name >
// 标题兜底（内部名或唯一显示名）。标题仅是存量恢复兜底，图标、置顶和可读标题必须消费同一结果，
// 避免首次渲染与点击恢复使用两套规则而产生“点前无图标、点后才出现”的漂移。
function resolveSessionAgent(s: ChatSession) {
  const raw = (s.title ?? '').trim()
  const candidate =
    (s.agent_id ?? '').trim() || getSessionAgent(s.id) || (s.agent_name ?? '').trim() || raw
  const config = candidate ? agentsStore.findAgentByNameOrDisplay(candidate) : undefined
  return {
    agentId: config?.name ?? candidate,
    config,
  }
}

// 场景实例会话自动置顶：据同一会话身份解析结果是否有场景描述符判定（registry，通用无领域词）。
function isScenarioSession(s: ChatSession): boolean {
  // 注意不能要求 config 必中：resolver 可仅凭 agentId 判定，agent 未注册到 store 时也要能置顶
  //（SessionList.test「场景实例会话自动置顶」回归锁）。
  // agentId 形状兜底（matchesInstanceId）：冷启动 agents 目录未就绪、metadata 缺失时，
  // K12 等场景实例仍按实例 ID 模式（如 k12-tutor-*）置顶，避免"打开 App 有时不置顶"
  //（BUG-20260816-003；原型 app.html .cs-item data-pin-locked）。
  const resolved = resolveSessionAgent(s)
  if (!resolved.agentId) return false
  return (
    scenarioRegistry.isScenarioInstance({
      agentId: resolved.agentId,
      metadata: resolved.config?.metadata,
    }) || scenarioRegistry.matchesInstanceId(resolved.agentId)
  )
}
// 有效置顶 = 手动置顶 或 场景实例（场景实例常驻顶部）
function isPinnedSession(s: ChatSession): boolean {
  return pinnedIds.value.has(s.id) || isScenarioSession(s)
}

// 会话可读标题：场景会话 title 默认 = 原始 agent id（如 k12-tutor-KKE5v8zQ），家长看不懂。
// 该会话绑定的 Agent 三路解析：localStorage 绑定 > 后端 agent_name > 标题本身即 agent 内部名
// （深链建会话时把标题设为 role=agent 名）。命中且标题未被手动改名时显示 display_name（P0-20260708）。
// 会话列表对齐原型（app.html .cs-item）：智能体会话的身份 = **标题内联 emoji 前缀**（如「🎓 小明的辅导老师
// · 五年级」），而非独立头像框或 meta 里的智能体名。通用会话（无专属 agent avatar）不加前缀。
function sessionTitle(s: ChatSession): string {
  const raw = (s.title ?? '').trim()
  const resolved = resolveSessionAgent(s)
  const boundName = resolved.agentId
  const cfg = resolved.config
  const avatar = (cfg?.metadata?.avatar ?? '').trim()
  const display = (cfg?.display_name ?? '').trim()
  // 孤儿态（BUG-20260712 治标）：agent 已删除且标题未被手动改名 → 显示「已删除的智能体」，
  // 绝不裸显内部 ID（技术泄漏）。信号两路：①绑定墓碑/后端 agent_name 指向查无此人的 agent；
  // ②遗留会话（绑定早被旧守卫清掉）标题恰为某场景实例内部名（registry 名模式，shell 零场景知识）。
  if (!cfg && agentsStore.agentsLoaded) {
    const assoc =
      (s.agent_id ?? '').trim() ||
      getSessionAgent(s.id) ||
      getSessionAgentTombstone(s.id) ||
      (s.agent_name ?? '')
    const orphanByAssoc = !!assoc && (!raw || raw === assoc)
    const orphanByPattern = !!raw && scenarioRegistry.matchesInstanceId(raw)
    if (orphanByAssoc || orphanByPattern) return t('chat.orphanAgentSession')
  }
  // 标题为空 / 恰为 agent 内部名（未手动改名）→ 显示可读名；改过名则保留自定义标题
  const resolvedBase =
    display && (!raw || raw === boundName || raw === cfg?.name)
      ? display
      : raw || t('chat.newSessionDefault')
  const base = scenarioRegistry.projectInstanceDisplayName(
    {
      agentId: cfg?.name ?? boundName,
      agentName: display,
      metadata: cfg?.metadata,
    },
    resolvedBase,
  )
  // 专属智能体（带 avatar emoji）在标题前内联图标（原型做法）
  return avatar ? `${avatar} ${base}` : base
}

// Filter state（搜索框常驻，无需展开/收起开关）
const filterQuery = ref('')

function normalizeSearchText(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '')
}

onMounted(() => {
  try {
    const raw = localStorage.getItem('hexclaw_pinned_sessions')
    if (raw) pinnedIds.value = new Set(JSON.parse(raw))
  } catch {
    /* ignore */
  }
})

function savePins() {
  localStorage.setItem('hexclaw_pinned_sessions', JSON.stringify([...pinnedIds.value]))
}

function togglePin(sessionId: string) {
  if (pinnedIds.value.has(sessionId)) {
    pinnedIds.value.delete(sessionId)
  } else {
    pinnedIds.value.add(sessionId)
  }
  pinnedIds.value = new Set(pinnedIds.value)
  savePins()
}

function pinActionLabel(session: ChatSession): string {
  if (isScenarioSession(session)) return t('chat.scenarioPinned')
  return isPinnedSession(session) ? t('chat.unpin') : t('chat.pin')
}

function handlePinAction(session: ChatSession) {
  if (isScenarioSession(session)) return
  togglePin(session.id)
}

// 活动会话永远可见（BUG-20260711-G）：点 agent 复用三天前的老会话时，条目按 updated_at
// 排在「更早」分组视口外，用户视角=「列表里不显示」。选中变化即把活动条目滚进视口；
// 不重排列表（保持按活跃时间分组的稳定心智），block:nearest 已可见时零跳动。
watch(
  () => chatStore.currentSessionId,
  async (sid) => {
    if (!sid) return
    await nextTick()
    // CSS.escape 兜底（jsdom 无该全局）：会话 id 只需转义引号/反斜杠即可安全进属性选择器
    const escaped =
      typeof CSS !== 'undefined' && CSS.escape
        ? CSS.escape(sid)
        : sid.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const el = document.querySelector<HTMLElement>(
      `.hc-sessions__item[data-session-id="${escaped}"]`,
    )
    el?.scrollIntoView?.({ block: 'nearest' }) // 方法级可选：jsdom 元素无 scrollIntoView 实现
  },
  { immediate: true },
)

const sessionMenuItems = computed<ContextMenuItem[]>(() => {
  const session = ctxSessionId.value
    ? [...chatStore.sessions, ...extraSessions.value].find((item) => item.id === ctxSessionId.value)
    : undefined
  const isScenarioPinned = session ? isScenarioSession(session) : false
  const isPinned = session ? isPinnedSession(session) : false
  return [
    { id: 'rename', label: t('chat.rename'), icon: Pencil },
    {
      id: 'pin',
      label: isScenarioPinned
        ? t('chat.scenarioPinned')
        : isPinned
          ? t('chat.unpin')
          : t('chat.pin'),
      icon: isPinned ? PinOff : Pin,
      disabled: isScenarioPinned,
    },
    {
      id: 'branches',
      label: t('chat.viewBranches', '查看分支'),
      icon: GitBranch,
      disabled: !session || branchAvailability.value.get(session.id) !== 'available',
    },
    { id: 'sep1', label: '', separator: true },
    { id: 'delete', label: t('common.delete'), icon: Trash2, danger: true, shortcut: '⌫' },
  ]
})

const mergedSessions = computed<ChatSession[]>(() => {
  const byId = new Map<string, ChatSession>()
  for (const session of [...chatStore.sessions, ...extraSessions.value]) {
    byId.set(session.id, session)
  }
  return Array.from(byId.values())
})

const sortedSessions = computed(() => {
  const list = mergedSessions.value
  const pinned = list.filter((s) => isPinnedSession(s))
  const unpinned = list.filter((s) => !isPinnedSession(s))
  return [...pinned, ...unpinned]
})

type SearchSessionItem = {
  session: ChatSession
  snippet?: string
}

const searchSessionItems = computed<SearchSessionItem[]>(() => {
  const q = normalizeSearchText(filterQuery.value.trim())
  if (!q) return []

  const sessionMap = new Map(mergedSessions.value.map((session) => [session.id, session]))
  const results = new Map<string, SearchSessionItem>()

  for (const session of mergedSessions.value) {
    if (normalizeSearchText(sessionTitle(session)).includes(q)) {
      results.set(session.id, { session })
    }
  }

  for (const result of contentSearchResults.value) {
    const sessionId = result.message.session_id
    const existing = results.get(sessionId)
    const session = sessionMap.get(sessionId) ?? {
      id: sessionId,
      title: result.session_title || t('chat.newSessionDefault'),
      created_at: result.message.created_at || result.message.timestamp,
      updated_at: result.message.created_at || result.message.timestamp,
      message_count: 0,
    }
    if (!sessionMap.has(sessionId)) {
      sessionMap.set(sessionId, session)
    }
    if (!existing) {
      results.set(sessionId, {
        session,
        snippet: result.message.content,
      })
    }
  }

  return Array.from(results.values()).sort((a, b) => {
    if (isPinnedSession(a.session) !== isPinnedSession(b.session)) {
      return isPinnedSession(a.session) ? -1 : 1
    }
    return new Date(b.session.updated_at).getTime() - new Date(a.session.updated_at).getTime()
  })
})

type SessionSection = { key: string; label: string; sessions: ChatSession[] }
type SearchSessionSection = { key: string; label: string; sessions: SearchSessionItem[] }

function getSessionDateBucket(updatedAt: string) {
  const date = new Date(updatedAt)
  if (Number.isNaN(date.getTime())) return 'earlier'
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterdayStart = new Date(todayStart)
  yesterdayStart.setDate(yesterdayStart.getDate() - 1)
  if (date >= todayStart) return 'today'
  if (date >= yesterdayStart) return 'yesterday'
  return 'earlier'
}

const sessionSections = computed<SessionSection[]>(() => {
  if (filterQuery.value.trim()) return []
  const sections: SessionSection[] = []
  const pinned = sortedSessions.value.filter((s) => isPinnedSession(s))
  const unpinned = sortedSessions.value.filter((s) => !isPinnedSession(s))

  if (pinned.length > 0) {
    sections.push({ key: 'pinned', label: t('chat.pinnedSection'), sessions: pinned })
  }

  const buckets: Record<'today' | 'yesterday' | 'earlier', ChatSession[]> = {
    today: [],
    yesterday: [],
    earlier: [],
  }
  for (const session of unpinned) {
    buckets[getSessionDateBucket(session.updated_at) as 'today' | 'yesterday' | 'earlier'].push(
      session,
    )
  }

  if (buckets.today.length > 0)
    sections.push({ key: 'today', label: t('chat.todaySection'), sessions: buckets.today })
  if (buckets.yesterday.length > 0)
    sections.push({
      key: 'yesterday',
      label: t('chat.yesterdaySection'),
      sessions: buckets.yesterday,
    })
  if (buckets.earlier.length > 0)
    sections.push({ key: 'earlier', label: t('chat.earlierSection'), sessions: buckets.earlier })

  return sections
})

const searchSections = computed<SearchSessionSection[]>(() => {
  if (!filterQuery.value.trim()) return []
  return [
    {
      key: 'search-results',
      label: t('chat.searchResultsSection'),
      sessions: searchSessionItems.value,
    },
  ]
})

const showEmptyState = computed(() =>
  filterQuery.value.trim()
    ? searchSessionItems.value.length === 0 && !searchingHistory.value
    : sortedSessions.value.length === 0,
)

function formatDate(ts: string): string {
  return formatSessionDate(ts)
}

function isSessionGenerating(sessionId: string) {
  return chatStore.isSessionStreaming(sessionId) || chatStore.isSessionExecuting(sessionId)
}

function isSessionAwaitingApproval(sessionId: string) {
  return chatStore.hasSessionPendingApproval(sessionId)
}

function selectSession(sessionId: string) {
  if (renamingId.value) return
  chatStore.selectSession(sessionId)
}

// 分支查看器（BUG-20260703 收尾）：fork 落地后「从父会话找回分支」的消费面——
// 右键「查看分支」→ getSessionBranches → 弹层列分支 → 点击切换。
const branchesFor = ref<string | null>(null)
const branchesList = ref<ChatSession[]>([])
const branchesLoading = ref(false)
const branchesError = ref(false)

async function openBranches(sessionId: string) {
  branchesFor.value = sessionId
  branchesLoading.value = true
  branchesError.value = false
  branchesList.value = []
  try {
    const res = await getSessionBranches(sessionId)
    branchesList.value = res.branches ?? []
  } catch (e) {
    branchesError.value = true
    console.error('[SessionList] load branches failed:', e)
  } finally {
    branchesLoading.value = false
  }
}

function selectBranch(branchId: string) {
  branchesFor.value = null
  chatStore.selectSession(branchId)
}

// BUG-20260703 P2-5：删除必须过二次确认（此前删除按钮/右键/⌫ 直删，误触即丢整段
// 对话历史）。三个入口统一走 deleteSession → 确认弹层 → performDeleteSession。
const confirmDeleteId = ref<string | null>(null)
const confirmDeleteTitle = computed(() => {
  const sid = confirmDeleteId.value
  if (!sid) return ''
  const session =
    chatStore.sessions.find((s) => s.id === sid) ?? mergedSessions.value.find((s) => s.id === sid)
  return session?.title || t('chat.newSessionDefault')
})

function deleteSession(sessionId: string) {
  if (deletingSessionIds.value.has(sessionId)) return
  confirmDeleteId.value = sessionId
}

async function confirmDeleteSession() {
  const sid = confirmDeleteId.value
  confirmDeleteId.value = null
  if (sid) await performDeleteSession(sid)
}

async function performDeleteSession(sessionId: string) {
  if (deletingSessionIds.value.has(sessionId)) return
  const nextDeleting = new Set(deletingSessionIds.value)
  nextDeleting.add(sessionId)
  deletingSessionIds.value = nextDeleting
  const wasPinned = pinnedIds.value.has(sessionId)
  if (wasPinned) {
    pinnedIds.value.delete(sessionId)
    pinnedIds.value = new Set(pinnedIds.value)
    savePins()
  }
  try {
    await chatStore.deleteSession(sessionId)
    chatStore.clearPendingApprovalsForSession(sessionId)
    // 分页加载的旧会话只存在于 extraSessions；删除成功后必须同步清理本地分页缓存，
    // 否则 API 已成功但列表仍残留，刷新前会形成“删除无效”的假象。
    extraSessions.value = extraSessions.value.filter((session) => session.id !== sessionId)
  } catch (e) {
    if (wasPinned) {
      pinnedIds.value.add(sessionId)
      pinnedIds.value = new Set(pinnedIds.value)
      savePins()
    }
    console.error('[SessionList] delete failed:', e)
  } finally {
    const currentDeleting = new Set(deletingSessionIds.value)
    currentDeleting.delete(sessionId)
    deletingSessionIds.value = currentDeleting
  }
}

function startRename(sessionId: string) {
  // 分页加载的会话只在 extraSessions 里、不在 chatStore.sessions，需走 mergedSessions 兜底，
  // 否则「加载更多」得到的旧会话双击/右键重命名时 startRename 直接 return（输入框不弹）。
  const session =
    chatStore.sessions.find((s) => s.id === sessionId) ??
    mergedSessions.value.find((s) => s.id === sessionId)
  if (!session) return
  renamingId.value = sessionId
  renameValue.value = session.title || t('chat.newSessionDefault')
  nextTick(() => {
    const input = Array.isArray(renameInputRef.value)
      ? renameInputRef.value[0]
      : renameInputRef.value
    input?.focus()
    input?.select()
  })
}

async function commitRename() {
  const sid = renamingId.value
  if (!sid) return
  const newTitle = renameValue.value.trim() || t('chat.newSessionDefault')
  renamingId.value = null
  const requestSeq = (renameRequestSeq.get(sid) ?? 0) + 1
  renameRequestSeq.set(sid, requestSeq)
  try {
    await apiUpdateSessionTitle(sid, newTitle)
    if (renameRequestSeq.get(sid) !== requestSeq) return
    // 同 startRename：extraSessions（分页加载）的标题也要本地刷新，否则改名成功但 UI 不变。
    const session =
      chatStore.sessions.find((s) => s.id === sid) ?? mergedSessions.value.find((s) => s.id === sid)
    if (session) session.title = newTitle
  } catch (e) {
    console.error('[SessionList] rename failed:', e)
  }
}

function cancelRename() {
  renamingId.value = null
}

function handleRenameKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    commitRename()
  } else if (e.key === 'Escape') {
    cancelRename()
  }
}

function handleContextMenu(e: MouseEvent, sessionId: string) {
  ctxSessionId.value = sessionId
  openMenuSessionId.value = sessionId
  void refreshBranchAvailability(sessionId)
  ctxMenu.value?.show(e)
}

function handleActionsClick(e: MouseEvent, sessionId: string) {
  if (openMenuSessionId.value === sessionId) {
    ctxMenu.value?.hide()
    return
  }
  const trigger = e.currentTarget
  if (!(trigger instanceof HTMLElement)) return
  ctxSessionId.value = sessionId
  openMenuSessionId.value = sessionId
  void refreshBranchAvailability(sessionId)
  ctxMenu.value?.showAt(trigger)
}

function handleActionsKeydown(e: KeyboardEvent, sessionId: string) {
  if (!(e.shiftKey && e.key === 'F10')) return
  e.preventDefault()
  e.stopPropagation()
  const trigger = e.currentTarget
  if (!(trigger instanceof HTMLElement)) return
  ctxSessionId.value = sessionId
  openMenuSessionId.value = sessionId
  void refreshBranchAvailability(sessionId)
  ctxMenu.value?.showAt(trigger)
}

function handleContextMenuClose() {
  openMenuSessionId.value = null
}

async function handleCtxAction(action: string) {
  const sid = ctxSessionId.value
  if (!sid) return
  switch (action) {
    case 'delete':
      await deleteSession(sid)
      break
    case 'branches':
      await openBranches(sid)
      break
    case 'rename':
      startRename(sid)
      break
    case 'pin':
      {
        const session = mergedSessions.value.find((item) => item.id === sid)
        if (session && !isScenarioSession(session)) togglePin(sid)
      }
      break
  }
}

async function loadMoreSessions() {
  if (loadingMoreSessions.value || !hasMoreSessions.value) return
  loadingMoreSessions.value = true
  try {
    const offset = mergedSessions.value.length
    const result = await listSessions({ limit: SESSION_PAGE_SIZE, offset })
    const loaded = (result.sessions || []).map((session) => ({
      id: session.id,
      title: session.title || t('chat.newSessionDefault'),
      // BUG-20260703：分支徽标依赖 parent_session_id，映射丢字段会让分页加载的
      // 分支会话（P2-1 fork）在完整列表里不可辨识。
      parent_session_id: session.parent_session_id,
      created_at: session.created_at,
      updated_at: session.updated_at,
      message_count: session.message_count ?? 0,
    }))
    if (loaded.length < SESSION_PAGE_SIZE) {
      hasMoreSessions.value = false
    }
    if (loaded.length > 0) {
      const next = new Map(extraSessions.value.map((session) => [session.id, session]))
      for (const session of loaded) {
        if (!chatStore.sessions.some((existing) => existing.id === session.id)) {
          next.set(session.id, session)
        }
      }
      extraSessions.value = Array.from(next.values())
      showAllConversations.value = true
    }
  } catch (error) {
    console.error('[SessionList] load more sessions failed:', error)
  } finally {
    loadingMoreSessions.value = false
  }
}

function formatSearchSnippet(content?: string) {
  if (!content) return ''
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 72) return normalized
  return normalized.slice(0, 72) + '…'
}

watch(filterQuery, (value) => {
  if (filterDebounceTimer) {
    clearTimeout(filterDebounceTimer)
    filterDebounceTimer = null
  }
  if (filterAbortController) {
    filterAbortController.abort()
    filterAbortController = null
  }

  const query = value.trim()
  if (!query) {
    contentSearchResults.value = []
    searchingHistory.value = false
    return
  }

  const seq = ++filterRequestSeq
  searchingHistory.value = true
  filterDebounceTimer = setTimeout(async () => {
    const ac = new AbortController()
    filterAbortController = ac
    try {
      const result = await searchMessages(query, { limit: 50 })
      if (ac.signal.aborted || seq !== filterRequestSeq) return
      contentSearchResults.value = result.results || []
    } catch (error) {
      if (ac.signal.aborted || seq !== filterRequestSeq) return
      contentSearchResults.value = []
      console.error('[SessionList] search messages failed:', error)
    } finally {
      if (seq === filterRequestSeq) {
        searchingHistory.value = false
      }
    }
  }, 220)
})

onUnmounted(() => {
  if (filterDebounceTimer) clearTimeout(filterDebounceTimer)
  if (filterAbortController) filterAbortController.abort()
})
</script>

<template>
  <div class="hc-sessions">
    <!-- 常驻搜索框（对齐原型 .srch：放大镜图标 + 输入框始终可见） -->
    <div class="hc-sessions__search-slot">
      <SearchInput
        v-model="filterQuery"
        fluid
        class="hc-sessions__search"
        :placeholder="t('chat.filterSessions')"
      />
    </div>

    <template v-if="filterQuery.trim()">
      <div v-if="searchingHistory" class="hc-sessions__searching">
        {{ t('chat.searchingHistory') }}
      </div>
      <template v-for="section in searchSections" :key="section.key">
        <div class="hc-sessions__section">
          <div class="hc-sessions__section-label">{{ section.label }}</div>
          <div
            v-for="item in section.sessions"
            :key="item.session.id"
            :data-session-id="item.session.id"
            class="hc-sessions__item"
            :class="{
              'hc-sessions__item--active': chatStore.currentSessionId === item.session.id,
              'hc-sessions__item--pinned': isPinnedSession(item.session),
              'hc-sessions__item--menu-open': openMenuSessionId === item.session.id,
            }"
            @click="selectSession(item.session.id)"
            @dblclick.stop="startRename(item.session.id)"
            @contextmenu="handleContextMenu($event, item.session.id)"
          >
            <span
              v-if="isSessionGenerating(item.session.id)"
              class="hc-sessions__spinner"
              :title="t('chat.generatingInBackground')"
              aria-hidden="true"
            />
            <div class="hc-sessions__content">
              <HcClearableField v-if="renamingId === item.session.id">
                <input
                  ref="renameInputRef"
                  v-model="renameValue"
                  class="hc-sessions__rename-input"
                  @blur="commitRename"
                  @keydown="handleRenameKeydown"
                  @click.stop
                />
              </HcClearableField>
              <div v-else class="hc-sessions__title-row">
                <!-- BUG-20260703 P2-1：分支会话可辨识（由「由此分叉」创建） -->
                <GitBranch
                  v-if="item.session.parent_session_id"
                  :size="11"
                  class="hc-sessions__branch-badge"
                  :title="t('chat.branchSession', '分支会话')"
                  aria-hidden="true"
                />
                <div class="hc-sessions__title">{{ sessionTitle(item.session) }}</div>
                <span
                  v-if="isSessionAwaitingApproval(item.session.id)"
                  class="hc-sessions__approval-dot"
                  :title="t('chat.pendingApprovalInBackground')"
                />
              </div>
              <div class="hc-sessions__meta">
                <span v-if="item.snippet" class="hc-sessions__snippet">{{
                  formatSearchSnippet(item.snippet)
                }}</span>
                <span v-else class="hc-sessions__time">{{
                  formatDate(item.session.updated_at)
                }}</span>
              </div>
            </div>
            <button
              class="hc-sessions__pin-action"
              type="button"
              :aria-label="pinActionLabel(item.session)"
              :title="pinActionLabel(item.session)"
              :disabled="isScenarioSession(item.session)"
              @click.stop="handlePinAction(item.session)"
            >
              <PinOff v-if="isPinnedSession(item.session)" :size="18" aria-hidden="true" />
              <Pin v-else :size="18" aria-hidden="true" />
            </button>
            <button
              class="hc-sessions__actions"
              type="button"
              :aria-label="t('chat.sessionActions')"
              aria-haspopup="menu"
              :aria-expanded="openMenuSessionId === item.session.id"
              @click.stop="handleActionsClick($event, item.session.id)"
              @keydown="handleActionsKeydown($event, item.session.id)"
            >
              <MoreHorizontal :size="20" aria-hidden="true" />
            </button>
          </div>
        </div>
      </template>
    </template>

    <template v-else v-for="section in sessionSections" :key="section.key">
      <div class="hc-sessions__section">
        <div class="hc-sessions__section-label">{{ section.label }}</div>
        <div
          v-for="session in section.sessions"
          :key="session.id"
          :data-session-id="session.id"
          class="hc-sessions__item"
          :class="{
            'hc-sessions__item--active': chatStore.currentSessionId === session.id,
            'hc-sessions__item--pinned': isPinnedSession(session),
            'hc-sessions__item--menu-open': openMenuSessionId === session.id,
          }"
          @click="selectSession(session.id)"
          @dblclick.stop="startRename(session.id)"
          @contextmenu="handleContextMenu($event, session.id)"
        >
          <span
            v-if="isSessionGenerating(session.id)"
            class="hc-sessions__spinner"
            :title="t('chat.generatingInBackground')"
            aria-hidden="true"
          />
          <div class="hc-sessions__content">
            <HcClearableField v-if="renamingId === session.id">
              <input
                ref="renameInputRef"
                v-model="renameValue"
                class="hc-sessions__rename-input"
                @blur="commitRename"
                @keydown="handleRenameKeydown"
                @click.stop
              />
            </HcClearableField>
            <div v-else class="hc-sessions__title-row">
              <!-- BUG-20260703 P2-1：分支会话可辨识（由「由此分叉」创建） -->
              <GitBranch
                v-if="session.parent_session_id"
                :size="11"
                class="hc-sessions__branch-badge"
                :title="t('chat.branchSession', '分支会话')"
                aria-hidden="true"
              />
              <div class="hc-sessions__title">{{ sessionTitle(session) }}</div>
              <span
                v-if="isSessionAwaitingApproval(session.id)"
                class="hc-sessions__approval-dot"
                :title="t('chat.pendingApprovalInBackground')"
              />
            </div>
            <div class="hc-sessions__meta">
              <span class="hc-sessions__time">{{ formatDate(session.updated_at) }}</span>
              <span v-if="session.message_count > 0" class="hc-sessions__count">{{
                session.message_count
              }}</span>
            </div>
          </div>
          <button
            class="hc-sessions__pin-action"
            type="button"
            :aria-label="pinActionLabel(session)"
            :title="pinActionLabel(session)"
            :disabled="isScenarioSession(session)"
            @click.stop="handlePinAction(session)"
          >
            <PinOff v-if="isPinnedSession(session)" :size="18" aria-hidden="true" />
            <Pin v-else :size="18" aria-hidden="true" />
          </button>
          <button
            class="hc-sessions__actions"
            type="button"
            :aria-label="t('chat.sessionActions')"
            aria-haspopup="menu"
            :aria-expanded="openMenuSessionId === session.id"
            @click.stop="handleActionsClick($event, session.id)"
            @keydown="handleActionsKeydown($event, session.id)"
          >
            <MoreHorizontal :size="20" aria-hidden="true" />
          </button>
        </div>
      </div>
    </template>

    <div v-if="showEmptyState" class="hc-sessions__empty">
      {{ filterQuery ? t('chat.noFilterResults') : t('chat.noSessions') }}
    </div>

    <button
      v-if="hasMoreSessions && !filterQuery.trim()"
      class="hc-sessions__load-more"
      :disabled="loadingMoreSessions"
      @click="loadMoreSessions"
    >
      {{
        loadingMoreSessions
          ? t('common.loading')
          : showAllConversations
            ? t('chat.loadMoreSessions')
            : t('chat.allConversations')
      }}
    </button>

    <ContextMenu
      ref="ctxMenu"
      :items="sessionMenuItems"
      variant="session"
      @select="handleCtxAction"
      @close="handleContextMenuClose"
    />

    <!-- 分支查看器：右键「查看分支」弹层，点分支即切换（getSessionBranches 消费面） -->
    <Teleport to="body">
      <div
        v-if="branchesFor"
        class="hc-branches__overlay"
        data-testid="branches-dialog"
        @click.self="branchesFor = null"
      >
        <div
          class="hc-branches__panel"
          role="dialog"
          :aria-label="t('chat.branchesTitle', '会话分支')"
        >
          <div class="hc-branches__head">
            <GitBranch :size="14" />
            <b>{{ t('chat.branchesTitle', '会话分支') }}</b>
            <button
              class="hc-branches__close"
              :aria-label="t('common.close')"
              @click="branchesFor = null"
            >
              ✕
            </button>
          </div>
          <div v-if="branchesLoading" class="hc-branches__muted">{{ t('common.loading') }}</div>
          <div v-else-if="branchesError" class="hc-branches__muted">
            {{ t('chat.branchesLoadFailed', '分支加载失败') }}
          </div>
          <div
            v-else-if="branchesList.length === 0"
            class="hc-branches__muted"
            data-testid="branches-empty"
          >
            {{ t('chat.noBranches', '此会话还没有分支——在任意回复上点「由此分叉」即可创建') }}
          </div>
          <div v-else class="hc-branches__list">
            <button
              v-for="b in branchesList"
              :key="b.id"
              class="hc-branches__item"
              :data-testid="`branch-item-${b.id}`"
              @click="selectBranch(b.id)"
            >
              <GitBranch :size="11" class="hc-branches__item-icon" />
              <span class="hc-branches__item-title">{{
                b.title || t('chat.newSessionDefault')
              }}</span>
              <span class="hc-branches__item-time">{{ formatDate(b.updated_at) }}</span>
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- BUG-20260703 P2-5：删除会话二次确认（后端为软删，但 UI 无恢复入口=用户视角不可逆） -->
    <ConfirmDialog
      :open="!!confirmDeleteId"
      :title="t('chat.deleteSessionConfirmTitle', '删除会话？')"
      :message="t('chat.deleteSessionConfirmMessage', { title: confirmDeleteTitle })"
      :confirm-text="t('agents.delete', '删除')"
      :cancel-text="t('common.cancel', '取消')"
      :confirmation-key="confirmDeleteId"
      danger
      @confirm="confirmDeleteSession"
      @cancel="confirmDeleteId = null"
    />
  </div>
</template>

<style scoped>
.hc-sessions {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px;
  display: flex;
  flex-direction: column;
}

/* DD-019：外层占用会话内容轨，SearchInput 的 100% 不再与横向 margin 叠加。 */
.hc-sessions__search-slot {
  flex-shrink: 0;
  min-width: 0;
  margin: 6px 4px 12px;
}
.hc-sessions__search {
  inline-size: 100%;
}

.hc-sessions__section {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 10px;
}

.hc-sessions__searching {
  padding: 0 10px 8px;
  font-size: 11px;
  color: var(--hc-text-muted);
}

.hc-sessions__section-label {
  padding: 0 10px 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--hc-text-muted);
  letter-spacing: 0.02em;
}

.hc-sessions__item {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 24px 24px;
  align-items: center;
  column-gap: 0;
  width: 100%;
  box-sizing: border-box;
  padding: 9px 8px 9px 10px;
  margin-bottom: 1px;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.15s var(--hc-ease-out, ease-out);
}

.hc-sessions__item:hover {
  background: color-mix(in srgb, var(--hc-text-primary) 7%, transparent);
}

.hc-sessions__item--active {
  background: color-mix(in srgb, var(--hc-text-primary) 7%, transparent);
}

.hc-sessions__content {
  grid-column: 1;
  grid-row: 1;
  min-width: 0;
}

.hc-sessions__item:has(> .hc-sessions__spinner) .hc-sessions__content {
  padding-inline-start: 20px;
}

.hc-sessions__title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.hc-sessions__spinner {
  position: absolute;
  inset-inline-start: 10px;
  top: 50%;
  transform: translateY(-50%);
  width: 12px;
  height: 12px;
  border-radius: 999px;
  border: 1.5px solid color-mix(in srgb, var(--hc-text-muted) 28%, transparent);
  border-top-color: var(--hc-accent);
  animation: hc-session-spin 0.85s linear infinite;
}

.hc-sessions__title {
  font-size: 13px;
  font-weight: 400;
  color: var(--hc-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 分支会话徽标（BUG-20260703 P2-1 fork）：小巧、随主题、不与生成中 spinner 抢位 */
.hc-sessions__branch-badge {
  flex: 0 0 auto;
  color: var(--hc-text-muted);
  opacity: 0.75;
}

/* ─── 分支查看器弹层 ─── */
.hc-branches__overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(2px);
}
.hc-branches__panel {
  width: min(360px, 90vw);
  max-height: 60vh;
  overflow: auto;
  border-radius: 14px;
  padding: 14px;
  background: var(--hc-bg-elevated);
  border: 1px solid var(--hc-border);
  box-shadow: var(--hc-shadow-lg, 0 12px 32px rgba(0, 0, 0, 0.22));
}
.hc-branches__head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 10px;
  color: var(--hc-text-primary);
  font-size: 13px;
}
.hc-branches__close {
  margin-inline-start: auto;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--hc-text-muted);
  font-size: 13px;
  padding: 2px 6px;
  border-radius: 6px;
}
.hc-branches__close:hover {
  color: var(--hc-text-primary);
  background: var(--hc-bg-hover, rgba(127, 127, 127, 0.1));
}
.hc-branches__muted {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--hc-text-muted);
  padding: 6px 2px;
}
.hc-branches__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.hc-branches__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 8px 10px;
  border: none;
  border-radius: 9px;
  background: transparent;
  cursor: pointer;
  text-align: start;
}
.hc-branches__item:hover {
  background: var(--hc-bg-hover, rgba(127, 127, 127, 0.1));
}
.hc-branches__item-icon {
  flex: 0 0 auto;
  color: var(--hc-text-muted);
}
.hc-branches__item-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--hc-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hc-branches__item-time {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--hc-text-muted);
}

.hc-sessions__approval-dot {
  width: 7px;
  height: 7px;
  flex: 0 0 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--hc-warning, #d97706) 82%, white 18%);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--hc-warning, #d97706) 18%, transparent);
}

.hc-sessions__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 3px;
}

.hc-sessions__time {
  font-size: 11px;
  color: var(--hc-text-muted);
}

.hc-sessions__count {
  margin-left: auto;
  font-size: 11px;
  color: var(--hc-text-muted);
}

.hc-sessions__snippet {
  font-size: 11px;
  color: var(--hc-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hc-sessions__pin-action,
.hc-sessions__actions {
  width: 24px;
  height: 28px;
  opacity: 0;
  padding: 0;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: #8e8e8e;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    opacity 0.12s var(--hc-ease-out, ease-out),
    color 0.12s;
}

.hc-sessions__pin-action {
  grid-column: 2;
  grid-row: 1;
}

.hc-sessions__actions {
  grid-column: 3;
  grid-row: 1;
}
.hc-sessions__pin-action:disabled {
  cursor: default;
}

.hc-sessions__item:hover .hc-sessions__pin-action,
.hc-sessions__item:hover .hc-sessions__actions,
.hc-sessions__item:focus-within .hc-sessions__pin-action,
.hc-sessions__item:focus-within .hc-sessions__actions,
.hc-sessions__item--menu-open .hc-sessions__pin-action,
.hc-sessions__item--menu-open .hc-sessions__actions {
  opacity: 1;
}

.hc-sessions__pin-action:not(:disabled):hover,
.hc-sessions__pin-action:not(:disabled):focus-visible,
.hc-sessions__actions:hover,
.hc-sessions__actions:focus-visible {
  color: var(--hc-text-primary);
  background: transparent;
  outline: none;
}

.hc-sessions__pin-action:focus-visible,
.hc-sessions__actions:focus-visible {
  box-shadow: 0 0 0 2px var(--hc-accent-subtle);
}

.hc-sessions__rename-input {
  display: block;
  width: 100%;
  height: 19.5px;
  box-sizing: border-box;
  font-size: 13px;
  line-height: 17.5px;
  color: var(--hc-text-primary);
  background: var(--hc-bg-input, var(--hc-bg-hover));
  border: 1px solid var(--hc-accent);
  border-radius: 6px;
  padding: 0 5px;
  outline: none;
  box-shadow: 0 0 0 3px var(--hc-accent-subtle);
}

.hc-sessions__empty {
  /* 对齐原型：空态文案在会话列表区域内垂直居中（占满剩余空间） */
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
  text-align: center;
  font-size: 12px;
  color: var(--hc-text-muted);
}

.hc-sessions__load-more {
  /* 对齐原型：「所有会话」入口固定在列表底部 */
  margin: auto 6px 10px;
  padding: 8px 10px;
  border: 1px solid var(--hc-border);
  border-radius: 12px;
  background: transparent;
  color: var(--hc-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.15s,
    border-color 0.15s;
}

.hc-sessions__load-more:hover:not(:disabled) {
  background: color-mix(in srgb, var(--hc-bg-hover) 86%, transparent);
  border-color: color-mix(in srgb, var(--hc-accent) 22%, var(--hc-border));
}

.hc-sessions__load-more:disabled {
  opacity: 0.6;
  cursor: default;
}

@keyframes hc-session-spin {
  to {
    transform: translateY(-50%) rotate(360deg);
  }
}
</style>
