<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, type Component } from 'vue'

export interface ContextMenuItem {
  id: string
  label: string
  icon?: Component
  shortcut?: string
  danger?: boolean
  separator?: boolean
  disabled?: boolean
}

const props = withDefaults(defineProps<{
  items: ContextMenuItem[]
  variant?: 'default' | 'session'
}>(), {
  variant: 'default',
})

const emit = defineEmits<{
  select: [id: string]
  close: []
}>()

const visible = ref(false)
const x = ref(0)
const y = ref(0)
const menuRef = ref<HTMLDivElement>()
let returnFocusTo: HTMLElement | null = null

function fitToViewport(left: number, top: number) {
  const el = menuRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  x.value = Math.max(8, Math.min(left, window.innerWidth - rect.width - 8))
  y.value = Math.max(8, Math.min(top, window.innerHeight - rect.height - 8))
}

function focusFirstItem() {
  menuRef.value?.querySelector<HTMLButtonElement>('.hc-ctx__item:not(:disabled)')?.focus()
}

function show(event: MouseEvent) {
  event.preventDefault()
  returnFocusTo = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  x.value = event.clientX
  y.value = event.clientY
  visible.value = true
  nextTick(() => {
    fitToViewport(event.clientX, event.clientY)
    focusFirstItem()
  })
}

/** Anchor the menu below a compact trigger (for ellipsis buttons) without coupling callers to menu geometry. */
function showAt(anchor: HTMLElement) {
  returnFocusTo = anchor
  visible.value = true
  nextTick(() => {
    const anchorRect = anchor.getBoundingClientRect()
    const menuWidth = menuRef.value?.getBoundingClientRect().width ?? 0
    const left = props.variant === 'session'
      ? anchorRect.left - 16
      : anchorRect.right - menuWidth
    const top = props.variant === 'session'
      ? anchorRect.bottom + 2
      : anchorRect.bottom + 6
    fitToViewport(left, top)
    focusFirstItem()
  })
}

function hide(restoreFocus = false) {
  visible.value = false
  emit('close')
  if (restoreFocus) {
    const target = returnFocusTo
    nextTick(() => target?.focus())
  }
  returnFocusTo = null
}

function handleSelect(item: ContextMenuItem) {
  if (item.disabled || item.separator) return
  emit('select', item.id)
  hide()
}

function handleClickOutside(e: MouseEvent) {
  if (visible.value && menuRef.value && !menuRef.value.contains(e.target as Node)) {
    hide(false)
  }
}

function handleKeydown(e: KeyboardEvent) {
  const buttons = Array.from(menuRef.value?.querySelectorAll<HTMLButtonElement>('.hc-ctx__item:not(:disabled)') ?? [])
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    hide(true)
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || buttons.length === 0) return
  e.preventDefault()
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const next = e.key === 'Home'
    ? 0
    : e.key === 'End'
      ? buttons.length - 1
      : e.key === 'ArrowDown'
        ? (current + 1 + buttons.length) % buttons.length
        : (current - 1 + buttons.length) % buttons.length
  buttons[next]?.focus()
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
  document.addEventListener('contextmenu', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
  document.removeEventListener('contextmenu', handleClickOutside)
})

defineExpose({ show, showAt, hide })
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="hc-ctx--enter"
      leave-active-class="hc-ctx--leave"
      enter-from-class="hc-ctx--hidden"
      leave-to-class="hc-ctx--hidden"
    >
      <div
        v-if="visible"
        ref="menuRef"
        class="hc-ctx"
        :class="{ 'hc-ctx--session': variant === 'session' }"
        role="menu"
        aria-orientation="vertical"
        :style="{ left: x + 'px', top: y + 'px' }"
        @contextmenu.prevent
        @keydown="handleKeydown"
      >
        <template v-for="item in items" :key="item.id">
          <div v-if="item.separator" class="hc-ctx__sep" />
          <button
            v-else
            class="hc-ctx__item"
            role="menuitem"
            :class="{
              'hc-ctx__item--danger': item.danger,
              'hc-ctx__item--disabled': item.disabled,
            }"
            :disabled="item.disabled"
            @click="handleSelect(item)"
          >
            <component v-if="item.icon" :is="item.icon" :size="14" class="hc-ctx__icon" />
            <span class="hc-ctx__label">{{ item.label }}</span>
            <span v-if="item.shortcut" class="hc-ctx__shortcut">{{ item.shortcut }}</span>
          </button>
        </template>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.hc-ctx {
  position: fixed;
  z-index: var(--hc-z-popover);
  min-width: 170px;
  padding: 6px;
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-elevated);
  border: 0.5px solid var(--hc-border);
  box-shadow: var(--hc-shadow-float);
  backdrop-filter: saturate(180%) blur(var(--hc-blur-heavy));
  -webkit-backdrop-filter: saturate(180%) blur(var(--hc-blur-heavy));
}

.hc-ctx__item {
  display: flex;
  align-items: center;
  gap: var(--hc-space-2);
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--hc-text-primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;
}

.hc-ctx__item:hover {
  background: var(--hc-bg-hover);
}

.hc-ctx__item:hover .hc-ctx__shortcut {
  color: var(--hc-text-secondary);
}

.hc-ctx__item--danger {
  color: var(--hc-error);
}

.hc-ctx__item--danger:hover {
  background: var(--hc-error);
  color: #fff;
}

.hc-ctx__item--disabled {
  color: var(--hc-text-muted);
  opacity: 0.72;
  cursor: not-allowed;
}

.hc-ctx__item--disabled:hover {
  background: transparent;
  color: var(--hc-text-muted);
}

.hc-ctx__icon {
  flex-shrink: 0;
  opacity: 0.8;
}

.hc-ctx__label {
  flex: 1;
}

.hc-ctx__shortcut {
  font-size: 11px;
  color: var(--hc-text-muted);
  margin-left: var(--hc-space-4);
}

.hc-ctx__sep {
  height: 1px;
  background: var(--hc-divider);
  margin: 4px 8px;
}

/* Session rows use the separately approved ChatGPT-measured menu geometry. */
.hc-ctx--session {
  width: 140px;
  min-width: 140px;
  box-sizing: border-box;
  padding: 6px;
  border: 1px solid var(--hc-border);
  border-radius: 16px;
  backdrop-filter: saturate(180%) blur(18px);
  -webkit-backdrop-filter: saturate(180%) blur(18px);
  transform-origin: top left;
}

.hc-ctx--session .hc-ctx__item {
  height: 36px;
  gap: 10px;
  padding: 0 10px;
  border-radius: 9px;
}

.hc-ctx--session .hc-ctx__icon {
  width: 17px;
  height: 17px;
  opacity: 1;
}

.hc-ctx--session .hc-ctx__item--danger:hover,
.hc-ctx--session .hc-ctx__item--danger:focus-visible {
  color: var(--hc-error);
  background: color-mix(in srgb, var(--hc-error) 10%, transparent);
}

.hc-ctx--session .hc-ctx__item--disabled {
  opacity: 0.45;
  cursor: default;
}

.hc-ctx--session .hc-ctx__sep {
  margin: 5px 8px;
}

.hc-ctx--enter {
  transition: opacity 0.15s cubic-bezier(0.25, 0.1, 0.25, 1), transform 0.15s cubic-bezier(0.25, 0.1, 0.25, 1);
}

.hc-ctx--leave {
  transition: opacity 0.1s cubic-bezier(0.25, 0.1, 0.25, 1), transform 0.1s cubic-bezier(0.25, 0.1, 0.25, 1);
}

.hc-ctx--hidden {
  opacity: 0;
  transform: scale(0.96);
}
</style>
