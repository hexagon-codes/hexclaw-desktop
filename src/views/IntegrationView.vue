<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Plus, Store, FolderOpen, Link } from 'lucide-vue-next'
import SkillsView from '@/views/SkillsView.vue'
import McpView from '@/views/McpView.vue'
import PageToolbar from '@/components/common/PageToolbar.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import SplitButton, { type SplitButtonItem } from '@/components/common/SplitButton.vue'
import { getNavigationChildren } from '@/config/navigation'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

function resolveTab(path: string): string {
  if (path.startsWith('/integration/mcp')) return 'mcp'
  return 'skills'
}

const activeTab = ref(resolveTab(route.path))
const integrationSearch = ref('')
const tabKeyMap: Record<string, string> = {
  'integration-skills': 'skills',
  'integration-mcp': 'mcp',
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
  const pathMap: Record<string, string> = { skills: '/integration', mcp: '/integration/mcp' }
  const target = pathMap[tab] || '/integration'
  if (route.path !== target) router.replace(target)
})

const skillsViewRef = ref<{ openInstallDialog?: () => void; switchToHub?: () => void }>()
const mcpViewRef = ref<{ openAddServer?: () => void; switchToMarketplace?: () => void }>()

const splitLabel = computed(() =>
  activeTab.value === 'mcp'
    ? t('mcp.addServer', 'Add Server')
    : t('integration.installSkill', 'Install Skill'),
)

const splitItems = computed<SplitButtonItem[]>(() => {
  if (activeTab.value === 'mcp') {
    return [
      { id: 'manual', label: t('mcp.addServer', 'Add Server'), icon: Plus },
      { id: 'marketplace', label: t('integration.split.browseHub', 'Browse Marketplace'), icon: Store },
    ]
  }
  return [
    { id: 'hub', label: t('integration.split.browseHub', 'Browse Marketplace'), icon: Store },
    { id: 'file', label: t('integration.split.fromFile', 'Install from File'), icon: FolderOpen },
    { id: 'url', label: t('integration.split.fromUrl', 'Install from URL'), icon: Link },
  ]
})

function onSplitMainClick() {
  if (activeTab.value === 'skills') skillsViewRef.value?.switchToHub?.()
  else if (activeTab.value === 'mcp') mcpViewRef.value?.openAddServer?.()
}

function onSplitSelect(id: string) {
  if (activeTab.value === 'skills') {
    if (id === 'hub') skillsViewRef.value?.switchToHub?.()
    else if (id === 'file' || id === 'url') skillsViewRef.value?.openInstallDialog?.()
  } else if (activeTab.value === 'mcp') {
    if (id === 'manual') mcpViewRef.value?.openAddServer?.()
    else if (id === 'marketplace') mcpViewRef.value?.switchToMarketplace?.()
  }
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
        <SplitButton
          v-if="activeTab === 'skills' || activeTab === 'mcp'"
          :label="splitLabel"
          :icon="Plus"
          :items="splitItems"
          @click="onSplitMainClick"
          @select="onSplitSelect"
        />
      </template>
    </PageToolbar>
    <PageHeader
      :eyebrow="t('integration.eyebrow', 'integration')"
      :title="t('integration.title', 'Integrations')"
      :description="t('integration.description', 'Manage skills and MCP servers.')"
    />
    <div class="hc-page-shell__content">
      <SkillsView
        v-if="activeTab === 'skills'"
        ref="skillsViewRef"
        :embedded-search="integrationSearch"
        :hide-installed-search="true"
      />
      <McpView v-else-if="activeTab === 'mcp'" ref="mcpViewRef" />
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
