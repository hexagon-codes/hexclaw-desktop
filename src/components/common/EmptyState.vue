<script setup lang="ts">
import type { Component } from 'vue'

defineProps<{
  icon?: Component
  title: string
  description?: string
}>()
</script>

<template>
  <div class="flex flex-col items-center justify-center py-12 text-center">
    <component
      :is="icon"
      v-if="icon"
      :size="48"
      class="mb-4 opacity-20"
      :style="{ color: 'var(--hc-text-muted)' }"
    />
    <h3 class="text-sm font-medium mb-1" :style="{ color: 'var(--hc-text-secondary)' }">
      {{ title }}
    </h3>
    <p v-if="description" class="text-xs max-w-xs" :style="{ color: 'var(--hc-text-muted)' }">
      {{ description }}
    </p>
    <slot />
  </div>
</template>
