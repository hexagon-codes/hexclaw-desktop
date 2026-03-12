<script setup lang="ts">
import { Bot, MessageSquare, Settings, Trash2 } from 'lucide-vue-next'
import type { AgentRole } from '@/api/agents'
import StatusBadge from '@/components/common/StatusBadge.vue'

const props = defineProps<{
  role: AgentRole
}>()

const emit = defineEmits<{
  chat: [role: AgentRole]
  edit: [role: AgentRole]
  delete: [role: AgentRole]
}>()
</script>

<template>
  <div
    class="rounded-xl border p-4 transition-all cursor-pointer hover:border-blue-500/30 group"
    :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
  >
    <div class="flex items-start justify-between mb-3">
      <div class="flex items-center gap-3">
        <div
          class="w-10 h-10 rounded-lg flex items-center justify-center"
          :style="{ background: 'var(--hc-accent)', color: '#fff' }"
        >
          <Bot :size="20" />
        </div>
        <div>
          <div class="font-medium text-sm" :style="{ color: 'var(--hc-text-primary)' }">
            {{ role.display_name || role.name }}
          </div>
          <StatusBadge :status="role.status === 'active' ? 'online' : 'offline'" />
        </div>
      </div>
      <!-- 操作按钮 (悬停显示) -->
      <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          class="p-1.5 rounded-md hover:bg-white/5 transition-colors"
          :style="{ color: 'var(--hc-text-secondary)' }"
          title="聊天"
          @click.stop="emit('chat', role)"
        >
          <MessageSquare :size="14" />
        </button>
        <button
          class="p-1.5 rounded-md hover:bg-white/5 transition-colors"
          :style="{ color: 'var(--hc-text-secondary)' }"
          title="编辑"
          @click.stop="emit('edit', role)"
        >
          <Settings :size="14" />
        </button>
        <button
          class="p-1.5 rounded-md hover:bg-white/5 transition-colors"
          :style="{ color: 'var(--hc-error)' }"
          title="删除"
          @click.stop="emit('delete', role)"
        >
          <Trash2 :size="14" />
        </button>
      </div>
    </div>

    <p
      class="text-xs leading-relaxed line-clamp-2 mb-3"
      :style="{ color: 'var(--hc-text-secondary)' }"
    >
      {{ role.description || '暂无描述' }}
    </p>

    <div class="flex items-center justify-between">
      <div class="flex gap-1 flex-wrap">
        <span
          v-for="tool in (role.tools || []).slice(0, 3)"
          :key="tool"
          class="px-2 py-0.5 rounded text-xs"
          :style="{ background: 'var(--hc-bg-hover)', color: 'var(--hc-text-muted)' }"
        >
          {{ tool }}
        </span>
        <span
          v-if="(role.tools || []).length > 3"
          class="px-2 py-0.5 rounded text-xs"
          :style="{ color: 'var(--hc-text-muted)' }"
        >
          +{{ (role.tools || []).length - 3 }}
        </span>
      </div>
      <span class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">
        {{ role.model || 'default' }}
      </span>
    </div>
  </div>
</template>
