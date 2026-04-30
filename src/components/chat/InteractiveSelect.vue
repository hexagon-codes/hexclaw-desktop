<!--
  v0.4.0 G3/E6 InteractiveSelect — 单选列表（option 列表）。

  消息 interactive 协议：
    {
      type: 'select',
      prompt?: '请选择...',
      options: [{ label, value, description? }, ...],
      resolved?: { action: value, label, value }   // 用户已选后回填
    }

  点击选项 → emit('select', { action: value, label, value })
  ChatView 把它写回 message.interactive.resolved，并以用户身份回传。
-->
<template>
  <div class="hc-interactive-select">
    <div v-if="prompt" class="hc-interactive-select__prompt">{{ prompt }}</div>
    <div class="hc-interactive-select__list" role="listbox" :aria-disabled="!!resolved">
      <button
        v-for="opt in options"
        :key="opt.value"
        type="button"
        :class="[
          'hc-interactive-select__item',
          resolved?.value === opt.value ? 'is-resolved' : '',
        ]"
        :disabled="!!resolved"
        role="option"
        :aria-selected="resolved?.value === opt.value"
        @click="onClick(opt)"
      >
        <span v-if="resolved?.value === opt.value" class="hc-interactive-select__check">✓</span>
        <span class="hc-interactive-select__main">
          <span class="hc-interactive-select__label">{{ opt.label }}</span>
          <span v-if="opt.description" class="hc-interactive-select__desc">{{ opt.description }}</span>
        </span>
      </button>
    </div>
    <div v-if="resolved" class="hc-interactive-select__hint">已选择：{{ resolved.label || resolved.value }}</div>
  </div>
</template>

<script setup lang="ts">
import type { InteractiveOption, InteractiveResolved } from '@/types'

defineProps<{
  prompt?: string
  options: InteractiveOption[]
  resolved?: InteractiveResolved
}>()

const emit = defineEmits<{
  (e: 'select', payload: { action: string; label: string; value: string }): void
}>()

function onClick(opt: InteractiveOption) {
  emit('select', { action: opt.value, label: opt.label, value: opt.value })
}
</script>

<style scoped>
.hc-interactive-select {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px 22px;
  margin: 10px 0;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-xl);
  background: var(--hc-bg-card);
  box-shadow: var(--hc-shadow-sm);
  animation: hc-is-enter 0.32s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
@keyframes hc-is-enter {
  from { opacity: 0; transform: scale(0.96) translateY(8px); }
  to   { opacity: 1; transform: scale(1) translateY(0); }
}
.hc-interactive-select__prompt {
  font-size: 15px;
  font-weight: 500;
  line-height: 1.6;
  letter-spacing: -0.01em;
  color: var(--hc-text-primary);
}
.hc-interactive-select__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.hc-interactive-select__item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 14px;
  font: inherit;
  font-size: 13px;
  color: var(--hc-text-primary);
  background: var(--hc-bg-input);
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  cursor: pointer;
  text-align: left;
  transition:
    background 140ms cubic-bezier(0.25, 0.1, 0.25, 1),
    transform 140ms cubic-bezier(0.25, 0.1, 0.25, 1),
    box-shadow 140ms cubic-bezier(0.25, 0.1, 0.25, 1);
}
.hc-interactive-select__item:hover:not(:disabled) {
  background: var(--hc-bg-hover);
  transform: translateX(2px);
}
.hc-interactive-select__item:active:not(:disabled) {
  transform: scale(0.99);
}
.hc-interactive-select__item:disabled {
  cursor: default;
  opacity: 0.55;
}
.hc-interactive-select__item.is-resolved {
  opacity: 1;
  border-color: var(--hc-accent);
  box-shadow: 0 0 0 3px var(--hc-accent-subtle);
}
.hc-interactive-select__main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}
.hc-interactive-select__label {
  font-weight: 500;
  letter-spacing: -0.005em;
}
.hc-interactive-select__desc {
  font-size: 12px;
  line-height: 1.5;
  color: var(--hc-text-muted);
}
.hc-interactive-select__check {
  font-weight: 600;
  color: var(--hc-success);
  flex-shrink: 0;
  margin-top: 1px;
}
.hc-interactive-select__hint {
  font-size: 12px;
  line-height: 1.5;
  color: var(--hc-text-muted);
}
</style>
