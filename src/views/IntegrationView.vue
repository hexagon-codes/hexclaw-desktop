<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Download, Plus } from 'lucide-vue-next'
import { useLogsStore } from '@/stores/logs'
import SkillsView from '@/views/SkillsView.vue'
import McpView from '@/views/McpView.vue'
import PageToolbar from '@/components/common/PageToolbar.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import { getNavigationChildren } from '@/config/navigation'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

function resolveTab(path: string): string {
  if (path.startsWith('/integration/mcp')) return 'mcp'
  if (path.startsWith('/integration/diagnostics')) return 'diagnostics'
  return 'skills'
}

const activeTab = ref(resolveTab(route.path))
const integrationSearch = ref('')
const tabKeyMap: Record<string, string> = {
  'integration-skills': 'skills',
  'integration-mcp': 'mcp',
  'integration-diagnostics': 'diagnostics',
}

const segments = computed(() =>
  getNavigationChildren('integration').map((tab) => ({
    key: tabKeyMap[tab.id] ?? tab.id,
    label: t(tab.i18nKey),
  })),
)

watch(() => route.path, (p) => {
  activeTab.value = resolveTab(p)
})

watch(activeTab, (tab) => {
  const pathMap: Record<string, string> = { skills: '/integration', mcp: '/integration/mcp', diagnostics: '/integration/diagnostics' }
  const target = pathMap[tab] || '/integration'
  if (route.path !== target) router.replace(target)
})

function onExportIntegrationLogs() {
  try {
    const data = JSON.stringify(logsStore.entries, null, 2)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `hexclaw-integration-logs-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    console.error('[IntegrationView] export-logs failed:', e)
  }
}

const logsStore = useLogsStore()

const diagnosticEntries = computed(() =>
  logsStore.entries
    .filter(e => e.level === 'error' || e.level === 'warn')
    .slice(0, 20)
    .map(e => ({
      title: `${e.source || 'system'} · ${e.domain || 'general'}`,
      desc: e.message,
      level: e.level as string,
    })),
)

onMounted(() => {
  if (logsStore.entries.length === 0) logsStore.loadHistory()
})

const skillsViewRef = ref<{ openInstallDialog?: () => void }>()
const mcpViewRef = ref<{ openAddServer?: () => void }>()

function onAddInstance() {
  if (activeTab.value === 'skills') skillsViewRef.value?.openInstallDialog?.()
  else if (activeTab.value === 'mcp') mcpViewRef.value?.openAddServer?.()
}
</script>

<template>
  <div class="hc-page-shell">
    <PageToolbar
      :search-placeholder="activeTab === 'skills' ? t('integration.searchPlaceholder', 'Search skills, MCP servers...') : undefined"
      @search="integrationSearch = $event"
    >
      <template #tabs>
        <SegmentedControl v-model="activeTab" :segments="segments" />
      </template>
      <template #actions>
        <button v-if="activeTab === 'diagnostics'" class="hc-btn hc-btn-ghost" @click="onExportIntegrationLogs">
          <Download :size="14" />
          {{ t('integration.exportLogs', 'Export Logs') }}
        </button>
        <button v-if="activeTab === 'skills'" class="hc-btn hc-btn-primary" @click="onAddInstance">
          <Plus :size="14" />
          {{ t('integration.addInstance', 'Add Instance') }}
        </button>
      </template>
    </PageToolbar>
    <PageHeader
      :eyebrow="t('integration.eyebrow', 'integration')"
      :title="t('integration.title', 'Integrations')"
      :description="t('integration.description', 'Manage skills, MCP servers, and diagnostics.')"
    />
    <div class="hc-page-shell__content">
      <SkillsView
        v-if="activeTab === 'skills'"
        ref="skillsViewRef"
        :embedded-search="integrationSearch"
        :hide-installed-search="true"
      />
      <McpView v-else-if="activeTab === 'mcp'" ref="mcpViewRef" />
      <div v-else-if="activeTab === 'diagnostics'" class="hc-diagnostics">
        <div class="hc-diagnostics__card">
          <div class="hc-diagnostics__title">{{ t('integration.recentFailures', 'Recent Failures') }}</div>
          <div v-if="diagnosticEntries.length > 0" class="hc-diagnostics__list">
            <div v-for="(entry, idx) in diagnosticEntries" :key="idx" class="hc-diagnostics__item">
              <div class="hc-diagnostics__item-title">{{ entry.title }}</div>
              <div class="hc-diagnostics__item-desc">{{ entry.desc }}</div>
              <span
                class="hc-diagnostics__badge"
                :class="entry.level === 'error' ? 'hc-diagnostics__badge--red' : 'hc-diagnostics__badge--amber'"
              >
                {{ entry.level === 'error' ? 'Error' : 'Warning' }}
              </span>
            </div>
          </div>
          <div v-else class="hc-diagnostics__empty">
            {{ t('integration.noDiagnostics', '暂无异常日志') }}
          </div>
        </div>
      </div>
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

.hc-diagnostics {
  padding: 20px;
}

.hc-diagnostics__card {
  border: 1px solid var(--hc-border);
  border-radius: var(--hc-radius-md, 12px);
  background: var(--hc-bg-card);
  padding: 16px;
}

.hc-diagnostics__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--hc-text-primary);
  margin-bottom: 12px;
}

.hc-diagnostics__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.hc-diagnostics__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--hc-radius-sm, 8px);
  background: var(--hc-bg-hover);
}

.hc-diagnostics__item-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-primary);
}

.hc-diagnostics__item-desc {
  flex: 1;
  font-size: 12px;
  color: var(--hc-text-muted);
}

.hc-diagnostics__badge {
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 8px;
  white-space: nowrap;
}

.hc-diagnostics__badge--amber {
  background: rgba(240, 180, 41, 0.16);
  color: #d97706;
}

.hc-diagnostics__badge--green {
  background: rgba(50, 213, 131, 0.14);
  color: #16a34a;
}

.hc-diagnostics__badge--red {
  background: rgba(239, 68, 68, 0.14);
  color: #dc2626;
}

.hc-diagnostics__empty {
  padding: 24px;
  text-align: center;
  font-size: 13px;
  color: var(--hc-text-muted);
}
</style>
