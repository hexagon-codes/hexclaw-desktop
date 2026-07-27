import { vi } from 'vitest'

export function weeklyPracticeApiMockDefaults(agent = 'test-agent') {
  return {
    k12GetCurriculumProgress: vi.fn().mockResolvedValue({ progress: null }),
    k12GetWeeklyPracticeSettings: vi.fn().mockResolvedValue({
      agent,
      revision: 1,
      timezone: 'Asia/Shanghai',
      due_review_enabled: true,
      textbook_consolidation_enabled: false,
      arithmetic_warmup_enabled: false,
      arithmetic_minutes: 2,
      created_at: '2026-07-27T00:00:00Z',
      updated_at: '2026-07-27T00:00:00Z',
    }),
    k12EnsureWeeklyPracticePlan: vi.fn().mockResolvedValue({
      plan: {
        plan_id: 'weekly-test',
        agent,
        revision: 1,
        iso_week_year: 2026,
        iso_week_number: 31,
        timezone: 'Asia/Shanghai',
        week_start: '2026-07-27T00:00:00+08:00',
        week_end: '2026-08-02T23:59:59+08:00',
        local_start_date: '2026-07-27',
        local_end_date: '2026-08-02',
        status: 'draft',
        settings_revision: 1,
        tracks: [],
        created_at: '2026-07-27T00:00:00Z',
        updated_at: '2026-07-27T00:00:00Z',
      },
      replayed: false,
    }),
    k12GetWeeklyPracticeHistory: vi.fn().mockResolvedValue({
      items: [],
      next_cursor: null,
    }),
  }
}
