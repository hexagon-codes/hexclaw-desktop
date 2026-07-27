/**
 * BUG-20260708 F2 · K12 tutor 建档缺人设(SOUL) → 身份回落默认助理「小蟹」。
 *
 * 症状（真机 qwen3.5:9b 取证）：正确 pin role=k12-tutor-xxx 问「你是谁」→ 回「我是小蟹 🦀」。
 * 根因：K12ProfileForm.registerAgent 只传 skills + display_name，不传 system_prompt →
 *   后端 agent system_prompt='' → 引擎用默认助理人设。skills 只塑造「怎么教」，不塑造「我是谁」。
 *
 * 修复：建档 registerAgent + 改档 updateAgent 均带 system_prompt（据 child/grade/textbook 生成的
 *   辅导老师人设），使 tutor 自我认同为「{child}的辅导老师」而非小蟹。
 * 回归锁：payload.system_prompt 非空且含身份锚（辅导老师 + 孩子称呼）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12ProfileForm from '../views/K12ProfileForm.vue'

const h = vi.hoisted(() => ({
  registerSpy: vi.fn().mockResolvedValue({}),
  updateSpy: vi.fn().mockResolvedValue({}),
  bundleSpy: vi.fn().mockResolvedValue({}),
}))
vi.mock('@/api/agents', () => ({
  registerAgent: (a: unknown) => h.registerSpy(a),
  updateAgent: (name: string, u: unknown) => h.updateSpy(name, u),
  getAgents: vi.fn().mockResolvedValue({ agents: [], total: 0, default: '' }),
  getRoles: vi.fn().mockResolvedValue({ roles: [] }),
}))
vi.mock('@/api/k12', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/k12')>()),
  k12UpdateProfileBundle: (r: unknown) => h.bundleSpy(r),
  k12GetTextbookBindingOptions: vi.fn().mockResolvedValue({ items: [] }),
  k12GetCurriculumProgress: vi.fn().mockResolvedValue({
    progress: {
      revision: 1,
      textbook_manifest_id: 'manifest-1',
      volume: '五年级上册',
      unit_id: 'unit-1',
    },
  }),
  k12GetWeeklyPracticeSettings: vi.fn().mockResolvedValue({
    revision: 1,
    timezone: 'Asia/Shanghai',
    due_review_enabled: true,
    textbook_consolidation_enabled: false,
    arithmetic_warmup_enabled: false,
    arithmetic_minutes: 2,
  }),
  k12ProvisionCron: vi.fn().mockResolvedValue({ provisioned: [] }),
}))

function i18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN } })
}
const B = () => new DOMWrapper(document.body)

describe('BUG-20260708 F2 · tutor 建档带人设(SOUL)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = ''
    h.registerSpy.mockClear(); h.updateSpy.mockClear(); h.bundleSpy.mockReset().mockResolvedValue({})
  })

  it('建档：registerAgent 带非空 system_prompt，含身份锚（辅导老师 + 孩子称呼）', async () => {
    mount(K12ProfileForm, { global: { plugins: [createPinia(), i18n()] }, attachTo: document.body })
    await B().find('input.k12pf__input').setValue('小明')
    await B().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()
    const payload = h.registerSpy.mock.calls[0]![0] as { system_prompt?: string }
    expect(payload.system_prompt, 'tutor 必须带人设，否则身份回落小蟹').toBeTruthy()
    expect(payload.system_prompt).toContain('辅导助手')
    expect(payload.system_prompt).toContain('小明')
    // 身份不得是默认助理
    expect(payload.system_prompt).not.toContain('小蟹')
  })

  it('D3 · 家长编辑「老师的语气」→ 回写编辑后的 system_prompt（非派生默认）', async () => {
    mount(K12ProfileForm, { global: { plugins: [createPinia(), i18n()] }, attachTo: document.body })
    await B().find('input.k12pf__input').setValue('小明')
    const soul = B().find('[data-testid="k12-soul-text"]')
    expect(soul.exists(), '建档应有「老师的语气」编辑框').toBe(true)
    await soul.setValue('你是小明的辅导老师，说话温柔一点，多用鼓励。')
    await B().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()
    const payload = h.registerSpy.mock.calls[0]![0] as { system_prompt?: string }
    expect(payload.system_prompt).toBe('你是小明的辅导老师，说话温柔一点，多用鼓励。')
  })

  it('改档：唯一 bundle 的 agent_config 带 system_prompt（改年级后人设随讲题边界更新）', async () => {
    mount(K12ProfileForm, {
      props: { agent: { name: 'k12-tutor-x', display_name: '小明的辅导老师 · 五年级', metadata: { scenario: 'k12-tutor', 'k12.child_name': '小明', 'k12.grade_term': '五年级上', 'k12.textbook_edition': '人教版', avatar: '🎓' } } },
      global: { plugins: [createPinia(), i18n()] }, attachTo: document.body,
    })
    await flushPromises()
    await B().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()
    const upd = h.bundleSpy.mock.calls[0]![0] as {
      agent_config: { system_prompt?: string }
    }
    expect(upd.agent_config.system_prompt, '改档也须原子回写人设').toBeTruthy()
    expect(upd.agent_config.system_prompt).toContain('辅导助手')
    expect(h.updateSpy).not.toHaveBeenCalled()
  })
})
