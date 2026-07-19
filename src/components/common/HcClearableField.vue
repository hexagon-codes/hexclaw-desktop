<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, onBeforeUnmount, onMounted, onUpdated, ref } from 'vue'
import { X } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  /** 为密码显隐、单位等尾部控件预留的空间（px）。 */
  trailing?: number
}>(), {
  trailing: 8,
})

const root = ref<HTMLElement | null>(null)
const hasValue = ref(false)
const isTextarea = ref(false)
let field: HTMLInputElement | HTMLTextAreaElement | null = null

const instance = getCurrentInstance()
const clearLabel = computed(() => {
  const translate = instance?.appContext.config.globalProperties.$t as
    | ((key: string) => string)
    | undefined
  return typeof translate === 'function' ? translate('common.clearInput') : 'Clear input'
})

function syncState() {
  const next = root.value?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea') ?? null
  if (next !== field) {
    field?.removeEventListener('input', syncState)
    field?.removeEventListener('change', syncState)
    field = next
    field?.addEventListener('input', syncState)
    field?.addEventListener('change', syncState)
  }
  isTextarea.value = field instanceof HTMLTextAreaElement
  hasValue.value = !!field?.value && !field.disabled && !field.readOnly
}

function clear() {
  if (!field || field.disabled || field.readOnly) return
  field.value = ''
  field.dispatchEvent(new Event('input', { bubbles: true }))
  field.focus()
  syncState()
}

onMounted(() => {
  syncState()
  // 父组件的 v-model 指令在子组件 mounted 之后写入原生 value，下一 tick 再同步初值。
  void nextTick(syncState)
})
onUpdated(syncState)
onBeforeUnmount(() => {
  field?.removeEventListener('input', syncState)
  field?.removeEventListener('change', syncState)
})
</script>

<template>
  <div
    ref="root"
    class="hc-clearable-field"
    :class="{ 'hc-clearable-field--textarea': isTextarea }"
    :style="{ '--hc-clearable-trailing': `${props.trailing}px` }"
  >
    <slot />
    <button
      v-if="hasValue"
      type="button"
      class="hc-clearable-field__button"
      :aria-label="clearLabel"
      :title="clearLabel"
      @mousedown.prevent
      @click.stop="clear"
    >
      <X :size="14" aria-hidden="true" />
    </button>
  </div>
</template>

<style scoped>
.hc-clearable-field {
  --hc-clearable-trailing: 8px;
  position: relative;
  display: block;
  width: 100%;
  min-width: 0;
}

.hc-clearable-field :deep(input),
.hc-clearable-field :deep(textarea) {
  padding-inline-end: calc(var(--hc-clearable-trailing) + 30px) !important;
}

.hc-clearable-field__button {
  position: absolute;
  z-index: 2;
  inset-inline-end: var(--hc-clearable-trailing);
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  opacity: 0.82;
  transition:
    color 150ms cubic-bezier(0.16, 1, 0.3, 1),
    background-color 150ms cubic-bezier(0.16, 1, 0.3, 1),
    opacity 150ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 150ms cubic-bezier(0.34, 1.56, 0.64, 1);
}

.hc-clearable-field--textarea .hc-clearable-field__button {
  top: 8px;
  transform: none;
}

.hc-clearable-field__button:hover {
  background: color-mix(in srgb, var(--hc-text-muted) 14%, transparent);
  color: var(--hc-text-secondary);
  opacity: 1;
  transform: translateY(-50%) scale(1.03);
}

.hc-clearable-field--textarea .hc-clearable-field__button:hover {
  transform: scale(1.03);
}

.hc-clearable-field__button:focus-visible {
  outline: none;
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--hc-accent) 22%, transparent);
}

.hc-clearable-field__button:active {
  transform: translateY(-50%) scale(0.94);
}

.hc-clearable-field--textarea .hc-clearable-field__button:active {
  transform: scale(0.94);
}
</style>
