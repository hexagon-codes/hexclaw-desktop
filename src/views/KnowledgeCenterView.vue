<script setup lang="ts">
import { onMounted, ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { FileText } from 'lucide-vue-next'
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

onMounted(async () => {
  try {
    const runtimeConfig = await getRuntimeConfig()
    knowledgeEnabled.value = runtimeConfig.knowledge.enabled !== false
  } catch {
    knowledgeEnabled.value = true
  }
})

function onRebuildIndex() {
  knowledgeViewRef.value?.rebuildAll?.()
}

function onUploadDoc() {
  knowledgeViewRef.value?.openFilePicker?.()
}

function onAddTextDoc() {
  knowledgeViewRef.value?.openUpload?.()
}
</script>

<template>
  <div class="hc-page-shell">
    <PageToolbar
      :search-placeholder="t('knowledge.searchPlaceholder', 'Search knowledge...')"
      @search="knowledgeSearch = $event"
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
      />
      <MemoryView v-else />
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
