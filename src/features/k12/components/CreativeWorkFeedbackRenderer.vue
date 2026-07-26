<script setup lang="ts">
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'

defineProps<{
  generationId: string
  feedbackId: string
  projectionMarkdown: string
  visibleEvidence: string[]
  affirmation: string
  parentGuidance: string
  nextStep: string
  limitations?: string
}>()
</script>

<template>
  <div
    class="creative-feedback"
    data-testid="creative-work-feedback-renderer"
    :data-generation-id="generationId"
    :data-feedback-id="feedbackId"
  >
    <MarkdownRenderer :content="projectionMarkdown" :show-artifacts="false" />
  </div>
</template>
