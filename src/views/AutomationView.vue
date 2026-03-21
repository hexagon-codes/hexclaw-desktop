<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { FileInput, Plus, RefreshCw } from 'lucide-vue-next'
import TasksView from '@/views/TasksView.vue'
import CanvasView from '@/views/CanvasView.vue'
import PageToolbar from '@/components/common/PageToolbar.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import { getNavigationChildren } from '@/config/navigation'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const activeTab = ref(route.path.startsWith('/automation/canvas') ? 'canvas' : 'tasks')
const automationSearch = ref('')

const segments = computed(() =>
  getNavigationChildren('automation').map((tab) => ({
    key: tab.id === 'automation-canvas' ? 'canvas' : 'tasks',
    label: t(tab.i18nKey),
  })),
)

watch(() => route.path, (p) => {
  activeTab.value = p.startsWith('/automation/canvas') ? 'canvas' : 'tasks'
})

watch(activeTab, (tab) => {
  const path = tab === 'canvas' ? '/automation/canvas' : '/automation'
  if (route.path !== path) router.replace(path)
})

const tasksViewRef = ref<{ openCreateForm?: () => void; loadJobs?: () => void }>()

async function onImportFlow() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json,.yaml,.yml'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      console.log('[AutomationView] imported flow:', data)
      window.$message?.success?.('Flow imported')
    } catch (e) {
      window.$message?.error?.('Import failed: invalid file')
    }
  }
  input.click()
}

function onRefresh() {
  if (activeTab.value === 'tasks') {
    tasksViewRef.value?.loadJobs?.()
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
