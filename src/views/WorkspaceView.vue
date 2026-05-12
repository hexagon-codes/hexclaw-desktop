<script setup lang="ts">
/**
 * WorkspaceView — Task-first Workspace 三面板布局。
 *
 * 不 import RuntimeContext / RuntimeEvent / useRuntimeStore。
 * 所有数据通过 useWorkspace composable + Projection DTO 消费。
 */
import { useWorkspace } from '@/composables/useWorkspace'
import TaskListPanel from '@/components/workspace/TaskListPanel.vue'
import ContextDetailPanel from '@/components/workspace/ContextDetailPanel.vue'
import TimelinePanel from '@/components/workspace/TimelinePanel.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const {
  activeProjections,
  completedProjections,
  selectedTaskId,
  selectedContextProjection,
  selectedTimelineProjection,
  selectedNarrativeProjection,
  selectedResultProjection,
  selectTask,
  activeCount,
} = useWorkspace()
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <PageHeader :title="t('workspace.title')" :description="t('workspace.description')" />

    <!-- Empty State: no tasks at all -->
    <div
      v-if="activeProjections.length === 0 && completedProjections.length === 0"
      class="flex-1 flex items-center justify-center"
    >
      <EmptyState
        emoji="⚡"
        :title="t('workspace.emptyTitle')"
        :description="t('workspace.emptyDesc')"
      />
    </div>

    <!-- Three-panel layout -->
    <div v-else class="workspace-layout">
      <!-- Left: Task List -->
      <aside class="workspace-panel workspace-panel--left">
        <TaskListPanel
          :active-tasks="activeProjections"
          :completed-tasks="completedProjections"
          :selected-task-id="selectedTaskId"
          @select-task="selectTask"
        />
      </aside>

      <!-- Center: Context Detail -->
      <main class="workspace-panel workspace-panel--center">
        <ContextDetailPanel
          :projection="selectedContextProjection"
          :result-projection="selectedResultProjection"
        />
      </main>

      <!-- Right: Timeline -->
      <aside class="workspace-panel workspace-panel--right">
        <TimelinePanel
          :items="selectedTimelineProjection"
          :narrative-items="selectedNarrativeProjection"
          :task-id="selectedTaskId"
        />
      </aside>
    </div>
  </div>
</template>

<style scoped>
.workspace-layout {
  flex: 1;
  display: flex;
  overflow: hidden;
  min-height: 0;
}

.workspace-panel {
  overflow-y: auto;
}

.workspace-panel--left {
  width: 280px;
  flex-shrink: 0;
  border-right: 1px solid var(--hc-divider);
}

.workspace-panel--center {
  flex: 1;
  min-width: 0;
}

.workspace-panel--right {
  width: 320px;
  flex-shrink: 0;
  border-left: 1px solid var(--hc-divider);
}
</style>
