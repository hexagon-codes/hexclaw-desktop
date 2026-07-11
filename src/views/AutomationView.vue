<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Plus, RefreshCw } from 'lucide-vue-next'
import TasksView from '@/views/TasksView.vue'
import WebhookPanel from '@/components/automation/WebhookPanel.vue'
import WorkflowPanel from '@/components/automation/WorkflowPanel.vue'
import PageToolbar from '@/components/common/PageToolbar.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import { getNavigationChildren } from '@/config/navigation'

type AutomationTab = 'tasks' | 'webhooks' | 'workflows'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

function resolveTab(path: string): AutomationTab {
  if (path.startsWith('/automation/webhooks')) return 'webhooks'
  if (path.startsWith('/automation/workflows')) return 'workflows'
  return 'tasks'
}

const automationSearch = ref('')
const tabKeyMap: Record<string, AutomationTab> = {
  'automation-tasks': 'tasks',
  'automation-webhooks': 'webhooks',
  'automation-workflows': 'workflows',
}

const pathMap: Record<AutomationTab, string> = {
  tasks: '/automation',
  webhooks: '/automation/webhooks',
  workflows: '/automation/workflows',
}

const segments = computed(() =>
  getNavigationChildren('automation').map((tab) => ({
    key: tabKeyMap[tab.id] ?? 'tasks',
    label: t(tab.i18nKey),
  })),
)

const activeTab = computed<AutomationTab>({
  get: () => resolveTab(route.path),
  set(tab) {
    const target = pathMap[tab]
    if (route.path !== target) {
      router.replace(target)
    }
  },
})

const tasksViewRef = ref<{ openCreateForm?: () => void; loadJobs?: () => void }>()
const webhookPanelRef = ref<{ loadWebhooks?: () => void; openCreateForm?: () => void }>()
const workflowPanelRef = ref<{ loadWorkflows?: () => void; createWorkflow?: () => void }>()

async function onRefresh() {
  if (activeTab.value === 'tasks') {
    tasksViewRef.value?.loadJobs?.()
  } else if (activeTab.value === 'workflows') {
    workflowPanelRef.value?.loadWorkflows?.()
  } else {
    await webhookPanelRef.value?.loadWebhooks?.()
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

// 顶栏主按钮：按 tab 切换文案 + 入口（锚点 prototype au-0/au-1/au-2）
const primaryActionLabel = computed(() => {
  if (activeTab.value === 'webhooks') return t('automation.newWebhook', 'New Webhook')
  if (activeTab.value === 'workflows') return t('automation.newWorkflow', 'New Workflow')
  return t('automation.newTask', 'New Task')
})

function onPrimaryAction() {
  if (activeTab.value === 'webhooks') {
    webhookPanelRef.value?.openCreateForm?.()
  } else if (activeTab.value === 'workflows') {
    workflowPanelRef.value?.createWorkflow?.()
  } else {
    void onNewTask()
  }
}
</script>

<template>
  <div class="hc-page-shell">
    <PageToolbar :search-placeholder="t('automation.searchPlaceholder')" @search="automationSearch = $event">
      <template #tabs>
        <SegmentedControl v-model="activeTab" :segments="segments" />
      </template>
      <template #actions>
        <!-- 刷新图标按钮（真功能，按 activeTab 分别刷新任务/Webhook/工作流；原型 au-0 仅示意 icbtn） -->
        <button
          class="hc-btn hc-btn-ghost"
          @click="onRefresh"
          :title="t('common.refresh', 'Refresh')"
        >
          <RefreshCw :size="14" />
        </button>
        <!-- 主按钮按 tab 切换文案：新建任务 / 新建 Webhook / 新建工作流（锚点 prototype au-0/1/2） -->
        <button class="hc-btn hc-btn-primary" @click="onPrimaryAction">
          <Plus :size="14" />
          {{ primaryActionLabel }}
        </button>
      </template>
    </PageToolbar>
    <div class="hc-page-shell__content">
      <TasksView v-if="activeTab === 'tasks'" ref="tasksViewRef" :search="automationSearch" />
      <WorkflowPanel v-else-if="activeTab === 'workflows'" ref="workflowPanelRef" :search="automationSearch" />
      <WebhookPanel v-else ref="webhookPanelRef" :search="automationSearch" />
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
