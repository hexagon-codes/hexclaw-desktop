<!--
  v0.4.0 G3/E6 InteractiveApproval — 审批确认（同意/拒绝二选一）。

  消息 interactive 协议：
    {
      type: 'approval',
      approval: {
        subject: '是否允许在 /tmp 写入文件？',
        summary?: '工具 fs.write 即将创建 README.md',
        approve_label?: '同意' (default '同意'),
        reject_label?: '拒绝' (default '拒绝'),
        approve_action?: 'approve' (default 'approve'),
        reject_action?: 'reject' (default 'reject')
      },
      resolved?: { action, approved }
    }

  点击 → emit('select', { action, label, approved })
-->
<template>
  <div class="hc-interactive-approval">
    <div class="hc-interactive-approval__header">
      <span class="hc-interactive-approval__icon" aria-hidden="true">!</span>
      <div class="hc-interactive-approval__heading">
        <div class="hc-interactive-approval__subject">{{ approval.subject }}</div>
        <div v-if="approval.summary" class="hc-interactive-approval__summary">{{ approval.summary }}</div>
      </div>
    </div>
    <div class="hc-interactive-approval__row">
      <button
        type="button"
        :class="[
          'hc-interactive-approval__btn',
          'is-approve',
          resolved?.approved === true ? 'is-resolved' : '',
        ]"
        :disabled="!!resolved"
        @click="onApprove"
      >
        <span v-if="resolved?.approved === true" class="hc-interactive-approval__check">✓</span>
        {{ approval.approve_label || '同意' }}
      </button>
      <button
        type="button"
        :class="[
          'hc-interactive-approval__btn',
          'is-reject',
          resolved?.approved === false ? 'is-resolved' : '',
        ]"
        :disabled="!!resolved"
        @click="onReject"
      >
        <span v-if="resolved?.approved === false" class="hc-interactive-approval__check">✓</span>
        {{ approval.reject_label || '拒绝' }}
      </button>
    </div>
    <div v-if="resolved" class="hc-interactive-approval__hint">
      已{{ resolved.approved ? '同意' : '拒绝' }}
    </div>
  </div>
</template>

<script setup lang="ts">
import type { InteractiveApproval, InteractiveResolved } from '@/types'

const props = defineProps<{
  approval: InteractiveApproval
  resolved?: InteractiveResolved
}>()

const emit = defineEmits<{
  (e: 'select', payload: { action: string; label: string; approved: boolean }): void
}>()

function onApprove() {
  const action = props.approval.approve_action || 'approve'
  const label = props.approval.approve_label || '同意'
  emit('select', { action, label, approved: true })
}

function onReject() {
  const action = props.approval.reject_action || 'reject'
  const label = props.approval.reject_label || '拒绝'
  emit('select', { action, label, approved: false })
}
</script>

<style scoped>
.hc-interactive-approval {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px 22px;
  margin: 10px 0;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-xl);
  background: var(--hc-bg-card);
  box-shadow: var(--hc-shadow-sm);
  animation: hc-ia-enter 0.32s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
@keyframes hc-ia-enter {
  from { opacity: 0; transform: scale(0.96) translateY(8px); }
  to   { opacity: 1; transform: scale(1) translateY(0); }
}
.hc-interactive-approval__header {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.hc-interactive-approval__icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  font-size: 14px;
  font-weight: 700;
  color: var(--hc-text-inverse);
  background: var(--hc-warning, #f59e0b);
  border-radius: 50%;
}
.hc-interactive-approval__heading {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}
.hc-interactive-approval__subject {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.5;
  letter-spacing: -0.01em;
  color: var(--hc-text-primary);
}
.hc-interactive-approval__summary {
  font-size: 13px;
  line-height: 1.5;
  color: var(--hc-text-muted);
  white-space: pre-wrap;
  word-break: break-word;
}
.hc-interactive-approval__row {
  display: flex;
  gap: 10px;
}
.hc-interactive-approval__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 18px;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  letter-spacing: -0.005em;
  border: 0.5px solid transparent;
  border-radius: var(--hc-radius-md);
  cursor: pointer;
  transition:
    background 140ms cubic-bezier(0.25, 0.1, 0.25, 1),
    transform 140ms cubic-bezier(0.25, 0.1, 0.25, 1),
    box-shadow 140ms cubic-bezier(0.25, 0.1, 0.25, 1);
}
.hc-interactive-approval__btn.is-approve {
  background: var(--hc-accent);
  color: var(--hc-text-inverse);
  box-shadow: var(--hc-shadow-sm);
}
.hc-interactive-approval__btn.is-approve:hover:not(:disabled) {
  background: var(--hc-accent-hover);
  transform: scale(1.02);
}
.hc-interactive-approval__btn.is-reject {
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
  border-color: var(--hc-border);
}
.hc-interactive-approval__btn.is-reject:hover:not(:disabled) {
  background: var(--hc-bg-hover);
  transform: scale(1.02);
}
.hc-interactive-approval__btn:active:not(:disabled) {
  transform: scale(0.98);
}
.hc-interactive-approval__btn:disabled {
  cursor: default;
  opacity: 0.55;
}
.hc-interactive-approval__btn.is-resolved {
  opacity: 1;
  box-shadow: 0 0 0 3px var(--hc-accent-subtle);
}
.hc-interactive-approval__check {
  font-weight: 600;
  color: var(--hc-success);
}
.hc-interactive-approval__hint {
  font-size: 12px;
  line-height: 1.5;
  color: var(--hc-text-muted);
}
</style>
