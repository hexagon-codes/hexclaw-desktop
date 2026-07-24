<script setup lang="ts">
import MarkdownRenderer from './MarkdownRenderer.vue'

defineProps<{
  content: string
}>()
</script>

<template>
  <MarkdownRenderer class="hc-reasoning-markdown" :content="content" :show-artifacts="false" />
</template>

<style scoped>
.hc-reasoning-markdown :deep(.markdown-body) {
  font-size: inherit;
}
</style>
