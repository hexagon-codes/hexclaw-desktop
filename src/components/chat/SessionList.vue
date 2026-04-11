<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatTime } from '@/utils/time'
import { Trash2, Copy, Pencil, Pin, PinOff, Search } from 'lucide-vue-next'
import { useChatStore } from '@/stores/chat'
import { listSessions, searchMessages, updateSessionTitle as apiUpdateSessionTitle, type SessionMessageSearchResult } from '@/api/chat'
import { setClipboard } from '@/api/desktop'
import ContextMenu from '@/components/common/ContextMenu.vue'
import type { ContextMenuItem } from '@/components/common/ContextMenu.vue'
import type { ChatSession } from '@/types'

const { t } = useI18n()
const chatStore = useChatStore()
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

// Filter state
const filterQuery = ref('')
const showFilter = ref(false)

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

function toggleFilter() {
  showFilter.value = !showFilter.value
  if (!showFilter.value) {
    filterQuery.value = ''
    contentSearchResults.value = []
  }
}

const sessionMenuItems = computed<ContextMenuItem[]>(() => {
  const isPinned = ctxSessionId.value ? pinnedIds.value.has(ctxSessionId.value) : false
  return [
    { id: 'pin', label: isPinned ? t('chat.unpin') : t('chat.pin'), icon: isPinned ? PinOff : Pin },
    { id: 'rename', label: t('chat.rename'), icon: Pencil },
    { id: 'copy_title', label: t('chat.copyTitle'), icon: Copy },
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
  const pinned = list.filter(s => pinnedIds.value.has(s.id))
  const unpinned = list.filter(s => !pinnedIds.value.has(s.id))
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
    if (pinnedIds.value.has(a.session.id) !== pinnedIds.value.has(b.session.id)) {
      return pinnedIds.value.has(a.session.id) ? -1 : 1
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
  const pinned = sortedSessions.value.filter((s) => pinnedIds.value.has(s.id))
  const unpinned = sortedSessions.value.filter((s) => !pinnedIds.value.has(s.id))

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

async function deleteSession(sessionId: string) {
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
  const session = chatStore.sessions.find(s => s.id === sessionId)
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
    const session = chatStore.sessions.find(s => s.id === sid)
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
    <!-- Filter bar -->
    <div class="hc-sessions__filter-bar">
      <button class="hc-sessions__filter-toggle" :class="{ 'hc-sessions__filter-toggle--active': showFilter }" @click="toggleFilter" :title="t('common.search')">
        <Search :size="13" />
      </button>
      <input
        v-if="showFilter"
        v-model="filterQuery"
        class="hc-sessions__filter-input"
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
              'hc-sessions__item--pinned': pinnedIds.has(item.session.id),
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
                <div class="hc-sessions__title">{{ item.session.title || t('chat.newSessionDefault') }}</div>
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
            'hc-sessions__item--pinned': pinnedIds.has(session.id),
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
              <div class="hc-sessions__title">{{ session.title || t('chat.newSessionDefault') }}</div>
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

.hc-sessions__filter-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 4px 10px;
  flex-shrink: 0;
}

.hc-sessions__filter-toggle {
  padding: 4px;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  border-radius: var(--hc-radius-sm);
  cursor: pointer;
  display: flex;
  transition: background 0.15s;
}

.hc-sessions__filter-toggle:hover,
.hc-sessions__filter-toggle--active {
  background: var(--hc-bg-hover);
  color: var(--hc-text-secondary);
}

.hc-sessions__filter-input {
  flex: 1;
  font-size: 12px;
  padding: 3px 8px;
  border: 1px solid var(--hc-border);
  border-radius: var(--hc-radius-sm);
  background: var(--hc-bg-input, var(--hc-bg-hover));
  color: var(--hc-text-primary);
  outline: none;
}

.hc-sessions__filter-input:focus {
  border-color: var(--hc-accent);
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
  background: color-mix(in srgb, var(--hc-accent) 10%, transparent);
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
  padding: 32px 16px;
  text-align: center;
  font-size: 12px;
  color: var(--hc-text-muted);
}

.hc-sessions__load-more {
  margin: 6px 6px 10px;
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
