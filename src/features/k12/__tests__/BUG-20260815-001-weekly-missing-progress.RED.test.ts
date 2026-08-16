import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import K12WeeklyPracticePanel from '../components/K12WeeklyPracticePanel.vue'
import panelSource from '../components/K12WeeklyPracticePanel.vue?raw'

const settings = {
  agent: 'mingming',
  revision: 7,
  timezone: 'Asia/Shanghai',
  due_review_enabled: true as const,
  textbook_consolidation_enabled: true,
  textbook_consolidation_tier: 'standard' as const,
  arithmetic_warmup_enabled: true,
  arithmetic_minutes: 2,
  created_at: '2026-07-20T00:00:00Z',
  updated_at: '2026-07-20T00:00:00Z',
}

const progress = {
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
}

function makeSetupRequiredPlan() {
  return {
    plan_id: 'weekly-30',
    agent: 'mingming',
    revision: 11,
    iso_week_year: 2026,
    iso_week_number: 30,
    timezone: 'Asia/Shanghai',
    week_start: '2026-07-20T00:00:00+08:00',
    week_end: '2026-07-26T23:59:59+08:00',
    local_start_date: '2026-07-20',
    local_end_date: '2026-07-26',
    status: 'draft',
    settings_revision: 7,
    curriculum_progress_revision: 4,
    tracks: [
      {
        plan_section: 'due_review',
        status: 'ready',
        items: [],
      },
      {
        plan_section: 'textbook_consolidation',
        status: 'failed',
        failure_message: 'curriculum progress setup required',
        items: [],
        arithmetic_batch: null,
      },
      {
        plan_section: 'arithmetic_warmup',
        status: 'failed',
        failure_message: 'curriculum progress setup required',
        items: [],
        arithmetic_batch: {
          batch_id: '',
          state: 'failed_retryable',
          item_count: 0,
          content_digest: '',
          retryable: false,
          failure_message: 'curriculum progress setup required',
          created_at: '2026-07-20T00:00:00Z',
          updated_at: '2026-07-20T00:00:00Z',
        },
      },
    ],
    manual_track_recommendations: {
      textbook_consolidation: {
        availability: 'setup_required',
        selected_item_count: 5,
        recommended_item_count: 5,
        min_item_count: 1,
        max_item_count: 10,
      },
      arithmetic_warmup: {
        availability: 'setup_required',
        selected_item_count: 10,
        recommended_item_count: 10,
        min_item_count: 1,
        max_item_count: 20,
      },
    },
    created_at: '2026-07-20T00:00:00Z',
    updated_at: '2026-07-20T00:00:00Z',
  }
}

function mountPanel(plan: unknown = makeSetupRequiredPlan()) {
  return mount(K12WeeklyPracticePanel, {
    props: {
      progress: progress as any,
      settings: settings as any,
      plan: plan as any,
      history: [],
    },
    global: {
      stubs: {
        MarkdownRenderer: {
          props: ['content'],
          template: '<div>{{ content }}</div>',
        },
        FinalArtifactActions: true,
      },
    },
  })
}

describe('BUG-20260815-001 approved weekly missing-progress surface', () => {
  it('keeps the missing-progress card in a stacked grid that wraps long text', () => {
    // 权威原型 app.html:1414：.rc-week-progress--missing>div{display:grid;gap:3px;max-width:760px}
    // 生产必须保留纵向堆叠与正常换行，不得被 flex+nowrap 覆盖成单行溢出。
    const innerRule =
      panelSource.match(/\.weekly-progress--missing > div \{[\s\S]*?\n}/)?.[0] ?? ''
    const outerRules =
      panelSource.match(/\.weekly-progress--missing \{[\s\S]*?\n}/g) ?? []
    const spanRule =
      panelSource.match(/\.weekly-progress--missing > div > span \{[\s\S]*?\n}/)?.[0] ?? ''
    expect(innerRule).toContain('display: grid')
    expect(innerRule).toContain('max-width: 760px')
    expect(outerRules.some((rule) => rule.includes('align-items: flex-start'))).toBe(true)
    expect(spanRule).toContain('white-space: normal')
    expect(spanRule).not.toContain('white-space: nowrap')
  })

  it('projects the approved Chinese setup guidance instead of the raw English failure message', () => {
    const wrapper = mountPanel()

    expect(wrapper.text()).not.toContain('curriculum progress setup required')
    expect(wrapper.text()).toContain('先设置教材进度，再生成同步巩固题')
    expect(wrapper.text()).toContain('先设置教材进度，再生成口算热身题')
  })
})
