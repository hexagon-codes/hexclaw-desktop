import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import K12WeeklyPracticePanel from '../components/K12WeeklyPracticePanel.vue'
import panelSource from '../components/K12WeeklyPracticePanel.vue?raw'

const settings = {
  agent: 'mingming',
  revision: 7,
  timezone: 'Asia/Shanghai',
  due_review_enabled: true as const,
  textbook_consolidation_enabled: false,
  arithmetic_warmup_enabled: false,
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
  verified_page_from: 45,
  verified_page_to: 62,
  page_verification_status: 'verified',
  segment_refs: ['segment-45-62'],
  evidence_source: 'parent_confirmed',
  confirmed_at: '2026-07-20T00:00:00Z',
  created_at: '2026-07-20T00:00:00Z',
  updated_at: '2026-07-20T00:00:00Z',
}

const availabilityValues = [
  'available',
  'setup_required',
  'processing',
  'failed_retryable',
  'failed_terminal',
] as const

function makePlan(availability: (typeof availabilityValues)[number] = 'available') {
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
    ],
    manual_track_recommendations: {
      textbook_consolidation: {
        availability,
        selected_item_count: 5,
        recommended_item_count: 5,
        min_item_count: 1,
        max_item_count: 10,
      },
      arithmetic_warmup: {
        availability,
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

function mountPanel(availability: (typeof availabilityValues)[number] = 'available') {
  return mount(K12WeeklyPracticePanel, {
    props: {
      progress: progress as any,
      settings: settings as any,
      plan: makePlan(availability) as any,
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

describe('BUG-20260727-005 approved weekly manual-track projection', () => {
  it('keeps both manual recommendation cards visible when both automatic settings are false', () => {
    const wrapper = mountPanel()

    expect(wrapper.get('[data-textbook-consolidation-state]').text()).toContain('同步巩固')
    expect(wrapper.get('[data-arithmetic-state]').text()).toContain('口算热身')
  })

  it.each(availabilityValues)(
    'projects the exact manual-track availability state %s',
    (availability) => {
      const wrapper = mountPanel(availability)

      expect(
        wrapper.get(
          `[data-textbook-consolidation-state][data-availability="${availability}"]`,
        ),
      ).toBeTruthy()
      expect(
        wrapper.get(`[data-arithmetic-state][data-availability="${availability}"]`),
      ).toBeTruthy()
    },
  )

  it('uses the shared inline count field and emits the selected textbook item_count', async () => {
    const wrapper = mountPanel()
    const field = wrapper.get('[data-testid="manual-count-textbook_consolidation"]')
    const input = field.get('input[type="number"]')

    expect(panelSource).toContain('K12ManualQuestionCountField')
    expect(input.attributes('min')).toBe('1')
    expect(input.attributes('max')).toBe('10')
    expect((input.element as HTMLInputElement).value).toBe('5')
    expect(wrapper.find('[role="group"][aria-label="同步巩固本次题量"]').exists()).toBe(false)

    await input.setValue('8')
    await wrapper.get('[data-consolidation-action]').trigger('click')

    expect(wrapper.emitted('prepare-textbook')).toContainEqual([{ item_count: 8 }])
  })

  it('uses the same inline count field and emits arithmetic create with item_count', async () => {
    const wrapper = mountPanel()
    const field = wrapper.get('[data-testid="manual-count-arithmetic_warmup"]')
    const input = field.get('input[type="number"]')

    expect(input.attributes('min')).toBe('1')
    expect(input.attributes('max')).toBe('20')
    expect((input.element as HTMLInputElement).value).toBe('10')
    expect(wrapper.find('[role="group"][aria-label="口算热身本组时长"]').exists()).toBe(false)

    await input.setValue('15')
    await wrapper.get('[data-arithmetic-action]').trigger('click')

    expect(wrapper.emitted('arithmetic-action')).toContainEqual([
      { action: 'create', item_count: 15 },
    ])
  })

  it('keeps the selected count in both retryable generation labels', () => {
    const plan = makePlan('failed_retryable') as any
    plan.manual_track_recommendations.textbook_consolidation.selected_item_count = 6
    plan.manual_track_recommendations.arithmetic_warmup.selected_item_count = 12
    plan.tracks.push(
      {
        plan_section: 'textbook_consolidation',
        status: 'failed',
        failure_message: '同步巩固生成失败',
        items: [],
        arithmetic_batch: null,
      },
      {
        plan_section: 'arithmetic_warmup',
        status: 'failed',
        failure_message: '口算热身生成失败',
        items: [],
        arithmetic_batch: {
          batch_id: 'batch-retryable',
          state: 'failed_retryable',
          item_count: 0,
          content_digest: '',
          retryable: true,
          failure_message: '口算热身生成失败',
          created_at: '2026-07-20T00:00:00Z',
          updated_at: '2026-07-20T00:00:00Z',
        },
      },
    )
    const wrapper = mount(K12WeeklyPracticePanel, {
      props: {
        progress: progress as any,
        settings: settings as any,
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

    const labels = wrapper.findAll('button').map((button) => button.text().trim())
    expect(labels).toContain('重试生成 6 道')
    expect(labels).toContain('重试生成 12 道')
  })

  it('keeps defer and long-term suppress as visible text actions on every due item', async () => {
    const plan = makePlan() as any
    plan.tracks[0].items = [
      {
        item_id: 'weekly-item-1',
        position: 1,
        plan_section: 'due_review',
        source_kind: 'mistake',
        generation_method: 'original',
        source_ref: 'mistake-1',
        verification: {
          status: 'verified',
          evidence_refs: ['批改记录'],
        },
        prompt_markdown: '2 + 3 = ?',
      },
    ]
    const wrapper = mount(K12WeeklyPracticePanel, {
      props: {
        progress: progress as any,
        settings: settings as any,
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
    const item = wrapper.get('.weekly-item')
    const actions = item.findAll('button').map((button) => button.text().trim())

    // 架构图 10（2026-07-25 裁决）：到期复习行必须有一键加入练习集动作（用户 2026-08-16 对齐原型）
    expect(actions).toEqual(['加入练习集', '本周先不练', '不再复习'])
    expect(item.find('[aria-label*="更多"]').exists()).toBe(false)

    // 按钮顺序：加入练习集 / 本周先不练 / 不再复习（suppress 弹层在第三个）
    await item.findAll('button')[2]!.trigger('click')
    const confirm = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-suppress-review"]',
    )
    expect(confirm).not.toBeNull()
    confirm!.click()
    await nextTick()
    expect(wrapper.emitted('suppress-item')).toContainEqual([plan.tracks[0].items[0]])
  })

  it('shows the exact approved positive empty state when this week has no mistakes', () => {
    const wrapper = mountPanel()

    expect(wrapper.text()).toContain('本周暂时没有需要复习的错题')
    expect(wrapper.text()).toContain(
      '可以根据当前教材进度做几道同步巩固，或者进行一次口算热身',
    )
  })

  it('uses the shared K12BookTabs contract and removes the private weekly tab styling', () => {
    const wrapper = mountPanel()
    const tabs = wrapper.get('[role="tablist"][aria-label="本周该练视图"]')

    expect(panelSource).toContain('K12BookTabs')
    expect(tabs.classes()).toContain('k12-book-tabs')
    expect(wrapper.find('.weekly-tabs').exists()).toBe(false)
  })
})
