<script setup lang="ts">
import { ref, computed, nextTick, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { MessageSquare, Trash2, Copy, Pencil, Pin, PinOff, Search } from 'lucide-vue-next'
import { useChatStore } from '@/stores/chat'
import { dbUpdateSessionTitle } from '@/db/chat'
import ContextMenu from '@/components/common/ContextMenu.vue'
import type { ContextMenuItem } from '@/components/common/ContextMenu.vue'

const { t } = useI18n()
const chatStore = useChatStore()
const ctxMenu = ref<InstanceType<typeof ContextMenu>>()
const ctxSessionId = ref<string | null>(null)

const renamingId = ref<string | null>(null)
const renameValue = ref('')
const renameInputRef = ref<HTMLInputElement>()

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

const sortedSessions = computed(() => {
  const q = filterQuery.value.trim().toLowerCase()
  let list = chatStore.sessions
  if (q) {
    list = list.filter(s => (s.title || '').toLowerCase().includes(q))
  }
  const pinned = list.filter(s => pinnedIds.value.has(s.id))
  const unpinned = list.filter(s => !pinnedIds.value.has(s.id))
  return [...pinned, ...unpinned]
})

function formatDate(ts: string): string {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function selectSession(sessionId: string) {
  if (renamingId.value) return
  chatStore.selectSession(sessionId)
}

async function deleteSession(sessionId: string) {
  pinnedIds.value.delete(sessionId)
  savePins()
  await chatStore.deleteSession(sessionId)
}

function startRename(sessionId: string) {
  const session = chatStore.sessions.find(s => s.id === sessionId)
  if (!session) return
  renamingId.value = sessionId
  renameValue.value = session.title || t('chat.newSessionDefault')
  nextTick(() => {
    renameInputRef.value?.focus()
    renameInputRef.value?.select()
  })
}

async function commitRename() {
  const sid = renamingId.value
  if (!sid) return
  const newTitle = renameValue.value.trim() || t('chat.newSessionDefault')
  renamingId.value = null
  try {
    await dbUpdateSessionTitle(sid, newTitle)
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
      if (session) navigator.clipboard.writeText(session.title || t('chat.newSessionDefault'))
      break
    }
  }
}
</script>

<template>
  <div class="hc-sessions">
    <!-- Filter bar -->
    <div class="hc-sessions__filter-bar">
      <button class="hc-sessions__filter-toggle" :class="{ 'hc-sessions__filter-toggle--active': showFilter }" @click="showFilter = !showFilter" :title="t('common.search')">
        <Search :size="13" />
      </button>
      <input
        v-if="showFilter"
        v-model="filterQuery"
        class="hc-sessions__filter-input"
        :placeholder="t('chat.filterSessions')"
      />
    </div>

    <!-- Pinned divider -->
    <div v-if="sortedSessions.some(s => pinnedIds.has(s.id)) && sortedSessions.some(s => !pinnedIds.has(s.id))" class="hc-sessions__pin-divider" />

    <div
      v-for="session in sortedSessions"
      :key="session.id"
      class="hc-sessions__item"
      :class="{
        'hc-sessions__item--active': chatStore.currentSessionId === session.id,
        'hc-sessions__item--pinned': pinnedIds.has(session.id),
      }"
      @click="selectSession(session.id)"
      @dblclick.stop="startRename(session.id)"
      @contextmenu="handleContextMenu($event, session.id)"
    >
      <!-- Pin / message icon -->
      <Pin v-if="pinnedIds.has(session.id)" :size="12" class="hc-sessions__pin-icon" />
      <MessageSquare v-else :size="14" class="hc-sessions__icon" />

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
        <div v-else class="hc-sessions__title">{{ session.title || t('chat.newSessionDefault') }}</div>
        <div v-if="renamingId !== session.id" class="hc-sessions__time">{{ formatDate(session.updated_at) }}</div>
      </div>
      <button
        class="hc-sessions__delete"
        :title="t('chat.deleteSession')"
        @click.stop="deleteSession(session.id)"
      >
        <Trash2 :size="12" />
      </button>
    </div>

    <div v-if="sortedSessions.length === 0" class="hc-sessions__empty">
      {{ filterQuery ? t('chat.noFilterResults') : t('chat.noSessions') }}
    </div>

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
  padding: 4px 2px 6px;
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

.hc-sessions__pin-divider {
  height: 1px;
  background: var(--hc-border);
  margin: 4px 8px;
  flex-shrink: 0;
}

.hc-sessions__pin-icon {
  flex-shrink: 0;
  color: var(--hc-accent);
  opacity: 0.7;
  transform: rotate(-45deg);
}

.hc-sessions__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  margin-bottom: 1px;
  border-radius: var(--hc-radius-sm);
  cursor: pointer;
  transition: background 0.15s;
}

.hc-sessions__item:hover {
  background: var(--hc-bg-hover);
}

.hc-sessions__item--active {
  background: var(--hc-bg-active);
}

.hc-sessions__icon {
  flex-shrink: 0;
  color: var(--hc-text-muted);
  opacity: 0.6;
}

.hc-sessions__item--active .hc-sessions__icon {
  color: var(--hc-accent);
  opacity: 1;
}

.hc-sessions__content {
  flex: 1;
  min-width: 0;
}

.hc-sessions__title {
  font-size: 13px;
  color: var(--hc-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hc-sessions__time {
  font-size: 11px;
  color: var(--hc-text-muted);
  margin-top: 1px;
}

.hc-sessions__delete {
  opacity: 0;
  padding: 4px;
  border-radius: var(--hc-radius-sm);
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  display: flex;
  transition: opacity 0.15s, color 0.15s;
}

.hc-sessions__item:hover .hc-sessions__delete {
  opacity: 1;
}

.hc-sessions__delete:hover {
  color: var(--hc-error);
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
  background: var(--hc-bg-hover);
}

.hc-sessions__empty {
  padding: 32px 16px;
  text-align: center;
  font-size: 12px;
  color: var(--hc-text-muted);
}
</style>
