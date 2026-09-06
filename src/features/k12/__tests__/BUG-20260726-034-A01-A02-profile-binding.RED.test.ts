import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12ProfileForm from '../views/K12ProfileForm.vue'

const h = vi.hoisted(() => ({
  updateAgent: vi.fn().mockResolvedValue({}),
  getAgents: vi.fn().mockResolvedValue({ agents: [], total: 0, default: '' }),
  updateProfileBundle: vi.fn().mockResolvedValue({}),
  getBindingOptions: vi.fn().mockResolvedValue({ items: [] }),
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
  k12UpdateProfile: vi.fn().mockResolvedValue({}),
  k12UpdateProfileBundle: h.updateProfileBundle,
  k12GetTextbookBindingOptions: h.getBindingOptions,
  k12GetCurriculumCatalog: vi.fn().mockResolvedValue({
    agent: 'k12-tutor-x',
    subject: 'math',
    textbook_binding_id: 'binding-old',
    textbook_manifest_id: 'manifest-math-pep-5b-g1',
    document_id: 'document-math-pep-5b',
    document_generation: 1,
    textbook_edition: '人教版',
    textbook_version: '2022',
    title: '义务教育教科书·数学五年级下册',
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
  k12GetProfile: vi.fn().mockResolvedValue({
    child_name: '小明', grade_term: '五年级下', textbook_edition: '人教版', revision: 0,
  }),
  k12GetCurriculumProgress: vi.fn().mockResolvedValue({
    progress: {
      progress_id: 'progress-1',
      agent: 'k12-tutor-x',
      subject: 'math',
      revision: 3,
      textbook_binding_id: 'binding-old',
      textbook_manifest_id: 'manifest-math-pep-5b-g1',
      textbook_edition: '人教版',
      textbook_version: '2022',
      title: '义务教育教科书·数学五年级下册',
      volume: '五年级下册',
      unit_id: 'unit-1',
      unit_title: '第1单元',
      page_verification_status: 'not_requested',
      segment_refs: [],
      evidence_source: 'parent_confirmed',
      confirmed_at: '2026-07-27T08:00:00Z',
      created_at: '2026-07-27T08:00:00Z',
      updated_at: '2026-07-27T08:00:00Z',
    },
  }),
  k12GetWeeklyPracticeSettings: vi.fn().mockResolvedValue({
    agent: 'k12-tutor-x',
    revision: 2,
    timezone: 'Asia/Shanghai',
    due_review_enabled: true,
    textbook_consolidation_enabled: true,
    arithmetic_warmup_enabled: true,
    arithmetic_minutes: 2,
    created_at: '2026-07-27T08:00:00Z',
    updated_at: '2026-07-27T08:00:00Z',
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

const agent = {
  name: 'k12-tutor-x',
  display_name: '小明的辅导助手 · 五年级',
  description: '只帮助小明完成当前学期的学习任务',
  system_prompt: '以可核验教材与错题事实辅导小明。',
  provider: 'openai',
  model: 'gpt-4.1-mini',
  metadata: {
    scenario: 'k12-tutor',
    'k12.child_name': '小明',
    'k12.grade_term': '五年级下',
    'k12.textbook_edition': '人教版',
    'k12.textbook_edition.math': '人教版',
    'k12.textbook_edition.chinese': '人教版',
    'k12.textbook_edition.english': '人教版',
    'k12.textbook_edition.science': '教科版',
    'k12.textbook_edition.information_technology': '浙教版',
    'k12.textbook_edition.art': '人美版',
  },
}

const readyCatalog = {
  subject: 'math',
  textbook_edition: '人教版',
  textbook_version: '2022',
  title: '义务教育教科书·数学五年级下册',
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
  page_refs: [{ logical_page: 1, pdf_page: 1, segment_refs: ['segment-1'] }],
}

const bindingOptions = [
  {
    manifest_id: 'manifest-waiting',
    document_id: 'document-waiting',
    document_generation: 1,
    document_title: '等待摄取.pdf',
    state: 'waiting_ingest',
    retryable: false,
    failure_message: '',
    text_index_state: 'pending',
    vector_index_state: 'pending',
    catalog: null,
    updated_at: '2026-07-27T08:00:00Z',
  },
  {
    manifest_id: 'manifest-extracting',
    document_id: 'document-extracting',
    document_generation: 1,
    document_title: '正在识别.pdf',
    state: 'extracting',
    retryable: false,
    failure_message: '',
    text_index_state: 'processing',
    vector_index_state: 'pending',
    catalog: null,
    updated_at: '2026-07-27T08:01:00Z',
  },
  {
    manifest_id: 'manifest-math-pep-5b-g1',
    document_id: 'document-math-pep-5b',
    document_generation: 1,
    document_title: '义务教育教科书·数学五年级下册.pdf',
    state: 'ready_for_confirmation',
    retryable: false,
    failure_message: '',
    text_index_state: 'ready',
    vector_index_state: 'ready',
    catalog: readyCatalog,
    updated_at: '2026-07-27T08:02:00Z',
  },
  {
    manifest_id: 'manifest-no-default-model',
    document_id: 'document-no-default-model',
    document_generation: 1,
    document_title: '默认模型未配置.pdf',
    state: 'failed_terminal',
    retryable: false,
    failure_message: '默认模型未配置',
    text_index_state: 'failed',
    vector_index_state: 'pending',
    catalog: null,
    updated_at: '2026-07-27T08:03:00Z',
  },
  {
    manifest_id: 'manifest-retryable',
    document_id: 'document-retryable',
    document_generation: 1,
    document_title: '识别失败.pdf',
    state: 'failed_retryable',
    retryable: true,
    failure_message: '识别失败',
    text_index_state: 'failed',
    vector_index_state: 'pending',
    catalog: null,
    updated_at: '2026-07-27T08:04:00Z',
  },
  {
    manifest_id: 'manifest-stale',
    document_id: 'document-stale',
    document_generation: 1,
    document_title: '源已失效.pdf',
    state: 'stale',
    retryable: false,
    failure_message: '源已失效',
    text_index_state: 'stale',
    vector_index_state: 'stale',
    catalog: null,
    updated_at: '2026-07-27T08:05:00Z',
  },
]

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

function normalizedText(value: string | null | undefined) {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function accessibleName(element: HTMLElement) {
  const ariaLabel = normalizedText(element.getAttribute('aria-label'))
  if (ariaLabel) return ariaLabel

  const labelledBy = normalizedText(element.getAttribute('aria-labelledby'))
  if (labelledBy) {
    return normalizedText(
      labelledBy
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' '),
    )
  }

  const id = element.getAttribute('id')
  if (id) {
    const label = document.querySelector<HTMLLabelElement>(`label[for="${id}"]`)
    if (label) return normalizedText(label.textContent)
  }

  const wrappingLabel = element.closest('label')
  if (wrappingLabel) return normalizedText(wrappingLabel.textContent)
  return normalizedText(element.textContent)
}

function roleSelector(role: 'button' | 'combobox' | 'option') {
  if (role === 'button') return 'button,[role="button"]'
  if (role === 'combobox') return 'select,[role="combobox"]'
  return 'option,[role="option"]'
}

function queryByRoleName(
  root: ParentNode,
  role: 'button' | 'combobox' | 'option',
  name: string,
) {
  return Array.from(root.querySelectorAll<HTMLElement>(roleSelector(role))).find(
    (element) => accessibleName(element) === name,
  )
}

function renderProfile() {
  return mount(K12ProfileForm, {
    props: { agent },
    global: { plugins: [createPinia(), i18n()] },
    attachTo: document.body,
  })
}

async function saveProfile() {
  const save = queryByRoleName(document.body, 'button', '保存')
  expect(save, '[BUG-20260726-034][A01/A02] 缺少可访问名称为“保存”的既有主操作').toBeDefined()
  await new DOMWrapper(save!).trigger('click')
  await flushPromises()
}

describe('[BUG-20260726-034] A01/A02 K12 profile-bundle and textbook binding contracts', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    h.updateAgent.mockReset().mockResolvedValue({})
    h.getAgents.mockReset().mockResolvedValue({ agents: [], total: 0, default: '' })
    h.updateProfileBundle.mockReset().mockResolvedValue({})
    h.getBindingOptions.mockReset().mockResolvedValue({ items: [] })
  })

  it('[BUG-20260726-034][A01] sends the exact six-field agent_config in the sole bundle write and never calls updateAgent', async () => {
    renderProfile()
    await flushPromises()
    await saveProfile()

    expect(h.updateProfileBundle).toHaveBeenCalledTimes(1)
    const request = h.updateProfileBundle.mock.calls[0]?.[0] as Record<string, unknown>
    expect(request.agent).toBe('k12-tutor-x')
    expect(
      request,
      '[BUG-20260726-034][A01] profile-bundle 缺少同事务 agent_config',
    ).toHaveProperty('agent_config')
    expect(Object.keys(request.agent_config as Record<string, unknown>).sort()).toEqual(
      ['display_name', 'description', 'system_prompt', 'provider', 'model', 'skills'].sort(),
    )
    expect(request.agent_config).toEqual({
      display_name: '小明的辅导助手 · 五年级',
      description: '只帮助小明完成当前学期的学习任务',
      system_prompt: '以可核验教材与错题事实辅导小明。',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      skills: expect.arrayContaining([
        'k12-pedagogy',
        'homework-checker',
        'math-tutor',
        'grade-constraint',
        'k12_grade',
        'k12_review',
      ]),
    })
    expect(h.updateAgent).toHaveBeenCalledTimes(0)
  })

  it('[BUG-20260726-034][A02] exposes the empty textbook binding state without inventing a second entry point', async () => {
    h.getBindingOptions.mockResolvedValueOnce({ items: [] })
    renderProfile()
    await flushPromises()

    expect(
      normalizedText(document.body.textContent),
      '[BUG-20260726-034][A02] 未绑定教材时必须投影“未上传”',
    ).toContain('未上传')
    expect(normalizedText(document.body.textContent)).toContain('关联教材后可生成教材同步练习')
  })

  it('[BUG-20260726-034][A02] renders all frozen manifest states and enables only ready_for_confirmation', async () => {
    h.getBindingOptions.mockResolvedValueOnce({ items: bindingOptions })
    renderProfile()
    await flushPromises()

    const selector = queryByRoleName(document.body, 'combobox', '关联教材文件')
    expect(
      selector,
      '[BUG-20260726-034][A02] 缺少可访问名称为“关联教材文件”的 manifest 选择器',
    ).toBeDefined()
    await new DOMWrapper(selector!).trigger('click')
    await flushPromises()

    for (const stateLabel of [
      '等待摄取',
      '正在识别',
      '可确认',
      '默认模型未配置',
      '识别失败',
      '源已失效',
    ]) {
      expect(normalizedText(document.body.textContent)).toContain(stateLabel)
    }

    const options = Array.from(
      document.body.querySelectorAll<HTMLOptionElement | HTMLElement>(roleSelector('option')),
    )
    expect(options).toHaveLength(6)
    for (const option of options) {
      const enabled = !(
        (option instanceof HTMLOptionElement && option.disabled) ||
        option.getAttribute('aria-disabled') === 'true'
      )
      expect(enabled, `只有“可确认”项可选：${accessibleName(option)}`).toBe(
        normalizedText(option.textContent).includes('可确认'),
      )
    }
  })

  it('[BUG-20260726-034][A02] submits textbook_manifest_id and never submits server-owned textbook_binding_id', async () => {
    h.getBindingOptions.mockResolvedValueOnce({ items: bindingOptions })
    renderProfile()
    await flushPromises()
    await saveProfile()

    expect(h.updateProfileBundle).toHaveBeenCalledTimes(1)
    const request = h.updateProfileBundle.mock.calls[0]?.[0] as {
      curriculum_progress?: Record<string, unknown>
    }
    expect(
      request.curriculum_progress,
      '[BUG-20260726-034][A02] 保存必须包含 curriculum_progress 草稿',
    ).toBeDefined()
    expect(request.curriculum_progress).toHaveProperty(
      'textbook_manifest_id',
      'manifest-math-pep-5b-g1',
    )
    expect(request.curriculum_progress).not.toHaveProperty('textbook_binding_id')
  })
})
