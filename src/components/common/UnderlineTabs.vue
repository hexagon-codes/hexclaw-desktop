<script setup lang="ts">
/**
 * 二级 tab（下划线式）统一组件 —— 全站 utabs 唯一实现。
 * 下划线用激活 tab 自身的 CSS border-bottom（天然=tab 全宽、含计数徽标，
 * 无 JS 测量/时机问题，最稳）。支持可选前置图标 + 计数后缀。
 */
import type { Component } from 'vue'

interface Tab {
  key: string
  label: string
  icon?: Component
  count?: number
}

defineProps<{
  tabs: Tab[]
  modelValue: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()
</script>

<template>
  <div class="hc-utabs" role="tablist">
    <button
      v-for="tab in tabs"
      :key="tab.key"
      type="button"
      role="tab"
      :aria-selected="modelValue === tab.key"
      class="hc-utab"
      :class="{ 'hc-utab--on': modelValue === tab.key }"
      @click="emit('update:modelValue', tab.key)"
    >
      <component :is="tab.icon" v-if="tab.icon" :size="15" class="hc-utab__icon" />
      {{ tab.label }}
      <!-- 计数徽标：仅 count>0 才显示，0 / 未传一律隐藏（全站二级 tab 统一，不留悬空「0」）。 -->
      <span v-if="tab.count != null && tab.count > 0" class="hc-utab__count">{{ tab.count }}</span>
    </button>
  </div>
</template>

<style scoped>
.hc-utabs {
  display: flex;
  gap: 24px;
  border-bottom: 1px solid var(--hc-border);
}

.hc-utab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 0;
  border: none;
  /* 激活下划线 = 自身 border-bottom，天然覆盖标签+计数全宽 */
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  background: transparent;
  color: var(--hc-text-secondary);
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  white-space: nowrap;
  transition: color 0.18s ease, border-color 0.18s ease;
}

.hc-utab:hover:not(.hc-utab--on) {
  color: var(--hc-text-primary);
}

.hc-utab--on {
  color: var(--hc-accent);
  border-bottom-color: var(--hc-accent);
}

.hc-utab__icon {
  flex-shrink: 0;
}

.hc-utab__count {
  font-size: 11px;
  font-weight: 600;
  opacity: 0.7;
  margin-left: 1px;
}
</style>
