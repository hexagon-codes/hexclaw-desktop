<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatTime } from '@/utils/time'
import { Trash2, Copy, Pencil, Pin, PinOff, Search, GitBranch } from 'lucide-vue-next'
import { useChatStore } from '@/stores/chat'
import { useAgentsStore } from '@/stores/agents'
import { getSessionAgent } from '@/stores/session-agent-binding'
import { scenarioRegistry } from '@/shell/scenario/registry'
import { listSessions, searchMessages, getSessionBranches, updateSessionTitle as apiUpdateSessionTitle, type SessionMessageSearchResult } from '@/api/chat'
import { setClipboard } from '@/api/desktop'
import ContextMenu from '@/components/common/ContextMenu.vue'
import type { ContextMenuItem } from '@/components/common/ContextMenu.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import type { ChatSession } from '@/types'

const { t } = useI18n()
const chatStore = useChatStore()
const agentsStore = useAgentsStore()
const ctxMenu = ref<InstanceType<typeof ContextMenu>>()
const ctxSessionId = ref<string | null>(null)

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

// 场景实例会话自动置顶：据会话绑定的 agent 是否有场景描述符判定（registry，通用无领域词）。
function isScenarioSession(s: ChatSession): boolean {
  if (!s.agent_name) return false
  const cfg = agentsStore.findAgent(s.agent_name)
  return scenarioRegistry.isScenarioInstance({ agentId: s.agent_name, metadata: cfg?.metadata })
}
// 有效置顶 = 手动置顶 或 场景实例（场景实例常驻顶部）
function isPinnedSession(s: ChatSession): boolean {
  return pinnedIds.value.has(s.id) || isScenarioSession(s)
}

// 会话可读标题：场景会话 title 默认 = 原始 agent id（如 k12-tutor-KKE5v8zQ），家长看不懂。
// 该会话绑定的 Agent 三路解析：localStorage 绑定 > 后端 agent_name > 标题本身即 agent 内部名
// （深链建会话时把标题设为 role=agent 名）。命中且标题未被手动改名时显示 display_name（P0-20260708）。
// 会话绑定的 Agent 三路解析：localStorage 绑定 > 后端 agent_name > 标题即内部名。
function boundAgentOf(s: ChatSession) {
  const raw = (s.title ?? '').trim()
  const boundName = getSessionAgent(s.id) || s.agent_name || raw
  return boundName ? agentsStore.findAgent(boundName) : undefined
}

// 会话列表对齐原型（app.html .cs-item）：智能体会话的身份 = **标题内联 emoji 前缀**（如「🎓 小明的辅导老师
// · 五年级」），而非独立头像框或 meta 里的智能体名。通用会话（无专属 agent avatar）不加前缀。
function sessionTitle(s: ChatSession): string {
  const raw = (s.title ?? '').trim()
  const boundName = getSessionAgent(s.id) || s.agent_name || raw
  const cfg = boundName ? agentsStore.findAgent(boundName) : undefined
  const avatar = (cfg?.metadata?.avatar ?? '').trim()
  const display = (cfg?.display_name ?? '').trim()
  // 标题为空 / 恰为 agent 内部名（未手动改名）→ 显示可读名；改过名则保留自定义标题
  const base = display && (!raw || raw === boundName || raw === cfg?.name)
    ? display
    : raw || t('chat.newSessionDefault')
  // 专属智能体（带 avatar emoji）在标题前内联图标（原型做法）
  return avatar ? `${avatar} ${base}` : base
}

// Filter state（搜索框常驻，无需展开/收起开关）
const filterQuery = ref('')

