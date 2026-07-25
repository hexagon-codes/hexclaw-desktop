import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  get: vi.fn(),
  query: vi.fn(),
  retry: vi.fn(),
  start: vi.fn(),
}))

vi.mock('@/api/k12', () => ({
  k12GetDeliveryBatch: (...args: unknown[]) => h.get(...args),
  k12QueryDeliveryBatch: (...args: unknown[]) => h.query(...args),
  k12RetryDeliveryBatch: (...args: unknown[]) => h.retry(...args),
}))

import { useK12DeliveryBatch } from '../useK12DeliveryBatch'

const child = (status: string, ordinal = 0) => ({
  delivery_id: `delivery-${ordinal}`,
  batch_id: 'batch-1',
  batch_ordinal: ordinal,
  agent_name: 'ming',
  object_kind: 'tutoring_tips',
  object_id: 'tips-1',
  binding_id: `binding-${ordinal}`,
  target: { platform: 'dingtalk', chat_id: `chat-${ordinal}` },
  status,
  dedupe_key: `child-${ordinal}`,
  payload_digest: 'sha256:payload',
  payload_json: '{}',
  render_manifest_json: '{}',
  attempt: 1,
  created_at: 1,
  updated_at: 1,
})

const batch = (status: string) => ({
  batch_id: 'batch-1',
  agent_name: 'ming',
  object_kind: 'tutoring_tips',
  object_id: 'tips-1',
  dedupe_key: 'batch-dedupe',
  content_digest: 'sha256:content',
  status,
  receipts: [child(status === 'partial_failed' ? 'failed' : status)],
  created_at: 1,
  updated_at: 1,
})

function wrapper() {
  return mount(
    defineComponent({
      setup() {
        const delivery = useK12DeliveryBatch({
          agent: () => 'ming',
          idleLabel: '发送到手机',
          pollDelayMs: 1,
        })
        return { delivery, send: () => delivery.send(() => h.start()) }
      },
      template:
        '<button data-testid="send" :disabled="delivery.disabled.value" @click="send">{{ delivery.label.value }}</button>',
    }),
  )
}

describe('K12 DeliveryBatch 单按钮状态机', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    h.get.mockReset()
    h.query.mockReset()
    h.retry.mockReset()
    h.start.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('sending/unknown 只查询原批次，全部 delivered 后才显示发送成功', async () => {
    h.start.mockResolvedValue(batch('outcome_unknown'))
    h.query.mockResolvedValue(batch('delivered'))
    const w = wrapper()

    await w.get('[data-testid="send"]').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('发送中…')
    expect(h.retry).not.toHaveBeenCalled()

    await vi.runOnlyPendingTimersAsync()
    await flushPromises()
    expect(h.query).toHaveBeenCalledWith('ming', 'batch-1')
    expect(w.text()).toContain('发送成功')
  })

  it('partial_failed 只调用批次 retry，按钮不出现接收人或渠道选择', async () => {
    h.start.mockResolvedValue(batch('partial_failed'))
    h.retry.mockResolvedValue(batch('delivered'))
    const w = wrapper()

    await w.get('[data-testid="send"]').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('发送失败 · 重试')
    expect(w.text()).not.toMatch(/选择|接收人|钉钉|飞书/)

    await w.get('[data-testid="send"]').trigger('click')
    await flushPromises()
    expect(h.retry).toHaveBeenCalledWith('ming', 'batch-1')
    expect(h.start).toHaveBeenCalledTimes(1)
    expect(w.text()).toContain('发送成功')
  })

  it('创建响应丢失时重放同一业务命令，不凭前端猜测成功', async () => {
    h.start.mockRejectedValueOnce(new Error('response lost')).mockResolvedValue(batch('delivered'))
    const w = wrapper()

    await w.get('[data-testid="send"]').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('发送失败 · 重试')

    await w.get('[data-testid="send"]').trigger('click')
    await flushPromises()
    expect(h.start).toHaveBeenCalledTimes(2)
    expect(w.text()).toContain('发送成功')
  })

  it('可按持久 batch id 恢复，不重新创建发送命令', async () => {
    h.get.mockResolvedValue(batch('delivered'))
    const w = wrapper()
    await w.vm.delivery.restore('batch-1')
    await flushPromises()

    expect(h.get).toHaveBeenCalledWith('ming', 'batch-1')
    expect(h.start).not.toHaveBeenCalled()
    expect(w.text()).toContain('发送成功')
  })
})
