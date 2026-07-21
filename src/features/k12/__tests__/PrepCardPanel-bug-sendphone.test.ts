import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import PrepCardPanel from '../views/PrepCardPanel.vue'

const h = vi.hoisted(() => ({
  send: vi.fn(),
  retry: vi.fn(),
  query: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}))

vi.mock('@/api/k12', () => ({
  k12PrepCard: vi.fn().mockResolvedValue({
    knowledge_points: ['小数乘法'],
    sections: [
      { title: '知识点回顾', content: '小数乘法要对齐小数点', source_label: '📖 依据课本' },
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
  k12SendPrepCard: (...args: unknown[]) => h.send(...args),
  k12RetryDeliveryReceipt: (...args: unknown[]) => h.retry(...args),
  k12QueryDeliveryReceipt: (...args: unknown[]) => h.query(...args),
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
  delivery_id: 'delivery-prep-1',
  agent_name: 'ming',
  object_kind: 'prep_card',
  object_id: 'prep-1',
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

describe('DD-024: 备课卡真实直发并展示持久回执', () => {
  const writeSpy = vi.fn()
  beforeEach(() => {
    setActivePinia(createPinia())
    h.send.mockReset().mockResolvedValue(sendingReceipt)
    h.retry.mockReset()
    h.query.mockReset().mockResolvedValue({ ...sendingReceipt, status: 'delivered' })
    h.toastSuccess.mockReset()
    h.toastError.mockReset()
    h.toastInfo.mockReset()
    Object.assign(navigator, { clipboard: { writeText: writeSpy } })
    writeSpy.mockReset()
  })

  it('点📱 调真实投递端点；受理只显示发送中，查询证据后才显示已送达', async () => {
    const w = mount(PrepCardPanel, {
      props: { agentId: 'ming', grade: '五年级上', knowledgePoints: ['小数乘法'] },
      global: { plugins: [createPinia(), i18n()], stubs: { MarkdownRenderer: true } },
    })
    await flushPromises()
    await w.get('[data-testid="prep-send"]').trigger('click')
    await flushPromises()
    expect(h.send).toHaveBeenCalledWith('ming', expect.stringContaining('知识点回顾'))
    expect(writeSpy).not.toHaveBeenCalled()
    expect(w.get('[data-testid="prep-delivery-receipt"]').text()).toContain('等待送达确认')
    expect(w.text()).not.toContain('已送达钉钉')

    await w.get('[data-testid="prep-delivery-query"]').trigger('click')
    await flushPromises()
    expect(h.query).toHaveBeenCalledWith('ming', 'delivery-prep-1')
    expect(w.get('[data-testid="prep-delivery-receipt"]').text()).toContain('已送达')
  })

  it('未绑定时提供连接设置 CTA，不复制文本冒充发送', async () => {
    h.send.mockRejectedValue(new Error('这个辅导助手还没绑定手机私聊'))
    const w = mount(PrepCardPanel, {
      props: { agentId: 'ming', grade: '五年级上', knowledgePoints: ['小数乘法'] },
      global: { plugins: [createPinia(), i18n()], stubs: { MarkdownRenderer: true } },
    })
    await flushPromises()
    await w.get('[data-testid="prep-send"]').trigger('click')
    await flushPromises()
    expect(writeSpy).not.toHaveBeenCalled()
    expect(w.get('[data-testid="prep-bind-cta"]').attributes('href')).toBe('/channels')
  })
})
