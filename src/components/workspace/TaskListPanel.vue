<script setup lang="ts">
/**
 * TaskListPanel — Task List 面板。
 *
 * 消费 WorkspaceTaskProjection[]，不 import Runtime store/types。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  MessageSquare, Bot, Puzzle, Wrench, GitBranch, Zap,
} from 'lucide-vue-next'
import type { Component } from 'vue'
import type { WorkspaceTaskProjection } from '@/types/workspace'
import type { TaskType } from '@/types'

const { t } = useI18n()

const props = defineProps<{
  activeTasks: WorkspaceTaskProjection[]
  completedTasks: WorkspaceTaskProjection[]
  selectedTaskId: string | null
}>()

const emit = defineEmits<{
  selectTask: [taskId: string]
}>()

const TASK_TYPE_ICON: Record<TaskType, Component> = {
  chat: MessageSquare,
  agent: Bot,
  skill: Puzzle,
  tool: Wrench,
  workflow: GitBranch,
  automation: Zap,
}

const STATUS_COLOR: Record<string, string> = {
  pending: 'var(--hc-text-muted)',
  running: 'var(--hc-accent)',
  completed: 'var(--hc-success)',
  failed: 'var(--hc-error)',
  cancelled: 'var(--hc-warning)',
}

const STATUS_BG: Record<string, string> = {
  pending: 'var(--hc-bg-hover)',
  running: 'rgba(99, 102, 241, 0.1)',
  completed: 'rgba(50, 213, 131, 0.1)',
  failed: 'rgba(245, 101, 101, 0.1)',
  cancelled: 'rgba(240, 180, 41, 0.1)',
}

const STATUS_LABEL: Record<string, string> = {
  pending: t('tasks.statusPending'),
  running: t('tasks.statusRunning'),
  completed: t('tasks.statusCompleted'),
  failed: t('tasks.statusFailed'),
  cancelled: t('tasks.statusCancelled'),
}

function getTypeIcon(type: TaskType): Component {
  return TASK_TYPE_ICON[type] || Zap
}
</script>

<template>
  <div class="task-list-panel">
    <!-- Active Tasks -->
    <div v-if="activeTasks.length > 0" class="task-list__section">
      <div class="task-list__section-header">
        <span class="task-list__section-title">{{ t('workspace.taskList.active') }}</span>
        <span class="task-list__section-count">{{ activeTasks.length }}</span>
      </div>
      <div class="task-list__items">
        <button
          v-for="task in activeTasks"
          :key="task.taskId"
          class="task-list__item"
          :class="{ 'task-list__item--selected': selectedTaskId === task.taskId }"
          @click="emit('selectTask', task.taskId)"
        >
          <component :is="getTypeIcon(task.taskType)" :size="14" class="task-list__type-icon" />
          <div class="task-list__item-body">
            <span class="task-list__task-id">{{ task.taskId.slice(0, 8) }}</span>
            <span v-if="task.goal" class="task-list__goal">{{ task.goal }}</span>
            <span v-else-if="task.activityState" class="task-list__activity">{{ task.activityState }}</span>
          </div>
          <span
            class="task-list__status"
            :style="{ color: STATUS_COLOR[task.status], background: STATUS_BG[task.status] }"
          >
            {{ STATUS_LABEL[task.status] || task.status }}
          </span>
          <span class="task-list__elapsed">{{ task.elapsed }}</span>
        </button>
      </div>
    </div>

    <!-- Completed Tasks -->
    <div v-if="completedTasks.length > 0" class="task-list__section">
      <div class="task-list__section-header">
        <span class="task-list__section-title">{{ t('workspace.taskList.completed') }}</span>
        <span class="task-list__section-count">{{ completedTasks.length }}</span>
      </div>
      <div class="task-list__items">
        <button
          v-for="task in completedTasks"
          :key="task.taskId"
          class="task-list__item"
          :class="{ 'task-list__item--selected': selectedTaskId === task.taskId }"
          @click="emit('selectTask', task.taskId)"
        >
          <component :is="getTypeIcon(task.taskType)" :size="14" class="task-list__type-icon" />
          <div class="task-list__item-body">
            <span class="task-list__task-id">{{ task.taskId.slice(0, 8) }}</span>
            <span v-if="task.goal" class="task-list__goal">{{ task.goal }}</span>
          </div>
          <span
            class="task-list__status"
            :style="{ color: STATUS_COLOR[task.status], background: STATUS_BG[task.status] }"
          >
            {{ STATUS_LABEL[task.status] || task.status }}
          </span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.task-list-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 12px;
}

.task-list__section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.task-list__section-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 4px 4px;
}

.task-list__section-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--hc-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.task-list__section-count {
  font-size: 10px;
  font-weight: 600;
  color: var(--hc-text-muted);
  background: var(--hc-bg-hover);
  padding: 0 6px;
  border-radius: 100px;
  line-height: 1.6;
}

.task-list__items {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.task-list__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 8px;
  border: none;
  border-radius: var(--hc-radius-md);
  background: transparent;
  cursor: pointer;
  text-align: left;
  width: 100%;
  transition: background 0.1s;
}

.task-list__item:hover {
  background: var(--hc-bg-hover);
}

.task-list__item--selected {
  background: rgba(99, 102, 241, 0.08);
  outline: 1px solid var(--hc-accent-subtle);
}

.task-list__type-icon {
  color: var(--hc-text-secondary);
  flex-shrink: 0;
}

.task-list__item-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.task-list__task-id {
  font-size: 11px;
  font-family: 'SF Mono', 'Menlo', monospace;
  color: var(--hc-text-muted);
}

.task-list__goal {
  font-size: 12px;
  color: var(--hc-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.task-list__activity {
  font-size: 11px;
  color: var(--hc-text-muted);
  font-style: italic;
}

.task-list__status {
  font-size: 10px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 100px;
  line-height: 1.5;
  flex-shrink: 0;
}

.task-list__elapsed {
  font-size: 10px;
  color: var(--hc-text-muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  width: 28px;
  text-align: right;
}
</style>
