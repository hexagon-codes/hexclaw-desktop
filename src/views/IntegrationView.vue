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
const promptsViewRef = ref<{ newPrompt?: () => void; addMemory?: () => void }>()
// 跟踪 PromptsView 内当前子 tab（由事件驱动，保证响应性）
const promptsSection = ref<'prompts' | 'memories'>('prompts')
watch(activeTab, (tab) => {
  if (tab === 'prompts') promptsSection.value = 'prompts'
})

// 顶栏搜索框 placeholder：3 个子 tab 都显示搜索框，文案按子 tab 区分
const searchPlaceholder = computed(() => {
  if (activeTab.value === 'mcp') return t('integration.searchMcp', '搜索 MCP…')
  if (activeTab.value === 'prompts') return t('integration.searchPrompts', '搜索 Prompt…')
  return t('integration.searchSkills', '搜索 Skill…')
})

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
        <!-- Prompt 库 tab：主操作随子 tab 切换（全部=新建 Prompt / 记忆=添加记忆，对齐原型 tbar in-2） -->
        <button
          v-else-if="activeTab === 'prompts'"
          class="hc-btn hc-btn-primary"
          @click="promptsSection === 'memories' ? promptsViewRef?.addMemory?.() : promptsViewRef?.newPrompt?.()"
        >
          <Plus :size="14" />
          {{ promptsSection === 'memories'
            ? t('memories.addMemory', '添加记忆')
            : t('integration.newPrompt', '新建 Prompt') }}
        </button>
      </template>
    </PageToolbar>
    <div class="hc-page-shell__content">
      <SkillsView
        v-if="activeTab === 'skills'"
        ref="skillsViewRef"
        :embedded-search="integrationSearch"
        :hide-installed-search="true"
      />
      <McpView
        v-else-if="activeTab === 'mcp'"
        ref="mcpViewRef"
        :embedded-search="integrationSearch"
      />
      <PromptsView
        v-else-if="activeTab === 'prompts'"
        ref="promptsViewRef"
        :filter="integrationSearch"
        @section-change="promptsSection = $event"
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
