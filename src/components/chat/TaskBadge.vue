<script setup lang="ts">
import { useRouter } from 'vue-router'

const props = defineProps<{
  taskId: string
  skillName?: string
  status?: string
  elapsed?: number
}>()

const router = useRouter()
function navigateToWorkspace() {
  router.push({ path: '/workspace', query: { taskId: props.taskId } })
}
</script>

<template>
  <div class="task-badge" @click="navigateToWorkspace">
    <span class="task-badge__icon">&#x2699;</span>
    <span class="task-badge__name">{{ skillName || 'task' }}</span>
    <span v-if="status" class="task-badge__status">{{ status }}</span>
    <span v-if="elapsed" class="task-badge__elapsed">{{ (elapsed / 1000).toFixed(1) }}s</span>
  </div>
</template>

<style scoped>
.task-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 11px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.15s;
}
.task-badge:hover { background: var(--bg-tertiary); }
.task-badge__name { font-weight: 500; }
.task-badge__status {
  font-size: 10px;
  padding: 0 4px;
  background: var(--accent-muted);
  border-radius: 4px;
}
.task-badge__elapsed { font-size: 10px; opacity: 0.7; }
</style>
