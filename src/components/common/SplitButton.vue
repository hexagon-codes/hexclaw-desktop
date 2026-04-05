<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, type Component } from 'vue'
import { ChevronDown } from 'lucide-vue-next'

export interface SplitButtonItem {
  id: string
  label: string
  icon?: Component
  separator?: boolean
  disabled?: boolean
}

defineProps<{
  label: string
  icon?: Component
  items: SplitButtonItem[]
}>()

const emit = defineEmits<{
  click: []
  select: [id: string]
}>()

const open = ref(false)
const wrapperRef = ref<HTMLDivElement>()
const menuRef = ref<HTMLDivElement>()
const menuX = ref(0)
const menuY = ref(0)

function toggle() {
  if (open.value) {
    open.value = false
    return
  }
  open.value = true
  nextTick(() => {
    const trigger = wrapperRef.value
    const menu = menuRef.value
    if (!trigger || !menu) return
    const r = trigger.getBoundingClientRect()
    const mr = menu.getBoundingClientRect()
    // Align right edge of menu with right edge of button
    let left = r.right - mr.width
    if (left < 8) left = 8
    let top = r.bottom + 4
    if (top + mr.height > window.innerHeight - 8) {
      top = r.top - mr.height - 4
    }
    menuX.value = left
    menuY.value = top
  })
}

function handleSelect(item: SplitButtonItem) {
  if (item.disabled || item.separator) return
  emit('select', item.id)
  open.value = false
}

function onClickOutside(e: MouseEvent) {
  if (!open.value) return
  const target = e.target as Node
  if (wrapperRef.value?.contains(target)) return
  if (menuRef.value?.contains(target)) return
  open.value = false
}

onMounted(() => document.addEventListener('mousedown', onClickOutside, true))
onUnmounted(() => document.removeEventListener('mousedown', onClickOutside, true))
</script>

<template>
  <div ref="wrapperRef" class="hc-split-btn">
    <button class="hc-split-btn__main" @click="emit('click')">
      <component v-if="icon" :is="icon" :size="14" />
      {{ label }}
    </button>
    <div class="hc-split-btn__divider" />
    <button class="hc-split-btn__caret" @click.stop="toggle">
      <ChevronDown :size="14" :class="{ 'hc-split-btn__caret-icon--open': open }" />
    </button>
  </div>

  <Teleport to="body">
    <Transition
      enter-active-class="hc-split-menu--enter"
      leave-active-class="hc-split-menu--leave"
      enter-from-class="hc-split-menu--hidden"
      leave-to-class="hc-split-menu--hidden"
    >
      <div
        v-if="open"
        ref="menuRef"
        class="hc-split-menu"
        :style="{ left: menuX + 'px', top: menuY + 'px' }"
      >
        <template v-for="item in items" :key="item.id">
          <div v-if="item.separator" class="hc-split-menu__sep" />
          <button
            v-else
            class="hc-split-menu__item"
            :class="{ 'hc-split-menu__item--disabled': item.disabled }"
            :disabled="item.disabled"
            @click="handleSelect(item)"
          >
            <component v-if="item.icon" :is="item.icon" :size="14" class="hc-split-menu__icon" />
            <span class="hc-split-menu__label">{{ item.label }}</span>
          </button>
        </template>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* ─── Trigger ──────────────────────────────────── */
.hc-split-btn {
  display: inline-flex;
  align-items: stretch;
  border-radius: var(--hc-radius-md);
  overflow: hidden;
}

.hc-split-btn__main {
  display: inline-flex;
  align-items: center;
  gap: var(--hc-space-2);
  padding: var(--hc-space-2) var(--hc-space-4);
  font-size: 13px;
  font-weight: 500;
  border: none;
  cursor: pointer;
  background: var(--hc-accent);
  color: var(--hc-text-inverse);
  transition: background 0.2s;
}

.hc-split-btn__main:hover {
  background: var(--hc-accent-hover);
}

.hc-split-btn__main:active {
  transform: scale(0.97);
}

.hc-split-btn__divider {
  width: 1px;
  background: rgba(255, 255, 255, 0.2);
}

.hc-split-btn__caret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 6px;
  border: none;
  cursor: pointer;
  background: var(--hc-accent);
  color: var(--hc-text-inverse);
  transition: background 0.2s;
}

.hc-split-btn__caret:hover {
  background: var(--hc-accent-hover);
}

.hc-split-btn__caret svg {
  transition: transform 0.2s;
}

.hc-split-btn__caret-icon--open {
  transform: rotate(180deg);
}

/* ─── Dropdown Menu ────────────────────────────── */
.hc-split-menu {
  position: fixed;
  z-index: var(--hc-z-popover);
  min-width: 200px;
  padding: 4px;
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-elevated);
  border: 1px solid var(--hc-border);
  box-shadow: var(--hc-shadow-float);
  backdrop-filter: saturate(180%) blur(var(--hc-blur-heavy));
  -webkit-backdrop-filter: saturate(180%) blur(var(--hc-blur-heavy));
}

.hc-split-menu__item {
  display: flex;
  align-items: center;
  gap: var(--hc-space-2);
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: var(--hc-radius-sm);
  background: transparent;
  color: var(--hc-text-primary);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;
}

.hc-split-menu__item:hover {
  background: var(--hc-accent);
  color: #fff;
}

.hc-split-menu__item:hover .hc-split-menu__icon {
  opacity: 1;
}

.hc-split-menu__item--disabled {
  opacity: 0.4;
  cursor: default;
}

.hc-split-menu__item--disabled:hover {
  background: transparent;
  color: var(--hc-text-primary);
}

.hc-split-menu__icon {
  flex-shrink: 0;
  opacity: 0.8;
}

.hc-split-menu__label {
  flex: 1;
}

.hc-split-menu__sep {
  height: 1px;
  background: var(--hc-divider);
  margin: 4px 8px;
}

/* ─── Transitions ──────────────────────────────── */
.hc-split-menu--enter {
  transition: opacity 0.15s cubic-bezier(0.25, 0.1, 0.25, 1),
    transform 0.15s cubic-bezier(0.25, 0.1, 0.25, 1);
}

.hc-split-menu--leave {
  transition: opacity 0.1s cubic-bezier(0.25, 0.1, 0.25, 1),
    transform 0.1s cubic-bezier(0.25, 0.1, 0.25, 1);
}

.hc-split-menu--hidden {
  opacity: 0;
  transform: scale(0.96) translateY(-4px);
}
</style>
