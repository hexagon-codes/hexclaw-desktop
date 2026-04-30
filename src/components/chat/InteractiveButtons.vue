<!--
  D2 交互式按钮 — 识题确认 / 二选一类场景。

  消息块格式（ContentBlock.type='buttons'）：
    {
      type: 'buttons',
      prompt: '是这道题吗？',
      buttons: [
        { label: '是', action: 'confirm-question', variant: 'primary' },
        { label: '不是', action: 'reject-question' }
      ],
      resolved?: { action, label }   // 已点击后由 store 回填，禁用其余按钮
    }

  点击后通过 emit('select', payload) 让父组件把 action/label 写回消息（resolved）
  并以 user 身份回传到对话流。
-->
<template>
  <div class="hc-interactive-buttons">
    <div v-if="prompt" class="hc-interactive-buttons__prompt">{{ prompt }}</div>
    <div class="hc-interactive-buttons__row">
      <button
        v-for="btn in buttons"
        :key="btn.action"
        type="button"
        :class="[
          'hc-interactive-buttons__btn',
          btn.variant === 'primary' ? 'is-primary' : 'is-secondary',
          resolved?.action === btn.action ? 'is-resolved' : '',
        ]"
        :disabled="!!resolved"
        @click="onClick(btn)"
      >
        <span v-if="resolved?.action === btn.action" class="hc-interactive-buttons__check">✓</span>
        {{ btn.label }}
      </button>
    </div>
    <div v-if="resolved" class="hc-interactive-buttons__hint">已选择：{{ resolved.label }}</div>
  </div>
</template>

<script setup lang="ts">
import type { InteractiveButton } from '@/types'

defineProps<{
  prompt?: string
  buttons: InteractiveButton[]
  resolved?: { action: string; label: string }
}>()

const emit = defineEmits<{
  (e: 'select', payload: { action: string; label: string; payload?: string }): void
}>()

function onClick(btn: InteractiveButton) {
  emit('select', { action: btn.action, label: btn.label, payload: btn.payload })
}
</script>

<style scoped>
/* HIG：卡片圆角 ≥ 16px、组件内 padding ≥ 20px、柔和多层阴影、0.5px 细边框；
   入场弹簧曲线（cubic-bezier(0.34, 1.56, 0.64, 1)）+ scale + opacity。 */
.hc-interactive-buttons {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px 22px;
  margin: 10px 0;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-xl);
  background: var(--hc-bg-card);
  box-shadow: var(--hc-shadow-sm);
  animation: hc-ib-enter 0.32s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
@keyframes hc-ib-enter {
  from { opacity: 0; transform: scale(0.96) translateY(8px); }
  to   { opacity: 1; transform: scale(1) translateY(0); }
}
.hc-interactive-buttons__prompt {
  font-size: 15px;
  font-weight: 500;
  line-height: 1.6;
  letter-spacing: -0.01em;
  color: var(--hc-text-primary);
}
.hc-interactive-buttons__row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.hc-interactive-buttons__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 18px;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  letter-spacing: -0.005em;
  color: var(--hc-text-primary);
  background: transparent;
  border: 0.5px solid transparent;
  border-radius: var(--hc-radius-md);
  cursor: pointer;
  transition:
    background 140ms cubic-bezier(0.25, 0.1, 0.25, 1),
    color 140ms cubic-bezier(0.25, 0.1, 0.25, 1),
    transform 140ms cubic-bezier(0.25, 0.1, 0.25, 1),
    box-shadow 140ms cubic-bezier(0.25, 0.1, 0.25, 1),
    opacity 140ms cubic-bezier(0.25, 0.1, 0.25, 1);
}
.hc-interactive-buttons__btn.is-primary {
  background: var(--hc-accent);
  color: var(--hc-text-inverse);
  box-shadow: var(--hc-shadow-sm);
}
.hc-interactive-buttons__btn.is-primary:hover:not(:disabled) {
  background: var(--hc-accent-hover);
  transform: scale(1.02);
}
.hc-interactive-buttons__btn.is-secondary {
  border-color: var(--hc-border);
  background: var(--hc-bg-input);
}
.hc-interactive-buttons__btn.is-secondary:hover:not(:disabled) {
  background: var(--hc-bg-hover);
  transform: scale(1.02);
}
.hc-interactive-buttons__btn:active:not(:disabled) {
  transform: scale(0.98);
}
.hc-interactive-buttons__btn:disabled {
  cursor: default;
  opacity: 0.55;
}
.hc-interactive-buttons__btn.is-resolved {
  opacity: 1;
  box-shadow: 0 0 0 3px var(--hc-accent-subtle);
}
.hc-interactive-buttons__check {
  font-weight: 600;
  color: var(--hc-success);
}
.hc-interactive-buttons__hint {
  font-size: 12px;
  line-height: 1.5;
  color: var(--hc-text-muted);
}
</style>
