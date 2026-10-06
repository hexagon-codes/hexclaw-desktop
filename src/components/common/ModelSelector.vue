<script setup lang="ts">
import { computed } from 'vue'
import HcSelect from './HcSelect.vue'
import { useSettingsStore } from '@/stores/settings'
import type { AvailableChatModel } from '@/config/model-contract'

/** 模型名单与身份投影共用；各入口的保存和会话绑定仍由原控制器负责。 */
const props = withDefaults(
  defineProps<{
    modelValue: string
    mode?: 'select' | 'menu'
    providerKey?: string
    emptyLabel?: string
    disabled?: boolean
    disableWhenEmpty?: boolean
    preserveInvalid?: boolean
    isUsable?: (model: AvailableChatModel) => boolean
    modelTitle?: (model: AvailableChatModel) => string
  }>(),
  {
    mode: 'select',
    emptyLabel: '',
    disabled: false,
    disableWhenEmpty: false,
    preserveInvalid: false,
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  select: [model: AvailableChatModel]
}>()
const settings = useSettingsStore()
const models = computed(() => {
  const seen = new Set<string>()
  return settings.availableModels.filter((model) => {
    if (props.providerKey !== undefined && model.providerKey !== props.providerKey) return false
    const identity = `${model.providerId}::${model.modelId}`
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
})
function valueFor(model: AvailableChatModel): string {
  return props.providerKey === undefined ? `${model.providerId}::${model.modelId}` : model.modelId
}
const options = computed(() => {
  const result = [
    { value: '', label: props.emptyLabel },
    ...models.value.map((model) => ({
      value: valueFor(model),
      label:
        props.providerKey === undefined
          ? `${model.providerName} / ${model.modelName}`
          : model.modelName,
      disabled: props.isUsable ? !props.isUsable(model) : false,
    })),
  ]
  if (
    props.preserveInvalid &&
    props.modelValue &&
    !result.some((option) => option.value === props.modelValue)
  ) {
    result.push({ value: props.modelValue, label: `${props.modelValue} (invalid)` })
  }
  return result
})
const groups = computed(() => {
  const grouped = new Map<
    string,
    { providerId: string; providerName: string; models: AvailableChatModel[] }
  >()
  for (const model of models.value) {
    let group = grouped.get(model.providerId)
    if (!group) {
      group = { providerId: model.providerId, providerName: model.providerName, models: [] }
      grouped.set(model.providerId, group)
    }
    group.models.push(model)
  }
  return [...grouped.values()]
})
function pick(value: string) {
  const model = models.value.find((entry) => valueFor(entry) === value)
  if (model && props.isUsable && !props.isUsable(model)) return
  if (value && !model) return
  emit('update:modelValue', value)
  if (model) emit('select', model)
}
</script>

<template>
  <HcSelect
    v-if="mode === 'select'"
    :model-value="modelValue"
    :options="options"
    :disabled="disabled || (disableWhenEmpty && models.length === 0)"
    @update:model-value="pick"
  />
  <div v-else class="hc-model-selector__menu">
    <slot name="before" />
    <template v-if="groups.length">
      <div v-for="group in groups" :key="group.providerId" class="hc-model-selector__group">
        <div class="hc-model-selector__group-label">{{ group.providerName }}</div>
        <button
          v-for="model in group.models"
          :key="valueFor(model)"
          type="button"
          class="hc-model-selector__item"
          :class="{
            'hc-model-selector__item--active': modelValue === valueFor(model),
            'hc-model-selector__item--disabled': isUsable && !isUsable(model),
          }"
          :disabled="disabled || (isUsable && !isUsable(model))"
          :title="modelTitle?.(model)"
          @click="pick(valueFor(model))"
        >
          <slot name="model" :model="model" :selected="modelValue === valueFor(model)">
            {{ model.modelName }}
          </slot>
        </button>
      </div>
    </template>
    <slot v-else name="empty" />
  </div>
</template>

<style scoped>
.hc-model-selector__group {
  padding: 4px 0;
}
.hc-model-selector__group + .hc-model-selector__group {
  border-top: 1px solid var(--hc-divider);
}
.hc-model-selector__group-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--hc-text-muted);
  padding: 4px 8px 2px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
:deep(.hc-model-selector__item) {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  background: transparent;
  color: var(--hc-text-secondary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  border-radius: var(--hc-radius-sm);
  transition: background 0.1s;
}
:deep(.hc-model-selector__item:hover) {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}
:deep(.hc-model-selector__item--active) {
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  font-weight: 500;
}
:deep(.hc-model-selector__item--disabled) {
  opacity: 0.5;
  cursor: not-allowed;
}
:deep(.hc-model-selector__item--disabled:hover) {
  background: transparent;
  color: var(--hc-text-secondary);
}
</style>
