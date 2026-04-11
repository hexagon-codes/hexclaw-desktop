<script setup lang="ts">
import { onMounted, ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Brain, Eraser, FileText } from 'lucide-vue-next'
import KnowledgeView from '@/views/KnowledgeView.vue'
import MemoryView from '@/views/MemoryView.vue'
import PageToolbar from '@/components/common/PageToolbar.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import { getNavigationChildren } from '@/config/navigation'
import { getRuntimeConfig } from '@/api/settings'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const activeTab = ref(route.path === '/knowledge/memory' ? 'memory' : 'docs')
const knowledgeSearch = ref('')
const memorySearch = ref('')
const knowledgeEnabled = ref(true)

const segments = computed(() =>
  getNavigationChildren('knowledge').map((tab) => ({
    key: tab.id === 'knowledge-memory' ? 'memory' : 'docs',
    label: t(tab.i18nKey),
  })),
)

watch(
  () => route.path,
  (p) => {
    activeTab.value = p === '/knowledge/memory' ? 'memory' : 'docs'
  },
)

watch(activeTab, (tab) => {
  const path = tab === 'memory' ? '/knowledge/memory' : '/knowledge'
  if (route.path !== path) router.replace(path)
})

const knowledgeViewRef = ref<InstanceType<typeof KnowledgeView>>()
type MemoryViewExpose = {
  openAddDialog?: () => void
  setToolbarSearch?: (value: string) => void
  submitToolbarSearch?: () => Promise<void> | void
  requestClearAll?: () => void
}

const memoryViewRef = ref<MemoryViewExpose>()

const toolbarSearchPlaceholder = computed(() =>
  activeTab.value === 'memory'
    ? t('memory.searchPlaceholder', 'Search memory...')
    : t('knowledge.documentSearchPlaceholder', 'Search documents...'),
)

const toolbarSearchValue = computed(() =>
  activeTab.value === 'memory' ? memorySearch.value : knowledgeSearch.value,
)

onMounted(async () => {
  try {
    const runtimeConfig = await getRuntimeConfig()
    knowledgeEnabled.value = runtimeConfig.knowledge.enabled !== false
  } catch {
    knowledgeEnabled.value = true
  }
})

function onAddTextDoc() {
  knowledgeViewRef.value?.openUpload?.()
}

function onAddMemory() {
  memoryViewRef.value?.openAddDialog?.()
}

function onToolbarSearch(value: string) {
  if (activeTab.value === 'memory') {
    memorySearch.value = value
    memoryViewRef.value?.setToolbarSearch?.(value)
    return
  }
  knowledgeSearch.value = value
}

function onToolbarSearchSubmit() {
  if (activeTab.value !== 'memory') return
  void memoryViewRef.value?.submitToolbarSearch?.()
}

function onClearMemory() {
  memoryViewRef.value?.requestClearAll?.()
}
</script>

<template>
  <div class="hc-page-shell">
    <PageToolbar
      :search-placeholder="toolbarSearchPlaceholder"
      :search-value="toolbarSearchValue"
      @search="onToolbarSearch"
      @search-submit="onToolbarSearchSubmit"
    >
      <template #tabs>
        <SegmentedControl v-model="activeTab" :segments="segments" />
      </template>
      <template #actions>
        <template v-if="activeTab === 'docs'">
          <button
            class="hc-btn hc-btn-primary"
            :disabled="!knowledgeEnabled"
            :title="!knowledgeEnabled ? t('knowledge.backendDisabled') : undefined"
            @click="onAddTextDoc"
          >
            <FileText :size="14" />
            {{ t('knowledge.addDoc', 'Add Document') }}
          </button>
        </template>
        <template v-else>
          <button
            data-testid="knowledge-clear-memory"
            class="hc-btn hc-btn-ghost hc-toolbar__danger"
            @click="onClearMemory"
          >
            <Eraser :size="14" />
            {{ t('memory.clearAll') }}
          </button>
          <button
            data-testid="knowledge-add-memory"
            class="hc-btn hc-btn-primary"
            @click="onAddMemory"
          >
            <Brain :size="14" />
            {{ t('memory.addMemory') }}
          </button>
        </template>
      </template>
    </PageToolbar>
    <PageHeader
      :eyebrow="t('knowledge.eyebrow', 'knowledge base')"
      :title="t('knowledge.title', 'Knowledge')"
      :description="
        t('knowledge.description', 'Manage documents and memory for contextual AI responses.')
      "
    />
    <div class="hc-page-shell__content">
      <KnowledgeView
        v-if="activeTab === 'docs'"
        ref="knowledgeViewRef"
        :knowledge-enabled="knowledgeEnabled"
        :document-search="knowledgeSearch"
      />
      <MemoryView v-else ref="memoryViewRef" />
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

.hc-toolbar__danger {
  color: var(--hc-error);
  background: transparent;
}

.hc-toolbar__danger:hover {
  color: var(--hc-error);
  background: color-mix(in srgb, var(--hc-error) 10%, transparent);
}
</style>
