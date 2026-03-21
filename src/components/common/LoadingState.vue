<script setup lang="ts">
defineProps<{
  text?: string
  rows?: number
}>()
</script>

<template>
  <div class="hc-skeleton" role="status" :aria-label="text || 'Loading...'">
    <div class="hc-skeleton__row">
      <div class="hc-skeleton__block hc-skeleton__block--circle" />
      <div class="hc-skeleton__block hc-skeleton__block--line" />
    </div>
    <div class="hc-skeleton__row">
      <div class="hc-skeleton__block hc-skeleton__block--circle" />
      <div class="hc-skeleton__block hc-skeleton__block--line" />
    </div>
    <div class="hc-skeleton__block hc-skeleton__block--card" />
    <div class="hc-skeleton__row">
      <div class="hc-skeleton__block hc-skeleton__block--line" />
    </div>
    <div class="hc-skeleton__row">
      <div class="hc-skeleton__block hc-skeleton__block--line-short" />
    </div>
    <template v-if="(rows || 5) > 5">
      <div class="hc-skeleton__block hc-skeleton__block--card" />
      <div class="hc-skeleton__row">
        <div class="hc-skeleton__block hc-skeleton__block--circle" />
        <div class="hc-skeleton__block hc-skeleton__block--line" />
      </div>
    </template>
  </div>
</template>
