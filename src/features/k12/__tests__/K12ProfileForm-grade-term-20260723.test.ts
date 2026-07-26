import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import HcSelect from '@/components/common/HcSelect.vue'
import K12ProfileForm from '../views/K12ProfileForm.vue'
import { PRIMARY_GRADES } from '../curriculum'

const h = vi.hoisted(() => ({
  updateAgent: vi.fn().mockResolvedValue({}),
  getAgents: vi.fn().mockResolvedValue({ agents: [], total: 0, default: '' }),
  updateProfile: vi.fn().mockResolvedValue({}),
  updateProfileBundle: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/api/agents', () => ({
  registerAgent: vi.fn().mockResolvedValue({}),
  unregisterAgent: vi.fn().mockResolvedValue({}),
  updateAgent: h.updateAgent,
  getAgents: h.getAgents,
  getRoles: vi.fn().mockResolvedValue({ roles: [] }),
}))

vi.mock('@/api/k12', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/k12')>()),
  k12UpdateProfile: h.updateProfile,
  k12UpdateProfileBundle: h.updateProfileBundle,
  k12GetCurriculumCatalog: vi.fn().mockResolvedValue({
    agent: 'k12-tutor-x',
    subject: 'math',
    textbook_binding_id: 'binding-1',
    textbook_edition: '人教版',
    textbook_version: '2022',
    title: '数学',
    volume: '五年级下册',
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
  k12GetCurriculumProgress: vi.fn().mockResolvedValue({
    progress: {
      progress_id: 'progress-1',
      agent: 'k12-tutor-x',
      subject: 'math',
      revision: 1,
      textbook_binding_id: 'binding-1',
      textbook_edition: '人教版',
      textbook_version: '2022',
      title: '数学',
      volume: '五年级下册',
      unit_id: 'unit-1',
      unit_title: '第1单元',
      page_verification_status: 'not_requested',
      segment_refs: [],
      evidence_source: 'parent_confirmed',
      confirmed_at: '',
      created_at: '',
      updated_at: '',
    },
  }),
  k12GetWeeklyPracticeSettings: vi.fn().mockResolvedValue({
    agent: 'k12-tutor-x',
    revision: 1,
    timezone: 'Asia/Shanghai',
    due_review_enabled: true,
    textbook_consolidation_enabled: false,
    arithmetic_warmup_enabled: false,
    arithmetic_minutes: 2,
    created_at: '',
    updated_at: '',
  }),
  k12ProvisionCron: vi.fn().mockResolvedValue({ provisioned: [] }),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    success: vi.fn(),
    warning: vi.fn(),
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

const body = () => new DOMWrapper(document.body)

describe('K12ProfileForm 年级与学期二级联动', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    h.updateAgent.mockClear()
    h.getAgents.mockReset().mockResolvedValue({ agents: [], total: 0, default: '' })
    h.updateProfile.mockReset().mockResolvedValue({})
    h.updateProfileBundle.mockReset().mockResolvedValue({})
  })

  it('无损预填既有值；改年级不重置学期；保存仍写既有 grade_term 串', async () => {
    const wrapper = mount(K12ProfileForm, {
      props: {
        agent: {
          name: 'k12-tutor-x',
          display_name: '小明的辅导助手 · 五年级',
          metadata: {
            scenario: 'k12-tutor',
            'k12.child_name': '小明',
            'k12.grade_term': '五年级下',
            'k12.textbook_edition': '人教版',
          },
        },
      },
      global: { plugins: [createPinia(), i18n()] },
      attachTo: document.body,
    })

    const selects = wrapper.findAllComponents(HcSelect)
    const gradeSelect = selects.find(
      (select) => select.attributes('data-testid') === 'k12pf-grade',
    )
    const semesterSelect = selects.find(
      (select) => select.attributes('data-testid') === 'k12pf-semester',
    )
    expect(gradeSelect).toBeDefined()
    expect(semesterSelect).toBeDefined()
    expect(gradeSelect!.props('modelValue')).toBe('五年级')
    expect(semesterSelect!.props('modelValue')).toBe('下')
    const gradeOptions = gradeSelect!.props('options') as Array<{
      value: string
      label: string
      disabled?: boolean
    }>
    expect(PRIMARY_GRADES).toHaveLength(6)
    expect(gradeOptions).toHaveLength(12)
    expect(gradeOptions.slice(0, 6).map((option) => option.value)).toEqual(PRIMARY_GRADES)
    expect(gradeOptions.find((option) => option.value === '六年级')?.disabled).not.toBe(true)
    expect(gradeOptions.slice(6).every((option) => option.disabled === true)).toBe(true)
    expect(semesterSelect!.props('options')).toHaveLength(2)

    gradeSelect!.vm.$emit('update:modelValue', '六年级')
    await flushPromises()
    expect(semesterSelect!.props('modelValue')).toBe('下')

    await body().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()
    expect(h.updateProfileBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'k12-tutor-x',
        profile: expect.objectContaining({ grade_term: '六年级下' }),
      }),
    )
  })

  it('创建页只保留“上一步 / 创建”，不提供没有生产契约的示例入口', () => {
    mount(K12ProfileForm, {
      global: { plugins: [createPinia(), i18n()] },
      attachTo: document.body,
    })

    expect(
      body()
        .findAll('.k12pf__foot .k12pf__btn')
        .map((button) => button.text()),
    ).toEqual(['上一步', '创建'])
    expect(body().find('[data-testid="k12pf-preview"]').exists()).toBe(false)
  })
})
