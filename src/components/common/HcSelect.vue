<script setup lang="ts">
/**
 * 通用自定义下拉（替代原生 <select>）。
 * 原生 select 弹层在 macOS WKWebView 下不受 CSS 控制、字号异常巨大；
 * 本组件 Teleport 到 body 自渲染，全平台一致、可样式化。
 * API 对齐原生 select：v-model + options[{value,label,disabled?}] + placeholder/disabled。
 * 结构/交互复用 ProviderSelect（定位/键盘/点击外部/翻转）。
 */
import { ref, computed, nextTick, watch, onMounted, onBeforeUnmount } from 'vue'
import { ChevronDown } from 'lucide-vue-next'

interface Option {
  value: string
  label: string
  disabled?: boolean
  /** 可选：选项前的图标（图片 src，如服务商 logo）。缺省则纯文字（向后兼容）。 */
  icon?: string
}

const props = withDefaults(
  defineProps<{
    modelValue: string
    options: Option[]
    placeholder?: string
    disabled?: boolean
  }>(),
  { placeholder: '', disabled: false },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const open = ref(false)
const triggerRef = ref<HTMLButtonElement | null>(null)
const dropdownRef = ref<HTMLUListElement | null>(null)
const highlightIndex = ref(-1)
const dropdownStyle = ref<Record<string, string>>({})

const selectableOptions = computed(() => props.options)
const selected = computed(() => props.options.find((o) => o.value === props.modelValue) ?? null)
const selectedIndex = computed(() => props.options.findIndex((o) => o.value === props.modelValue))
const displayLabel = computed(() => selected.value?.label ?? props.placeholder)

function updatePosition() {
  if (!triggerRef.value) return
  const rect = triggerRef.value.getBoundingClientRect()
  const spaceBelow = window.innerHeight - rect.bottom
  const flipUp = spaceBelow < 260 && rect.top > spaceBelow
  dropdownStyle.value = flipUp
    ? {
        position: 'fixed',
        bottom: `${window.innerHeight - rect.top + 4}px`,
        left: `${rect.left}px`,
        width: `${rect.width}px`,
      }
    : {
        position: 'fixed',
        top: `${rect.bottom + 4}px`,
        left: `${rect.left}px`,
        width: `${rect.width}px`,
      }
}

async function openDropdown() {
  if (open.value || props.disabled) return
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
  if (open.value) closeDropdown()
  else openDropdown()
}

function pick(i: number) {
  const opt = selectableOptions.value[i]
  if (!opt || opt.disabled) return
  emit('update:modelValue', opt.value)
  closeDropdown()
}

function nextEnabled(from: number, dir: 1 | -1) {
  const n = selectableOptions.value.length
  if (n === 0) return -1
  let i = from
  for (let step = 0; step < n; step++) {
    i = (i + dir + n) % n
    if (!selectableOptions.value[i]?.disabled) return i
  }
  return from
}

function onKeydown(e: KeyboardEvent) {
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      if (!open.value) openDropdown()
      else {
        highlightIndex.value = nextEnabled(highlightIndex.value, 1)
        scrollToHighlighted()
      }
      break
    case 'ArrowUp':
      e.preventDefault()
      if (!open.value) openDropdown()
      else {
        highlightIndex.value = nextEnabled(highlightIndex.value, -1)
        scrollToHighlighted()
      }
      break
    case 'Enter':
    case ' ':
      e.preventDefault()
      if (open.value && highlightIndex.value >= 0) pick(highlightIndex.value)
      else openDropdown()
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

function onClickOutside(e: MouseEvent) {
  const target = e.target as Node
  if (triggerRef.value?.contains(target) || dropdownRef.value?.contains(target)) return
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

watch(
  () => props.modelValue,
  () => {
    if (open.value) closeDropdown()
  },
)
</script>

<template>
  <div class="hc-select">
    <button
      ref="triggerRef"
      type="button"
      class="hc-select__trigger hc-input"
      role="combobox"
      :aria-expanded="open"
      aria-haspopup="listbox"
      :disabled="disabled"
      @click="toggle"
      @keydown="onKeydown"
    >
      <img
        v-if="selected?.icon"
        :src="selected.icon"
        alt=""
        aria-hidden="true"
        class="hc-select__icon"
      />
      <span class="hc-select__label" :class="{ 'hc-select__label--placeholder': !selected }">
        {{ displayLabel }}
      </span>
      <ChevronDown
        :size="12"
        class="hc-select__arrow"
        :class="{ 'hc-select__arrow--open': open }"
      />
    </button>

    <Teleport to="body">
      <Transition name="hc-dropdown">
        <ul
          v-if="open"
          ref="dropdownRef"
          class="hc-select__dropdown"
          role="listbox"
          :style="dropdownStyle"
        >
          <li
            v-for="(opt, i) in selectableOptions"
            :key="opt.value"
            class="hc-select__option"
            :class="{
              'hc-select__option--active': opt.value === modelValue,
              'hc-select__option--highlighted': i === highlightIndex,
              'hc-select__option--disabled': opt.disabled,
            }"
            role="option"
            :aria-selected="opt.value === modelValue"
            :aria-disabled="opt.disabled"
            @mousedown.prevent="pick(i)"
            @mouseenter="highlightIndex = i"
          >
            <img
              v-if="opt.icon"
              :src="opt.icon"
              alt=""
              aria-hidden="true"
              class="hc-select__icon"
            />
            <span class="hc-select__option-label">{{ opt.label }}</span>
          </li>
        </ul>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.hc-select {
  position: relative;
  width: 100%;
}

.hc-select__trigger {
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

.hc-select__trigger:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.hc-select__label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hc-select__label--placeholder {
  color: var(--hc-text-muted);
}

.hc-select__arrow {
  position: absolute;
  right: 10px;
  color: var(--hc-text-muted);
  flex-shrink: 0;
  transition: transform 0.2s;
}

.hc-select__arrow--open {
  transform: rotate(180deg);
}
</style>

<style>
/* Dropdown 被 Teleport 到 body —— 不能用 scoped */
.hc-select__dropdown {
  z-index: var(--hc-z-popover, 9200);
  max-height: 260px;
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

.hc-select__option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: var(--hc-radius-sm, 6px);
  font-size: 13px;
  color: var(--hc-text-secondary);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.hc-select__option-label {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 选项/触发器前的图标（服务商 logo 等）——全局块：同时命中作用域内的触发器与 Teleport 到 body 的选项 */
.hc-select__icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  object-fit: contain;
  border-radius: 4px;
}

.hc-select__option--highlighted {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}

.hc-select__option--active {
  color: var(--hc-accent);
  font-weight: 500;
}

.hc-select__option--active.hc-select__option--highlighted {
  background: var(--hc-accent-subtle);
}

.hc-select__option--disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

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
