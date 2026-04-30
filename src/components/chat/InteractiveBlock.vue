<!--
  v0.4.0 G3/E6 InteractiveBlock — 4 type 调度入口。

  根据 InteractivePayload.type 分发到对应子组件，统一 emit('select', payload)。

  设计原则：
    - 一处分发，避免 ChatView 写满 v-if-else
    - select payload 用统一 schema：{ action, label, ... }，调用方按需取
    - resolved 由 store/调用方写回，子组件只读，禁用其余选项
-->
<template>
  <InteractiveButtons
    v-if="payload.type === 'buttons' && (payload.buttons?.length ?? 0) > 0"
    :prompt="payload.prompt"
    :buttons="payload.buttons!"
    :resolved="resolvedAsButton"
    @select="onSelect"
  />
  <InteractiveSelect
    v-else-if="payload.type === 'select' && (payload.options?.length ?? 0) > 0"
    :prompt="payload.prompt"
    :options="payload.options!"
    :resolved="payload.resolved"
    @select="onSelect"
  />
  <InteractiveApproval
    v-else-if="payload.type === 'approval' && payload.approval"
    :approval="payload.approval"
    :resolved="payload.resolved"
    @select="onSelect"
  />
  <InteractiveCard
    v-else-if="payload.type === 'card' && payload.card"
    :card="payload.card"
    :resolved="payload.resolved"
    @select="onSelect"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { InteractivePayload } from '@/types'
import InteractiveButtons from './InteractiveButtons.vue'
import InteractiveSelect from './InteractiveSelect.vue'
import InteractiveApproval from './InteractiveApproval.vue'
import InteractiveCard from './InteractiveCard.vue'

const props = defineProps<{
  payload: InteractivePayload
}>()

const emit = defineEmits<{
  (
    e: 'select',
    payload: { action: string; label: string; value?: string; payload?: string; approved?: boolean },
  ): void
}>()

// InteractiveButtons 期望的 resolved 是 { action, label }，需要从通用 InteractiveResolved 适配
const resolvedAsButton = computed(() => {
  const r = props.payload.resolved
  if (!r) return undefined
  return { action: r.action, label: r.label || r.action }
})

function onSelect(p: { action: string; label: string; value?: string; payload?: string; approved?: boolean }) {
  emit('select', p)
}
</script>
