import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12ProfileForm from '../views/K12ProfileForm.vue'
import HcSelect from '@/components/common/HcSelect.vue'
import { PRIMARY_GRADES } from '../curriculum'

const h = vi.hoisted(() => ({
  registerSpy: vi.fn().mockResolvedValue({}),
  unregisterSpy: vi.fn().mockResolvedValue({}),
  updateSpy: vi.fn().mockResolvedValue({}),
  profileSpy: vi.fn().mockResolvedValue({}),
  profileBundleSpy: vi.fn().mockResolvedValue({}),
  catalogSpy: vi.fn(),
  progressSpy: vi.fn(),
  settingsSpy: vi.fn(),
  bindingOptionsSpy: vi.fn(),
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
  k12UpdateProfileBundle: (r: unknown) => h.profileBundleSpy(r),
  k12GetCurriculumCatalog: (...args: unknown[]) => h.catalogSpy(...args),
  k12GetCurriculumProgress: (...args: unknown[]) => h.progressSpy(...args),
  k12GetWeeklyPracticeSettings: (...args: unknown[]) => h.settingsSpy(...args),
  k12GetTextbookBindingOptions: (...args: unknown[]) => h.bindingOptionsSpy(...args),
  // useK12Store 依赖（建档尾部 fire-and-forget setupAutomation，需可 resolve）
  k12BindIM: vi.fn().mockResolvedValue({}),
  k12ProvisionCron: (req: unknown) => h.provisionSpy(req),
  k12TutorTurn: vi.fn(),
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12TutoringTips: vi.fn(),
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
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}
function render() {
  return mount(K12ProfileForm, {
    global: { plugins: [createPinia(), i18n()] },
    attachTo: document.body,
  })
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
    h.profileBundleSpy.mockReset().mockResolvedValue({
      profile: {
        child_name: '小明',
        grade_term: '五年级上',
        textbook_edition: '人教版',
        revision: 2,
      },
      curriculum_progress: {},
      weekly_practice_settings: {},
      replayed: false,
    })
    h.catalogSpy.mockReset().mockImplementation(
      (_agent: string, textbookEdition: string, volume: string) =>
        Promise.resolve({
          agent: 'k12-tutor-x',
          subject: 'math',
          textbook_binding_id: `binding-${textbookEdition}-${volume}`,
          textbook_edition: textbookEdition,
          textbook_version: '2022',
          title: '数学',
          volume,
          page_min: 1,
          page_max: 120,
          units: [
            {
              unit_id: 'unit-1',
              title: '第1单元',
              page_from: 1,
              page_to: 20,
              lessons: [],
            },
          ],
        }),
    )
    h.progressSpy.mockReset().mockResolvedValue({
      progress: {
        progress_id: 'progress-1',
        agent: 'k12-tutor-x',
        subject: 'math',
        revision: 1,
        textbook_binding_id: 'binding-人教版-五年级上册',
        textbook_edition: '人教版',
        textbook_version: '2022',
        title: '数学',
        volume: '五年级上册',
        unit_id: 'unit-1',
        unit_title: '第1单元',
        page_verification_status: 'not_requested',
        segment_refs: [],
        evidence_source: 'parent_confirmed',
        confirmed_at: '2026-07-20T00:00:00Z',
        created_at: '2026-07-20T00:00:00Z',
        updated_at: '2026-07-20T00:00:00Z',
      },
    })
    h.settingsSpy.mockReset().mockResolvedValue({
      agent: 'k12-tutor-x',
      revision: 1,
      timezone: 'Asia/Shanghai',
      due_review_enabled: true,
      textbook_consolidation_enabled: false,
      arithmetic_warmup_enabled: false,
      arithmetic_minutes: 2,
      created_at: '2026-07-20T00:00:00Z',
      updated_at: '2026-07-20T00:00:00Z',
    })
    h.bindingOptionsSpy.mockReset().mockResolvedValue({
      items: [
        {
          manifest_id: 'manifest-math-1',
          document_id: 'document-math-1',
          document_generation: 1,
          document_title: '义务教育教科书·数学五年级上册.pdf',
          state: 'ready_for_confirmation',
          retryable: false,
          failure_message: '',
          text_index_state: 'ready',
          vector_index_state: 'ready',
          catalog: {
            subject: 'math',
            textbook_edition: '人教版',
            textbook_version: '2022',
            title: '数学',
            volume: '五年级上册',
            page_min: 1,
            page_max: 120,
            units: [
              {
                unit_id: 'unit-1',
                title: '第1单元',
                page_from: 1,
                page_to: 20,
                lessons: [],
              },
            ],
            page_refs: [],
          },
          updated_at: '2026-07-20T00:00:00Z',
        },
      ],
    })
    h.provisionSpy.mockReset().mockResolvedValue({ provisioned: [] })
    h.getAgentsSpy.mockReset().mockResolvedValue({ agents: [], total: 0, default: '' })
    h.toastSuccessSpy.mockReset()
    h.toastWarningSpy.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('显示名随称呼/年级自动生成「{称呼}的辅导老师 · {年级}」', async () => {
    render()
    await B().find('.k12pf__input').setValue('小明')
    expect(B().find('.k12pf__intro').text()).toContain('小明的辅导助手 · 五年级')
  })

  it('创建 → registerAgent 一次性写六科 canonical metadata + 数学派生镜像，不再补写 legacy profile', async () => {
    const w = render()
    await B().find('input.k12pf__input').setValue('小明')
    await B().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()
    // 1) 注册 agent：仅 scenario 标记 + avatar（驱动 registry 解析增强视图），provider 空跟随全局
    expect(h.registerSpy).toHaveBeenCalledTimes(1)
    const payload = h.registerSpy.mock.calls[0]![0] as {
      name: string
      display_name: string
      provider: string
      skills: string[]
      system_prompt: string
      metadata: Record<string, string>
    }
    expect(payload.name).toMatch(/^k12-tutor-/)
    expect(payload.display_name).toContain('小明的辅导助手 · 五年级')
    expect(payload.provider).toBe('')
    expect(payload.metadata.scenario).toBe('k12-tutor')
    expect(payload.metadata['k12.learner_id']).toMatch(/^learner-[A-Za-z0-9_-]{8,}$/)
    expect(payload.metadata['k12.child_name']).toBe('小明')
    expect(payload.metadata['k12.grade_term']).toBe('五年级上')
    expect(payload.metadata).toMatchObject({
      'k12.textbook_edition': '人教版',
      'k12.textbook_edition.math': '人教版',
      'k12.textbook_edition.chinese': '人教版',
      'k12.textbook_edition.english': '人教PEP版',
      'k12.textbook_edition.science': '教科版',
      'k12.textbook_edition.information_technology': '浙教版',
      'k12.textbook_edition.art': '人美版',
    })
    // 当前版本只开放数学教材边界；其他五科仅作兼容 metadata 保留，不注入运行时提示词。
    expect(payload.system_prompt).toContain('数学讲解始终按人教版')
    for (const edition of ['人教PEP版', '教科版', '浙教版', '人美版']) {
      expect(payload.system_prompt).not.toContain(edition)
    }
    // skills 从模板 manifest 全挂好：P0 必备 + P1 默认 + 基础设施（grade-constraint/k12_grade/k12_review）；P2（物化）默认不挂
    for (const s of [
      'k12-pedagogy',
      'homework-checker',
      'math-tutor',
      'chinese-tutor',
      'english-tutor',
      'concept-explainer',
      'k12_grade',
    ]) {
      expect(payload.skills).toContain(s)
    }
    // 回归锁（F1/F3 修复）：年级边界硬约束基座 + 复习读工具必须始终挂载——引擎不 co-load requires，
    // 漏挂 grade-constraint = 不超纲替代话术 runtime 缺失；漏挂 k12_review = 复习飞轮对话入口断。
    expect(payload.skills).toContain('grade-constraint')
    expect(payload.skills).toContain('k12_review')
    expect(payload.skills).not.toContain('physics-tutor')
    expect(payload.skills).not.toContain('chemistry-tutor')
    expect(h.profileSpy).not.toHaveBeenCalled()
    expect(w.emitted('created')).toBeTruthy()
  })

  it('按定版原型只渲染数学教材行，legacy textbook_edition 作为数学 fallback', () => {
    mount(K12ProfileForm, {
      props: {
        agent: {
          name: 'k12-tutor-x',
          display_name: '小明的辅导助手 · 五年级',
          metadata: {
            scenario: 'k12-tutor',
            'k12.child_name': '小明',
            'k12.grade_term': '五年级上',
            'k12.textbook_edition': '北师大版',
          },
        },
      },
      global: { plugins: [createPinia(), i18n()] },
      attachTo: document.body,
    })

    const rows = B().findAll('[data-testid="k12-textbook-row"]')
    expect(rows).toHaveLength(1)
    expect(rows.map((row) => row.attributes('data-subject'))).toEqual(['math'])
    expect(rows.map((row) => row.find('.hc-select__label').text())).toEqual(['北师大版'])
  })

  it('改数学教材只改数学 metadata，保留其他科和无关 metadata，并同步 legacy fallback', async () => {
    const w = mount(K12ProfileForm, {
      props: {
        agent: {
          name: 'k12-tutor-x',
          display_name: '小明的辅导助手 · 五年级',
          metadata: {
            scenario: 'k12-tutor',
            avatar: '🎓',
            custom: 'keep-me',
            'k12.child_name': '小明',
            'k12.grade_term': '五年级上',
            'k12.textbook_edition': '人教版',
            'k12.textbook_edition.math': '人教版',
            'k12.textbook_edition.chinese': '统编版',
            'k12.textbook_edition.english': '外研版',
            'k12.textbook_edition.science': '苏教版',
            'k12.textbook_edition.information_technology': '粤教版',
            'k12.textbook_edition.art': '湘美版',
          },
        },
      },
      global: { plugins: [createPinia(), i18n()] },
      attachTo: document.body,
    })

    await flushPromises()
    const mathSelect = w
      .findAllComponents(HcSelect)
      .find((select) => select.element.closest('[data-testid="k12-textbook-math"]'))!
    mathSelect.vm.$emit('update:modelValue', '北师大版')
    await flushPromises()
    await B().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()

    expect(h.updateSpy).not.toHaveBeenCalled()
    expect(h.profileBundleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: {
          child_name: '小明',
          grade_term: '五年级上',
          subject_textbooks: {
            math: '北师大版',
            chinese: '统编版',
            english: '外研版',
            science: '苏教版',
            information_technology: '粤教版',
            art: '湘美版',
          },
        },
      }),
    )
  })

  it('两个同名称孩子生成不同 learner owner，展示名不参与稳定标识', async () => {
    const first = render()
    await B().find('input.k12pf__input').setValue('同名孩子')
    await B().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()
    const firstID = (
      h.registerSpy.mock.calls[0]![0] as {
        metadata: Record<string, string>
      }
    ).metadata['k12.learner_id']
    first.unmount()
    document.body.innerHTML = ''

    const second = render()
    await B().find('input.k12pf__input').setValue('同名孩子')
    await B().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()
    const secondID = (
      h.registerSpy.mock.calls[1]![0] as {
        metadata: Record<string, string>
      }
    ).metadata['k12.learner_id']

    expect(firstID).toMatch(/^learner-/)
    expect(secondID).toMatch(/^learner-/)
    expect(secondID).not.toBe(firstID)
    second.unmount()
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

  it('改档 bundle 失败 → Agent 基础字段零写入且无补偿写', async () => {
    h.profileBundleSpy.mockRejectedValueOnce(new Error('profile update failed'))
    const w = mount(K12ProfileForm, {
      props: {
        agent: {
          name: 'k12-tutor-x',
          display_name: '小明的辅导助手 · 五年级',
          description: '人教版 · 五年级上 · 按年级边界讲解',
          system_prompt: '旧人设',
          provider: 'old-provider',
          model: 'old-model',
          skills: ['math-tutor'],
          metadata: {
            scenario: 'k12-tutor',
            'k12.child_name': '小明',
            'k12.grade_term': '五年级上',
            'k12.textbook_edition': '人教版',
          },
        },
      },
      global: { plugins: [createPinia(), i18n()] },
      attachTo: document.body,
    })
    w.findAllComponents(HcSelect)[0]!.vm.$emit('update:modelValue', '六年级')
    await flushPromises()
    await B().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()

    expect(h.updateSpy).not.toHaveBeenCalled()
    expect(w.emitted('created')).toBeFalsy()
    expect(h.provisionSpy).not.toHaveBeenCalled()
    expect(B().text()).toContain('profile update failed')
  })

  it('改档持久化成功后按具体 agent 补齐默认任务，失败保留档案终态并可由下次保存重试', async () => {
    h.provisionSpy.mockRejectedValueOnce(new Error('cron temporarily unavailable'))
    const w = mount(K12ProfileForm, {
      props: {
        agent: {
          name: 'k12-tutor-x',
          display_name: '小明的辅导助手 · 五年级',
          metadata: {
            scenario: 'k12-tutor',
            'k12.child_name': '小明',
            'k12.grade_term': '五年级上',
            'k12.textbook_edition': '人教版',
          },
        },
      },
      global: { plugins: [createPinia(), i18n()] },
      attachTo: document.body,
    })

    await flushPromises()
    await B().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()

    expect(h.profileBundleSpy).toHaveBeenCalledOnce()
    expect(h.provisionSpy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ agent: 'k12-tutor-x' }),
    )
    expect(w.emitted('created')).toEqual([['k12-tutor-x']])
    expect(B().text()).not.toContain('cron temporarily unavailable')
    expect(h.toastWarningSpy).toHaveBeenCalledWith(expect.stringContaining('0/4'))
  })

  it('持久建档成功但列表刷新失败 → 仍返回已创建终态并提示刷新，不诱导重复建档', async () => {
    h.getAgentsSpy.mockRejectedValueOnce(new Error('refresh failed'))
    const w = render()
    await B().find('input.k12pf__input').setValue('小明')
    await B().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()

    expect(h.registerSpy).toHaveBeenCalledOnce()
    expect(h.profileSpy).not.toHaveBeenCalled()
    expect(w.emitted('created')).toBeTruthy()
    expect(h.toastWarningSpy).toHaveBeenCalledWith(expect.stringContaining('已保存'))
  })

  it('改档模式：预填 k12.* + 改年级 → profile-bundle 原子写六科与 Agent 基础字段', async () => {
    const w = mount(K12ProfileForm, {
      props: {
        agent: {
          name: 'k12-tutor-x',
          display_name: '小明的辅导助手 · 五年级',
          metadata: {
            scenario: 'k12-tutor',
            'k12.child_name': '小明',
            'k12.grade_term': '五年级上',
            'k12.textbook_edition': '人教版',
            avatar: '🎓',
          },
        },
      },
      global: { plugins: [createPinia(), i18n()] },
      attachTo: document.body,
    })
    // 预填称呼（读 k12.child_name）
    expect((B().find('input.k12pf__input').element as HTMLInputElement).value).toBe('小明')
    // 改年级 → 六年级；学期保持原来的“上”（两个字段均走 HcSelect）
    w.findAllComponents(HcSelect)[0]!.vm.$emit('update:modelValue', '六年级')
    await flushPromises()
    await B().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()
    expect(h.registerSpy).not.toHaveBeenCalled() // 改档不新建
    expect(h.updateSpy).not.toHaveBeenCalled()
    // 编辑态所有字段走唯一 profile-bundle。
    const bundle = h.profileBundleSpy.mock.calls[0]![0] as {
      agent: string
      agent_config: { display_name: string }
      profile: {
        child_name: string
        grade_term: string
        subject_textbooks: Record<string, string>
      }
    }
    expect(bundle.agent).toBe('k12-tutor-x')
    expect(bundle.agent_config.display_name).toContain('六年级')
    expect(bundle.profile.grade_term).toBe('六年级上')
    expect(bundle.profile.child_name).toBe('小明')
    expect(bundle.profile.subject_textbooks.math).toBe('人教版')
    expect(w.emitted('created')).toBeTruthy()
  })

  it('卡片副标题：建档严格写定版原型的数学教材进度边界', async () => {
    render()
    await B().find('input.k12pf__input').setValue('小明')
    await B().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()
    const payload = h.registerSpy.mock.calls[0]![0] as { description: string }
    expect(payload.description).toBe('五年级上 · 数学教材与进度已绑定 · 按年级边界讲解')
  })

  it('卡片副标题：改档改年级 → profile-bundle 同步派生 description（不写死）', async () => {
    const w = mount(K12ProfileForm, {
      props: {
        agent: {
          name: 'k12-tutor-x',
          display_name: '小明的辅导助手 · 五年级',
          metadata: {
            scenario: 'k12-tutor',
            'k12.child_name': '小明',
            'k12.grade_term': '五年级上',
            'k12.textbook_edition': '人教版',
            avatar: '🎓',
          },
        },
      },
      global: { plugins: [createPinia(), i18n()] },
      attachTo: document.body,
    })
    w.findAllComponents(HcSelect)[0]!.vm.$emit('update:modelValue', '六年级')
    await flushPromises()
    await B().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()
    const bundle = h.profileBundleSpy.mock.calls[0]![0] as {
      agent_config: { description: string }
    }
    expect(bundle.agent_config.description).toBe(
      '六年级上 · 数学教材与进度已绑定 · 按年级边界讲解',
    )
    expect(h.updateSpy).not.toHaveBeenCalled()
  })

  it('按定版原型分层展示只读能力与真实挂载 Skill，P0 锁定', async () => {
    render()
    expect(B().findAll('.k12pf__skillrow')).toHaveLength(0)
    expect(
      B().find('[data-testid="k12-profile-capabilities"]').findAll('.k12pf__skillchip'),
    ).toHaveLength(5)
    const mounted = B().find('[data-testid="k12-profile-mounted-skills"]')
    expect(mounted.exists()).toBe(true)
    expect(mounted.findAll('input[type="checkbox"]')).toHaveLength(9)
    expect(mounted.findAll('input[type="checkbox"][disabled]')).toHaveLength(3)
    await B().find('input.k12pf__input').setValue('小明')
    await B().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()
    const payload = h.registerSpy.mock.calls[0]![0] as { skills: string[] }
    expect(payload.skills).toContain('concept-explainer')
    expect(payload.skills).toContain('math-tutor')
    expect(payload.skills).toContain('k12_grade')
  })

  it('建档 footer 严格为上一步 / 创建，仅发出有生产宿主的返回意图', async () => {
    const w = render()
    const labels = B()
      .findAll('.k12pf__foot .k12pf__btn')
      .map((button) => button.text())
    expect(labels).toEqual(['上一步', '创建'])

    await B().find('[data-testid="k12pf-back"]').trigger('click')
    expect(w.emitted('back')).toHaveLength(1)
    expect(B().find('[data-testid="k12pf-preview"]').exists()).toBe(false)
    expect(w.emitted('close')).toBeUndefined()
    expect(B().findAll('.k12pf__note')).toHaveLength(1)
  })

  it('编辑删除使用 alertdialog 确认语义，第一次点击不执行删除', async () => {
    vi.useFakeTimers()
    const w = mount(K12ProfileForm, {
      props: {
        agent: {
          name: 'k12-tutor-x',
          display_name: '小明的辅导助手 · 五年级',
          metadata: {
            scenario: 'k12-tutor',
            'k12.child_name': '小明',
            'k12.grade_term': '五年级上',
            'k12.textbook_edition': '人教版',
          },
        },
      },
      global: { plugins: [createPinia(), i18n()] },
      attachTo: document.body,
    })

    await B().find('[data-testid="k12pf-delete"]').trigger('click')
    expect(h.unregisterSpy).not.toHaveBeenCalled()
    const dialog = B().find('[role="alertdialog"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.text()).toContain('确定删除「小明的辅导助手」？')
    expect((dialog.find('.hc-dialog__btn--danger').element as HTMLButtonElement).disabled).toBe(
      true,
    )
    await vi.advanceTimersByTimeAsync(5_000)
    await dialog.find('.hc-dialog__btn--danger').trigger('click')
    await flushPromises()
    expect(h.unregisterSpy).toHaveBeenCalledExactlyOnceWith('k12-tutor-x')
    expect(w.emitted('removed')).toEqual([['k12-tutor-x']])
  })

  it('年级展示含未来学段只读预告，持久 grade_term 仍冻结为小学 6×2', () => {
    const w = render()
    // 两个字段均走 HcSelect；小学 value 仍为稳定中文契约，未来学段仅作 disabled 预告。
    const gradeSelect = w.findAllComponents(HcSelect)[0]!
    const gradeOpts = gradeSelect.props('options') as Array<{
      value: string
      label: string
      disabled?: boolean
    }>
    const semesterOpts = (
      w.findAllComponents(HcSelect)[1]!.props('options') as { value: string; label: string }[]
    ).map((o) => o.label)
    expect(PRIMARY_GRADES).toHaveLength(6)
    expect(gradeOpts).toHaveLength(12)
    expect(gradeOpts.slice(0, 6).map((option) => option.value)).toEqual(PRIMARY_GRADES)
    expect(gradeOpts.slice(0, 6).map((option) => option.label)).toEqual([
      '一年级',
      '二年级',
      '三年级',
      '四年级',
      '五年级',
      '六年级',
    ])
    expect(gradeOpts.find((option) => option.value === '六年级')?.disabled).not.toBe(true)
    expect(gradeOpts.slice(6)).toEqual([
      { value: 'future-junior-1', label: '初一（暂未开放）', disabled: true },
      { value: 'future-junior-2', label: '初二（暂未开放）', disabled: true },
      { value: 'future-junior-3', label: '初三（暂未开放）', disabled: true },
      { value: 'future-senior-1', label: '高一（暂未开放）', disabled: true },
      { value: 'future-senior-2', label: '高二（暂未开放）', disabled: true },
      { value: 'future-senior-3', label: '高三（暂未开放）', disabled: true },
    ])
    expect(semesterOpts).toEqual(['上学期', '下学期'])
  })
})
