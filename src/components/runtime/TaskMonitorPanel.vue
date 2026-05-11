<script setup lang="ts">
import { ref, computed } from 'vue'
import type { Component } from 'vue'
import { useTaskStore } from '@/stores/tasks'
import { MessageSquare, Bot, Puzzle, Wrench, GitBranch, Zap, XCircle, ChevronDown } from 'lucide-vue-next'
import EmptyState from '@/components/common/EmptyState.vue'
import type { Task, TaskType } from '@/types'

const taskStore = useTaskStore()

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
  pending: '等待中',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const expandedTaskId = ref<string | null>(null)

function toggleDetail(taskId: string) {
  expandedTaskId.value = expandedTaskId.value === taskId ? null : taskId
}

function getTypeIcon(type: TaskType): Component {
  return TASK_TYPE_ICON[type] || Zap
}

function confirmCancel(taskId: string) {
  if (confirm('确定取消该任务？')) {
    taskStore.cancelTask(taskId)
  }
}

function elapsedSince(iso?: string): string {
  if (!iso) return '-'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 1000) return '刚刚'
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m`
  return `${Math.floor(ms / 3600000)}h`
}
</script>

<template>
  <div class="task-monitor">
    <!-- Active Tasks -->
    <div v-if="taskStore.activeTasks.length > 0" class="task-monitor__section">
      <div class="task-monitor__section-header">
        <span class="task-monitor__section-title">运行中</span>
        <span class="task-monitor__section-count">{{ taskStore.activeTasks.length }}</span>
      </div>
      <div class="task-monitor__list">
        <div
          v-for="task in taskStore.activeTasks"
          :key="task.id"
          class="task-monitor__card"
          :class="{ 'task-monitor__card--expanded': expandedTaskId === task.id }"
        >
          <!-- Card header -->
          <div class="task-monitor__card-header" @click="toggleDetail(task.id)">
            <component :is="getTypeIcon(task.type)" :size="16" class="task-monitor__type-icon" />
            <span class="task-monitor__task-id">{{ task.id.slice(0, 8) }}</span>
            <span
              class="task-monitor__status-badge"
              :style="{ color: STATUS_COLOR[task.status], background: STATUS_BG[task.status] }"
            >
              {{ STATUS_LABEL[task.status] }}
            </span>
            <span class="task-monitor__elapsed">{{ elapsedSince(task.metadata?.startedAt) }}</span>
            <ChevronDown :size="14" class="task-monitor__chevron" :class="{ 'task-monitor__chevron--open': expandedTaskId === task.id }" />
          </div>

          <!-- Progress bar -->
          <div v-if="typeof task.progress === 'number'" class="task-monitor__progress-bar">
            <div class="task-monitor__progress-fill" :style="{ width: `${Math.min(task.progress, 100)}%` }" />
          </div>

          <!-- Detail -->
          <div v-if="expandedTaskId === task.id" class="task-monitor__detail">
            <div class="task-monitor__detail-field">
              <span class="task-monitor__detail-label">Input</span>
              <pre class="task-monitor__detail-value">{{ JSON.stringify(task.input.payload, null, 2) }}</pre>
            </div>
            <div v-if="task.output" class="task-monitor__detail-field">
              <span class="task-monitor__detail-label">Output</span>
              <pre class="task-monitor__detail-value">{{ JSON.stringify(task.output.result, null, 2) }}</pre>
            </div>
            <div v-if="task.error" class="task-monitor__detail-field">
              <span class="task-monitor__detail-label">Error</span>
              <pre class="task-monitor__detail-value task-monitor__detail-value--error">{{ task.error.message }}</pre>
            </div>
            <button class="task-monitor__cancel-btn" @click="confirmCancel(task.id)">
              <XCircle :size="14" />
              取消任务
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Completed Tasks -->
    <div v-if="taskStore.completedTasks.length > 0" class="task-monitor__section">
      <div class="task-monitor__section-header">
        <span class="task-monitor__section-title">已完成</span>
        <span class="task-monitor__section-count">{{ taskStore.completedTasks.length }}</span>
      </div>
      <div class="task-monitor__list">
        <div
          v-for="task in taskStore.completedTasks.slice().reverse()"
          :key="task.id"
          class="task-monitor__card task-monitor__card--completed"
          :class="{ 'task-monitor__card--expanded': expandedTaskId === task.id }"
        >
          <div class="task-monitor__card-header" @click="toggleDetail(task.id)">
            <component :is="getTypeIcon(task.type)" :size="16" class="task-monitor__type-icon" />
            <span class="task-monitor__task-id">{{ task.id.slice(0, 8) }}</span>
            <span
              class="task-monitor__status-badge"
              :style="{ color: STATUS_COLOR[task.status], background: STATUS_BG[task.status] }"
            >
              {{ STATUS_LABEL[task.status] }}
            </span>
            <ChevronDown :size="14" class="task-monitor__chevron" :class="{ 'task-monitor__chevron--open': expandedTaskId === task.id }" />
          </div>

          <div v-if="expandedTaskId === task.id" class="task-monitor__detail">
            <div class="task-monitor__detail-field">
              <span class="task-monitor__detail-label">Input</span>
              <pre class="task-monitor__detail-value">{{ JSON.stringify(task.input.payload, null, 2) }}</pre>
            </div>
            <div v-if="task.output" class="task-monitor__detail-field">
              <span class="task-monitor__detail-label">Output</span>
              <pre class="task-monitor__detail-value">{{ JSON.stringify(task.output.result, null, 2) }}</pre>
            </div>
            <div v-if="task.error" class="task-monitor__detail-field">
              <span class="task-monitor__detail-label">Error</span>
              <pre class="task-monitor__detail-value task-monitor__detail-value--error">{{ task.error.message }}</pre>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Empty State -->
    <EmptyState
      v-if="taskStore.activeTasks.length === 0 && taskStore.completedTasks.length === 0"
      emoji="⚡"
      title="暂无运行中的任务"
      description="发送消息或触发自动化后，任务将显示在此处"
    />
  </div>
</template>

<style scoped>
.task-monitor {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 16px 18px;
}

.task-monitor__section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.task-monitor__section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--hc-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.task-monitor__section-count {
  font-size: 11px;
  font-weight: 600;
  color: var(--hc-text-muted);
  background: var(--hc-bg-hover);
  padding: 1px 7px;
  border-radius: 100px;
  line-height: 1.6;
}

.task-monitor__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.task-monitor__card {
  border: 1px solid var(--hc-border);
  border-radius: var(--hc-radius-lg);
  background: var(--hc-bg-card);
  overflow: hidden;
  transition: border-color 0.15s;
}

.task-monitor__card:hover {
  border-color: var(--hc-accent-subtle);
}

.task-monitor__card--expanded {
  border-color: var(--hc-accent);
}

.task-monitor__card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  cursor: pointer;
  user-select: none;
}

.task-monitor__type-icon {
  color: var(--hc-text-secondary);
  flex-shrink: 0;
}

.task-monitor__task-id {
  font-size: 12px;
  font-family: 'SF Mono', 'Menlo', monospace;
  color: var(--hc-text-muted);
  min-width: 60px;
}

.task-monitor__status-badge {
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 100px;
  line-height: 1.4;
}

.task-monitor__elapsed {
  margin-left: auto;
  font-size: 11px;
  color: var(--hc-text-muted);
  font-variant-numeric: tabular-nums;
}

.task-monitor__chevron {
  color: var(--hc-text-muted);
  transition: transform 0.2s;
  flex-shrink: 0;
}

.task-monitor__chevron--open {
  transform: rotate(180deg);
}

.task-monitor__progress-bar {
  height: 2px;
  background: var(--hc-bg-hover);
  margin: 0 12px 4px;
  border-radius: 2px;
  overflow: hidden;
}

.task-monitor__progress-fill {
  height: 100%;
  background: var(--hc-accent);
  border-radius: 2px;
  transition: width 0.3s ease;
}

.task-monitor__detail {
  border-top: 1px solid var(--hc-divider);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--hc-bg-hover);
}

.task-monitor__detail-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.task-monitor__detail-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--hc-text-muted);
}

.task-monitor__detail-value {
  font-size: 12px;
  font-family: 'SF Mono', 'Menlo', monospace;
  color: var(--hc-text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow-y: auto;
  margin: 0;
  line-height: 1.5;
}

.task-monitor__detail-value--error {
  color: var(--hc-error);
}

.task-monitor__cancel-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: none;
  border-radius: var(--hc-radius-md);
  background: rgba(245, 101, 101, 0.1);
  color: var(--hc-error);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
  align-self: flex-start;
}

.task-monitor__cancel-btn:hover {
  background: rgba(245, 101, 101, 0.2);
}
</style>
