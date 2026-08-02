<script setup lang="ts">
import { useToast } from '@/composables/useToast'
import { useK12Appearance, type K12AppearancePreference } from './useK12Appearance'

const toast = useToast()
const { preference, setPreference } = useK12Appearance()

const options: Array<{
  key: K12AppearancePreference
  label: string
  description: string
}> = [
  {
    key: 'k12',
    label: 'K12 专属皮肤',
    description: '全局皮肤；全部页面显示完整场景',
  },
  {
    key: 'default',
    label: '通用外观',
    description: '保持 HexClaw 默认界面',
  },
]

function select(next: K12AppearancePreference) {
  if (preference.value === next) return
  setPreference(next)
  toast.info(next === 'k12' ? '已切换为 K12 专属皮肤，已应用到全部页面' : '已切换为通用外观')
}

function onKeydown(event: KeyboardEvent, index: number) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
  event.preventDefault()
  const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1
  const target = (index + delta + options.length) % options.length
  select(options[target]!.key)
  const group = (event.currentTarget as HTMLElement).closest('[role="radiogroup"]')
  group?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[target]?.focus()
}
</script>

<template>
  <section class="k12-appearance-settings" aria-labelledby="k12-appearance-title">
    <div class="k12-appearance-settings__heading">
      <b id="k12-appearance-title">K12 外观</b>
      <span>应用到全部页面；完整学习场景随明暗模式切换</span>
    </div>
    <div class="k12-appearance-settings__grid" role="radiogroup" aria-label="K12 外观">
      <button
        v-for="(option, index) in options"
        :key="option.key"
        type="button"
        role="radio"
        class="k12-appearance-settings__card"
        :class="{ 'is-selected': preference === option.key }"
        :aria-checked="preference === option.key"
        :tabindex="preference === option.key ? 0 : -1"
        @click="select(option.key)"
        @keydown="onKeydown($event, index)"
      >
        <span class="k12-appearance-settings__copy">
          <span class="k12-appearance-settings__label">{{ option.label }}</span>
          <span class="k12-appearance-settings__description">{{ option.description }}</span>
        </span>
        <span class="k12-appearance-settings__check" aria-hidden="true">✓</span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.k12-appearance-settings {
  margin: 0 0 12px;
}

.k12-appearance-settings__heading {
  display: flex;
  align-items: flex-start;
  flex-direction: column;
  gap: 3px;
  margin: 0 0 8px;
}

.k12-appearance-settings__heading b {
  color: var(--hc-text-primary);
  font-size: 12.5px;
}

.k12-appearance-settings__heading span {
  color: var(--hc-text-muted);
  font-size: 11px;
  text-align: left;
}

.k12-appearance-settings__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.k12-appearance-settings__card {
  position: relative;
  min-width: 0;
  min-height: 60px;
  padding: 9px 36px 9px 12px;
  overflow: hidden;
  border: 1.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-card);
  color: var(--hc-text-primary);
  text-align: left;
  cursor: pointer;
  font: inherit;
  transition:
    border-color 0.2s,
    background 0.2s,
    transform 0.15s var(--hc-ease-smooth);
}

.k12-appearance-settings__card:hover {
  border-color: var(--hc-border-hl);
  transform: translateY(-1px);
}

.k12-appearance-settings__card:focus-visible {
  outline: 2px solid var(--hc-accent);
  outline-offset: 2px;
}

.k12-appearance-settings__card.is-selected {
  border-color: var(--hc-accent);
  background: color-mix(in srgb, var(--hc-accent-subtle) 78%, var(--hc-bg-card));
}

.k12-appearance-settings__copy {
  display: block;
  min-width: 0;
}

.k12-appearance-settings__label,
.k12-appearance-settings__description {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.k12-appearance-settings__label {
  color: var(--hc-text-primary);
  font-size: 13px;
  font-weight: 600;
}

.k12-appearance-settings__description {
  margin-top: 2px;
  color: var(--hc-text-muted);
  font-size: 11px;
}

.k12-appearance-settings__check {
  position: absolute;
  right: 12px;
  top: 50%;
  display: grid;
  width: 18px;
  height: 18px;
  place-items: center;
  border-radius: 50%;
  background: var(--hc-accent);
  color: #fff;
  font-size: 11px;
  font-weight: 800;
  opacity: 0;
  transform: translateY(-50%) scale(0.8);
}

.k12-appearance-settings__card.is-selected .k12-appearance-settings__check {
  opacity: 1;
  transform: translateY(-50%) scale(1);
}

@media (max-width: 880px) {
  .k12-appearance-settings__grid {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .k12-appearance-settings__card,
  .k12-appearance-settings__check {
    transition: none;
  }
}
</style>
