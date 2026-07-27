import { beforeEach, describe, expect, it } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12WeeklyPracticePanel from '../components/K12WeeklyPracticePanel.vue'

const plan = {
  plan_id: 'weekly-31',
  agent: 'mingming',
  revision: 4,
  iso_week_year: 2026,
  iso_week_number: 31,
  timezone: 'Asia/Shanghai',
  week_start: '2026-07-27T00:00:00+08:00',
  week_end: '2026-08-02T23:59:59+08:00',
  local_start_date: '2026-07-27',
  local_end_date: '2026-08-02',
  status: 'draft',
  settings_revision: 2,
  curriculum_progress_revision: 3,
  tracks: [
    {
      plan_section: 'due_review',
      status: 'ready',
      items: [
        {
          item_id: 'due-1',
          position: 1,
          plan_section: 'due_review',
          source_kind: 'mistake',
          generation_method: 'original',
          source_ref: 'mistake-1',
          verification: {
            status: 'verified',
            evidence_refs: ['mistake-1'],
          },
          prompt_markdown: '计算 3.6 × 2.5。',
        },
      ],
    },
    {
      plan_section: 'textbook_consolidation',
      status: 'ready',
      items: [
        {
          item_id: 'textbook-1',
          position: 2,
          plan_section: 'textbook_consolidation',
          source_kind: 'textbook',
          generation_method: 'retrieval_grounded',
          source_ref: 'segment-1',
          verification: {
            status: 'verified',
            evidence_refs: ['segment-1'],
            textbook_binding_id: 'binding-1',
            unit_id: 'unit-1',
            verified_page_from: 8,
            verified_page_to: 8,
          },
          prompt_markdown: '把 2/3 和 3/5 通分。',
        },
      ],
    },
    {
      plan_section: 'arithmetic_warmup',
      status: 'disabled',
      items: [],
    },
  ],
  created_at: '2026-07-27T08:00:00Z',
  updated_at: '2026-07-27T08:00:00Z',
}

const settings = {
  agent: 'mingming',
  revision: 2,
  timezone: 'Asia/Shanghai',
  due_review_enabled: true,
  textbook_consolidation_enabled: true,
  arithmetic_warmup_enabled: false,
  arithmetic_minutes: 2,
  created_at: '2026-07-27T08:00:00Z',
  updated_at: '2026-07-27T08:00:00Z',
}

