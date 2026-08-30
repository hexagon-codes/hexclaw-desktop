<script setup lang="ts">
import { ref } from 'vue'
import ActivityTimeline from '@/components/chat/ActivityTimeline.vue'
import HcDisclosureButton from '@/components/common/HcDisclosureButton.vue'
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

const expanded = ref(props.initiallyExpanded)
</script>

<template>
  <section class="k12-task-progress" :data-task-state="state" :aria-label="ariaLabel">
    <div class="k12-task-progress__header">
      <span class="k12-task-progress__summary" data-testid="task-progress-summary">
        {{ summary }}
      </span>
      <HcDisclosureButton
        v-if="items.length"
        class="k12-task-progress__disclosure"
        data-testid="task-progress-disclosure"
        :expanded="expanded"
        expanded-label="收起处理详情"
        collapsed-label="展开处理详情"
        @toggle="expanded = !expanded"
      />
    </div>

    <div v-if="expanded && items.length" class="k12-task-progress__timeline">
      <ActivityTimeline :items="items" layout="stacked" running-indicator="typing-dots" />
    </div>
  </section>
</template>

<style scoped>
.k12-task-progress {
  display: grid;
  gap: 9px;
  padding: 0;
  border: 0;
  background: transparent;
}

.k12-task-progress__header {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: flex-start;
  gap: 4px;
}

.k12-task-progress__summary {
  min-width: 0;
  flex: 0 1 auto;
  color: var(--hc-text-secondary);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
}

.k12-task-progress__timeline {
  padding-top: 0;
  border: 0;
}

</style>
