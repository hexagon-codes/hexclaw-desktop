<script setup lang="ts">
import { ref } from 'vue'
import ActivityTimeline from '@/components/chat/ActivityTimeline.vue'
import type { ActivityTimelineItem } from '@/components/chat/activity-timeline'

const props = withDefaults(
  defineProps<{
    state: 'running' | 'completed'
    summary: string
    ariaLabel: string
    items: ActivityTimelineItem[]
    /** Presentation only: callers may reveal the existing shared timeline on first render. */
    initiallyExpanded?: boolean
  }>(),
  { initiallyExpanded: false },
)

const emit = defineEmits<{
  viewResult: []
}>()

const expanded = ref(props.initiallyExpanded)
</script>

<template>
  <section class="k12-task-progress" :data-task-state="state" :aria-label="ariaLabel">
    <div class="k12-task-progress__header">
      <span class="k12-task-progress__summary" data-testid="task-progress-summary">
        {{ summary }}
      </span>
      <button
        v-if="items.length"
        class="k12-task-progress__disclosure"
        data-testid="task-progress-disclosure"
        type="button"
        :aria-expanded="expanded"
        :aria-label="expanded ? '收起处理详情' : '展开处理详情'"
        @click="expanded = !expanded"
      >
        <svg viewBox="0 0 20 20" aria-hidden="true" :class="{ 'is-expanded': expanded }">
          <path d="m6 8 4 4 4-4" />
        </svg>
      </button>
    </div>

    <div v-if="expanded && items.length" class="k12-task-progress__timeline">
      <ActivityTimeline :items="items" :layout="state === 'running' ? 'branch-grid' : 'stacked'" />
    </div>

    <button
      v-if="state === 'completed'"
      class="k12-task-progress__result"
      data-testid="task-progress-result"
      type="button"
      @click="emit('viewResult')"
    >
      查看结果 ›
    </button>
  </section>
</template>

<style scoped>
.k12-task-progress {
  display: grid;
  gap: 9px;
  padding: 10px 11px;
  border: 1px solid var(--hc-border);
  border-radius: 11px;
  background: var(--hc-bg-card);
}

.k12-task-progress__header {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.k12-task-progress__summary {
  min-width: 0;
  flex: 1;
  color: var(--hc-text-primary);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
}

.k12-task-progress__disclosure {
  display: grid;
  width: 24px;
  height: 24px;
  flex: none;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
}

.k12-task-progress__disclosure:hover,
.k12-task-progress__disclosure:focus-visible {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}

.k12-task-progress__disclosure svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.8;
  transition: transform 0.15s ease;
}

.k12-task-progress__disclosure svg.is-expanded {
  transform: rotate(180deg);
}

.k12-task-progress__timeline {
  padding-top: 9px;
  border-top: 1px solid var(--hc-divider);
}

.k12-task-progress__result {
  justify-self: start;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--hc-accent);
  cursor: pointer;
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
}

@media (prefers-reduced-motion: reduce) {
  .k12-task-progress__disclosure svg {
    transition: none;
  }
}
</style>
