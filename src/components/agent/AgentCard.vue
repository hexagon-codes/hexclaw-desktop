<script setup lang="ts">
import { Bot, MessageSquare } from 'lucide-vue-next'
import type { AgentRole } from '@/types'

const props = defineProps<{
  role: AgentRole
}>()

const emit = defineEmits<{
  chat: [role: AgentRole]
}>()
</script>

<template>
  <div
    class="hc-agent-card hc-card hc-card-interactive"
    @click="emit('chat', role)"
  >
    <div class="hc-agent-card__header">
      <div class="hc-agent-card__identity">
        <div class="hc-agent-card__avatar">
          <Bot :size="18" />
        </div>
        <div>
          <div class="hc-agent-card__name">{{ role.title || role.name }}</div>
          <div class="text-xs" style="color: var(--hc-text-muted)">{{ role.name }}</div>
        </div>
      </div>

      <div class="hc-agent-card__actions">
        <button
          class="hc-agent-card__action"
          title="聊天"
          @click.stop="emit('chat', role)"
        >
          <MessageSquare :size="14" />
        </button>
      </div>
    </div>

    <p class="hc-agent-card__desc">{{ role.goal || '暂无描述' }}</p>
  </div>
</template>

<style scoped>
.hc-agent-card {
  padding: 16px;
  cursor: pointer;
}

.hc-agent-card__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 10px;
}

.hc-agent-card__identity {
  display: flex;
  align-items: center;
  gap: 10px;
}

.hc-agent-card__avatar {
  width: 36px;
  height: 36px;
  border-radius: var(--hc-radius-md);
  background: var(--hc-accent);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.hc-agent-card__name {
  font-size: 14px;
  font-weight: 600;
  color: var(--hc-text-primary);
  margin-bottom: 2px;
}

.hc-agent-card__actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
}

.hc-agent-card:hover .hc-agent-card__actions {
  opacity: 1;
}

.hc-agent-card__action {
  padding: 5px;
  border-radius: var(--hc-radius-sm);
  border: none;
  background: transparent;
  color: var(--hc-text-secondary);
  cursor: pointer;
  display: flex;
  transition: background 0.15s, color 0.15s;
}

.hc-agent-card__action:hover {
  background: var(--hc-bg-hover);
}

.hc-agent-card__desc {
  font-size: 13px;
  line-height: 1.5;
  color: var(--hc-text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin: 0;
}
</style>
