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

defineProps<{
  items: ContextMenuItem[]
}>()

const emit = defineEmits<{
  select: [id: string]
  close: []
}>()

const visible = ref(false)
const x = ref(0)
const y = ref(0)
const menuRef = ref<HTMLDivElement>()

function show(event: MouseEvent) {
  event.preventDefault()
  x.value = event.clientX
  y.value = event.clientY
  visible.value = true
  nextTick(() => {
    // Adjust position if menu overflows viewport
    const el = menuRef.value
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.right > window.innerWidth) {
      x.value = window.innerWidth - rect.width - 8
    }
    if (rect.bottom > window.innerHeight) {
      y.value = window.innerHeight - rect.height - 8
    }
  })
}

function hide() {
  visible.value = false
  emit('close')
}

function handleSelect(item: ContextMenuItem) {
  if (item.disabled || item.separator) return
  emit('select', item.id)
  hide()
}

function handleClickOutside(e: MouseEvent) {
  if (visible.value && menuRef.value && !menuRef.value.contains(e.target as Node)) {
    hide()
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
  document.addEventListener('contextmenu', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
  document.removeEventListener('contextmenu', handleClickOutside)
})

defineExpose({ show, hide })
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
        :style="{ left: x + 'px', top: y + 'px' }"
        @contextmenu.prevent
      >
        <template v-for="item in items" :key="item.id">
          <div v-if="item.separator" class="hc-ctx__sep" />
          <button
            v-else
            class="hc-ctx__item"
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
  min-width: 180px;
  padding: 4px;
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-elevated);
  border: 1px solid var(--hc-border);
  box-shadow: var(--hc-shadow-float);
  backdrop-filter: saturate(180%) blur(var(--hc-blur-heavy));
  -webkit-backdrop-filter: saturate(180%) blur(var(--hc-blur-heavy));
}

.hc-ctx__item {
  display: flex;
  align-items: center;
  gap: var(--hc-space-2);
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: var(--hc-radius-sm);
  background: transparent;
  color: var(--hc-text-primary);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;
}

.hc-ctx__item:hover {
  background: var(--hc-accent);
  color: #fff;
}

.hc-ctx__item:hover .hc-ctx__shortcut {
  color: rgba(255, 255, 255, 0.7);
}

.hc-ctx__item--danger {
  color: var(--hc-error);
}

.hc-ctx__item--danger:hover {
  background: var(--hc-error);
  color: #fff;
}

.hc-ctx__item--disabled {
  opacity: 0.4;
  cursor: default;
}

.hc-ctx__item--disabled:hover {
  background: transparent;
  color: var(--hc-text-primary);
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
