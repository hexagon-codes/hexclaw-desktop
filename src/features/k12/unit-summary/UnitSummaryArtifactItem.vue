<script setup lang="ts">
import type { Artifact } from '@/types'
import { UNIT_SUBJECT_LABELS } from './types'
defineProps<{ artifact: Artifact }>()
const emit = defineEmits<{ action: [payload: { id: string; action: string }] }>()
</script>
<template>
  <article class="unit-artifact">
    <b>{{ artifact.title }}</b>
    <p>
      {{ UNIT_SUBJECT_LABELS[artifact.reference?.subject || ''] }} ·
      <template v-if="artifact.reference?.unitNumber"
        >第{{ artifact.reference.unitNumber }}单元 ·
      </template>
      <template v-if="artifact.reference?.edition">{{ artifact.reference.edition }} · </template>
      {{ artifact.reference?.generatedDate }} · v{{
        String(artifact.reference?.version || 1).padStart(2, '0')
      }}
    </p>
    <div class="unit-artifact__actions">
      <button type="button" @click="emit('action', { id: artifact.id, action: 'open' })">
        打开资料
      </button>
      <span class="unit-artifact__download">
        <button
          type="button"
          :disabled="artifact.busy"
          :title="artifact.reference?.filename"
          @click="emit('action', { id: artifact.id, action: 'download' })"
        >
          下载 PDF
        </button>
        <span role="tooltip" class="unit-artifact__filename">{{
          artifact.reference?.filename
        }}</span>
      </span>
      <button
        type="button"
        :disabled="artifact.busy"
        @click="emit('action', { id: artifact.id, action: 'print' })"
      >
        打印
      </button>
    </div>
  </article>
</template>
<style scoped>
.unit-artifact {
  position: relative;
  padding: 14px;
  border: 1px solid var(--hc-border);
  border-radius: 10px;
  background: var(--hc-bg-card);
  color: var(--hc-text-primary);
}
.unit-artifact b {
  font-size: 14px;
  font-weight: 600;
}
.unit-artifact p {
  margin: 4px 0 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--hc-text-secondary);
}
.unit-artifact__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.unit-artifact button {
  min-height: 32px;
  padding: 5px 10px;
  border: 1px solid var(--hc-border);
  border-radius: 6px;
  background: var(--hc-bg-elevated);
  color: var(--hc-text-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.unit-artifact button:disabled {
  opacity: 0.5;
  cursor: wait;
}
.unit-artifact__download {
  display: inline-flex;
}
.unit-artifact__filename {
  display: none;
  position: absolute;
  bottom: 52px;
  left: 12px;
  right: 12px;
  padding: 8px 10px;
  overflow-wrap: anywhere;
  pointer-events: none;
  border: 1px solid var(--hc-border);
  border-radius: 6px;
  background: var(--hc-bg-elevated);
  font-size: 12px;
  z-index: 2;
}
.unit-artifact__download:hover .unit-artifact__filename,
.unit-artifact__download:focus-within .unit-artifact__filename {
  display: block;
}
</style>
