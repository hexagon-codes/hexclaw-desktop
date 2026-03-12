<script setup lang="ts">
import { computed } from 'vue'
import { MessageSquare, Trash2 } from 'lucide-vue-next'
import { useChatStore } from '@/stores/chat'

const chatStore = useChatStore()

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
</script>

<template>
  <div class="flex-1 overflow-y-auto">
    <div
      v-for="session in chatStore.sessions"
      :key="session.id"
      class="group flex items-center gap-2 px-3 py-2.5 mx-2 mb-0.5 rounded-lg cursor-pointer transition-colors"
      :style="{
        background: chatStore.currentSessionId === session.id ? 'var(--hc-bg-hover)' : 'transparent',
      }"
      @click="selectSession(session.id)"
    >
      <MessageSquare :size="14" class="flex-shrink-0" :style="{ color: 'var(--hc-text-muted)' }" />
      <div class="flex-1 min-w-0">
        <div class="text-sm truncate" :style="{ color: 'var(--hc-text-primary)' }">
          {{ session.title || '新对话' }}
        </div>
        <div class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">
          {{ formatDate(session.updated_at) }}
        </div>
      </div>
      <button
        class="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-white/5 transition-all"
        :style="{ color: 'var(--hc-text-muted)' }"
        title="删除会话"
        @click.stop="deleteSession(session.id)"
      >
        <Trash2 :size="12" />
      </button>
    </div>

    <div v-if="chatStore.sessions.length === 0" class="px-4 py-8 text-center">
      <p class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">暂无会话</p>
    </div>
  </div>
</template>
