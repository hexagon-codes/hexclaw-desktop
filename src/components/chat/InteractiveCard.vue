<!--
  v0.4.0 G3/E6 InteractiveCard — 富信息卡片（题卡 / 任务卡 / 工具结果卡）。

  消息 interactive 协议：
    {
      type: 'card',
      card: {
        title: '订单 #1234',
        fields?: [{ label: '状态', value: '待付款', short?: true }, ...],
        buttons?: [{ label, action, variant?, payload? }, ...],
        image?: 'https://...',
        footer?: '更新于 2026-04-28 12:30'
      },
      resolved?: { action, label }
    }

  点击 button → emit('select', { action, label, payload? })
  纯展示（无 button）时，组件只渲染信息，不触发 select。
-->
<template>
  <div class="hc-interactive-card">
    <img v-if="card.image" :src="card.image" alt="" class="hc-interactive-card__image" loading="lazy" />
    <div class="hc-interactive-card__title">{{ card.title }}</div>
    <div v-if="card.fields && card.fields.length" class="hc-interactive-card__fields">
      <div
        v-for="(f, i) in card.fields"
        :key="i"
        :class="['hc-interactive-card__field', f.short ? 'is-short' : '']"
      >
        <div class="hc-interactive-card__field-label">{{ f.label }}</div>
        <div class="hc-interactive-card__field-value">{{ f.value }}</div>
      </div>
    </div>
    <div v-if="card.buttons && card.buttons.length" class="hc-interactive-card__row">
      <button
        v-for="btn in card.buttons"
        :key="btn.action"
        type="button"
        :class="[
          'hc-interactive-card__btn',
          btn.variant === 'primary' ? 'is-primary' : btn.variant === 'danger' ? 'is-danger' : 'is-secondary',
          resolved?.action === btn.action ? 'is-resolved' : '',
        ]"
        :disabled="!!resolved"
        @click="onClick(btn)"
      >
        <span v-if="resolved?.action === btn.action" class="hc-interactive-card__check">✓</span>
        {{ btn.label }}
      </button>
    </div>
    <div v-if="card.footer" class="hc-interactive-card__footer">{{ card.footer }}</div>
    <div v-if="resolved && card.buttons?.length" class="hc-interactive-card__hint">
      已选择：{{ resolved.label || resolved.action }}
    </div>
  </div>
</template>

<script setup lang="ts">
import type { InteractiveButton, InteractiveCard, InteractiveResolved } from '@/types'

defineProps<{
  card: InteractiveCard
  resolved?: InteractiveResolved
}>()

const emit = defineEmits<{
  (e: 'select', payload: { action: string; label: string; payload?: string }): void
}>()

function onClick(btn: InteractiveButton) {
  emit('select', { action: btn.action, label: btn.label, payload: btn.payload })
}
</script>

<style scoped>
.hc-interactive-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px 22px;
  margin: 10px 0;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-xl);
  background: var(--hc-bg-card);
  box-shadow: var(--hc-shadow-sm);
  animation: hc-ic-enter 0.32s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
@keyframes hc-ic-enter {
  from { opacity: 0; transform: scale(0.96) translateY(8px); }
  to   { opacity: 1; transform: scale(1) translateY(0); }
}
.hc-interactive-card__image {
  width: 100%;
  max-height: 220px;
  object-fit: cover;
  border-radius: var(--hc-radius-md);
  margin-bottom: 4px;
}
.hc-interactive-card__title {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.5;
  letter-spacing: -0.01em;
  color: var(--hc-text-primary);
}
.hc-interactive-card__fields {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px 16px;
}
@media (min-width: 480px) {
  .hc-interactive-card__fields {
    grid-template-columns: 1fr;
  }
  .hc-interactive-card__field.is-short {
    grid-column: span 1;
  }
}
.hc-interactive-card__field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.hc-interactive-card__field-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--hc-text-muted);
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.hc-interactive-card__field-value {
  font-size: 13px;
  line-height: 1.5;
  color: var(--hc-text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}
.hc-interactive-card__row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 4px;
}
.hc-interactive-card__btn {
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
    box-shadow 140ms cubic-bezier(0.25, 0.1, 0.25, 1);
}
.hc-interactive-card__btn.is-primary {
  background: var(--hc-accent);
  color: var(--hc-text-inverse);
  box-shadow: var(--hc-shadow-sm);
}
.hc-interactive-card__btn.is-primary:hover:not(:disabled) {
  background: var(--hc-accent-hover);
  transform: scale(1.02);
}
.hc-interactive-card__btn.is-secondary {
  border-color: var(--hc-border);
  background: var(--hc-bg-input);
}
.hc-interactive-card__btn.is-secondary:hover:not(:disabled) {
  background: var(--hc-bg-hover);
  transform: scale(1.02);
}
.hc-interactive-card__btn.is-danger {
  background: var(--hc-danger, #dc2626);
  color: var(--hc-text-inverse);
}
.hc-interactive-card__btn.is-danger:hover:not(:disabled) {
  filter: brightness(1.05);
  transform: scale(1.02);
}
.hc-interactive-card__btn:active:not(:disabled) {
  transform: scale(0.98);
}
.hc-interactive-card__btn:disabled {
  cursor: default;
  opacity: 0.55;
}
.hc-interactive-card__btn.is-resolved {
  opacity: 1;
  box-shadow: 0 0 0 3px var(--hc-accent-subtle);
}
.hc-interactive-card__check {
  font-weight: 600;
  color: var(--hc-success);
}
.hc-interactive-card__footer {
  font-size: 11px;
  color: var(--hc-text-muted);
  margin-top: 4px;
}
.hc-interactive-card__hint {
  font-size: 12px;
  line-height: 1.5;
  color: var(--hc-text-muted);
}
</style>
