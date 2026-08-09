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
  k12UpdateProfileBundle: h.updateProfileBundle,
  k12GetTextbookBindingOptions: vi.fn().mockResolvedValue({ items: [] }),
  k12GetCurriculumProgress: vi.fn().mockResolvedValue({
    progress: {
      progress_id: 'progress-1',
      agent: 'k12-tutor-x',
      subject: 'math',
      revision: 1,
      textbook_binding_id: 'binding-1',
      textbook_manifest_id: 'manifest-1',
      textbook_edition: '人教版',
      textbook_version: '2022',
      title: '数学',
      volume: '五年级下册',
      unit_id: 'unit-1',
      unit_title: '第一单元',
      page_verification_status: 'not_requested',
      segment_refs: [],
      evidence_source: 'parent_confirmed',
      confirmed_at: '2026-07-26T00:00:00Z',
      created_at: '2026-07-26T00:00:00Z',
      updated_at: '2026-07-26T00:00:00Z',
    },
  }),
  k12GetWeeklyPracticeSettings: vi.fn().mockResolvedValue({
    agent: 'k12-tutor-x',
    revision: 1,
    timezone: 'Asia/Shanghai',
    due_review_enabled: true,
    textbook_consolidation_enabled: false,
    textbook_consolidation_tier: 'standard',
    arithmetic_warmup_enabled: false,
    arithmetic_minutes: 2,
    created_at: '2026-07-26T00:00:00Z',
    updated_at: '2026-07-26T00:00:00Z',
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

const FUTURE_GRADE_LABELS = [
  '初一（暂未开放）',
  '初二（暂未开放）',
  '初三（暂未开放）',
  '高一（暂未开放）',
  '高二（暂未开放）',
  '高三（暂未开放）',
] as const

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

const body = () => new DOMWrapper(document.body)

function mountEditProfile() {
  return mount(K12ProfileForm, {
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
}

function gradeCombobox() {
  return body()
    .findAll('[role="combobox"]')
    .find((element) => element.attributes('aria-label') === '年级')
}

describe('BUG-20260726-032 · 孩子档案未来年级只读预告', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    h.updateAgent.mockClear()
    h.getAgents.mockReset().mockResolvedValue({ agents: [], total: 0, default: '' })
    h.updateProfileBundle.mockReset().mockResolvedValue({})
  })

  it('BUG-20260726-032 exposes the exact six future grades as visible disabled options', async () => {
    const wrapper = mountEditProfile()
    const combobox = gradeCombobox()
    expect(combobox, '年级字段必须以可访问 combobox 暴露').toBeDefined()
    await combobox!.trigger('click')
    await flushPromises()

    const options = body().findAll('[role="option"]')
    const primaryOptions = options.slice(0, 6)
    const futureOptions = options.filter((option) =>
      FUTURE_GRADE_LABELS.includes(option.text() as (typeof FUTURE_GRADE_LABELS)[number]),
    )
    expect(primaryOptions.map((option) => option.text())).toEqual([
      '一年级',
      '二年级',
      '三年级',
      '四年级',
      '五年级',
      '六年级',
    ])
    expect(primaryOptions.every((option) => option.attributes('aria-disabled') !== 'true')).toBe(
      true,
    )
    expect(futureOptions.map((option) => option.text())).toEqual(FUTURE_GRADE_LABELS)
    expect(futureOptions.every((option) => option.attributes('aria-disabled') === 'true')).toBe(
      true,
    )
    expect(options.slice(-6).map((option) => option.text())).toEqual(FUTURE_GRADE_LABELS)

    wrapper.unmount()
  })

  it('BUG-20260726-032 blocks mouse and keyboard selection and never persists a future grade', async () => {
    const wrapper = mountEditProfile()
    const combobox = gradeCombobox()
    expect(combobox).toBeDefined()
    await combobox!.trigger('click')
    await flushPromises()

    const futureOption = body()
      .findAll('[role="option"]')
      .find((option) => option.text() === FUTURE_GRADE_LABELS[0])
    expect(futureOption, '初一预告项必须可见').toBeDefined()

    await futureOption!.trigger('mousedown')
    await futureOption!.trigger('mouseenter')
    await combobox!.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(combobox!.text()).toContain('五年级')
    expect(h.updateAgent).not.toHaveBeenCalled()
    expect(h.updateProfileBundle).not.toHaveBeenCalled()

    await body().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()
    expect(h.updateProfileBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'k12-tutor-x',
        profile: expect.objectContaining({ grade_term: '五年级下' }),
      }),
    )
    expect(h.updateProfileBundle).not.toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({ grade_term: expect.stringMatching(/^[初高]/) }),
      }),
    )

    wrapper.unmount()
  })
})
