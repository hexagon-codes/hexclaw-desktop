<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onBeforeUnmount } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import { PROVIDER_LOGOS, getProviderTypes } from '@/config/providers'
import type { ProviderType } from '@/types'

const props = withDefaults(defineProps<{
  modelValue: ProviderType
  includeOllama?: boolean
}>(), {
  includeOllama: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: ProviderType]
}>()

const open = ref(false)
const triggerRef = ref<HTMLButtonElement | null>(null)
const dropdownRef = ref<HTMLUListElement | null>(null)
const highlightIndex = ref(-1)
const dropdownStyle = ref<Record<string, string>>({})

const presets = getProviderTypes({ includeOllama: props.includeOllama })

const selected = computed(() => presets.find((p) => p.type === props.modelValue) ?? presets[0]!)

const selectedIndex = computed(() => presets.findIndex((p) => p.type === props.modelValue))

// ─── Position ────────────────────────────────────────
function updatePosition() {
  if (!triggerRef.value) return
  const rect = triggerRef.value.getBoundingClientRect()
  const spaceBelow = window.innerHeight - rect.bottom
  const flipUp = spaceBelow < 260 && rect.top > spaceBelow

  if (flipUp) {
    dropdownStyle.value = {
      position: 'fixed',
      bottom: `${window.innerHeight - rect.top + 4}px`,
      left: `${rect.left}px`,
      width: `${rect.width}px`,
    }
  } else {
    dropdownStyle.value = {
      position: 'fixed',
      top: `${rect.bottom + 4}px`,
      left: `${rect.left}px`,
      width: `${rect.width}px`,
    }
  }
}

// ─── Open / Close ────────────────────────────────────
async function openDropdown() {
  if (open.value) return
  open.value = true
  highlightIndex.value = Math.max(0, selectedIndex.value)
  await nextTick()
  updatePosition()
  scrollToHighlighted()
}

function closeDropdown(refocus = true) {
  if (!open.value) return
  open.value = false
  highlightIndex.value = -1
  if (refocus) triggerRef.value?.focus()
}

function toggle() {
  if (open.value) {
    closeDropdown()
  } else {
    openDropdown()
  }
}

function pick(type: ProviderType) {
  emit('update:modelValue', type)
  closeDropdown()
}

// ─── Keyboard ────────────────────────────────────────
function onKeydown(e: KeyboardEvent) {
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      if (!open.value) {
        openDropdown()
      } else {
        highlightIndex.value = (highlightIndex.value + 1) % presets.length
        scrollToHighlighted()
      }
      break
    case 'ArrowUp':
      e.preventDefault()
      if (!open.value) {
        openDropdown()
      } else {
        highlightIndex.value = (highlightIndex.value - 1 + presets.length) % presets.length
        scrollToHighlighted()
      }
      break
    case 'Enter':
    case ' ':
      e.preventDefault()
      if (open.value && highlightIndex.value >= 0) {
        pick(presets[highlightIndex.value]!.type)
      } else {
        openDropdown()
      }
      break
    case 'Escape':
      e.preventDefault()
      closeDropdown()
      break
    case 'Tab':
      closeDropdown(false)
      break
  }
}

function scrollToHighlighted() {
  nextTick(() => {
    const el = dropdownRef.value?.children[highlightIndex.value] as HTMLElement | undefined
    el?.scrollIntoView?.({ block: 'nearest' })
  })
}

// ─── Click outside & scroll reposition ───────────────
function onClickOutside(e: MouseEvent) {
  const target = e.target as Node
  if (
    triggerRef.value?.contains(target) ||
    dropdownRef.value?.contains(target)
  ) return
  closeDropdown(false)
}

function onScrollOrResize() {
  if (open.value) updatePosition()
}

onMounted(() => {
  document.addEventListener('mousedown', onClickOutside, true)
  window.addEventListener('scroll', onScrollOrResize, true)
  window.addEventListener('resize', onScrollOrResize)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onClickOutside, true)
  window.removeEventListener('scroll', onScrollOrResize, true)
  window.removeEventListener('resize', onScrollOrResize)
})

// Close when modelValue changes from outside
watch(() => props.modelValue, () => {
  if (open.value) closeDropdown()
})
</script>

<template>
  <div class="hc-provider-select">
    <button
      ref="triggerRef"
      type="button"
      class="hc-provider-select__trigger hc-input"
      role="combobox"
      :aria-expanded="open"
      aria-haspopup="listbox"
      @click="toggle"
      @keydown="onKeydown"
    >
      <img
        :src="PROVIDER_LOGOS[selected.type]"
        :alt="selected.name"
        class="hc-provider-select__logo"
      />
      <span class="hc-provider-select__name">{{ selected.name }}</span>
      <ChevronDown
        :size="12"
        class="hc-provider-select__arrow"
        :class="{ 'hc-provider-select__arrow--open': open }"
      />
    </button>

    <Teleport to="body">
      <Transition name="hc-dropdown">
        <ul
          v-if="open"
          ref="dropdownRef"
          class="hc-provider-select__dropdown"
          role="listbox"
          :style="dropdownStyle"
        >
          <li
            v-for="(preset, i) in presets"
            :key="preset.type"
            class="hc-provider-select__option"
            :class="{
              'hc-provider-select__option--active': preset.type === modelValue,
              'hc-provider-select__option--highlighted': i === highlightIndex,
            }"
            role="option"
            :aria-selected="preset.type === modelValue"
            @mousedown.prevent="pick(preset.type)"
            @mouseenter="highlightIndex = i"
          >
            <img
              :src="PROVIDER_LOGOS[preset.type]"
              :alt="preset.name"
              class="hc-provider-select__option-logo"
            />
            <span>{{ preset.name }}</span>
          </li>
        </ul>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.hc-provider-select {
  position: relative;
  width: 100%;
}

.hc-provider-select__trigger {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  padding-right: 32px;
  line-height: 1.5;
  text-align: left;
  background-image: none;
}

.hc-provider-select__name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hc-provider-select__arrow {
  position: absolute;
  right: 10px;
  color: var(--hc-text-muted);
  flex-shrink: 0;
  transition: transform 0.2s;
}

.hc-provider-select__arrow--open {
  transform: rotate(180deg);
}

.hc-provider-select__logo {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  flex-shrink: 0;
}
</style>

<style>
/* Dropdown is teleported to body — cannot be scoped */
.hc-provider-select__dropdown {
  z-index: var(--hc-z-popover, 9200);
  max-height: 240px;
  overflow-y: auto;
  margin: 0;
  padding: 4px;
  list-style: none;
  border-radius: var(--hc-radius-md, 8px);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-elevated);
  backdrop-filter: blur(var(--hc-blur-heavy, 40px));
  box-shadow: var(--hc-shadow-float);
}

.hc-provider-select__option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--hc-radius-sm, 6px);
  font-size: 13px;
  color: var(--hc-text-secondary);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.hc-provider-select__option-logo {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  flex-shrink: 0;
}

.hc-provider-select__option--highlighted {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}

.hc-provider-select__option--active {
  color: var(--hc-accent);
  font-weight: 500;
}

.hc-provider-select__option--active.hc-provider-select__option--highlighted {
  background: var(--hc-accent-subtle);
}

/* Dropdown transition */
.hc-dropdown-enter-active,
.hc-dropdown-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.hc-dropdown-enter-from,
.hc-dropdown-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
