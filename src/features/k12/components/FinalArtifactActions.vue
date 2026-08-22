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
      data-governed-button="k12-action"
      :class="[
        'btn',
        {
          'btn-primary': primaryAction === action,
          'final-artifact-actions__primary': primaryAction === action,
        },
      ]"
      :disabled="actionDisabled(action)"
      @click="dispatch(action)"
    >
      <svg
        v-if="action === 'print'"
        class="ic-sm final-artifact-actions__icon"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path d="M6 9V2h12v7" />
        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5h-2" />
        <path d="M6 14h12v8H6z" />
      </svg>
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
  gap: 7px;
}
.final-artifact-actions button {
  flex: none;
  font-family: Arial;
  line-height: normal;
}
.final-artifact-actions__icon {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2;
}
.final-artifact-actions button:disabled {
  cursor: default;
  opacity: 0.55;
}
.final-artifact-actions__reason {
  align-self: center;
  color: var(--hc-text-muted);
  font-size: 12px;
}
</style>
