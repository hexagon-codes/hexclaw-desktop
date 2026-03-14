<script setup lang="ts">
import { ref } from 'vue'
import { MessageSquare, Trash2, Copy, Pencil } from 'lucide-vue-next'
import { useChatStore } from '@/stores/chat'
import ContextMenu from '@/components/common/ContextMenu.vue'
import type { ContextMenuItem } from '@/components/common/ContextMenu.vue'

const chatStore = useChatStore()
const ctxMenu = ref<InstanceType<typeof ContextMenu>>()
const ctxSessionId = ref<string | null>(null)

const sessionMenuItems: ContextMenuItem[] = [
  { id: 'rename', label: '重命名', icon: Pencil },
  { id: 'copy_title', label: '复制标题', icon: Copy },
  { id: 'sep1', label: '', separator: true },
  { id: 'delete', label: '删除会话', icon: Trash2, danger: true, shortcut: '⌫' },
]

function formatDate(ts: string): string {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function selectSession(sessionId: string) {
  chatStore.selectSession(sessionId)
}

async function deleteSession(sessionId: string) {
  await chatStore.deleteSession(sessionId)
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
    case 'copy_title': {
      const session = chatStore.sessions.find(s => s.id === sid)
      if (session) navigator.clipboard.writeText(session.title || '新对话')
      break
    }
  }
}
</script>

<template>
  <div class="hc-sessions">
    <div
      v-for="session in chatStore.sessions"
      :key="session.id"
      class="hc-sessions__item"
      :class="{ 'hc-sessions__item--active': chatStore.currentSessionId === session.id }"
      @click="selectSession(session.id)"
      @contextmenu="handleContextMenu($event, session.id)"
    >
      <MessageSquare :size="14" class="hc-sessions__icon" />
      <div class="hc-sessions__content">
        <div class="hc-sessions__title">{{ session.title || '新对话' }}</div>
        <div class="hc-sessions__time">{{ formatDate(session.updated_at) }}</div>
      </div>
      <button
        class="hc-sessions__delete"
        title="删除会话"
        @click.stop="deleteSession(session.id)"
      >
        <Trash2 :size="12" />
      </button>
    </div>

    <div v-if="chatStore.sessions.length === 0" class="hc-sessions__empty">
      暂无会话
    </div>

    <ContextMenu ref="ctxMenu" :items="sessionMenuItems" @select="handleCtxAction" />
  </div>
</template>

<style scoped>
.hc-sessions {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px;
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

.hc-sessions__empty {
  padding: 32px 16px;
  text-align: center;
  font-size: 12px;
  color: var(--hc-text-muted);
}
</style>
