<script setup lang="ts">
import { ref } from 'vue'
import type { PhotoJobItemDTO } from '@/api/k12'
import KnowledgeSourceDialog from '@/components/knowledge/KnowledgeSourceDialog.vue'
import './assistant-process.css'

defineProps<{ items: PhotoJobItemDTO[] }>()
const source = ref<NonNullable<PhotoJobItemDTO['reuse']> | null>(null)
function openSource(item: NonNullable<PhotoJobItemDTO['reuse']>, event: MouseEvent) {
  if (event.currentTarget instanceof HTMLElement)
    event.currentTarget.focus({ preventScroll: true })
  source.value = item
}
</script>

<template>
  <details v-if="items.length" class="hc-process hc-process-tool" data-status="success" data-testid="question-reuse-activity">
    <summary>
      <span class="hc-process__marker" aria-hidden="true">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5L16 9" /></svg>
      </span>
      <span class="hc-process-tool__name">Question reuse</span>
      <span class="hc-process-tool__meta">{{ items.length }} {{ items.length === 1 ? 'item' : 'items' }}</span>
    </summary>
    <div class="hc-process-tool__detail">
      <div v-for="item in items" :key="item.question.problem_id" class="hc-process__retrieval-hit">
        <div class="hc-process__retrieval-title">
          <button
            v-if="item.reuse?.document_id && /\.pdf$/i.test(item.reuse.source_name)"
            type="button"
            class="question-reuse-source"
            @click="openSource(item.reuse, $event)"
          >{{ item.reuse.source_name }}<span v-if="item.reuse.page"> · {{ item.reuse.page }}</span></button>
          <span v-else>{{ item.reuse?.source_name ?? 'Reuse source unavailable' }}</span>
        </div>
        <p class="hc-process__excerpt">{{ item.reuse?.stem ?? item.question.question }}</p>
      </div>
    </div>
  </details>
  <KnowledgeSourceDialog
    v-if="source?.document_id"
    :document-id="source.document_id"
    :title="source.source_name"
    :source-digest="source.source_digest"
    :initial-page="source.page || 1"
    @close="source = null"
  />
</template>

<style scoped>
.question-reuse-source {
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.question-reuse-source:hover { text-decoration: underline; }
</style>
