import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import * as k12Api from '../../../api/k12'
import K12WeeklyPracticePanel from '../components/K12WeeklyPracticePanel.vue'

describe('weekly-practice HTTP client contract', () => {
  it('exports the canonical read, bundle, plan, output, delivery, and save clients', () => {
    const requiredExports = [
      'k12GetCurriculumCatalog',
      'k12GetCurriculumProgress',
      'k12GetWeeklyPracticeSettings',
      'k12UpdateProfileBundle',
      'k12EnsureWeeklyPracticePlan',
      'k12GetCurrentWeeklyPracticePlan',
      'k12GetWeeklyPracticeHistory',
      'k12GetWeeklyPracticeSnapshot',
      'k12PrepareWeeklyPracticeOutput',
      'k12SendWeeklyPracticeSnapshot',
      'k12SaveWeeklyPracticePlanToPracticeSet',
    ] as const

    for (const exportName of requiredExports) {
      expect(k12Api[exportName]).toBeTypeOf('function')
    }
  })
})

const settings = {
  agent: 'mingming',
  revision: 2,
  timezone: 'Asia/Shanghai',
  due_review_enabled: true as const,
  textbook_consolidation_enabled: true,
  textbook_consolidation_tier: 'standard' as const,
  arithmetic_warmup_enabled: true,
  arithmetic_minutes: 2,
  created_at: '2026-07-20T00:00:00Z',
  updated_at: '2026-07-20T00:00:00Z',
}

const plan = {
  plan_id: 'weekly-30',
  agent: 'mingming',
  revision: 3,
  iso_week_year: 2026,
  iso_week_number: 30,
  timezone: 'Asia/Shanghai',
  week_start: '2026-07-20T00:00:00+08:00',
  week_end: '2026-07-26T23:59:59+08:00',
  local_start_date: '2026-07-20',
  local_end_date: '2026-07-26',
  status: 'draft' as const,
  settings_revision: 2,
  curriculum_progress_revision: 4,
  tracks: [
    {
      plan_section: 'due_review' as const,
      status: 'ready' as const,
      items: [
        {
          item_id: 'due-1',
          position: 1,
          plan_section: 'due_review' as const,
          source_kind: 'mistake',
          generation_method: 'original' as const,
          source_ref: 'mistake-1',
          verification: {
            status: 'verified' as const,
            evidence_refs: ['小数乘法错题 · 连续错 2 次'],
          },
          prompt_markdown: '计算 4.2 × 3。',
        },
      ],
    },
    {
      plan_section: 'textbook_consolidation' as const,
      status: 'ready' as const,
      items: [
        {
          item_id: 'sync-1',
          position: 2,
          plan_section: 'textbook_consolidation' as const,
          source_kind: 'curriculum',
          generation_method: 'ai_generated' as const,
          source_ref: 'progress-1',
          verification: {
            status: 'verified' as const,
            evidence_refs: ['人教版五下 · 第4单元'],
            textbook_binding_id: 'pep-5b',
            unit_id: 'unit-4',
            verified_page_from: 52,
            verified_page_to: 53,
          },
          prompt_markdown: '写出一个与 3/4 相等的分数。',
        },
      ],
    },
    {
      plan_section: 'arithmetic_warmup' as const,
      status: 'failed' as const,
      failure_message: '口算生成暂时不可用，请稍后重试',
      items: [],
    },
  ],
  created_at: '2026-07-20T00:00:00Z',
  updated_at: '2026-07-20T00:00:00Z',
}

