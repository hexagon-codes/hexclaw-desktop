import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import { k12GetCurriculumProgress } from '@/api/k12'
import k12Zh from '../i18n/zh-CN'
import K12ProfileForm from '../views/K12ProfileForm.vue'

const h = vi.hoisted(() => ({
  updateAgent: vi.fn(),
  getAgents: vi.fn(),
  bundle: vi.fn(),
  legacyProfile: vi.fn(),
}))

vi.mock('@/api/agents', () => ({
  registerAgent: vi.fn(),
  unregisterAgent: vi.fn(),
  updateAgent: (...args: unknown[]) => h.updateAgent(...args),
  getAgents: (...args: unknown[]) => h.getAgents(...args),
  getRoles: vi.fn().mockResolvedValue({ roles: [] }),
}))

vi.mock('@/api/k12', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/k12')>()),
  k12UpdateProfile: (...args: unknown[]) => h.legacyProfile(...args),
  k12UpdateProfileBundle: (...args: unknown[]) => h.bundle(...args),
  k12GetTextbookBindingOptions: vi.fn().mockResolvedValue({
    agent: 'k12-tutor-x',
    subject: 'math',
    items: [
      {
        manifest_id: 'manifest-pep-5b',
        document_id: 'document-pep-5b',
        document_generation: 1,
        document_title: '数学五年级下册.pdf',
        state: 'ready_for_confirmation',
        retryable: false,
        failure_message: '',
        text_index_state: 'ready',
        vector_index_state: 'ready',
        updated_at: '',
        catalog: {
          subject: 'math',
          textbook_binding_id: 'pep-5b',
          textbook_edition: '人教版',
          textbook_version: '2022',
          title: '数学',
          volume: '五年级下册',
          page_min: 1,
          page_max: 120,
          page_refs: [],
          units: [
            {
              unit_id: 'unit-4',
              title: '第4单元「分数的意义和性质」',
              page_from: 45,
              page_to: 62,
              lessons: [],
            },
          ],
        },
      },
    ],
  }),
  k12GetCurriculumCatalog: vi.fn().mockResolvedValue({
    agent: 'k12-tutor-x',
    subject: 'math',
    textbook_binding_id: 'pep-5b',
    textbook_edition: '人教版',
    textbook_version: '2022',
    title: '数学',
    volume: '五年级下册',
    page_min: 1,
    page_max: 120,
    units: [
      {
        unit_id: 'unit-4',
        title: '第4单元「分数的意义和性质」',
        page_from: 45,
        page_to: 62,
        lessons: [
          {
            lesson_id: 'lesson-1',
            title: '第1课时',
            page_from: 45,
            page_to: 48,
          },
        ],
      },
    ],
  }),
  k12GetCurriculumProgress: vi.fn().mockResolvedValue({
    revision: 4,
    progress: {
      progress_id: 'progress-1',
      agent: 'k12-tutor-x',
      subject: 'math',
      revision: 4,
      textbook_binding_id: 'pep-5b',
      textbook_manifest_id: 'manifest-pep-5b',
      textbook_edition: '人教版',
      textbook_version: '2022',
      title: '数学',
      volume: '五年级下册',
      unit_id: 'unit-4',
      unit_title: '第4单元「分数的意义和性质」',
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
    revision: 5,
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

const subjectTextbooks = {
  math: '人教版',
  chinese: '统编版',
  english: '外研版',
  science: '苏教版',
  information_technology: '粤教版',
  art: '湘美版',
}

const editAgent = {
  name: 'k12-tutor-x',
  display_name: '小明的辅导助手 · 五年级',
  metadata: {
    scenario: 'k12-tutor',
    'k12.child_name': '小明',
    'k12.grade_term': '五年级下',
    'k12.textbook_edition': '人教版',
    'k12.textbook_edition.math': '人教版',
    'k12.textbook_edition.chinese': '统编版',
    'k12.textbook_edition.english': '外研版',
    'k12.textbook_edition.science': '苏教版',
    'k12.textbook_edition.information_technology': '粤教版',
    'k12.textbook_edition.art': '湘美版',
    'k12.profile_revision': '3',
  },
}

describe('K12ProfileForm weekly-practice bundle contract', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    h.updateAgent.mockReset().mockResolvedValue({})
    h.getAgents.mockReset().mockResolvedValue({ agents: [], total: 0, default: '' })
    h.bundle.mockReset().mockResolvedValue({
      agent_config: {
        display_name: '小明的辅导助手 · 五年级',
        description: '',
        system_prompt: '',
        provider: '',
        model: '',
      },
      profile: {
        child_name: '小明',
        grade_term: '五年级下',
        subject_textbooks: subjectTextbooks,
        textbook_edition: '人教版',
        revision: 4,
      },
      curriculum_progress: { revision: 5 },
      weekly_practice_settings: { revision: 6 },
      replayed: false,
    })
    h.legacyProfile.mockReset()
  })

  it('renders one math progress section and preserves hidden weekly settings in one bundle call', async () => {
    mount(K12ProfileForm, {
      props: { agent: editAgent },
      global: { plugins: [createPinia(), i18n()] },
      attachTo: document.body,
    })
    await flushPromises()

    expect(body().findAll('[data-testid="k12-textbook-math"]')).toHaveLength(1)
    expect(body().findAll('[data-testid="k12-math-progress"]')).toHaveLength(1)
    expect(body().find('[data-testid="k12-current-unit-value"]').exists()).toBe(true)
    expect(body().findAll('[role="switch"]')).toHaveLength(0)
    expect(body().find('[data-testid="k12-arithmetic-minutes"]').exists()).toBe(false)

    await body().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()

    expect(h.bundle).toHaveBeenCalledTimes(1)
    expect(h.legacyProfile).not.toHaveBeenCalled()
    expect(h.bundle).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'k12-tutor-x',
        expected_profile_revision: 3,
        expected_progress_revision: 4,
        expected_settings_revision: 5,
        profile: expect.objectContaining({
          child_name: '小明',
          grade_term: '五年级下',
          subject_textbooks: subjectTextbooks,
        }),
        curriculum_progress: expect.objectContaining({
          subject: 'math',
          textbook_manifest_id: 'manifest-pep-5b',
          volume: '五年级下册',
          unit_id: 'unit-4',
          evidence_source: 'parent_confirmed',
        }),
        weekly_practice_settings: {
          timezone: 'Asia/Shanghai',
          textbook_consolidation_enabled: false,
          arithmetic_warmup_enabled: false,
          arithmetic_minutes: 2,
        },
      }),
    )
    expect(h.bundle.mock.calls[0]?.[0].profile).toEqual({
      child_name: '小明',
      grade_term: '五年级下',
      subject_textbooks: subjectTextbooks,
    })
    expect(h.bundle.mock.calls[0]?.[0].agent_config).toEqual(
      expect.objectContaining({
        display_name: '小明的辅导助手 · 五年级',
        system_prompt: expect.any(String),
        provider: '',
        model: '',
      }),
    )
    expect(h.updateAgent).not.toHaveBeenCalled()
  })

  it('preserves the lifecycle revision after the current progress has been cleared', async () => {
    vi.mocked(k12GetCurriculumProgress).mockResolvedValueOnce({ progress: null, revision: 2 })
    mount(K12ProfileForm, {
      props: { agent: editAgent },
      global: { plugins: [createPinia(), i18n()] },
      attachTo: document.body,
    })
    await flushPromises()

    const unitSelect = body().find('[data-testid="k12-current-unit-value"]')
    await unitSelect.find('button').trigger('click')
    await flushPromises()
    const unitOption = body()
      .findAll('.hc-select__option')
      .find((option) => option.text().includes('第4单元'))
    expect(unitOption).toBeDefined()
    await unitOption!.trigger('mousedown')
    await flushPromises()

    await body().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()

    expect(h.bundle).toHaveBeenCalledWith(
      expect.objectContaining({ expected_progress_revision: 2 }),
    )
  })

  it('does not write Agent metadata or compensation state when the bundle fails', async () => {
    h.bundle.mockRejectedValueOnce(new Error('profile bundle failed'))
    mount(K12ProfileForm, {
      props: { agent: editAgent },
      global: { plugins: [createPinia(), i18n()] },
      attachTo: document.body,
    })
    await flushPromises()

    await body().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()

    expect(h.bundle).toHaveBeenCalledTimes(1)
    expect(h.updateAgent).not.toHaveBeenCalled()
  })
})
