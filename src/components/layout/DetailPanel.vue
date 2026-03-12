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
    <div
      v-if="open"
      class="w-[300px] flex-shrink-0 flex flex-col border-l overflow-hidden"
      :style="{ background: 'var(--hc-bg-panel)', borderColor: 'var(--hc-border)' }"
    >
      <div class="flex items-center justify-between px-4 py-3 border-b" :style="{ borderColor: 'var(--hc-border)' }">
        <span class="text-sm font-medium" :style="{ color: 'var(--hc-text-primary)' }">
          {{ title || '详情' }}
        </span>
        <button
          class="p-1 rounded hover:bg-white/5 transition-colors"
          :style="{ color: 'var(--hc-text-muted)' }"
          @click="emit('close')"
        >
          <X :size="16" />
        </button>
      </div>
      <div class="flex-1 overflow-y-auto p-4">
        <slot />
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.panel-enter-active,
.panel-leave-active {
  transition: width 0.2s ease, opacity 0.2s ease;
}

.panel-enter-from,
.panel-leave-to {
  width: 0;
  opacity: 0;
}
</style>
