<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import HcSelect from '@/components/common/HcSelect.vue'
import { projectReasoningPolicyForModel, reasoningModelState } from '@/config/model-contract'
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
    nativeSupport?: ModelReasoningSupport
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

const modelState = computed(() => reasoningModelState({
  reasoningSupport: props.support,
  reasoningControl: props.control,
  effectiveNativeReasoningSupport: props.nativeSupport,
}))

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

const selectedKey = computed(() => policyKey(projectReasoningPolicyForModel(normalizedPolicy.value, {
  reasoningSupport: props.support,
  reasoningControl: props.control,
})))

const selectOptions = computed(() => {
  if (modelState.value === 'controllable') return policyOptions.value
  return [
    {
      value: '__capability_status__',
      label:
        modelState.value === 'native'
          ? t('chat.reasoning.modelAutomatic')
          : modelState.value === 'unsupported'
            ? t('chat.reasoning.unsupported')
            : t('chat.reasoning.pending'),
    },
  ]
})

const selectValue = computed(() => {
  if (modelState.value !== 'controllable') return '__capability_status__'
  return policyOptions.value.some((option) => option.value === selectedKey.value)
    ? selectedKey.value
    : 'auto'
})

function updatePolicy(value: string) {
  if (modelState.value !== 'controllable') return
  if (!policyOptions.value.some((option) => option.value === value)) return
  emit('update:modelValue', policyFromKey(value))
}
</script>

<template>
  <HcSelect
    :model-value="selectValue"
    :options="selectOptions"
    :disabled="modelState !== 'controllable'"
    :title="modelState === 'native' ? t('chat.reasoning.modelAutomaticHint') : undefined"
    :aria-label="ariaLabel || t('chat.reasoning.settingsAriaLabel')"
    @update:model-value="updatePolicy"
  />
</template>
