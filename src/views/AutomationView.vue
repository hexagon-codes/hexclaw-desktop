<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Plus, RefreshCw } from 'lucide-vue-next'
import TasksView from '@/views/TasksView.vue'
import WebhookPanel from '@/components/automation/WebhookPanel.vue'
import PageToolbar from '@/components/common/PageToolbar.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import { getNavigationChildren } from '@/config/navigation'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

function resolveTab(path: string): 'tasks' | 'webhooks' {
  if (path.startsWith('/automation/webhooks')) return 'webhooks'
  return 'tasks'
}

const automationSearch = ref('')
const tabKeyMap: Record<string, 'tasks' | 'webhooks'> = {
  'automation-tasks': 'tasks',
  'automation-webhooks': 'webhooks',
}

const pathMap: Record<'tasks' | 'webhooks', string> = {
  tasks: '/automation',
  webhooks: '/automation/webhooks',
}

const segments = computed(() =>
  getNavigationChildren('automation').map((tab) => ({
    key: tabKeyMap[tab.id] ?? 'tasks',
    label: t(tab.i18nKey),
  })),
)

const activeTab = computed<'tasks' | 'webhooks'>({
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

async function onRefresh() {
  if (activeTab.value === 'tasks') {
    tasksViewRef.value?.loadJobs?.()
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
      <WebhookPanel v-else ref="webhookPanelRef" />
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
