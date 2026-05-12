<script setup lang="ts">
/**
 * TimelinePanel — AI Task Narrative Timeline 面板。
 *
 * 默认显示 Narrative 视图（TimelineNarrativeGroup[]）。
 * 保留 raw events 视图作为 toggle 备选。
 * 消费 Projection DTO，不 import RuntimeEvent。
 */
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { TimelineItemProjection, TimelineNarrativeGroup, NarrativePhase } from '@/types/workspace'
import TimelineItem from '@/components/inspector/TimelineItem.vue'

const { t } = useI18n()

const props = defineProps<{
  items: TimelineItemProjection[]
  narrativeItems: TimelineNarrativeGroup[]
  taskId: string | null
}>()

// ── 视图模式 ──────────────────────────────────────

type ViewMode = 'narrative' | 'raw'
const viewMode = ref<ViewMode>('narrative')

// ── Phase → color ────────────────────────────────

const PHASE_COLORS: Record<NarrativePhase, string> = {
  creation: 'var(--hc-accent)',
  preparation: '#a78bfa',
  execution: '#f59e0b',
  completion: 'var(--hc-success)',
  failure: 'var(--hc-error)',
  anomaly: '#f97316',
  maintenance: 'var(--hc-text-muted)',
}

// ── 展开状态（折叠 group 的 expand/collapse） ────

const expandedGroups = ref<Set<string>>(new Set())

function toggleGroup(id: string) {
  if (expandedGroups.value.has(id)) {
    expandedGroups.value.delete(id)
  } else {
    expandedGroups.value.add(id)
  }
}

function isExpanded(id: string): boolean {
  return expandedGroups.value.has(id)
}

// ── duration format（UI 层负责 presentation） ────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`
}
</script>

<template>
  <div class="timeline-panel">
    <!-- Header -->
    <div class="timeline-panel__header">
      <span class="timeline-panel__title">{{ t('workspace.timeline.title') }}</span>
      <span v-if="narrativeItems.length > 0" class="timeline-panel__count">{{ narrativeItems.length }}</span>
    </div>

    <!-- View toggle -->
    <div class="timeline-panel__toggle-row">
      <button
        class="timeline-panel__toggle-btn"
        :class="{ 'timeline-panel__toggle-btn--active': viewMode === 'narrative' }"
        @click="viewMode = 'narrative'"
      >
        {{ t('workspace.timeline.filterAll') }}
      </button>
      <button
        class="timeline-panel__toggle-btn"
        :class="{ 'timeline-panel__toggle-btn--active': viewMode === 'raw' }"
        @click="viewMode = 'raw'"
      >
        {{ t('workspace.narrative.showRaw') }}
      </button>
    </div>

    <!-- Empty state -->
    <div v-if="!taskId" class="timeline-panel__empty">
      <p>{{ t('workspace.timeline.emptyHint') }}</p>
    </div>
    <div
      v-else-if="viewMode === 'narrative' && narrativeItems.length === 0"
      class="timeline-panel__empty"
    >
      <p>{{ t('workspace.timeline.empty') }}</p>
    </div>
    <div
      v-else-if="viewMode === 'raw' && items.length === 0"
      class="timeline-panel__empty"
    >
      <p>{{ t('workspace.timeline.empty') }}</p>
    </div>

    <!-- Narrative view -->
    <div v-else-if="viewMode === 'narrative'" class="timeline-panel__narrative">
      <div
        v-for="group in narrativeItems"
        :key="group.id"
        class="narrative-group"
        :class="{ 'narrative-group--collapsed': group.isCollapsed && !isExpanded(group.id) }"
      >
        <!-- Group header -->
        <div class="narrative-group__header">
          <span
            class="narrative-group__dot"
            :style="{ background: PHASE_COLORS[group.phase] }"
            aria-hidden="true"
          />
          <div class="narrative-group__body">
            <div class="narrative-group__title-row">
              <span class="narrative-group__title">{{ t(group.title) }}</span>
              <span
                v-if="group.durationMs !== undefined"
                class="narrative-group__duration"
              >
                {{ formatDuration(group.durationMs) }}
              </span>
            </div>
            <p v-if="group.description" class="narrative-group__desc">
              {{ group.description }}
            </p>

            <!-- Expanded children -->
            <div
              v-if="group.isCollapsed && isExpanded(group.id)"
              class="narrative-group__children"
            >
              <TimelineItem
                v-for="(child, idx) in group.children"
                :key="idx"
                :time="child.time"
                :text="`${t(child.typeLabel)} · ${child.summary}`"
                :dot-color="PHASE_COLORS[group.phase]"
              />
            </div>
          </div>

          <!-- Expand/collapse button for folded groups -->
          <button
            v-if="group.isCollapsed"
            class="narrative-group__expand-btn"
            @click="toggleGroup(group.id)"
          >
            <span class="narrative-group__expand-chevron" :class="{ 'narrative-group__expand-chevron--open': isExpanded(group.id) }">
              ▶
            </span>
          </button>

          <!-- Event count badge -->
          <span
            v-if="group.eventCount > 1"
            class="narrative-group__badge"
          >
            {{ group.eventCount }}
          </span>
        </div>
      </div>
    </div>

    <!-- Raw events view -->
    <div v-else class="timeline-panel__events">
      <TimelineItem
        v-for="(item, idx) in items"
        :key="idx"
        :time="item.time"
        :text="`${t(item.typeLabel)} · ${item.summary}`"
        :dot-color="'var(--hc-accent)'"
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

.timeline-panel__toggle-row {
  display: flex;
  gap: 4px;
  padding: 0 4px;
}

.timeline-panel__toggle-btn {
  font-size: 11px;
  padding: 2px 8px;
  border: 1px solid var(--hc-border);
  border-radius: 100px;
  background: transparent;
  color: var(--hc-text-secondary);
  cursor: pointer;
  transition: background 0.1s, border-color 0.1s;
}

.timeline-panel__toggle-btn:hover {
  border-color: var(--hc-accent-subtle);
}

.timeline-panel__toggle-btn--active {
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

/* ── Narrative groups ───────────────────────────── */

.timeline-panel__narrative {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 4px;
}

.narrative-group {
  border-radius: 8px;
  padding: 8px 10px;
  transition: background 0.15s;
}

.narrative-group:hover {
  background: var(--hc-bg-hover);
}

.narrative-group--collapsed {
  /* subtle indent hint that it's foldable */
}

.narrative-group__header {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.narrative-group__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-top: 4px;
  flex-shrink: 0;
}

.narrative-group__body {
  min-width: 0;
  flex: 1;
}

.narrative-group__title-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.narrative-group__title {
  font-size: 12px;
  font-weight: 600;
  color: var(--hc-text-primary);
  line-height: 1.4;
}

.narrative-group__duration {
  font-size: 10px;
  color: var(--hc-text-muted);
  white-space: nowrap;
}

.narrative-group__desc {
  margin: 3px 0 0;
  font-size: 11px;
  color: var(--hc-text-secondary);
  line-height: 1.4;
}

.narrative-group__children {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 0.5px solid var(--hc-divider);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.narrative-group__expand-btn {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  border-radius: 4px;
  margin-top: 1px;
}

.narrative-group__expand-btn:hover {
  background: var(--hc-bg-active);
}

.narrative-group__expand-chevron {
  font-size: 7px;
  transition: transform 0.15s;
}

.narrative-group__expand-chevron--open {
  transform: rotate(90deg);
}

.narrative-group__badge {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  color: var(--hc-text-muted);
  background: var(--hc-bg-active);
  padding: 1px 6px;
  border-radius: 100px;
  margin-top: 1px;
}
</style>
