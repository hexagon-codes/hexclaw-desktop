import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12ProfileForm from '../views/K12ProfileForm.vue'
import HcSelect from '@/components/common/HcSelect.vue'

const h = vi.hoisted(() => ({
  registerSpy: vi.fn().mockResolvedValue({}),
  unregisterSpy: vi.fn().mockResolvedValue({}),
  updateSpy: vi.fn().mockResolvedValue({}),
  profileSpy: vi.fn().mockResolvedValue({}),
  provisionSpy: vi.fn().mockResolvedValue({ provisioned: [] }),
  getAgentsSpy: vi.fn().mockResolvedValue({ agents: [], total: 0, default: '' }),
  toastSuccessSpy: vi.fn(),
  toastWarningSpy: vi.fn(),
}))
vi.mock('@/api/agents', () => ({
  registerAgent: (a: unknown) => h.registerSpy(a),
  unregisterAgent: (name: string) => h.unregisterSpy(name),
  updateAgent: (name: string, u: unknown) => h.updateSpy(name, u),
  getAgents: () => h.getAgentsSpy(),
  getRoles: vi.fn().mockResolvedValue({ roles: [] }),
}))
vi.mock('@/api/k12', () => ({
  k12UpdateProfile: (r: unknown) => h.profileSpy(r),
  // useK12Store 依赖（建档尾部 fire-and-forget setupAutomation，需可 resolve）
  k12BindIM: vi.fn().mockResolvedValue({}),
  k12ProvisionCron: (req: unknown) => h.provisionSpy(req),
    k12TutorTurn: vi.fn(),
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12PrepCard: vi.fn(),
  k12Grade: vi.fn(),
  k12InsightReport: vi.fn(),
  k12StudyTime: vi.fn(),
  k12ListAccumulation: vi.fn(),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    success: h.toastSuccessSpy,
    warning: h.toastWarningSpy,
    error: vi.fn(),
    info: vi.fn(),
  }),
}))

