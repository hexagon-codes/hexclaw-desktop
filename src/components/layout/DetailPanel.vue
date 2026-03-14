<script setup lang="ts">
import { X } from 'lucide-vue-next'

defineProps<{
  open: boolean
  title?: string
}>()

const emit = defineEmits<{
  close: []
}>()
</script>

<template>
  <Transition name="panel">
    <div v-if="open" class="hc-detail-panel">
      <div class="hc-detail-panel__header">
        <span class="hc-detail-panel__title">{{ title || '详情' }}</span>
        <button class="hc-detail-panel__close" @click="emit('close')">
          <X :size="15" />
        </button>
      </div>
      <div class="hc-detail-panel__body">
        <slot />
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.hc-detail-panel {
  width: 300px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--hc-border-subtle);
  background: var(--hc-bg-panel);
  backdrop-filter: saturate(180%) blur(var(--hc-blur));
  -webkit-backdrop-filter: saturate(180%) blur(var(--hc-blur));
  overflow: hidden;
}

.hc-detail-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--hc-divider);
}

.hc-detail-panel__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--hc-text-primary);
}

.hc-detail-panel__close {
  padding: 4px;
  border-radius: var(--hc-radius-sm);
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  display: flex;
  transition: background 0.15s, color 0.15s;
}

.hc-detail-panel__close:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-secondary);
}

.hc-detail-panel__body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

/* Transition */
.panel-enter-active,
.panel-leave-active {
  transition: width 0.25s cubic-bezier(0.25, 0.1, 0.25, 1),
              opacity 0.25s cubic-bezier(0.25, 0.1, 0.25, 1);
}

.panel-enter-from,
.panel-leave-to {
  width: 0;
  opacity: 0;
}
</style>
