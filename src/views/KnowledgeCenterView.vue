<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { RefreshCw, Upload } from 'lucide-vue-next'
import KnowledgeView from '@/views/KnowledgeView.vue'
import MemoryView from '@/views/MemoryView.vue'
import PageToolbar from '@/components/common/PageToolbar.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import { getNavigationChildren } from '@/config/navigation'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const activeTab = ref(route.path === '/knowledge/memory' ? 'memory' : 'docs')
const knowledgeSearch = ref('')

const segments = computed(() =>
  getNavigationChildren('knowledge').map((tab) => ({
    key: tab.id === 'knowledge-memory' ? 'memory' : 'docs',
    label: t(tab.i18nKey),
  })),
)

watch(() => route.path, (p) => {
  activeTab.value = p === '/knowledge/memory' ? 'memory' : 'docs'
})

watch(activeTab, (tab) => {
  const path = tab === 'memory' ? '/knowledge/memory' : '/knowledge'
  if (route.path !== path) router.replace(path)
})

const knowledgeViewRef = ref<InstanceType<typeof KnowledgeView>>()

function onRebuildIndex() {
  knowledgeViewRef.value?.rebuildAll?.()
}

function onUploadDoc() {
  knowledgeViewRef.value?.openUpload?.()
}
</script>

<template>
  <div class="hc-page-shell">
    <PageToolbar :search-placeholder="t('knowledge.searchPlaceholder', 'Search knowledge...')" @search="knowledgeSearch = $event">
      <template #tabs>
        <SegmentedControl v-model="activeTab" :segments="segments" />
      </template>
      <template #actions>
        <button
          class="hc-btn hc-btn-ghost"
          data-action="rebuild-index"
          @click="onRebuildIndex"
        >
          <RefreshCw :size="14" />
          {{ t('knowledge.rebuildIndex', 'Rebuild Index') }}
        </button>
        <button
          class="hc-btn hc-btn-primary"
          data-action="upload-doc"
          @click="onUploadDoc"
        >
          <Upload :size="14" />
          {{ t('knowledge.uploadDocument', 'Upload Document') }}
        </button>
      </template>
    </PageToolbar>
    <PageHeader
      :eyebrow="t('knowledge.eyebrow', 'knowledge base')"
      :title="t('knowledge.title', 'Knowledge')"
      :description="t('knowledge.description', 'Manage documents and memory for contextual AI responses.')"
    />
    <div class="hc-page-shell__content">
      <KnowledgeView v-if="activeTab === 'docs'" ref="knowledgeViewRef" />
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
