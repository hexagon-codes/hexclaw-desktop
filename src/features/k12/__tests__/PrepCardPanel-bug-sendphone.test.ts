import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import PrepCardPanel from '../views/PrepCardPanel.vue'

vi.mock('@/api/k12', () => ({
  k12PrepCard: vi.fn().mockResolvedValue({
    knowledge_points: ['小数乘法'],
    sections: [{ title: '知识点回顾', content: '小数乘法要对齐小数点', source_label: '📖 依据课本' }],
  }),
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(), k12Grade: vi.fn(), k12InsightReport: vi.fn(),
  k12StudyTime: vi.fn(), k12ListAccumulation: vi.fn(),
  k12TutorTurn: vi.fn(),
  k12BindIM: vi.fn().mockResolvedValue({}), k12ProvisionCron: vi.fn().mockResolvedValue({ provisioned: [] }),
}))

function i18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN } })
}

// bug（用户报）：备课卡「发到手机」按钮不可用——原实现只 toast。后端无出网推送端点，故用真实客户端
// 动作：把备课卡文本复制到剪贴板（家长可粘贴发到手机 IM）。
describe('bug: 发到手机按钮须真复制备课卡到剪贴板', () => {
  const writeSpy = vi.fn().mockResolvedValue(undefined)
  beforeEach(() => {
    setActivePinia(createPinia())
    writeSpy.mockClear()
    Object.assign(navigator, { clipboard: { writeText: writeSpy } })
  })

  it('已生成备课卡时，点📱 把卡片内容复制到剪贴板', async () => {
    const w = mount(PrepCardPanel, {
      props: { agentId: 'ming', grade: '五年级上', knowledgePoints: ['小数乘法'] },
      global: { plugins: [createPinia(), i18n()], stubs: { MarkdownRenderer: true } },
    })
    await flushPromises()
    const phoneBtn = w.findAll('.icbtn').find((b) => b.text().includes('📱'))!
    await phoneBtn.trigger('click')
    await flushPromises()
    expect(writeSpy).toHaveBeenCalledTimes(1)
    // 复制的内容含备课卡实质（知识点回顾/正文），而非空
    expect(String(writeSpy.mock.calls[0]![0])).toContain('知识点回顾')
  })
})
