<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { Search } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import HcClearableField from './HcClearableField.vue'
import { INPUT_LIMITS, inputLimitError } from '@/utils/input-limits'

const { t } = useI18n()

const props = withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
  fluid?: boolean
  inputTestId?: string
  clearTestId?: string
  disabled?: boolean
  ariaLabel?: string
  maxCharacters?: number
}>(), {
  fluid: false,
  inputTestId: undefined,
  clearTestId: undefined,
  disabled: false,
  maxCharacters: INPUT_LIMITS.keyword,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  submit: []
  keydown: [event: KeyboardEvent]
}>()

const inputRef = ref<HTMLInputElement | null>(null)
const draft = ref(props.modelValue)
let composing = false
let lastEmittedValue = props.modelValue

function validate(report = false): boolean {
  const error = inputLimitError(draft.value, 'Search', props.maxCharacters)
  inputRef.value?.setCustomValidity(error)
  if (report && error) inputRef.value?.reportValidity()
  return !error
}

function publishInput(event: Event) {
  draft.value = (event.target as HTMLInputElement).value
  if (composing || (event as InputEvent).isComposing) return
  if (!validate() || draft.value === lastEmittedValue) return
  lastEmittedValue = draft.value
  emit('update:modelValue', draft.value)
}

function endComposition(event: CompositionEvent) {
  composing = false
  publishInput(event)
}

function startComposition() {
  composing = true
}

watch(() => props.modelValue, (value) => {
  draft.value = value
  lastEmittedValue = value
  void nextTick(() => validate())
})
watch(() => props.maxCharacters, () => { void nextTick(() => validate()) })

// IME 守卫：中文/维语等输入法拼字回车选词时 isComposing 为真（部分环境 keyCode=229），
// 此时回车用于确认候选词，不应触发搜索提交。参考 ChatView/MemoryView 已有写法。
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    if (composing || event.isComposing || event.keyCode === 229) return
    if (!validate(true)) {
      event.preventDefault()
      return
    }
  }
  emit('keydown', event)
  if (event.key === 'Enter') emit('submit')
}

defineExpose({
  focus: () => inputRef.value?.focus(),
  validate: () => validate(true),
})
</script>

<template>
  <div class="hc-search" :class="{ 'hc-search--fluid': fluid }">
    <Search :size="15" class="hc-search__icon" />
    <HcClearableField
      class="hc-search__field"
      :trailing="0"
      button-class="hc-search__clear"
      :button-test-id="clearTestId"
      :icon-size="13"
    >
      <input
        ref="inputRef"
        :value="draft"
        :data-testid="inputTestId"
        data-search-control
        type="text"
        class="hc-search__input"
        :disabled="disabled"
        :placeholder="placeholder || `${t('common.search')}...`"
        :aria-label="ariaLabel || placeholder || `${t('common.search')}...`"
        @input="publishInput"
        @compositionstart="startComposition"
        @compositionend="endComposition"
        @blur="validate(true)"
        @keydown="onKeydown"
      />
    </HcClearableField>
  </div>
</template>

<style scoped>
.hc-search {
  display: flex;
  align-items: center;
  gap: 8px;
  border-radius: 999px;
  border: 0.5px solid var(--hc-border);
  background: var(--hc-bg-input);
  padding: 0 8px 0 12px;
  height: 32px;
  width: 200px;
  box-sizing: border-box;
  transition:
    border-color 0.2s,
    box-shadow 0.2s,
    background-color 0.15s;
}

.hc-search--fluid {
  width: 100%;
}

.hc-search:focus-within {
  border-color: var(--hc-accent);
  box-shadow: var(--hc-focus-shadow, 0 0 0 3px var(--hc-accent-subtle));
}

.hc-search__icon {
  flex-shrink: 0;
  color: var(--hc-text-muted);
}

.hc-search__field {
  flex: 1;
  min-width: 0;
}

.hc-search__input {
  background: transparent;
  border: none;
  outline: none;
  font-size: 13px;
  color: var(--hc-text-primary);
  min-width: 0;
}

.hc-search__input::placeholder {
  color: var(--hc-text-muted);
}

.hc-search__input:disabled {
  cursor: not-allowed;
}

.hc-search:has(.hc-search__input:disabled) {
  opacity: 0.55;
}

.hc-search :deep(.hc-search__clear) {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  padding: 0;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.82;
  transition:
    background-color 150ms cubic-bezier(0.16, 1, 0.3, 1),
    color 150ms cubic-bezier(0.16, 1, 0.3, 1),
    opacity 150ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 150ms cubic-bezier(0.34, 1.56, 0.64, 1);
}

.hc-search :deep(.hc-search__clear:hover) {
  background: color-mix(in srgb, var(--hc-text-muted) 14%, transparent);
  color: var(--hc-text-secondary);
  opacity: 1;
  transform: scale(1.03);
}

.hc-search :deep(.hc-search__clear:focus-visible) {
  outline: none;
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  box-shadow: var(--hc-focus-shadow, 0 0 0 2px color-mix(in srgb, var(--hc-accent) 22%, transparent));
}

.hc-search :deep(.hc-search__clear:active) {
  transform: scale(0.94);
}
</style>
