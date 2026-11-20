<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { isDeliveryBatchInFlight, useK12DeliveryBatch } from '../useK12DeliveryBatch'

defineOptions({ inheritAttrs: false })
const props = defineProps<{
  agent: string
  recordId: string
  batchId: string
  status: string
  retryable?: boolean
  statusLabel: (status: string) => string
}>()
const emit = defineEmits<{ settled: [] }>()
const retrying = ref(false)
const delivery = useK12DeliveryBatch({ agent: () => props.agent, idleLabel: '发送失败 · 重试' })
const observingHistory = computed(() => isDeliveryBatchInFlight(props.status))
const displayedStatus = computed(() => delivery.batch.value?.status ?? props.status)

async function retry() {
  if (retrying.value || delivery.disabled.value) return
  retrying.value = true
  try {
    await delivery.retryExisting(props.batchId, props.recordId)
  } finally {
    retrying.value = false
    if (!delivery.observing.value) emit('settled')
  }
}

watch(observingHistory, async (observing, previous) => {
  // 重新打开未决历史时先核对原批次。旧服务上的失败记录也需要先确认批次存在。
  if (!observing && (previous !== undefined || props.retryable)) return
  if (delivery.observing.value || retrying.value) return
  const restored = await delivery.restore(props.batchId, props.recordId)
  if (restored && observing && !delivery.observing.value) emit('settled')
}, { immediate: true })
watch(delivery.observing, (observing, previouslyObserving) => {
  if (previouslyObserving && !observing && !retrying.value) emit('settled')
})
</script>

<template>
  <span
    v-if="observingHistory || displayedStatus === 'outcome_unknown'"
    :class="{
      'k12ps__delivery--pending': isDeliveryBatchInFlight(displayedStatus),
      'k12ps__delivery--failed': displayedStatus === 'failed' || displayedStatus === 'partial_failed',
    }"
  >{{ statusLabel(displayedStatus) }}</span>
  <button
    v-else-if="retryable || delivery.batch.value"
    v-bind="$attrs"
    type="button"
    :disabled="retrying || delivery.disabled.value"
    @click="retry"
  >
    {{ delivery.label.value }}
  </button>
  <span v-else class="k12ps__delivery--failed">{{ statusLabel(status) }}</span>
</template>
