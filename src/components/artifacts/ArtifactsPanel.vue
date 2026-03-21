<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, FileCode, Eye, GitCompareArrows, Code2 } from 'lucide-vue-next'
import type { Artifact } from '@/types'
import ArtifactCodeView from './ArtifactCodeView.vue'
import ArtifactPreview from './ArtifactPreview.vue'
import ArtifactDiffView from './ArtifactDiffView.vue'

const { t } = useI18n()

const props = defineProps<{
  artifacts: Artifact[]
  selectedId: string | null
}>()

const emit = defineEmits<{
  close: []
  select: [id: string]
}>()

type TabKey = 'list' | 'code' | 'preview' | 'diff'
const activeTab = ref<TabKey>('list')

const selectedArtifact = computed(() =>
  props.artifacts.find((a) => a.id === props.selectedId) ?? null,
)

const tabs = computed(() => {
  const base = [
    { key: 'list' as TabKey, icon: FileCode, label: t('chat.artifacts') },
    { key: 'code' as TabKey, icon: Code2, label: 'Code' },
  ]
  if (selectedArtifact.value?.type === 'html') {
    base.push({ key: 'preview' as TabKey, icon: Eye, label: 'Preview' })
  }
  if (selectedArtifact.value?.previousContent) {
    base.push({ key: 'diff' as TabKey, icon: GitCompareArrows, label: 'Diff' })
  }
  return base
})

function handleSelect(id: string) {
  emit('select', id)
  activeTab.value = 'code'
}

function typeLabel(type: string) {
  const map: Record<string, string> = { code: 'Code', html: 'HTML', file: 'File', markdown: 'MD' }
  return map[type] || type
}
</script>

<template>
  <div class="hc-artifacts">
    <!-- Header -->
    <div class="hc-artifacts__header">
      <div class="hc-artifacts__tabs">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          class="hc-artifacts__tab"
          :class="{ 'hc-artifacts__tab--active': activeTab === tab.key }"
          @click="activeTab = tab.key"
        >
          <component :is="tab.icon" :size="13" />
          {{ tab.label }}
        </button>
      </div>
      <button class="hc-artifacts__close" @click="emit('close')">
        <X :size="14" />
      </button>
    </div>

    <!-- Content -->
    <div class="hc-artifacts__body">
      <!-- List tab -->
      <div v-if="activeTab === 'list'" class="hc-artifacts__list">
        <div v-if="artifacts.length === 0" class="hc-artifacts__empty">
          <FileCode :size="28" class="hc-artifacts__empty-icon" />
          <p>{{ t('chat.artifactsEmpty') }}</p>
          <p class="hc-artifacts__empty-hint">{{ t('chat.artifactsHint') }}</p>
        </div>
        <button
          v-for="art in artifacts"
          :key="art.id"
          class="hc-artifacts__item"
          :class="{ 'hc-artifacts__item--active': selectedId === art.id }"
          @click="handleSelect(art.id)"
        >
          <div class="hc-artifacts__item-info">
            <span class="hc-artifacts__item-title">{{ art.title }}</span>
            <span class="hc-artifacts__item-meta">{{ art.language || typeLabel(art.type) }}</span>
          </div>
          <span class="hc-artifacts__item-badge">{{ typeLabel(art.type) }}</span>
        </button>
      </div>

      <!-- Code tab -->
      <div v-else-if="activeTab === 'code'" class="hc-artifacts__detail">
        <ArtifactCodeView v-if="selectedArtifact" :artifact="selectedArtifact" />
        <div v-else class="hc-artifacts__empty">
          <p>{{ t('chat.selectArtifact') }}</p>
        </div>
      </div>

      <!-- Preview tab -->
      <div v-else-if="activeTab === 'preview'" class="hc-artifacts__detail hc-artifacts__detail--full">
        <ArtifactPreview v-if="selectedArtifact" :artifact="selectedArtifact" />
      </div>

      <!-- Diff tab -->
      <div v-else-if="activeTab === 'diff'" class="hc-artifacts__detail">
        <ArtifactDiffView v-if="selectedArtifact" :artifact="selectedArtifact" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.hc-artifacts {
  width: 380px;
  flex-shrink: 0;
  border-left: 1px solid var(--hc-border-subtle);
  background: var(--hc-bg-sidebar);
  display: flex;
  flex-direction: column;
  animation: hc-slide-in 0.2s ease-out;
}

@keyframes hc-slide-in {
  from { transform: translateX(20px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}

.hc-artifacts__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--hc-border-subtle);
  gap: 4px;
}

.hc-artifacts__tabs {
  display: flex;
  gap: 2px;
}

.hc-artifacts__tab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: var(--hc-radius-sm);
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.hc-artifacts__tab:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-secondary);
}

.hc-artifacts__tab--active {
  background: var(--hc-bg-active);
  color: var(--hc-text-primary);
  font-weight: 500;
}

.hc-artifacts__close {
  padding: 4px;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  border-radius: var(--hc-radius-sm);
  display: flex;
}

.hc-artifacts__close:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}

.hc-artifacts__body {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

/* List */
.hc-artifacts__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.hc-artifacts__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: var(--hc-radius-sm);
  border: 1px solid transparent;
  background: var(--hc-bg-card);
  cursor: pointer;
  text-align: left;
  transition: all 0.15s;
  width: 100%;
}

.hc-artifacts__item:hover {
  border-color: var(--hc-accent-subtle);
}

.hc-artifacts__item--active {
  border-color: var(--hc-accent);
  background: var(--hc-accent-subtle);
}

.hc-artifacts__item-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.hc-artifacts__item-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--hc-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hc-artifacts__item-meta {
  font-size: 11px;
  color: var(--hc-text-muted);
}

.hc-artifacts__item-badge {
  font-size: 10px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 3px;
  color: var(--hc-accent);
  background: var(--hc-accent-subtle);
  flex-shrink: 0;
}

/* Detail */
.hc-artifacts__detail {
  height: 100%;
}

.hc-artifacts__detail--full {
  display: flex;
  flex-direction: column;
}

/* Empty */
.hc-artifacts__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 16px;
  text-align: center;
  color: var(--hc-text-muted);
  font-size: 13px;
}

.hc-artifacts__empty-icon {
  opacity: 0.3;
  margin-bottom: 8px;
}

.hc-artifacts__empty-hint {
  font-size: 12px;
  margin-top: 2px;
}
</style>
