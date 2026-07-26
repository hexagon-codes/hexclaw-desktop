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
          arithmetic_warmup_enabled: false,
        },
        plan,
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
    expect(wrapper.text()).toContain(
      '确认当前教材、单元和页码后，系统会补充与课堂同步的练习。错题巩固不受影响。',
    )
    expect(wrapper.text()).toContain('到期复习 · 原题')
    expect(wrapper.find('[data-track="textbook_consolidation"]').exists()).toBe(false)

    await wrapper.get('[data-testid="setup-weekly-progress"]').trigger('click')
    expect(wrapper.emitted('open-progress')).toEqual([
      [{ enableTextbookConsolidation: true }],
    ])
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
        },
        settings,
        plan,
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
        ],
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
    expect(wrapper.text()).toContain('来源：真实错题')
    expect(wrapper.text()).toContain('依据：小数乘法错题 · 连续错 2 次')
    expect(wrapper.text()).toContain('同步巩固 · AI生成')
    expect(wrapper.text()).toContain('依据：人教版五下 · 第4单元 · P52–53')
    expect(wrapper.text()).toContain('口算生成暂时不可用，请稍后重试')
    expect(wrapper.text()).toContain('7月20日–7月26日 · 2026年第30周')
  })
})
