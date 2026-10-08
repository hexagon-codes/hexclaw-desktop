<script setup lang="ts">
import { useK12Appearance, type K12AppearancePreference } from './useK12Appearance'
const { preference, setPreference } = useK12Appearance()
const options: Array<{ key: K12AppearancePreference; label: string }> = [
  { key: 'k12', label: 'K12 专属皮肤' }, { key: 'default', label: '通用外观' },
]
function onKeydown(event: KeyboardEvent, index: number) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
  event.preventDefault()
  const next = (index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + options.length) % options.length
  setPreference(options[next]!.key)
  ;(event.currentTarget as HTMLElement).closest('[role="radiogroup"]')?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
}
</script>
<template>
  <!-- 风格与明暗模式为独立全局偏好；后端切换和模型撤销不改变此选择。 -->
  <section class="k12-appearance-settings" aria-labelledby="k12-appearance-title">
    <div class="k12-appearance-settings__copy">
      <b id="k12-appearance-title">界面风格</b>
      <p>应用于全部页面，并随明暗模式切换。</p>
    </div>
    <div class="k12-appearance-settings__control">
      <div class="k12-appearance-settings__segmented" role="radiogroup" aria-label="界面风格">
        <button v-for="(option, index) in options" :key="option.key" type="button" role="radio"
          :class="{ 'is-selected': preference === option.key }" :aria-checked="preference === option.key"
          :tabindex="preference === option.key ? 0 : -1" @click="setPreference(option.key)" @keydown="onKeydown($event, index)">{{ option.label }}</button>
      </div>
    </div>
  </section>
</template>
<style scoped>
.k12-appearance-settings{display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:68px;padding:8px 0;box-sizing:border-box;border-bottom:1px solid var(--hc-border)}
.k12-appearance-settings__copy{display:flex;flex-direction:column;gap:3px;min-width:0}
.k12-appearance-settings__copy>b{font-size:14px;font-weight:500;color:var(--hc-text-primary)}
.k12-appearance-settings__control{width:360px;max-width:100%;min-width:0;flex-shrink:0}
.k12-appearance-settings__segmented{display:flex;padding:3px;min-height:36px;box-sizing:border-box;border:1px solid var(--hc-border);border-radius:10px;background:var(--hc-bg-input)}
.k12-appearance-settings__segmented button{flex:1;border:0;border-radius:7px;background:transparent;color:var(--hc-text-secondary);font:inherit;font-size:12.5px;cursor:pointer;padding:4px 8px}
.k12-appearance-settings__segmented button.is-selected{background:var(--hc-bg-card);color:var(--hc-accent);box-shadow:var(--hc-shadow-sm)}
.k12-appearance-settings__segmented button:focus-visible{outline:2px solid var(--hc-accent);outline-offset:1px}
.k12-appearance-settings p{margin:0;font-size:12px;line-height:1.5;color:var(--hc-text-secondary)}
@container settings-content (max-width:560px){.k12-appearance-settings{flex-direction:column;align-items:flex-start;gap:8px}.k12-appearance-settings__control{width:100%}}
</style>
