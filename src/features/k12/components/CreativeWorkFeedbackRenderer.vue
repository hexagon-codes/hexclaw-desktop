<script setup lang="ts">
import { computed } from 'vue'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'

const props = defineProps<{
  workType?: 'writing' | 'artwork'
  generationId: string
  feedbackId: string
  projectionMarkdown: string
  visibleEvidence: string[]
  affirmation: string
  parentGuidance: string
  nextStep: string
  limitations?: string
}>()

const savedStatus = computed(() => {
  if (props.workType === 'writing') return '这篇作文与点评已保存至作品列表'
  if (props.workType === 'artwork') return '这幅作品与点评已保存至作品列表'
  return ''
})
</script>

<template>
  <div
    class="creative-feedback"
    data-testid="creative-work-feedback-renderer"
    :data-generation-id="generationId"
    :data-feedback-id="feedbackId"
  >
    <MarkdownRenderer :content="projectionMarkdown" :show-artifacts="false" />
    <p
      v-if="savedStatus"
      class="creative-feedback__saved-status"
      data-testid="creative-work-saved-status"
      data-visible-state="feedback_ready"
      role="status"
    >
      <span class="creative-feedback__saved-icon" aria-hidden="true">✓</span>
      <span>{{ savedStatus }}</span>
    </p>
  </div>
</template>

<style scoped>
.creative-feedback__saved-status {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 14px 0 0;
  padding-top: 10px;
  border-top: 1px solid color-mix(in srgb, var(--hc-border) 68%, transparent);
  color: var(--hc-text-muted);
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
}

.creative-feedback__saved-icon {
  display: inline-grid;
  flex: 0 0 14px;
  width: 14px;
  height: 14px;
  place-items: center;
  border-radius: 50%;
  background: color-mix(in srgb, var(--hc-success) 12%, transparent);
  color: var(--hc-success);
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
}
</style>
