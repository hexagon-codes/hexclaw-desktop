import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  k12GetDeliveryBatch,
  k12QueryDeliveryBatch,
  k12RetryDeliveryBatch,
  type DeliveryBatchDTO,
} from '@/api/k12'

interface DeliveryBatchControllerOptions {
  agent: () => string
  idleLabel: string
  /** 仅用于缩短确定性测试；产品运行时使用默认轮询间隔。 */
  pollDelayMs?: number
}

const IN_FLIGHT = new Set<DeliveryBatchDTO['status']>(['pending', 'sending', 'outcome_unknown'])
const RETRYABLE = new Set<DeliveryBatchDTO['status']>(['failed', 'partial_failed'])

/**
 * K12 三个批准发送入口共用的唯一 UI 状态机。
 *
 * 接收人枚举、物理目标去重、失败 child 重试及 unknown child 查询全部由服务端
 * DeliveryBatch 负责；前端只把批次真相投影回原按钮，不保存或展示目标选择。
 */
export function useK12DeliveryBatch(options: DeliveryBatchControllerOptions) {
  const batch = ref<DeliveryBatchDTO | null>(null)
  const busy = ref(false)
  const createFailed = ref(false)
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let generation = 0

  function clearPoll() {
    if (pollTimer !== null) clearTimeout(pollTimer)
    pollTimer = null
  }

  function reset() {
    generation += 1
    clearPoll()
    batch.value = null
    busy.value = false
    createFailed.value = false
  }

  async function reconcile() {
    const operationGeneration = generation
    const current = batch.value
    const agent = options.agent().trim()
    if (!current || !agent || !IN_FLIGHT.has(current.status) || busy.value) return
    busy.value = true
    try {
      // pending/sending/outcome_unknown 都只查询原批次；这里绝不调用 retry。
      adopt(await k12QueryDeliveryBatch(agent, current.batch_id), operationGeneration)
    } catch {
      // 查询失败不能证明外发失败，更不能重发；保持「发送中…」并继续安全查询。
      scheduleReconcile(operationGeneration)
    } finally {
      if (operationGeneration === generation) busy.value = false
    }
  }

  function scheduleReconcile(operationGeneration = generation) {
    if (operationGeneration !== generation) return
    clearPoll()
    if (!batch.value || !IN_FLIGHT.has(batch.value.status)) return
    pollTimer = setTimeout(() => {
      if (operationGeneration === generation) void reconcile()
    }, options.pollDelayMs ?? 1_500)
  }

  function adopt(next: DeliveryBatchDTO | null | undefined, operationGeneration = generation) {
    if (operationGeneration !== generation) return
    clearPoll()
    if (!next) return
    batch.value = next
    createFailed.value = false
    if (IN_FLIGHT.has(next.status)) scheduleReconcile()
  }

  async function send(create: () => Promise<DeliveryBatchDTO>) {
    if (busy.value || batch.value?.status === 'delivered') return
    const agent = options.agent().trim()
    if (!agent) {
      createFailed.value = true
      return
    }
    const operationGeneration = generation
    busy.value = true
    createFailed.value = false
    try {
      const current = batch.value
      if (current && RETRYABLE.has(current.status)) {
        // 服务端只重发 failed child；delivered/unknown child 均不进入重发集合。
        adopt(await k12RetryDeliveryBatch(agent, current.batch_id), operationGeneration)
      } else if (current && IN_FLIGHT.has(current.status)) {
        adopt(await k12QueryDeliveryBatch(agent, current.batch_id), operationGeneration)
      } else {
        // 初次发送或创建响应丢失后的重放。稳定业务 dedupe 由服务端返回原 batch。
        adopt(await create(), operationGeneration)
      }
    } catch {
      if (operationGeneration !== generation) return
      if (!batch.value) createFailed.value = true
      else if (RETRYABLE.has(batch.value.status)) createFailed.value = true
      else scheduleReconcile(operationGeneration)
    } finally {
      if (operationGeneration === generation) busy.value = false
    }
  }

  async function restore(batchId: string | undefined) {
    const id = batchId?.trim()
    const agent = options.agent().trim()
    if (!id || !agent) return
    const operationGeneration = generation
    busy.value = true
    try {
      adopt(await k12GetDeliveryBatch(agent, id), operationGeneration)
    } catch {
      if (operationGeneration !== generation) return
      // 恢复读取失败不创建新批次；原按钮保持可重试，下一次业务命令由服务端稳定去重。
      createFailed.value = true
    } finally {
      if (operationGeneration === generation) busy.value = false
    }
  }

  const label = computed(() => {
    if (createFailed.value || (batch.value && RETRYABLE.has(batch.value.status))) {
      return '发送失败 · 重试'
    }
    if (busy.value || (batch.value && IN_FLIGHT.has(batch.value.status))) return '发送中…'
    if (batch.value?.status === 'delivered') return '发送成功'
    return options.idleLabel
  })
  const disabled = computed(
    () =>
      busy.value ||
      batch.value?.status === 'delivered' ||
      Boolean(batch.value && IN_FLIGHT.has(batch.value.status)),
  )

  watch(options.agent, reset)
  onBeforeUnmount(() => {
    generation += 1
    clearPoll()
  })

  return { batch, label, disabled, send, restore, adopt, reset }
}