const archivedHistory = [
  {
    snapshot_id: 'snapshot-week-30',
    plan_id: 'weekly-30',
    iso_week_year: 2026,
    iso_week_number: 30,
    timezone: 'Asia/Shanghai',
    local_start_date: '2026-07-20',
    local_end_date: '2026-07-26',
    item_count: 5,
    correct_count: 4,
    wrong_count: 1,
    needs_review_count: 0,
    archived_at: '2026-07-26T18:00:00+08:00',
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
  return normalizedText(element.textContent)
}

function roleSelector(role: 'button' | 'tab' | 'menuitem' | 'dialog') {
  if (role === 'button') return 'button,[role="button"]'
  return `[role="${role}"]`
}

function allByRole(root: ParentNode, role: 'button' | 'tab' | 'menuitem' | 'dialog') {
  return Array.from(root.querySelectorAll<HTMLElement>(roleSelector(role)))
}

function queryByRoleName(
  root: ParentNode,
  role: 'button' | 'tab' | 'menuitem' | 'dialog',
  name: string,
) {
  return allByRole(root, role).find((element) => accessibleName(element) === name)
}

function renderWeekly(history: typeof archivedHistory | [] = []) {
  return mount(K12WeeklyPracticePanel, {
    props: {
      progress: null,
      settings: settings as any,
      plan: plan as any,
      history: history as any,
      output: null,
      loading: false,
      busy: false,
      error: '',
      deliveryLabel: '发送到手机',
      deliveryDisabled: false,
    },
    global: { plugins: [i18n()] },
    attachTo: document.body,
  })
}

describe('[BUG-20260726-034] A04/A05 weekly-practice surface contracts', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('[BUG-20260727-006] delegates the current-week toolbar to the records host instead of duplicating it inside the panel', () => {
    renderWeekly()

    const directActionNames = ['打印', '导出 PDF', '发送到手机', '更多本周该练操作']
    for (const name of directActionNames) {
      expect(queryByRoleName(document.body, 'button', name)).toBeUndefined()
    }
    expect(queryByRoleName(document.body, 'button', '生成本周该练')).toBeUndefined()
    expect(queryByRoleName(document.body, 'button', '重新生成')).toBeUndefined()
    expect(normalizedText(document.body.textContent)).not.toContain('自定义打印预览')
  })

  it('[BUG-20260727-006] does not keep a second current-week more menu inside the panel', () => {
    renderWeekly()

    expect(queryByRoleName(document.body, 'button', '更多本周该练操作')).toBeUndefined()
    expect(allByRole(document.body, 'menuitem')).toHaveLength(0)
  })

  it('[BUG-20260726-034][A05] defaults to 本周 and renders the archived 5道4对1错 history card', async () => {
    renderWeekly(archivedHistory)

    const tabs = allByRole(document.body, 'tab')
    expect(
      tabs.map(accessibleName),
      '[BUG-20260726-034][A05] 本周该练内部二级页签必须 exact 为“本周｜历史”',
    ).toEqual(['本周', '历史'])
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('false')

    await new DOMWrapper(tabs[1]!).trigger('click')
    await flushPromises()

    const historyText = normalizedText(document.body.textContent)
    expect(historyText).toContain('7月20日–7月26日')
    expect(historyText).toContain('2026年第30周')
    expect(historyText).toContain('5 道 · 4 对 1 错')
    expect(historyText).toContain('已归档')
    expect(
      queryByRoleName(document.body, 'button', '查看周练'),
      '[BUG-20260726-034][A05] 归档卡缺少可达的只读详情入口',
    ).toBeDefined()
  })

  it('[BUG-20260726-034][A05] opens a read-only archived detail with only same-snapshot artifact actions', async () => {
    const wrapper = renderWeekly(archivedHistory)
    const historyTab = queryByRoleName(document.body, 'tab', '历史')
    expect(historyTab).toBeDefined()
    await new DOMWrapper(historyTab!).trigger('click')
    await flushPromises()

    const view = queryByRoleName(document.body, 'button', '查看周练')
    expect(view).toBeDefined()
    await new DOMWrapper(view!).trigger('click')
    await flushPromises()

    const dialogs = allByRole(document.body, 'dialog')
    expect(
      dialogs,
      '[BUG-20260726-034][A05] “查看周练”必须到达可访问的只读详情',
    ).toHaveLength(1)
    const detail = dialogs[0]!
    expect(normalizedText(detail.textContent)).toContain('7月20日–7月26日')
    for (const action of ['打印', '发送到手机', '查看对应学情']) {
      expect(
        queryByRoleName(detail, 'button', action),
        `[BUG-20260726-034][A05] 历史详情缺少同一 snapshot/artifact 操作“${action}”`,
      ).toBeDefined()
    }
    for (const forbidden of ['生成本周该练', '重新生成', '按新进度更新']) {
      expect(queryByRoleName(detail, 'button', forbidden)).toBeUndefined()
    }
    expect(wrapper.emitted('prepare-output')).toBeUndefined()
  })

  it('[BUG-20260727-006] removes current-week actions from history list focus order', async () => {
    renderWeekly(archivedHistory)
    await new DOMWrapper(queryByRoleName(document.body, 'tab', '历史')!).trigger('click')
    await flushPromises()

    for (const action of ['打印', '导出 PDF', '发送到手机', '更多本周该练操作']) {
      expect(queryByRoleName(document.body, 'button', action)).toBeUndefined()
    }
    expect(allByRole(document.body, 'button').map(accessibleName)).toContain('查看周练')
  })

})
