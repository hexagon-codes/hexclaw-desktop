<script setup lang="ts">
defineProps<{
  title: string
  description?: string
}>()
</script>

<template>
  <div
    class="flex items-center justify-between px-6 py-4 border-b flex-shrink-0"
    :style="{ borderColor: 'var(--hc-border)' }"
  >
    <div>
      <h1 class="text-base font-semibold" :style="{ color: 'var(--hc-text-primary)' }">{{ title }}</h1>
      <p v-if="description" class="text-xs mt-0.5" :style="{ color: 'var(--hc-text-secondary)' }">
        {{ description }}
      </p>
    </div>
    <div class="flex items-center gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
