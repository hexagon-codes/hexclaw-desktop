<script setup lang="ts">
import type { FinalArtifactAction, FinalArtifactActionIntent } from '../final-artifact-action'

const props = defineProps<{
  artifactDigest: string
}>()

const emit = defineEmits<{
  (event: 'intent', intent: FinalArtifactActionIntent): void
}>()

function dispatch(action: FinalArtifactAction) {
  emit('intent', {
    action,
    artifact_digest: props.artifactDigest,
  })
}
</script>

<template>
  <div class="final-artifact-actions" data-testid="final-artifact-actions">
    <button type="button" @click="dispatch('print')">打印</button>
    <button type="button" @click="dispatch('export_pdf')">导出 PDF</button>
    <button type="button" @click="dispatch('send_im')">发送到手机</button>
  </div>
</template>

<style scoped>
.final-artifact-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.final-artifact-actions button {
  border: 1px solid var(--hc-border);
  border-radius: 8px;
  background: var(--hc-bg-card);
  color: var(--hc-text-primary);
  padding: 6px 10px;
  font: inherit;
  cursor: pointer;
}
</style>
