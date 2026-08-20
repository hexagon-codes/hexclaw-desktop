<script setup lang="ts">
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import HcSelect from '@/components/common/HcSelect.vue'
import {
  allowedReasoningEfforts,
  normalizeDefaultReasoningPolicy,
  normalizeReasoningPolicy,
} from '@/utils/reasoning-policy'
import type {
  ModelReasoningControl,
  ModelReasoningSupport,
  ReasoningEffort,
  ReasoningPolicy,
} from '@/types'

defineOptions({ name: 'ReasoningPolicySelect' })

const props = withDefaults(
  defineProps<{
    modelValue: ReasoningPolicy
    scope: 'global' | 'agent'
    support: ModelReasoningSupport
    control?: ModelReasoningControl
    ariaLabel?: string
  }>(),
  { ariaLabel: '' },
)

const emit = defineEmits<{
  'update:modelValue': [policy: ReasoningPolicy]
}>()

const { t } = useI18n()

const effortLabels: Record<ReasoningEffort, string> = {
  low: 'chat.reasoning.effortOption.low',
  medium: 'chat.reasoning.effortOption.medium',
  high: 'chat.reasoning.effortOption.high',
  xhigh: 'chat.reasoning.effortOption.xhigh',
  max: 'chat.reasoning.effortOption.max',
}

function policyKey(policy: ReasoningPolicy): string {
  return policy.mode === 'effort' ? `effort:${policy.effort}` : policy.mode
}

function policyFromKey(value: string): ReasoningPolicy {
  if (value.startsWith('effort:')) {
    return { mode: 'effort', effort: value.slice('effort:'.length) as ReasoningEffort }
  }
  return { mode: value as Exclude<ReasoningPolicy['mode'], 'effort'> }
}

const normalizedPolicy = computed<ReasoningPolicy>(() =>
  props.scope === 'global'
    ? normalizeDefaultReasoningPolicy(props.modelValue)
    : normalizeReasoningPolicy(props.modelValue),
)

const allowedEfforts = computed(() => allowedReasoningEfforts(props.control))

const effectiveSupport = computed<ModelReasoningSupport>(() => {
  if (props.support === 'unsupported') return 'unsupported'
  if (props.support !== 'supported' || !props.control) return 'unknown'
  if (props.control.dialect === 'reasoning_effort' && allowedEfforts.value.length === 0) {
    return 'unknown'
  }
  return 'supported'
})

const policyOptions = computed(() => {
  const options: Array<{ value: string; label: string }> = []
  if (props.scope === 'agent') {
    options.push({ value: 'inherit', label: t('chat.reasoning.inherit') })
  }
  options.push({ value: 'auto', label: t('chat.reasoning.auto') })
  if (props.control?.dialect === 'reasoning_effort') {
    for (const effort of allowedEfforts.value) {
      options.push({ value: `effort:${effort}`, label: t(effortLabels[effort]) })
    }
  } else {
    options.push({ value: 'on', label: t('chat.reasoning.on') })
  }
  options.push({ value: 'off', label: t('chat.reasoning.off') })
  return options
})

const fallbackPolicy = computed<ReasoningPolicy>(() =>
  props.scope === 'agent' ? { mode: 'inherit' } : { mode: 'auto' },
)

const selectedKey = computed(() => policyKey(normalizedPolicy.value))

const selectOptions = computed(() => {
  if (effectiveSupport.value === 'supported') return policyOptions.value
  return [
    {
      value: '__capability_status__',
      label:
        effectiveSupport.value === 'unsupported'
          ? t('chat.reasoning.unsupported')
          : t('chat.reasoning.pending'),
    },
  ]
})

const selectValue = computed(() =>
  effectiveSupport.value === 'supported' ? selectedKey.value : '__capability_status__',
)

watch(
  [selectedKey, policyOptions],
  ([value, options]) => {
    if (options.some((option) => option.value === value)) return
    emit('update:modelValue', fallbackPolicy.value)
  },
  { immediate: true },
)

function updatePolicy(value: string) {
  if (effectiveSupport.value !== 'supported') return
  if (!policyOptions.value.some((option) => option.value === value)) return
  emit('update:modelValue', policyFromKey(value))
}
</script>

<template>
  <HcSelect
    :model-value="selectValue"
    :options="selectOptions"
    :disabled="effectiveSupport !== 'supported'"
    :aria-label="ariaLabel || t('chat.reasoning.settingsAriaLabel')"
    @update:model-value="updatePolicy"
  />
</template>
