<script setup lang="ts">
import { computed } from 'vue'
import type { FinalArtifactAction, FinalArtifactActionIntent } from '../final-artifact-action'

const props = defineProps<{
  artifactId?: string
  artifactDigest: string
  artifactTitle?: string
  disabled?: boolean
  disabledReason?: string
  primaryAction?: FinalArtifactAction
  sendLabel?: string
  sendDisabled?: boolean
  actions?: FinalArtifactAction[]
}>()

const emit = defineEmits<{
  (event: 'intent', intent: FinalArtifactActionIntent): void
}>()

function dispatch(action: FinalArtifactAction) {
  if (props.disabled || (action === 'send_im' && props.sendDisabled)) return
  emit('intent', {
    action,
    artifact_id: props.artifactId ?? '',
    artifact_digest: props.artifactDigest,
    artifact_title: props.artifactTitle ?? '',
  })
}

const visibleActions = computed(
  () => props.actions ?? (['print', 'export_pdf', 'send_im'] as FinalArtifactAction[]),
)

function actionLabel(action: FinalArtifactAction) {
  if (action === 'print') return '打印'
  if (action === 'export_pdf') return '导出 PDF'
  return props.sendLabel || '发送到手机'
}

function actionDisabled(action: FinalArtifactAction) {
  return props.disabled || (action === 'send_im' && props.sendDisabled)
}
</script>

<template>
  <div class="final-artifact-actions" data-testid="final-artifact-actions">
    <button
      v-for="action in visibleActions"
      :key="action"
      type="button"
      :class="{ 'final-artifact-actions__primary': primaryAction === action }"
      :disabled="actionDisabled(action)"
      @click="dispatch(action)"
    >
      {{ actionLabel(action) }}
    </button>
    <span v-if="disabledReason" class="final-artifact-actions__reason" role="status">
      {{ disabledReason }}
    </span>
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
.final-artifact-actions button:disabled {
  cursor: default;
  opacity: 0.55;
}
.final-artifact-actions button.final-artifact-actions__primary {
  border-color: var(--hc-accent);
  background: var(--hc-accent);
  color: var(--hc-text-on-accent, #fff);
}
.final-artifact-actions__reason {
  align-self: center;
  color: var(--hc-text-muted);
  font-size: 12px;
}
</style>
