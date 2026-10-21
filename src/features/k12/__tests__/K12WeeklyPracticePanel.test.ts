import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import k12Zh from '../i18n/zh-CN'

import K12WeeklyPracticePanel from '../components/K12WeeklyPracticePanel.vue'

function i18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': { k12: k12Zh } } })
}

// 父面板只消费冻结文件回执，PDF传输使用完整DTO夹具，避免挂载触发真实请求。
vi.mock('@/api/k12', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/k12')>()
  return {
    ...original,
    k12PrepareWeeklyTrackOutput: vi.fn().mockImplementation(async (agent: string, planId: string, section: string) => ({
      artifact: {
        artifact_id: `${agent}:${planId}:${section}`,
        source_kind: 'weekly_practice_snapshot', source_ref: planId,
        title: '练习单', source_digest: 'sha256:fixture-source', format: 'pdf',
        render_contract_version: 'practice-print-v1', content_type: 'application/pdf',
        byte_digest: 'sha256:fixture-pdf', byte_size: 11,
      },
      replayed: false,
    })),
    k12GetPrintArtifactContent: vi.fn().mockResolvedValue(new Blob(['fixture-pdf'], { type: 'application/pdf' })),
  }
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
        plugins: [i18n()],
        stubs: {
          MarkdownRenderer: {
            props: ['content'],
            template: '<div>{{ content }}</div>',
          },
        },
      },
    })

    await wrapper.get('[data-testid="setup-weekly-progress"]').trigger('click')
    expect(wrapper.emitted('open-progress')).toEqual([[]])
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
        plugins: [i18n()],
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
    await wrapper.get('.weekly-history__card button').trigger('click')
    expect(wrapper.emitted('open-history')).toEqual([[historyItem]])
    const historyActions = wrapper.findAll('.weekly-history-dialog__actions button')
    for (const button of historyActions.slice(0, 2)) await button.trigger('click')
    expect(wrapper.emitted('history-artifact-action')?.map(([intent]) => intent)).toEqual([
      { action: 'print', snapshot_id: 'snapshot-29', artifact_id: 'artifact-29' },
      { action: 'send_im', snapshot_id: 'snapshot-29', artifact_id: 'artifact-29' },
    ])
    expect(historySnapshot.snapshot_digest).toBe('sha256:frozen-history-29')
    expect(wrapper.emitted('prepare-output')).toBeUndefined()

    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text() === '本周')!
      .trigger('click')
    expect(wrapper.emitted('update:view')).toEqual([['history'], ['current']])
  })
})
