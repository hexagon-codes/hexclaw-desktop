<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    time: string
    text: string
    dotColor?: string
  }>(),
  { dotColor: 'var(--hc-accent)' },
)

const dotStyle = computed(() => ({ background: props.dotColor }))
</script>

<template>
  <div class="hc-timeline-item">
    <span class="hc-timeline-item__dot" :style="dotStyle" aria-hidden="true" />
    <div class="hc-timeline-item__body">
      <time class="hc-timeline-item__time">{{ time }}</time>
      <p class="hc-timeline-item__text">{{ text }}</p>
    </div>
  </div>
</template>

<style scoped>
.hc-timeline-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.hc-timeline-item__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-top: 4px;
  flex-shrink: 0;
}

.hc-timeline-item__body {
  min-width: 0;
  flex: 1;
}

.hc-timeline-item__time {
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: var(--hc-text-secondary);
  margin-bottom: 2px;
}

.hc-timeline-item__text {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--hc-text-primary);
}
</style>
