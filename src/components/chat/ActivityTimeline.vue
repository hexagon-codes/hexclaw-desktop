<script setup lang="ts">
import type { ActivityTimelineItem } from './activity-timeline'

withDefaults(
  defineProps<{
    items: ActivityTimelineItem[]
    /** Explicit presentation only. The default preserves existing thinking surfaces. */
    layout?: 'stacked' | 'branch-grid'
  }>(),
  { layout: 'stacked' },
)
</script>

<template>
  <ol
    v-if="items.length"
    class="hc-activity-timeline"
    :class="{ 'hc-activity-timeline--branch-grid': layout === 'branch-grid' }"
    :data-activity-layout="layout"
    data-testid="activity-timeline"
    role="list"
  >
    <li
      v-for="item in items"
      :key="item.id"
      class="hc-activity-timeline__item"
      :data-activity-state="item.state"
      data-testid="activity-timeline-item"
      role="listitem"
    >
      <span class="hc-activity-timeline__marker" aria-hidden="true">
        <svg v-if="item.state === 'completed'" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" />
          <path d="m8 12 2.5 2.5L16 9" />
        </svg>
        <span v-else-if="item.state === 'running'" class="hc-activity-timeline__pulse" />
        <span v-else>!</span>
      </span>
      <span class="hc-activity-timeline__copy">
        <b>{{ item.label }}</b>
        <small v-if="item.detail">{{ item.detail }}</small>
      </span>
    </li>
  </ol>
</template>

<style scoped>
.hc-activity-timeline {
  display: grid;
  gap: 9px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.hc-activity-timeline__item {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  color: var(--hc-text-secondary);
}

.hc-activity-timeline__marker {
  display: grid;
  width: 16px;
  height: 16px;
  place-items: center;
  color: var(--hc-text-muted);
  font-size: 11px;
  font-weight: 700;
}

.hc-activity-timeline__marker svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.8;
}

.hc-activity-timeline__item[data-activity-state='completed'] .hc-activity-timeline__marker {
  color: var(--hc-success);
}

.hc-activity-timeline__item[data-activity-state='failed'] .hc-activity-timeline__marker {
  color: var(--hc-error);
}

.hc-activity-timeline__pulse {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--hc-accent);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--hc-accent) 34%, transparent);
  animation: hc-activity-pulse 1.2s ease-out infinite;
}

.hc-activity-timeline__copy {
  min-width: 0;
}

.hc-activity-timeline__copy b,
.hc-activity-timeline__copy small {
  display: block;
}

.hc-activity-timeline__copy b {
  color: var(--hc-text-secondary);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
}

.hc-activity-timeline__copy small {
  margin-top: 1px;
  color: var(--hc-text-muted);
  font-size: 12px;
  line-height: 1.45;
}

.hc-activity-timeline--branch-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
}

.hc-activity-timeline--branch-grid .hc-activity-timeline__item {
  grid-template-columns: 19px minmax(0, 1fr);
  gap: 7px;
  padding: 8px 9px;
  border-radius: 9px;
  background: var(--hc-bg-card);
  font-size: 10.5px;
  line-height: 1.45;
}

.hc-activity-timeline--branch-grid .hc-activity-timeline__marker {
  width: 19px;
  height: 19px;
  background: var(--hc-accent-subtle);
  border-radius: 50%;
}

.hc-activity-timeline--branch-grid
  .hc-activity-timeline__item[data-activity-state='completed']
  .hc-activity-timeline__marker {
  background: color-mix(in srgb, var(--hc-success) 12%, transparent);
}

.hc-activity-timeline--branch-grid .hc-activity-timeline__marker svg {
  width: 15px;
  height: 15px;
}

.hc-activity-timeline--branch-grid .hc-activity-timeline__copy b {
  color: var(--hc-text-primary);
  font-size: 10.5px;
}

.hc-activity-timeline--branch-grid .hc-activity-timeline__copy small {
  margin-top: 2px;
  font-size: 10.5px;
  line-height: 1.4;
}

@keyframes hc-activity-pulse {
  70% {
    box-shadow: 0 0 0 5px transparent;
  }
  100% {
    box-shadow: 0 0 0 0 transparent;
  }
}

@media (prefers-reduced-motion: reduce) {
  .hc-activity-timeline__pulse {
    animation: none;
  }
}

@media (max-width: 700px) {
  .hc-activity-timeline--branch-grid {
    grid-template-columns: 1fr;
  }
}
</style>
