import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  api: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  api: h.api,
  apiGet: h.get,
  apiPost: h.post,
  apiPut: h.put,
  apiDelete: h.del,
}))

import {
  k12CreateWeeklyArithmeticBatch,
  k12EnsureWeeklyPracticePlan,
  k12GetCurrentWeeklyPracticePlan,
  k12GetCurriculumCatalog,
  k12GetCurriculumProgress,
  k12GetPrintArtifactContent,
  k12GetWeeklyPracticeHistory,
  k12GetWeeklyPracticeSettings,
  k12GetWeeklyPracticeSnapshot,
  k12PrepareArtifactPrintJob,
  k12PrepareWeeklyPracticeTextbookTrack,
  k12PrepareWeeklyPracticeOutput,
  k12SaveWeeklyPracticePlanToPracticeSet,
  k12SendWeeklyPracticeSnapshot,
  k12SubmitWeeklyPracticeAttempt,
  k12UpdateProfileBundle,
  type CurriculumProgressResp,
  type ProfileBundleResp,
  type UpdateProfileBundleReq,
} from '@/api/k12'

const plan = {
  plan_id: 'plan-30',
  agent: 'mingming',
  revision: 3,
  iso_week_year: 2026,
  iso_week_number: 30,
  timezone: 'Asia/Shanghai',
  week_start: '2026-07-20T00:00:00+08:00',
  week_end: '2026-07-26T23:59:59+08:00',
  local_start_date: '2026-07-20',
  local_end_date: '2026-07-26',
  status: 'draft',
  settings_revision: 2,
  curriculum_progress_revision: 4,
  tracks: [],
  created_at: '2026-07-20T00:00:00Z',
  updated_at: '2026-07-20T00:00:00Z',
}

const snapshot = {
  snapshot_id: 'snapshot-30',
  plan_id: 'plan-30',
  plan_revision: 3,
  agent: 'mingming',
  iso_week_year: 2026,
  iso_week_number: 30,
  timezone: 'Asia/Shanghai',
  week_start: '2026-07-20T00:00:00+08:00',
  week_end: '2026-07-26T23:59:59+08:00',
  local_start_date: '2026-07-20',
  local_end_date: '2026-07-26',
  settings_revision: 2,
  curriculum_progress_revision: 4,
  tracks: [],
  render_version: 'weekly-v1',
  snapshot_digest: 'sha256:snapshot',
  created_at: '2026-07-20T00:00:00Z',
}

const artifact = {
  artifact_id: 'artifact-30',
  source_kind: 'weekly_practice_snapshot',
  source_ref: 'snapshot-30',
  title: '本周该练',
  source_digest: 'sha256:snapshot',
  format: 'pdf',
  render_contract_version: 'practice-print-v1',
  content_type: 'application/pdf',
  byte_digest: 'sha256:pdf',
  byte_size: 128,
}