function i18n() {
  return createI18n({
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}
function render() {
  return mount(K12ProfileForm, { global: { plugins: [createPinia(), i18n()] }, attachTo: document.body })
}
// 弹窗 Teleport 到 body 后，DOM 查询走 body 作用域（wrapper 里只剩 teleport 占位）。
const B = () => new DOMWrapper(document.body)

describe('K12ProfileForm（M1-2 建档）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = '' // 清 teleport 残留，防跨测试累积
    h.registerSpy.mockClear()
    h.unregisterSpy.mockReset().mockResolvedValue({})
    h.updateSpy.mockClear()
    h.profileSpy.mockReset().mockResolvedValue({})
    h.provisionSpy.mockReset().mockResolvedValue({ provisioned: [] })
    h.getAgentsSpy.mockReset().mockResolvedValue({ agents: [], total: 0, default: '' })
    h.toastSuccessSpy.mockReset()
    h.toastWarningSpy.mockReset()
  })

  it('显示名随称呼/年级自动生成「{称呼}的辅导老师 · {年级}」', async () => {
    render()
    await B().find('.k12pf__input').setValue('小明')
    expect(B().find('.k12pf__intro').text()).toContain('小明的辅导助手 · 五年级')
  })

  it('创建 → registerAgent(scenario 标记) + PUT /profile(k12.* 档案) + 显示名 + K12 skills', async () => {
    const w = render()
    await B().find('input.k12pf__input').setValue('小明')
    await B().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()
    // 1) 注册 agent：仅 scenario 标记 + avatar（驱动 registry 解析增强视图），provider 空跟随全局
    expect(h.registerSpy).toHaveBeenCalledTimes(1)
    const payload = h.registerSpy.mock.calls[0]![0] as {
      name: string; display_name: string; provider: string; skills: string[]; metadata: Record<string, string>
    }
    expect(payload.name).toMatch(/^k12-tutor-/)
    expect(payload.display_name).toContain('小明的辅导助手 · 五年级')
    expect(payload.provider).toBe('')
    expect(payload.metadata.scenario).toBe('k12-tutor')
    // skills 从模板 manifest 全挂好：P0 必备 + P1 默认 + 基础设施（grade-constraint/k12_grade/k12_review）；P2（物化）默认不挂
    for (const s of ['k12-pedagogy', 'homework-checker', 'math-tutor', 'chinese-tutor', 'english-tutor', 'concept-explainer', 'k12_grade']) {
      expect(payload.skills).toContain(s)
    }
    // 回归锁（F1/F3 修复）：年级边界硬约束基座 + 复习读工具必须始终挂载——引擎不 co-load requires，
    // 漏挂 grade-constraint = 不超纲替代话术 runtime 缺失；漏挂 k12_review = 复习飞轮对话入口断。
    expect(payload.skills).toContain('grade-constraint')
    expect(payload.skills).toContain('k12_review')
    expect(payload.skills).not.toContain('physics-tutor')
    expect(payload.skills).not.toContain('chemistry-tutor')
    // 2) 档案经后端官方 PUT /profile 写入（字段名 grade_term/textbook_edition）
    expect(h.profileSpy).toHaveBeenCalledTimes(1)
    const prof = h.profileSpy.mock.calls[0]![0] as Record<string, string>
    expect(prof.agent).toBe(payload.name)
    expect(prof.child_name).toBe('小明')
    expect(prof.grade_term).toBe('五年级上')
    expect(prof.textbook_edition).toBe('人教版')
    expect(w.emitted('created')).toBeTruthy()
  })

  it('默认自动任务未注册时等待真实结果并显式告警，不再宣称提醒已注册', async () => {
    h.provisionSpy.mockResolvedValueOnce({ provisioned: [] })
    const w = render()
    await B().find('input.k12pf__input').setValue('小明')
    await B().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()

    expect(h.provisionSpy).toHaveBeenCalledOnce()
    expect(w.emitted('created')).toBeTruthy()
    expect(h.toastWarningSpy).toHaveBeenCalledWith(expect.stringContaining('未完整注册'))
    expect(h.toastSuccessSpy.mock.calls.flat().join('')).not.toContain('已注册')
  })

  it('建档第二步写档案失败 → 注销刚注册的 agent 作补偿，不留下半成品', async () => {
    h.profileSpy.mockRejectedValueOnce(new Error('profile write failed'))
    const w = render()
    await B().find('input.k12pf__input').setValue('小明')
    await B().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()

    expect(h.registerSpy).toHaveBeenCalledTimes(1)
    const registered = h.registerSpy.mock.calls[0]![0] as { name: string }
    expect(h.unregisterSpy).toHaveBeenCalledExactlyOnceWith(registered.name)
    expect(w.emitted('created')).toBeFalsy()
    expect(B().text()).toContain('profile write failed')
  })

  it('改档第二步写档案失败 → 回滚第一步 Agent 配置，不留下新名称配旧年级', async () => {
    h.profileSpy.mockRejectedValueOnce(new Error('profile update failed'))
    const w = mount(K12ProfileForm, {
      props: {
        agent: {
          name: 'k12-tutor-x', display_name: '小明的辅导助手 · 五年级',
          description: '人教版 · 五年级上 · 按年级边界讲解',
          system_prompt: '旧人设', provider: 'old-provider', model: 'old-model', skills: ['math-tutor'],
          metadata: { scenario: 'k12-tutor', 'k12.child_name': '小明', 'k12.grade_term': '五年级上', 'k12.textbook_edition': '人教版' },
        },
      },
      global: { plugins: [createPinia(), i18n()] }, attachTo: document.body,
    })
    w.findAllComponents(HcSelect)[0]!.vm.$emit('update:modelValue', '六年级上')
    await flushPromises()
    await B().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()

    expect(h.updateSpy).toHaveBeenCalledTimes(2)
    expect(h.updateSpy.mock.calls[1]).toEqual(['k12-tutor-x', expect.objectContaining({
      display_name: '小明的辅导助手 · 五年级',
      description: '人教版 · 五年级上 · 按年级边界讲解',
      system_prompt: '旧人设', provider: 'old-provider', model: 'old-model',
    })])
    expect(w.emitted('created')).toBeFalsy()
    expect(B().text()).toContain('profile update failed')
  })

  it('持久建档成功但列表刷新失败 → 仍返回已创建终态并提示刷新，不诱导重复建档', async () => {
    h.getAgentsSpy.mockRejectedValueOnce(new Error('refresh failed'))
    const w = render()
    await B().find('input.k12pf__input').setValue('小明')
    await B().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()

    expect(h.registerSpy).toHaveBeenCalledOnce()
    expect(h.profileSpy).toHaveBeenCalledOnce()
    expect(w.emitted('created')).toBeTruthy()
    expect(h.toastWarningSpy).toHaveBeenCalledWith(expect.stringContaining('已保存'))
  })

  it('改档模式：预填 k12.* + 改年级 → updateAgent(显示名) + PUT /profile(grade_term)', async () => {
    const w = mount(K12ProfileForm, {
      props: {
        agent: {
          name: 'k12-tutor-x',
          display_name: '小明的辅导助手 · 五年级',
          metadata: { scenario: 'k12-tutor', 'k12.child_name': '小明', 'k12.grade_term': '五年级上', 'k12.textbook_edition': '人教版', avatar: '🎓' },
        },
      },
      global: { plugins: [createPinia(), i18n()] },
      attachTo: document.body,
    })
    // 预填称呼（读 k12.child_name）
    expect((B().find('input.k12pf__input').element as HTMLInputElement).value).toBe('小明')
    // 改年级 → 六年级上（年级下拉走 HcSelect，B2：不再用原生 select）
    w.findAllComponents(HcSelect)[0]!.vm.$emit('update:modelValue', '六年级上')
    await flushPromises()
    await B().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()
    expect(h.registerSpy).not.toHaveBeenCalled() // 改档不新建
    // 显示名走 updateAgent（随年级重算）
    const [name, upd] = h.updateSpy.mock.calls[0] as [string, { display_name: string }]
    expect(name).toBe('k12-tutor-x')
    expect(upd.display_name).toContain('六年级')
    // 档案字段走后端官方 PUT /profile（grade_term 即讲题边界依据）
    const prof = h.profileSpy.mock.calls[0]![0] as Record<string, string>
    expect(prof.agent).toBe('k12-tutor-x')
    expect(prof.grade_term).toBe('六年级上')
    expect(prof.child_name).toBe('小明')
    expect(prof.textbook_edition).toBe('人教版')
    expect(w.emitted('created')).toBeTruthy()
  })

  it('卡片副标题：建档写派生 description「教材 · 年级 · 按年级边界讲解」（非写死，随档案跟随）', async () => {
    render()
    await B().find('input.k12pf__input').setValue('小明')
    await B().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()
    const payload = h.registerSpy.mock.calls[0]![0] as { description: string }
    expect(payload.description).toBe('人教版 · 五年级上 · 按年级边界讲解')
  })

  it('卡片副标题：改档改年级 → updateAgent 同步派生 description（不写死）', async () => {
    const w = mount(K12ProfileForm, {
      props: {
        agent: {
          name: 'k12-tutor-x',
          display_name: '小明的辅导助手 · 五年级',
          metadata: { scenario: 'k12-tutor', 'k12.child_name': '小明', 'k12.grade_term': '五年级上', 'k12.textbook_edition': '人教版', avatar: '🎓' },
        },
      },
      global: { plugins: [createPinia(), i18n()] },
      attachTo: document.body,
    })
    w.findAllComponents(HcSelect)[0]!.vm.$emit('update:modelValue', '六年级上')
    await flushPromises()
    await B().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()
    const [, upd] = h.updateSpy.mock.calls[0] as [string, { description: string }]
    expect(upd.description).toBe('人教版 · 六年级上 · 按年级边界讲解')
  })

  it('高级折叠：默认技能全挂好、P0 必备锁定、可微调（关掉 P1 不进绑定集）', async () => {
    render()
    const rows = B().findAll('.k12pf__skillrow')
    expect(rows.length).toBe(9) // 模板声明的 9 个技能
    // P0（前 3 个）必备 → 锁定 disabled + 有「必备」标
    const pedagogy = rows.find((r) => r.text().includes('教学法'))!
    expect((pedagogy.find('input').element as HTMLInputElement).disabled).toBe(true)
    expect(pedagogy.text()).toContain('必备')
    // 关掉一个 P1（知识点讲解 concept-explainer）
    const conceptRow = rows.find((r) => r.text().includes('知识点讲解'))!
    await conceptRow.find('input').setValue(false)
    await B().find('input.k12pf__input').setValue('小明')
    await B().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()
    const payload = h.registerSpy.mock.calls[0]![0] as { skills: string[] }
    expect(payload.skills).not.toContain('concept-explainer') // 微调生效
    expect(payload.skills).toContain('math-tutor') // P0 仍在
    expect(payload.skills).toContain('k12_grade')
  })

  it('年级选择只出小学 12 档中文枚举（冻结：无初中，见 bug-20260718-frozen-grade-subject）', () => {
    const w = render()
    // 年级下拉走 HcSelect（B2）：枚举取自 :options 属性
    const gradeSelect = w.findAllComponents(HcSelect)[0]!
    const opts = (gradeSelect.props('options') as { value: string; label: string }[]).map((o) => o.label)
    expect(opts).toContain('五年级上')
    expect(opts).not.toContain('初一上')
    expect(opts.some((o) => o.includes('初'))).toBe(false)
    expect(opts).toHaveLength(12)
  })
})
