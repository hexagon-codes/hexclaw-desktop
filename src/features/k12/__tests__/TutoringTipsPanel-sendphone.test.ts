import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import TutoringTipsPanel from '../views/TutoringTipsPanel.vue'

const h = vi.hoisted(() => ({
  send: vi.fn(),
  retry: vi.fn(),
  query: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}))

vi.mock('@/api/k12', () => ({
  k12TutoringTips: vi.fn().mockResolvedValue({
    knowledge_points: ['小数乘法'],
    sections: [
      { title: '这页在练什么', content: '小数乘法要对齐小数点', source_label: '📖 依据课本' },
      { title: '小明要留意', content: '暂无历史证据。', source_label: '🧠 学情信号' },
      {
        title: '每道题怎么带（不直接给答案）',
        content: '先问孩子小数位数。',
        source_label: '🤖 AI 归纳·供参考',
      },
    ],
  }),
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12Grade: vi.fn(),
  k12InsightReport: vi.fn(),
  k12StudyTime: vi.fn(),
  k12ListAccumulation: vi.fn(),
  k12TutorTurn: vi.fn(),
  k12BindIM: vi.fn().mockResolvedValue({}),
  k12ProvisionCron: vi.fn().mockResolvedValue({ provisioned: [] }),
  k12SendTutoringTips: (...args: unknown[]) => h.send(...args),
  k12GetDeliveryBatch: vi.fn(),
  k12RetryDeliveryBatch: (...args: unknown[]) => h.retry(...args),
  k12QueryDeliveryBatch: (...args: unknown[]) => h.query(...args),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: h.toastSuccess, error: h.toastError, info: h.toastInfo }),
}))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

const sendingReceipt = {
  delivery_id: 'delivery-tutoring-tips-1',
  batch_id: 'batch-tutoring-tips-1',
  batch_ordinal: 0,
  agent_name: 'ming',
  object_kind: 'tutoring_tips',
  object_id: 'tutoring-tips-1',
  binding_id: 'agent-rule:1',
  target: { platform: 'dingtalk', chat_id: 'staff-1', label: '钉钉 · 妈妈' },
  status: 'sending',
  dedupe_key: 'd1',
  payload_digest: 'sha256:x',
  payload_json: '{}',
  render_manifest_json: '{}',
  external_message_id: 'pqk-1',
  attempt: 1,
  created_at: 1,
  updated_at: 1,
} as const

const batch = (status: string) => ({
  batch_id: 'batch-tutoring-tips-1',
  agent_name: 'ming',
  object_kind: 'tutoring_tips',
  object_id: 'tutoring-tips-1',
  dedupe_key: 'batch-1',
  content_digest: 'sha256:x',
  status,
  receipts: [{ ...sendingReceipt, status }],
  created_at: 1,
  updated_at: 1,
})

describe('DD-024: 辅导要点全绑定直发的单按钮状态机', () => {
  const writeSpy = vi.fn()
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    h.send.mockReset().mockResolvedValue(batch('outcome_unknown'))
    h.retry.mockReset()
    h.query.mockReset().mockResolvedValue(batch('delivered'))
    h.toastSuccess.mockReset()
    h.toastError.mockReset()
    h.toastInfo.mockReset()
    Object.assign(navigator, { clipboard: { writeText: writeSpy } })
    writeSpy.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('点击后不选择平台或接收人；unknown 只查询原批次，全部送达才显示发送成功', async () => {
    const w = mount(TutoringTipsPanel, {
      props: {
        agentId: 'ming',
        dispatchId: 'dispatch-confirmed-1',
        sessionId: 'session-1',
        grade: '五年级上',
        knowledgePoints: ['小数乘法'],
      },
      global: { plugins: [createPinia(), i18n()], stubs: { MarkdownRenderer: true } },
    })
    await flushPromises()
    await w.get('[data-testid="tutoring-tips-send"]').trigger('click')
    await flushPromises()
    expect(h.send).toHaveBeenCalledWith('ming', expect.stringContaining('这页在练什么'))
    expect(writeSpy).not.toHaveBeenCalled()
    expect(w.get('[data-testid="tutoring-tips-send"]').text()).toBe('发送中…')
    expect(w.find('[data-testid="tutoring-tips-delivery-receipt"]').exists()).toBe(false)
    expect(w.text()).not.toMatch(/选择.*(钉钉|飞书|接收人|发送目标)/)

    await vi.runOnlyPendingTimersAsync()
    await flushPromises()
    expect(h.query).toHaveBeenCalledWith('ming', 'batch-tutoring-tips-1')
    expect(w.get('[data-testid="tutoring-tips-send"]').text()).toBe('发送成功')
    expect(h.toastSuccess).not.toHaveBeenCalled()
    expect(h.toastInfo).not.toHaveBeenCalled()
  })

  it('零绑定只在原按钮显示失败并允许重放，不弹目标设置或 Toast', async () => {
    h.send.mockRejectedValue(new Error('这个辅导助手还没绑定手机私聊'))
    const w = mount(TutoringTipsPanel, {
      props: {
        agentId: 'ming',
        dispatchId: 'dispatch-confirmed-1',
        sessionId: 'session-1',
        grade: '五年级上',
        knowledgePoints: ['小数乘法'],
      },
      global: { plugins: [createPinia(), i18n()], stubs: { MarkdownRenderer: true } },
    })
    await flushPromises()
    await w.get('[data-testid="tutoring-tips-send"]').trigger('click')
    await flushPromises()
    expect(writeSpy).not.toHaveBeenCalled()
    expect(w.get('[data-testid="tutoring-tips-send"]').text()).toBe('发送失败 · 重试')
    expect(w.find('[data-testid="tutoring-tips-bind-cta"]').exists()).toBe(false)
    expect(h.toastError).not.toHaveBeenCalled()

    h.send.mockResolvedValueOnce(batch('delivered'))
    await w.get('[data-testid="tutoring-tips-send"]').trigger('click')
    await flushPromises()
    expect(h.send).toHaveBeenCalledTimes(2)
    expect(w.get('[data-testid="tutoring-tips-send"]').text()).toBe('发送成功')
  })
})
