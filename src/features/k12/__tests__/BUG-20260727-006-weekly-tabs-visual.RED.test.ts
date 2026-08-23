import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import K12WeeklyPracticePanel from '../components/K12WeeklyPracticePanel.vue'

const settings = {
  agent: 'mingming',
  revision: 1,
  timezone: 'Asia/Shanghai',
  due_review_enabled: true,
  textbook_consolidation_enabled: false,
  textbook_consolidation_tier: 'standard',
  arithmetic_warmup_enabled: false,
  arithmetic_minutes: 2,
  created_at: '2026-07-20T00:00:00Z',
  updated_at: '2026-07-20T00:00:00Z',
}

const plan = {
  plan_id: 'weekly-30',
  agent: 'mingming',
  revision: 1,
  iso_week_year: 2026,
  iso_week_number: 30,
  timezone: 'Asia/Shanghai',
  week_start: '2026-07-20T00:00:00+08:00',
  week_end: '2026-07-26T23:59:59+08:00',
  local_start_date: '2026-07-20',
  local_end_date: '2026-07-26',
  status: 'draft',
  settings_revision: 1,
  curriculum_progress_revision: null,
  tracks: [
    { plan_section: 'due_review', status: 'ready', items: [] },
    { plan_section: 'textbook_consolidation', status: 'disabled', items: [] },
    { plan_section: 'arithmetic_warmup', status: 'disabled', items: [] },
  ],
  created_at: '2026-07-20T00:00:00Z',
  updated_at: '2026-07-20T00:00:00Z',
}

describe('BUG-20260727-006 weekly tabs visual contract', () => {
  it('uses direct shared K12BookTabs buttons without period card or source-tag variants', () => {
    const wrapper = mount(K12WeeklyPracticePanel, {
      props: {
        progress: null,
        settings: settings as any,
        plan: plan as any,
        history: [],
      },
    })

    const tabs = wrapper.get('[role="tablist"][aria-label="本周该练视图"]')
    expect(tabs.classes()).toContain('k12-book-tabs')
    expect(tabs.classes()).not.toContain('k12-secondary-tabs')
    expect(tabs.find('.k12-secondary-tabs__label').exists()).toBe(false)
    expect(tabs.findAll('.source-tag')).toHaveLength(0)

    const buttons = tabs.findAll('button')
    expect(buttons.map((button) => button.text())).toEqual(['本周', '历史'])
    expect(buttons.every((button) => button.element.parentElement === tabs.element)).toBe(true)
  })
})
