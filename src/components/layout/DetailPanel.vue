<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  open: boolean
  title?: string
}>()

const emit = defineEmits<{
  close: []
}>()

const route = useRoute()
const { t } = useI18n()

const resolvedTitle = computed(() => {
  if (props.title) return props.title
  const p = route.path
  if (p === '/' || p === '/dashboard' || p.startsWith('/chat')) return t('inspector.titles.context')
  if (p.startsWith('/agents')) return t('inspector.titles.agent')
  if (p.startsWith('/knowledge')) return t('inspector.titles.document')
  if (p.startsWith('/automation')) return t('inspector.titles.automation')
  if (p.startsWith('/integration')) return t('inspector.titles.diagnostic')
  if (p.startsWith('/logs')) return t('inspector.titles.log')
  if (p.startsWith('/settings')) return t('inspector.titles.settings')
  return t('inspector.titles.generic')
})
</script>

<template>
  <Transition name="panel">
    <aside
      v-if="open"
      class="hc-inspector hc-vibrancy"
      role="complementary"
      :aria-label="resolvedTitle"
    >
      <div class="hc-inspector__head">
        <span class="hc-inspector__title">{{ resolvedTitle }}</span>
        <div class="hc-inspector__actions">
          <button class="hc-inspector__btn" @click="emit('close')">
            <X :size="14" />
          </button>
        </div>
      </div>
      <div class="hc-inspector__body">
        <slot />
      </div>
    </aside>
  </Transition>
</template>

<style scoped>
.hc-inspector {
  width: 272px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--hc-border-subtle);
  background: var(--hc-bg-panel);
  overflow: hidden;
  position: relative;
}

.hc-inspector__head {
  height: 58px;
  border-bottom: 1px solid var(--hc-divider);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  flex-shrink: 0;
}

.hc-inspector__title {
  font-size: 13px;
  font-weight: 700;
  color: var(--hc-text-primary);
}

.hc-inspector__actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.hc-inspector__btn {
  width: 28px;
  height: 28px;
  border-radius: var(--hc-radius-sm);
  border: 1px solid var(--hc-border);
  background: rgba(255, 255, 255, 0.05);
  color: var(--hc-text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.hc-inspector__btn:hover {
  background: var(--hc-bg-hover);
  border-color: var(--hc-accent-subtle);
  color: var(--hc-text-primary);
}

.hc-inspector__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* Transition */
.panel-enter-active,
.panel-leave-active {
  transition: width 0.25s cubic-bezier(0.25, 0.1, 0.25, 1),
              opacity 0.25s cubic-bezier(0.25, 0.1, 0.25, 1);
}

.panel-enter-from,
.panel-leave-to {
  width: 0;
  opacity: 0;
}
</style>