describe('K12 weekly-practice HTTP contract', () => {
  beforeEach(() => {
    h.api.mockReset()
    h.get.mockReset()
    h.post.mockReset()
    h.put.mockReset()
    h.del.mockReset()
  })

  it('uses bare catalog, nullable progress wrapper, and bare default settings', async () => {
    const catalog = {
      agent: 'mingming',
      subject: 'math',
      textbook_binding_id: 'pep-5b',
      textbook_edition: '人教版',
      textbook_version: '2022',
      title: '数学',
      volume: '五年级下册',
      page_min: 1,
      page_max: 120,
      units: [],
    }
    const progress: CurriculumProgressResp = { progress: null, revision: 0 }
    const settings = {
      agent: 'mingming',
      revision: 0,
      timezone: 'Asia/Shanghai',
      due_review_enabled: true,
      textbook_consolidation_enabled: false,
      textbook_consolidation_tier: 'standard',
      arithmetic_warmup_enabled: false,
      arithmetic_minutes: 2,
      created_at: '',
      updated_at: '',
    }
    h.get.mockResolvedValueOnce(catalog).mockResolvedValueOnce(progress).mockResolvedValueOnce(settings)

    await expect(
      k12GetCurriculumCatalog('mingming', '人教版', '五年级下册'),
    ).resolves.toBe(catalog)
    await expect(k12GetCurriculumProgress('mingming')).resolves.toEqual({
      progress: null,
      revision: 0,
    })
    await expect(k12GetWeeklyPracticeSettings('mingming')).resolves.toBe(settings)

    expect(h.get).toHaveBeenNthCalledWith(1, '/api/k12/curriculum-catalog', {
      agent: 'mingming',
      subject: 'math',
      textbook_edition: '人教版',
      volume: '五年级下册',
    })
    expect(h.get).toHaveBeenNthCalledWith(2, '/api/k12/curriculum-progress', {
      agent: 'mingming',
      subject: 'math',
    })
    expect(h.get).toHaveBeenNthCalledWith(3, '/api/k12/weekly-practice/settings', {
      agent: 'mingming',
    })
    expect(Object.keys(settings).sort()).toEqual([
      'agent',
      'arithmetic_minutes',
      'arithmetic_warmup_enabled',
      'created_at',
      'due_review_enabled',
      'revision',
      'textbook_consolidation_enabled',
      'textbook_consolidation_tier',
      'timezone',
      'updated_at',
    ])
  })

  it('sends the profile bundle once with the three CAS revisions and canonical subobjects', async () => {
    const request: UpdateProfileBundleReq = {
      agent: 'mingming',
      idempotency_key: 'bundle-1',
      expected_profile_revision: 3,
      expected_progress_revision: 4,
      expected_settings_revision: 5,
      agent_config: {
        display_name: '小明的辅导助手',
        description: '小明的专属辅导助手',
        system_prompt: '辅导小明完成五年级下学期的学习。',
        provider: 'HexClaw-GPT',
        model: 'gpt-5.6-sol',
        skills: [],
      },
      profile: {
        child_name: '小明',
        grade_term: '五年级下',
        subject_textbooks: {
          math: '人教版',
          chinese: '统编版',
          english: '外研版',
          science: '苏教版',
          information_technology: '粤教版',
          art: '湘美版',
        },
      },
      curriculum_progress: {
        subject: 'math',
        textbook_manifest_id: 'manifest-pep-5b',
        volume: '五年级下册',
        unit_id: 'unit-4',
        page_from: 45,
        page_to: 62,
        evidence_source: 'parent_confirmed',
      },
      weekly_practice_settings: {
        timezone: 'Asia/Shanghai',
        textbook_consolidation_enabled: true,
        textbook_consolidation_tier: 'standard',
        arithmetic_warmup_enabled: true,
        arithmetic_minutes: 2,
      },
    }
    const response = {
      agent_config: request.agent_config,
      profile: { ...request.profile, textbook_edition: '人教版', revision: 4 },
      curriculum_progress: { revision: 5 },
      weekly_practice_settings: { revision: 6 },
      replayed: false,
    }
    h.put.mockResolvedValue(response)

    await expect(k12UpdateProfileBundle(request)).resolves.toBe(response)

    expect(h.put).toHaveBeenCalledExactlyOnceWith('/api/k12/profile-bundle', request)
    expect(Object.keys(response).sort()).toEqual([
      'agent_config',
      'curriculum_progress',
      'profile',
      'replayed',
      'weekly_practice_settings',
    ])
    expect(Object.keys(request.profile).sort()).toEqual([
      'child_name',
      'grade_term',
      'subject_textbooks',
    ])
    expect(Object.keys(request.profile.subject_textbooks).sort()).toEqual([
      'art',
      'chinese',
      'english',
      'information_technology',
      'math',
      'science',
    ])
    expect(response.profile.textbook_edition).toBe(response.profile.subject_textbooks.math)
  })

  it('models the nullable progress lifecycle in the profile-bundle contract', () => {
    const clearedProgress: UpdateProfileBundleReq['curriculum_progress'] = null
    const clearedResponseProgress: ProfileBundleResp['curriculum_progress'] = null
    const noProgress: CurriculumProgressResp = { progress: null, revision: 0 }

    expect(clearedProgress).toBeNull()
    expect(clearedResponseProgress).toBeNull()
    expect(noProgress).toEqual({ progress: null, revision: 0 })
  })

  it('preserves plan/current/history/snapshot wrapper and bare shapes', async () => {
    const history = {
      items: [
        {
          snapshot_id: 'snapshot-30',
          plan_id: 'plan-30',
          iso_week_year: 2026,
          iso_week_number: 30,
          timezone: 'Asia/Shanghai',
          local_start_date: '2026-07-20',
          local_end_date: '2026-07-26',
          item_count: 9,
          archived_at: '2026-07-27T00:00:00+08:00',
        },
      ],
      next_cursor: null,
    }
    h.post.mockResolvedValueOnce({ plan, replayed: false })
    h.get
      .mockResolvedValueOnce({ plan: null })
      .mockResolvedValueOnce(history)
      .mockResolvedValueOnce(snapshot)

    await expect(k12EnsureWeeklyPracticePlan('mingming', 'plan-key')).resolves.toEqual({
      plan,
      replayed: false,
    })
    await expect(k12GetCurrentWeeklyPracticePlan('mingming')).resolves.toEqual({ plan: null })
    await expect(k12GetWeeklyPracticeHistory('mingming', 'cursor-1', 20)).resolves.toBe(history)
    await expect(k12GetWeeklyPracticeSnapshot('mingming', 'snapshot-30')).resolves.toBe(snapshot)

    expect(h.post).toHaveBeenCalledWith('/api/k12/weekly-practice/plans', {
      agent: 'mingming',
      idempotency_key: 'plan-key',
    })
    expect(h.get).toHaveBeenNthCalledWith(2, '/api/k12/weekly-practice/plans/history', {
      agent: 'mingming',
      cursor: 'cursor-1',
      limit: 20,
    })
    expect(Object.keys(history).sort()).toEqual(['items', 'next_cursor'])
  })

  it('sends only the server-owned manual-track command fields', async () => {
    h.post.mockResolvedValueOnce({ plan, replayed: false }).mockResolvedValueOnce({
      batch: { batch_id: 'batch-30' },
      replayed: false,
    })

    await k12PrepareWeeklyPracticeTextbookTrack('plan-30', 3, 8, 'sync-1')
    await k12CreateWeeklyArithmeticBatch('plan-30', 3, 15, 'arithmetic-1')

    expect(h.post).toHaveBeenNthCalledWith(
      1,
      '/api/k12/weekly-practice/plans/plan-30/tracks/textbook_consolidation/prepare',
      {
        plan_revision: 3,
        item_count: 8,
        idempotency_key: 'sync-1',
      },
    )
    expect(h.post).toHaveBeenNthCalledWith(
      2,
      '/api/k12/weekly-practice/plans/plan-30/arithmetic-batches',
      {
        plan_revision: 3,
        item_count: 15,
        idempotency_key: 'arithmetic-1',
      },
    )
    for (const [, body] of h.post.mock.calls) {
      expect(body).not.toHaveProperty('agent')
      expect(body).not.toHaveProperty('expected_revision')
    }
  })

  it('prepares one existing artifact and reuses the artifact_id print variant/content endpoint', async () => {
    const prepared = { snapshot, artifact }
    const printJob = { print_job: { print_job_id: 'print-1', status: 'prepared' } }
    const pdf = new Blob(['pdf'], { type: 'application/pdf' })
    h.post.mockResolvedValueOnce(prepared).mockResolvedValueOnce(printJob)
    h.api.mockResolvedValue(pdf)

    await expect(
      k12PrepareWeeklyPracticeOutput('mingming', 'plan-30', 3, 'prepare-1'),
    ).resolves.toBe(prepared)
    await expect(
      k12PrepareArtifactPrintJob({
        agent: 'mingming',
        idempotency_key: 'print-1',
        artifact_id: 'artifact-30',
      }),
    ).resolves.toBe(printJob)
    await expect(k12GetPrintArtifactContent('mingming', 'artifact-30')).resolves.toBe(pdf)

    expect(Object.keys(prepared).sort()).toEqual(['artifact', 'snapshot'])
    expect(h.post).toHaveBeenNthCalledWith(
      2,
      '/api/k12/print-jobs',
      {
        agent: 'mingming',
        idempotency_key: 'print-1',
        artifact_id: 'artifact-30',
      },
    )
    expect(h.api).toHaveBeenCalledWith('/api/k12/print-artifacts/artifact-30/content', {
      method: 'GET',
      query: { agent: 'mingming' },
      responseType: 'blob',
    })
  })

  it('keeps send bare and attempt/save in their frozen wrappers', async () => {
    const delivery = {
      batch_id: 'delivery-1',
      agent_name: 'mingming',
      object_kind: 'weekly_practice_snapshot',
      object_id: 'snapshot-30',
      dedupe_key: 'send-1',
      content_digest: 'sha256:snapshot',
      status: 'pending',
      receipts: [],
      created_at: 1,
      updated_at: 1,
    }
    const attemptResponse = {
      attempt: {
        attempt_id: 'attempt-1',
        snapshot_id: 'snapshot-30',
        item_id: 'item-1',
        assessment_id: 'assessment-1',
        result: 'wrong',
        verification_evidence: {},
        mistake_record_id: 'mistake-1',
        review_scheduled: true,
        created_at: '2026-07-26T00:00:00Z',
      },
      replayed: false,
    }
    const saveResponse = {
      receipt: {
        save_receipt_id: 'save-1',
        plan_id: 'plan-30',
        plan_revision: 3,
        snapshot_id: 'snapshot-30',
        practice_set_id: 'practice-1',
        created_at: '2026-07-26T00:00:00Z',
      },
      replayed: false,
    }
    h.post
      .mockResolvedValueOnce(delivery)
      .mockResolvedValueOnce(attemptResponse)
      .mockResolvedValueOnce(saveResponse)

    await expect(
      k12SendWeeklyPracticeSnapshot('mingming', 'snapshot-30', 'send-1'),
    ).resolves.toBe(delivery)
    await expect(
      k12SubmitWeeklyPracticeAttempt(
        'mingming',
        'snapshot-30',
        'item-1',
        '12.5',
        'attempt-1',
      ),
    ).resolves.toBe(attemptResponse)
    await expect(
      k12SaveWeeklyPracticePlanToPracticeSet('mingming', 'plan-30', 3, 'save-1'),
    ).resolves.toBe(saveResponse)

    expect(Object.keys(delivery)).not.toContain('replayed')
    expect(Object.keys(attemptResponse).sort()).toEqual(['attempt', 'replayed'])
    expect(Object.keys(saveResponse).sort()).toEqual(['receipt', 'replayed'])
  })
})