onMounted(() => {
  try {
    const raw = localStorage.getItem('hexclaw_pinned_sessions')
    if (raw) pinnedIds.value = new Set(JSON.parse(raw))
  } catch { /* ignore */ }
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


const sessionMenuItems = computed<ContextMenuItem[]>(() => {
  const isPinned = ctxSessionId.value ? pinnedIds.value.has(ctxSessionId.value) : false
  return [
    { id: 'pin', label: isPinned ? t('chat.unpin') : t('chat.pin'), icon: isPinned ? PinOff : Pin },
    { id: 'rename', label: t('chat.rename'), icon: Pencil },
    { id: 'copy_title', label: t('chat.copyTitle'), icon: Copy },
    { id: 'branches', label: t('chat.viewBranches', '查看分支'), icon: GitBranch },
    { id: 'sep1', label: '', separator: true },
    { id: 'delete', label: t('chat.deleteSession'), icon: Trash2, danger: true, shortcut: '⌫' },
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
  const pinned = list.filter(s => isPinnedSession(s))
  const unpinned = list.filter(s => !isPinnedSession(s))
  return [...pinned, ...unpinned]
})

type SearchSessionItem = {
  session: ChatSession
  snippet?: string
}

const searchSessionItems = computed<SearchSessionItem[]>(() => {
  const q = filterQuery.value.trim().toLowerCase()
  if (!q) return []

  const sessionMap = new Map(mergedSessions.value.map((session) => [session.id, session]))
  const results = new Map<string, SearchSessionItem>()

  for (const session of mergedSessions.value) {
    if ((session.title || '').toLowerCase().includes(q)) {
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
    buckets[getSessionDateBucket(session.updated_at) as 'today' | 'yesterday' | 'earlier'].push(session)
  }

  if (buckets.today.length > 0) sections.push({ key: 'today', label: t('chat.todaySection'), sessions: buckets.today })
  if (buckets.yesterday.length > 0) sections.push({ key: 'yesterday', label: t('chat.yesterdaySection'), sessions: buckets.yesterday })
  if (buckets.earlier.length > 0) sections.push({ key: 'earlier', label: t('chat.earlierSection'), sessions: buckets.earlier })

  return sections
})

const searchSections = computed<SearchSessionSection[]>(() => {
  if (!filterQuery.value.trim()) return []
  return [{
    key: 'search-results',
    label: t('chat.searchResultsSection'),
    sessions: searchSessionItems.value,
  }]
})

const showEmptyState = computed(() => (
  filterQuery.value.trim()
    ? searchSessionItems.value.length === 0 && !searchingHistory.value
    : sortedSessions.value.length === 0
))

function formatDate(ts: string): string {
  return formatTime(ts, true)
}

function isSessionGenerating(sessionId: string) {
  return chatStore.isSessionStreaming(sessionId)
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
  const session = chatStore.sessions.find(s => s.id === sid) ?? mergedSessions.value.find(s => s.id === sid)
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
  const session = chatStore.sessions.find(s => s.id === sessionId) ?? mergedSessions.value.find(s => s.id === sessionId)
  if (!session) return
  renamingId.value = sessionId
  renameValue.value = session.title || t('chat.newSessionDefault')
  nextTick(() => {
    const input = Array.isArray(renameInputRef.value) ? renameInputRef.value[0] : renameInputRef.value
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
    const session = chatStore.sessions.find(s => s.id === sid) ?? mergedSessions.value.find(s => s.id === sid)
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
  ctxMenu.value?.show(e)
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
      togglePin(sid)
      break
    case 'copy_title': {
      const session = chatStore.sessions.find(s => s.id === sid)
      if (session) {
        try {
          await setClipboard(session.title || t('chat.newSessionDefault'))
        } catch {
          // clipboard access can be unavailable in tests or restricted runtimes
        }
      }
      break
    }
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
    <div class="hc-sessions__search">
      <Search :size="14" class="hc-sessions__search-icon" />
      <input
        v-model="filterQuery"
        class="hc-sessions__search-input"
        :placeholder="t('chat.filterSessions')"
      />
    </div>

    <template v-if="filterQuery.trim()">
      <div v-if="searchingHistory" class="hc-sessions__searching">{{ t('chat.searchingHistory') }}</div>
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
              <input
                v-if="renamingId === item.session.id"
                ref="renameInputRef"
                v-model="renameValue"
                class="hc-sessions__rename-input"
                @blur="commitRename"
                @keydown="handleRenameKeydown"
                @click.stop
              />
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
              <div v-if="renamingId !== item.session.id" class="hc-sessions__meta">
                <span v-if="item.snippet" class="hc-sessions__snippet">{{ formatSearchSnippet(item.snippet) }}</span>
                <span v-else class="hc-sessions__time">{{ formatDate(item.session.updated_at) }}</span>
              </div>
            </div>
            <button
              class="hc-sessions__delete"
              :disabled="deletingSessionIds.has(item.session.id)"
              :title="t('chat.deleteSession')"
              @click.stop="deleteSession(item.session.id)"
            >
              <Trash2 :size="12" />
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
            <input
              v-if="renamingId === session.id"
              ref="renameInputRef"
              v-model="renameValue"
              class="hc-sessions__rename-input"
              @blur="commitRename"
              @keydown="handleRenameKeydown"
              @click.stop
            />
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
            <div v-if="renamingId !== session.id" class="hc-sessions__meta">
              <span class="hc-sessions__time">{{ formatDate(session.updated_at) }}</span>
              <span v-if="session.message_count > 0" class="hc-sessions__count">{{ session.message_count }}</span>
            </div>
          </div>
          <button
            class="hc-sessions__delete"
            :disabled="deletingSessionIds.has(session.id)"
            :title="t('chat.deleteSession')"
            @click.stop="deleteSession(session.id)"
          >
            <Trash2 :size="12" />
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
      {{ loadingMoreSessions ? t('common.loading') : (showAllConversations ? t('chat.loadMoreSessions') : t('chat.allConversations')) }}
    </button>

    <ContextMenu ref="ctxMenu" :items="sessionMenuItems" @select="handleCtxAction" />

    <!-- 分支查看器：右键「查看分支」弹层，点分支即切换（getSessionBranches 消费面） -->
    <Teleport to="body">
      <div
        v-if="branchesFor"
        class="hc-branches__overlay"
        data-testid="branches-dialog"
        @click.self="branchesFor = null"
      >
        <div class="hc-branches__panel" role="dialog" :aria-label="t('chat.branchesTitle', '会话分支')">
          <div class="hc-branches__head">
            <GitBranch :size="14" />
            <b>{{ t('chat.branchesTitle', '会话分支') }}</b>
            <button class="hc-branches__close" :aria-label="t('common.close')" @click="branchesFor = null">✕</button>
          </div>
          <div v-if="branchesLoading" class="hc-branches__muted">{{ t('common.loading') }}</div>
          <div v-else-if="branchesError" class="hc-branches__muted">{{ t('chat.branchesLoadFailed', '分支加载失败') }}</div>
          <div v-else-if="branchesList.length === 0" class="hc-branches__muted" data-testid="branches-empty">
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
              <span class="hc-branches__item-title">{{ b.title || t('chat.newSessionDefault') }}</span>
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

/* 常驻搜索框（对齐原型 .srch） */
.hc-sessions__search {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  margin: 6px 4px 12px;
  padding: 8px 12px;
  border: 0.5px solid var(--hc-border);
  border-radius: 10px;
  background: var(--hc-bg-input, var(--hc-bg-hover));
  transition: border-color 0.15s, box-shadow 0.15s;
}

.hc-sessions__search:focus-within {
  border-color: var(--hc-accent);
  box-shadow: 0 0 0 3px var(--hc-accent-subtle);
}

.hc-sessions__search-icon {
  color: var(--hc-text-muted);
  flex-shrink: 0;
}

.hc-sessions__search-input {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  border: none;
  background: transparent;
  color: var(--hc-text-primary);
  outline: none;
}

.hc-sessions__search-input::placeholder {
  color: var(--hc-text-muted);
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
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  margin-bottom: 1px;
  border-radius: 12px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.hc-sessions__item:hover {
  background: color-mix(in srgb, var(--hc-bg-hover) 88%, transparent);
}

.hc-sessions__item--active {
  /* 选中态对齐原型 .cs-item.on 的精确 token（比旧 accent10% 略实，「你在此」更清晰） */
  background: var(--hc-bg-active);
}

.hc-sessions__content {
  flex: 1;
  min-width: 0;
}

.hc-sessions__title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.hc-sessions__spinner {
  width: 12px;
  height: 12px;
  flex: 0 0 12px;
  border-radius: 999px;
  border: 1.5px solid color-mix(in srgb, var(--hc-text-muted) 28%, transparent);
  border-top-color: var(--hc-accent);
  animation: hc-session-spin 0.85s linear infinite;
}

.hc-sessions__title {
  font-size: 13px;
  font-weight: 500;
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
  position: fixed; inset: 0; z-index: 60;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.45); backdrop-filter: blur(2px);
}
.hc-branches__panel {
  width: min(360px, 90vw); max-height: 60vh; overflow: auto;
  border-radius: 14px; padding: 14px;
  background: var(--hc-bg-elevated); border: 1px solid var(--hc-border);
  box-shadow: var(--hc-shadow-lg, 0 12px 32px rgba(0,0,0,.22));
}
.hc-branches__head {
  display: flex; align-items: center; gap: 7px; margin-bottom: 10px;
  color: var(--hc-text-primary); font-size: 13px;
}
.hc-branches__close {
  margin-inline-start: auto; border: none; background: transparent; cursor: pointer;
  color: var(--hc-text-muted); font-size: 13px; padding: 2px 6px; border-radius: 6px;
}
.hc-branches__close:hover { color: var(--hc-text-primary); background: var(--hc-bg-hover, rgba(127,127,127,.1)); }
.hc-branches__muted { font-size: 12.5px; line-height: 1.6; color: var(--hc-text-muted); padding: 6px 2px; }
.hc-branches__list { display: flex; flex-direction: column; gap: 4px; }
.hc-branches__item {
  display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0;
  padding: 8px 10px; border: none; border-radius: 9px; background: transparent;
  cursor: pointer; text-align: start;
}
.hc-branches__item:hover { background: var(--hc-bg-hover, rgba(127,127,127,.1)); }
.hc-branches__item-icon { flex: 0 0 auto; color: var(--hc-text-muted); }
.hc-branches__item-title {
  flex: 1; min-width: 0; font-size: 13px; color: var(--hc-text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.hc-branches__item-time { flex: 0 0 auto; font-size: 11px; color: var(--hc-text-muted); }

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

.hc-sessions__delete {
  opacity: 0;
  padding: 4px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  display: flex;
  transition: opacity 0.15s, color 0.15s, background 0.15s;
}

.hc-sessions__item:hover .hc-sessions__delete {
  opacity: 1;
}

.hc-sessions__delete:hover {
  color: var(--hc-error);
  background: color-mix(in srgb, var(--hc-error) 10%, transparent);
}

.hc-sessions__rename-input {
  width: 100%;
  font-size: 13px;
  color: var(--hc-text-primary);
  background: var(--hc-bg-input, var(--hc-bg-hover));
  border: 1px solid var(--hc-accent);
  border-radius: 4px;
  padding: 1px 4px;
  outline: none;
}

.hc-sessions__item--pinned {
  background: color-mix(in srgb, var(--hc-bg-hover) 72%, transparent);
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
  transition: background 0.15s, color 0.15s, border-color 0.15s;
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
    transform: rotate(360deg);
  }
}
</style>
