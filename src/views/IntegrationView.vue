<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Plus, Store, FolderOpen, Link } from 'lucide-vue-next'
import SkillsView from '@/views/SkillsView.vue'
import McpView from '@/views/McpView.vue'
import PromptsView from '@/views/PromptsView.vue'
import PageToolbar from '@/components/common/PageToolbar.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SplitButton, { type SplitButtonItem } from '@/components/common/SplitButton.vue'
import { getNavigationChildren } from '@/config/navigation'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

function resolveTab(path: string): string {
  if (path.startsWith('/integration/mcp')) return 'mcp'
  if (path.startsWith('/integration/prompts')) return 'prompts'
  return 'skills'
}

const activeTab = ref(resolveTab(route.path))
const integrationSearch = ref('')
type CapabilitySearchContext =
  | 'skills-installed'
  | 'skills-marketplace'
  | 'mcp-servers'
  | 'mcp-tools'
  | 'mcp-marketplace'
  | 'prompts'
const activeSearchContext = ref<CapabilitySearchContext>(
  activeTab.value === 'mcp' ? 'mcp-servers' : activeTab.value === 'prompts' ? 'prompts' : 'skills-installed',
)
const tabKeyMap: Record<string, string> = {
  'integration-skills': 'skills',
  'integration-mcp': 'mcp',
  'integration-prompts': 'prompts',
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
  const pathMap: Record<string, string> = { skills: '/integration', mcp: '/integration/mcp', prompts: '/integration/prompts' }
  const target = pathMap[tab] || '/integration'
  if (route.path !== target) router.replace(target)
  activeSearchContext.value =
    tab === 'mcp' ? 'mcp-servers' : tab === 'prompts' ? 'prompts' : 'skills-installed'
})

const skillsViewRef = ref<{ openInstallDialog?: () => void; switchToHub?: () => void; openCreateDialog?: () => void }>()

// 处理来自会话页扣子式技能子菜单的导航意图（?action=skill-install / skill-hub / skill-create）
function handleSkillQueryAction() {
  const action = route.query.action
  if (action !== 'skill-install' && action !== 'skill-hub' && action !== 'skill-create') return
  activeTab.value = 'skills'
  nextTick(() => {
    if (action === 'skill-install') skillsViewRef.value?.openInstallDialog?.()
    else if (action === 'skill-hub') skillsViewRef.value?.switchToHub?.()
    else if (action === 'skill-create') skillsViewRef.value?.openCreateDialog?.()
    // 清除 query，避免刷新/返回时重复触发
    if (route.query.action) router.replace({ path: '/integration' })
  })
}
onMounted(handleSkillQueryAction)
watch(() => route.query.action, () => handleSkillQueryAction())
const mcpViewRef = ref<{ openAddServer?: () => void; switchToMarketplace?: () => void }>()
const promptsViewRef = ref<{ newPrompt?: () => void }>()

// 能力页唯一搜索入口：子视图只声明上下文，输入状态与可见控件均由页面壳层持有。
const searchPlaceholder = computed(() => {
  switch (activeSearchContext.value) {
    case 'skills-marketplace':
      return t('skills.hub.searchPlaceholder', '搜索 ClawHub Skill…')
    case 'mcp-tools':
      return t('mcp.searchTools', '搜索工具…')
    case 'mcp-marketplace':
      return t('mcp.searchMarketplace', '搜索 MCP 服务器…')
    case 'mcp-servers':
      return t('integration.searchMcp', '搜索 MCP…')
    case 'prompts':
      return t('integration.searchPrompts', '搜索 Prompt…')
    default:
      return t('skills.searchPlaceholder', '搜索 Skill…')
  }
})

function setSearchContext(context: CapabilitySearchContext) {
  activeSearchContext.value = context
}

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
      :search-placeholder="searchPlaceholder"
      :search-value="integrationSearch"
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
        <!-- Prompt 库 tab：新建 Prompt（砍薄版后记忆移至「长期记忆」页，此处不再有记忆子 tab）。 -->
        <button
          v-else-if="activeTab === 'prompts'"
          class="hc-btn hc-btn-primary"
          @click="promptsViewRef?.newPrompt?.()"
        >
          <Plus :size="14" />
          {{ t('integration.newPrompt', '新建 Prompt') }}
        </button>
      </template>
    </PageToolbar>
    <div class="hc-page-shell__content">
      <SkillsView
        v-if="activeTab === 'skills'"
        ref="skillsViewRef"
        :embedded-search="integrationSearch"
        :hide-installed-search="true"
        @search-context-change="setSearchContext"
      />
      <McpView
        v-else-if="activeTab === 'mcp'"
        ref="mcpViewRef"
        :embedded-search="integrationSearch"
        @search-context-change="setSearchContext"
      />
      <PromptsView
        v-else-if="activeTab === 'prompts'"
        ref="promptsViewRef"
        :filter="integrationSearch"
      />
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
