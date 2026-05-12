<script setup lang="ts">
/**
 * TimelinePanel — Timeline 面板。
 *
 * 消费 TimelineItemProjection[]，不 import RuntimeEvent。
 * 5-category 过滤器 + category → color 映射在组件内部。
 * 复用 TimelineItem 组件。
 */
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { TimelineItemProjection, TimelineCategory } from '@/types/workspace'
import TimelineItem from '@/components/inspector/TimelineItem.vue'

const { t } = useI18n()

const props = defineProps<{
  items: TimelineItemProjection[]
  taskId: string | null
}>()

// ── category → color（UI theme semantics，不在 projector 中） ──

const CATEGORY_COLORS: Record<TimelineCategory, string> = {
  task: 'var(--hc-accent)',
  skill: '#f59e0b',
  system: '#14b8a6',
  warning: '#f97316',
  output: '#22c55e',
}

// ── filter ────────────────────────────────────────

type FilterValue = TimelineCategory | 'all'

const activeFilter = ref<FilterValue>('all')

const FILTERS: { value: FilterValue; labelKey: string }[] = [
  { value: 'all', labelKey: 'workspace.timeline.filterAll' },
  { value: 'task', labelKey: 'workspace.timeline.filterTask' },
  { value: 'skill', labelKey: 'workspace.timeline.filterSkill' },
  { value: 'system', labelKey: 'workspace.timeline.filterSystem' },
  { value: 'warning', labelKey: 'workspace.timeline.filterWarning' },
  { value: 'output', labelKey: 'workspace.timeline.filterOutput' },
]

const filteredItems = computed(() => {
  if (activeFilter.value === 'all') return props.items
  return props.items.filter(e => e.typeCategory === activeFilter.value)
})
</script>

<template>
  <div class="timeline-panel">
    <!-- Header -->
    <div class="timeline-panel__header">
      <span class="timeline-panel__title">{{ t('workspace.timeline.title') }}</span>
      <span v-if="items.length > 0" class="timeline-panel__count">{{ items.length }}</span>
    </div>

    <!-- Filter chips -->
    <div class="timeline-panel__filters">
      <button
        v-for="filter in FILTERS"
        :key="filter.value"
        class="timeline-panel__filter-chip"
        :class="{ 'timeline-panel__filter-chip--active': activeFilter === filter.value }"
        @click="activeFilter = filter.value"
      >
        {{ t(filter.labelKey) }}
      </button>
    </div>

    <!-- Empty state -->
    <div v-if="!taskId" class="timeline-panel__empty">
      <p>{{ t('workspace.timeline.emptyHint') }}</p>
    </div>
    <div v-else-if="filteredItems.length === 0" class="timeline-panel__empty">
      <p>{{ t('workspace.timeline.empty') }}</p>
    </div>

    <!-- Timeline events -->
    <div v-else class="timeline-panel__events">
      <TimelineItem
        v-for="(item, idx) in filteredItems"
        :key="idx"
        :time="item.time"
        :text="`${t(item.typeLabel)} · ${item.summary}`"
        :dot-color="CATEGORY_COLORS[item.typeCategory]"
      />
    </div>
  </div>
</template>

<style scoped>
.timeline-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
}

.timeline-panel__header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 4px;
}

.timeline-panel__title {
  font-size: 12px;
  font-weight: 600;
  color: var(--hc-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.timeline-panel__count {
  font-size: 10px;
  font-weight: 600;
  color: var(--hc-text-muted);
  background: var(--hc-bg-hover);
  padding: 0 6px;
  border-radius: 100px;
  line-height: 1.6;
}

.timeline-panel__filters {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 4px;
}

.timeline-panel__filter-chip {
  font-size: 11px;
  padding: 2px 8px;
  border: 1px solid var(--hc-border);
  border-radius: 100px;
  background: transparent;
  color: var(--hc-text-secondary);
  cursor: pointer;
  transition: background 0.1s, border-color 0.1s;
}

.timeline-panel__filter-chip:hover {
  border-color: var(--hc-accent-subtle);
}

.timeline-panel__filter-chip--active {
  background: rgba(99, 102, 241, 0.1);
  border-color: var(--hc-accent);
  color: var(--hc-accent);
}

.timeline-panel__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 12px;
}

.timeline-panel__empty p {
  font-size: 12px;
  color: var(--hc-text-muted);
  text-align: center;
  margin: 0;
}

.timeline-panel__events {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 0 4px;
}
</style>