describe('K12WeeklyPracticePanel projection', () => {
  it('keeps due review while missing progress routes to the canonical form', async () => {
    const wrapper = mount(K12WeeklyPracticePanel, {
      props: {
        progress: null,
        settings: {
          ...settings,
          textbook_consolidation_enabled: false,
          textbook_consolidation_tier: 'standard' as const,
          arithmetic_warmup_enabled: false,
        },
        plan: plan as any,
        history: [],
      },
      global: {
        stubs: {
          MarkdownRenderer: {
            props: ['content'],
            template: '<div>{{ content }}</div>',
          },
        },
      },
    })

    expect(wrapper.text()).toContain('设置教材进度，推荐更贴合课堂')
    expect(wrapper.text()).not.toContain('确认当前教材、单元和页码后')
    expect(wrapper.get('[data-testid="setup-weekly-progress"]').text()).toBe('调整进度')
    expect(wrapper.text()).toContain('到期复习 · 原题')
    expect(wrapper.find('[data-track="textbook_consolidation"]').exists()).toBe(true)

    await wrapper.get('[data-testid="setup-weekly-progress"]').trigger('click')
    expect(wrapper.emitted('open-progress')).toEqual([[]])
  })

  it('shows verified evidence, independent degradation, and server-owned ISO week fields', () => {
    const wrapper = mount(K12WeeklyPracticePanel, {
      props: {
        progress: {
          progress_id: 'progress-1',
          agent: 'mingming',
          subject: 'math',
          revision: 4,
          textbook_binding_id: 'pep-5b',
          textbook_edition: '人教版',
          textbook_version: '2022',
          title: '义务教育教科书数学',
          volume: '五年级下册',
          unit_id: 'unit-4',
          unit_title: '第4单元「分数的意义和性质」',
          requested_page_from: 45,
          requested_page_to: 62,
          verified_page_from: 45,
          verified_page_to: 62,
          page_verification_status: 'verified',
          segment_refs: ['segment-45-62'],
          evidence_source: 'parent_confirmed',
          confirmed_at: '2026-07-20T00:00:00Z',
          created_at: '2026-07-20T00:00:00Z',
          updated_at: '2026-07-20T00:00:00Z',
        } as any,
        settings,
        plan: plan as any,
        history: [
          {
            snapshot_id: 'snapshot-30',
            plan_id: 'weekly-30',
            iso_week_year: 2026,
            iso_week_number: 30,
            timezone: 'Asia/Shanghai',
            local_start_date: '2026-07-20',
            local_end_date: '2026-07-26',
            item_count: 9,
            archived_at: '2026-07-27T00:00:00+08:00',
          },
        ] as any,
      },
      global: {
        stubs: {
          MarkdownRenderer: {
            props: ['content'],
            template: '<div>{{ content }}</div>',
          },
        },
      },
    })

    expect(wrapper.text()).toContain(
      '人教版 · 五年级下册 · 第4单元「分数的意义和性质」 · P45–62',
    )
    expect(wrapper.text()).toContain('到期复习 · 原题')
    expect(wrapper.text()).not.toContain('来源：真实错题')
    expect(wrapper.text()).toContain('依据：小数乘法错题 · 连续错 2 次')
    expect(wrapper.text()).toContain('同步巩固 · AI生成')
    expect(wrapper.text()).toContain('依据：人教版五下 · 第4单元 · P52–53')
    expect(wrapper.text()).toContain('口算生成暂时不可用，请稍后重试')
    expect(wrapper.text()).toContain('7月20日–7月26日 · 2026年第30周')
  })

  it('[K12-WEEKLY-044] emits every history action against one frozen snapshot/artifact identity', async () => {
    const historyItem = Object.freeze({
      snapshot_id: 'snapshot-29',
      artifact_id: 'artifact-29',
      plan_id: 'weekly-29',
      iso_week_year: 2026,
      iso_week_number: 29,
      timezone: 'Asia/Shanghai',
      local_start_date: '2026-07-13',
      local_end_date: '2026-07-19',
      item_count: 8,
      correct_count: 7,
      wrong_count: 1,
      needs_review_count: 0,
      archived_at: '2026-07-20T00:00:00+08:00',
    })
    const historySnapshot = Object.freeze({
      snapshot_id: 'snapshot-29',
      artifact_id: 'artifact-29',
      plan_id: 'weekly-29',
      plan_revision: 4,
      agent: 'mingming',
      iso_week_year: 2026,
      iso_week_number: 29,
      timezone: 'Asia/Shanghai',
      week_start: '2026-07-13T00:00:00+08:00',
      week_end: '2026-07-19T23:59:59+08:00',
      local_start_date: '2026-07-13',
      local_end_date: '2026-07-19',
      settings_revision: 2,
      tracks: [],
      render_version: 'weekly-v1',
      snapshot_digest: 'sha256:frozen-history-29',
      created_at: '2026-07-20T00:00:00+08:00',
    })
    const wrapper = mount(K12WeeklyPracticePanel, {
      props: {
        progress: null,
        settings,
        plan: plan as any,
        history: [historyItem] as any,
        historySnapshot: historySnapshot as any,
      },
      global: {
        stubs: {
          MarkdownRenderer: {
            props: ['content'],
            template: '<div>{{ content }}</div>',
          },
          Teleport: true,
        },
      },
    })

    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text() === '历史')!
      .trigger('click')
    expect(wrapper.emitted('update:view')).toEqual([['history']])
    expect(wrapper.findAll('.weekly-history__card button').map((button) => button.text())).toEqual([
      '查看周练',
    ])

    await wrapper.get('.weekly-history__card button').trigger('click')
    expect(wrapper.emitted('open-history')).toEqual([[historyItem]])
    const historyActions = wrapper.findAll('.weekly-history-dialog__actions button')
    expect(historyActions.map((button) => button.text())).toEqual([
      '打印',
      '发送到手机',
      '查看对应学情',
    ])

    for (const button of historyActions.slice(0, 2)) await button.trigger('click')
    expect(
      wrapper.emitted('history-artifact-action')?.map(([intent]) => intent),
    ).toEqual([
      { action: 'print', snapshot_id: 'snapshot-29', artifact_id: 'artifact-29' },
      { action: 'send_im', snapshot_id: 'snapshot-29', artifact_id: 'artifact-29' },
    ])
    expect(historySnapshot.snapshot_digest).toBe('sha256:frozen-history-29')

    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text() === '本周')!
      .trigger('click')
    expect(wrapper.emitted('update:view')).toEqual([['history'], ['current']])
  })
})
