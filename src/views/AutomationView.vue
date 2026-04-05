<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { FileInput, Plus, RefreshCw } from 'lucide-vue-next'
import TasksView from '@/views/TasksView.vue'
import CanvasView from '@/views/CanvasView.vue'
import WebhookPanel from '@/components/automation/WebhookPanel.vue'
import PageToolbar from '@/components/common/PageToolbar.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import { getNavigationChildren } from '@/config/navigation'
import { useCanvasStore } from '@/stores/canvas'
import { useToast } from '@/composables/useToast'
import type { Workflow } from '@/types'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const canvasStore = useCanvasStore()
const toast = useToast()

function resolveTab(path: string): 'tasks' | 'canvas' | 'webhooks' {
  if (path.startsWith('/automation/canvas')) return 'canvas'
  if (path.startsWith('/automation/webhooks')) return 'webhooks'
  return 'tasks'
}

const automationSearch = ref('')
const tabKeyMap: Record<string, 'tasks' | 'canvas' | 'webhooks'> = {
  'automation-tasks': 'tasks',
  'automation-canvas': 'canvas',
  'automation-webhooks': 'webhooks',
}

const pathMap: Record<'tasks' | 'canvas' | 'webhooks', string> = {
  tasks: '/automation',
  canvas: '/automation/canvas',
  webhooks: '/automation/webhooks',
}

const segments = computed(() =>
  getNavigationChildren('automation').map((tab) => ({
    key: tabKeyMap[tab.id] ?? 'tasks',
    label: t(tab.i18nKey),
  })),
)

const activeTab = computed<'tasks' | 'canvas' | 'webhooks'>({
  get: () => resolveTab(route.path),
  set(tab) {
    const target = pathMap[tab]
    if (route.path !== target) {
      router.replace(target)
    }
  },
})

const tasksViewRef = ref<{ openCreateForm?: () => void; loadJobs?: () => void }>()
const webhookPanelRef = ref<{ loadWebhooks?: () => void }>()

async function onImportFlow() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const data = JSON.parse(text)

      if (!data.nodes || !Array.isArray(data.nodes)) {
        toast.error(t('automation.importInvalid', 'Invalid workflow file: missing nodes'))
        return
      }

      const importedWorkflow: Workflow = {
        id: data.id || `imported-${Date.now()}`,
        name: data.name || file.name.replace(/\.json$/, ''),
        description: data.description || '',
        nodes: data.nodes,
        edges: data.edges || [],
        created_at: data.created_at || new Date().toISOString(),
        updated_at: data.updated_at || new Date().toISOString(),
      }

      canvasStore.loadWorkflowToCanvas(importedWorkflow)

      if (activeTab.value !== 'canvas') {
        activeTab.value = 'canvas'
      }
      toast.success(t('automation.importSuccess', 'Workflow imported'))
    } catch {
      toast.error(t('automation.importFailed', 'Import failed: invalid JSON'))
    }
  }
  input.click()
}

async function onRefresh() {
  if (activeTab.value === 'tasks') {
    tasksViewRef.value?.loadJobs?.()
  } else if (activeTab.value === 'webhooks') {
    await webhookPanelRef.value?.loadWebhooks?.()
  } else {
    await canvasStore.loadWorkflows()
  }
}

async function onNewTask() {
  if (activeTab.value !== 'tasks') {
    activeTab.value = 'tasks'
    await nextTick()
  }
  await nextTick()
  tasksViewRef.value?.openCreateForm?.()
}
</script>

<template>
  <div class="hc-page-shell">
    <PageToolbar :search-placeholder="t('automation.searchPlaceholder', 'Search jobs, schedules, and workflow nodes')" @search="automationSearch = $event">
      <template #tabs>
        <SegmentedControl v-model="activeTab" :segments="segments" />
      </template>
      <template #actions>
        <button class="hc-btn hc-btn-ghost" @click="onRefresh" :title="t('common.refresh', 'Refresh')">
          <RefreshCw :size="14" />
        </button>
        <button class="hc-btn hc-btn-ghost" @click="onImportFlow">
          <FileInput :size="14" />
          {{ t('automation.importFlow', 'Import Flow') }}
        </button>
        <button class="hc-btn hc-btn-primary" @click="onNewTask">
          <Plus :size="14" />
          {{ t('automation.newTask', 'New Task') }}
        </button>
      </template>
    </PageToolbar>
    <PageHeader
      :eyebrow="t('automation.eyebrow', 'automation')"
      :title="t('automation.title', 'Automation')"
      :description="t('automation.description', 'Schedule tasks and build visual workflows.')"
    />
    <div class="hc-page-shell__content">
      <TasksView v-if="activeTab === 'tasks'" ref="tasksViewRef" />
      <WebhookPanel v-else-if="activeTab === 'webhooks'" ref="webhookPanelRef" />
      <CanvasView v-else />
    </div>
  </div>
</template>

<style scoped>
.hc-page-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.hc-page-shell__content {
  flex: 1;
  overflow: auto;
}
</style>
