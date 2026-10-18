<script setup lang="ts">
import { Copy, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'

defineProps<{ ariaLabel: string; copyLabel?: string }>()
const emit = defineEmits<{ close: []; copy: [] }>()
const { t } = useI18n()
</script>

<template>
  <section class="hc-detail-drawer" role="region" :aria-label="ariaLabel" @keydown.esc.stop.prevent="emit('close')">
    <header class="hc-detail-drawer__head">
      <slot name="header" />
      <button v-if="copyLabel" type="button" class="hc-detail-drawer__action hc-detail-drawer__copy" :title="copyLabel" :aria-label="copyLabel" @click="emit('copy')"><Copy :size="13" /></button>
      <button type="button" class="hc-detail-drawer__action hc-detail-drawer__close" :title="t('common.close')" :aria-label="t('common.close')" @click="emit('close')"><X :size="14" /></button>
    </header>
    <div class="hc-detail-drawer__body"><slot /></div>
  </section>
</template>

<style scoped>
/* 详情与列表共享有界工作区，领域页面只提供内容和关闭后的焦点目标。 */
.hc-detail-drawer { flex-shrink: 0; min-height: 0; max-height: 40%; display: flex; flex-direction: column; border-top: 1px solid var(--hc-border); background: var(--hc-bg-elevated); }
.hc-detail-drawer__head { display: flex; align-items: center; gap: 10px; padding: 6px 16px; border-bottom: .5px solid var(--hc-divider); font-size: 11px; flex-shrink: 0; }
.hc-detail-drawer__body { min-height: 0; overflow-y: auto; padding: 10px 16px 14px; }
.hc-detail-drawer__action { width: 28px; height: 28px; flex-shrink: 0; display: grid; place-items: center; border: none; background: transparent; color: var(--hc-text-secondary); border-radius: 6px; cursor: pointer; transition: background .15s, color .15s; }
.hc-detail-drawer__action:hover { background: var(--hc-bg-hover); color: var(--hc-text-primary); }
.hc-detail-drawer__action:focus-visible { outline: 2px solid var(--hc-accent); outline-offset: 2px; }
</style>
