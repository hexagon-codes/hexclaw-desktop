import { beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  api: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}))

vi.mock('../client', () => client)

import * as k12Api from '../k12'
import apiSource from '../k12.ts?raw'

const EXPECTED_RUNTIME_EXPORTS = [
  'k12AddAccumulation',
  'k12AddGrounding',
  'k12AddToBasket',
  'k12AdvancePracticeSet',
  'k12ArchiveMistake',
  'k12AssetURL',
  'k12Backup',
  'k12BindIM',
  'k12CancelImageTask',
  'k12CancelPracticeSet',
  'k12ColdStart',
  'k12CommitGenericPrintReceipt',
  'k12CommitPracticePrintReceipt',
  'k12ConfirmImageTask',
  'k12CreateCreativeWork',
  'k12CreateImageTask',
  'k12DeleteMistake',
  'k12ExportMd',
  'k12FillPracticeBasket',
  'k12FinalizePracticeSet',
  'k12GenerateCustomPaper',
  'k12GenerateWorkFeedback',
  'k12GetCreativeWork',
  'k12GetDeliveryBatch',
  'k12GetGenericPrintArtifact',
  'k12GetGenericPrintJob',
  'k12GetImageTask',
  'k12GetImageTaskResult',
  'k12GetPracticePaper',
  'k12GetPracticePrintJob',
  'k12GetPracticePrintJobPaper',
  'k12GetPracticeSet',
  'k12GetViewDescriptor',
  'k12Grade',
  'k12GradePracticeSet',
  'k12InsightReport',
  'k12ListAccumulation',
  'k12ListCreativeWorks',
  'k12ListMistakes',
  'k12ListPracticeSets',
  'k12MarkMastered',
  'k12TutoringTips',
  'k12PrepareGenericPrintJob',
  'k12PreparePracticePrintJob',
  'k12ProvisionCron',
  'k12QueryDeliveryBatch',
  'k12RecordMistake',
  'k12RecordGenericPrintEvent',
  'k12RecordPracticePrintEvent',
  'k12RemoveFromBasket',
  'k12Restore',
  'k12RestoreAs',
  'k12RestoreMistake',
  'k12RetryDeliveryBatch',
  'k12RetryGenericPrintJob',
  'k12RetryImageTask',
  'k12RetryPracticePrintJob',
  'k12ReviewQueue',
  'k12ReviewRetry',
  'k12RollbackRestoreAs',
  'k12SendAccumulation',
  'k12SendTutoringTips',
  'k12Solve',
  'k12SubmitPracticeSet',
  'k12SubmitWorkRevision',
  'k12TutorTurn',
  'k12UpdateProfile',
  'k12UploadAsset',
  'k12VerifyPracticeItem',
  'renderDocument',
].sort()

describe('K12 Desktop runtime export contract', () => {
  beforeEach(() => {
    Object.values(client).forEach((mock) => mock.mockReset())
  })

  it('matches the approved public function exact-set, including result and excluding retired bypasses', () => {
    const actual = Object.entries(k12Api)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort()

    expect(actual).toEqual(EXPECTED_RUNTIME_EXPORTS)
  })

  it('regenerates work feedback with a caller-owned idempotency command', async () => {
    const controller = new AbortController()
    client.apiPost.mockResolvedValue({ record_id: 'work-1' })

    await k12Api.k12GenerateWorkFeedback(
      'tutor/小明',
      'work / 1',
      'feedback-command-1',
      controller.signal,
    )

    expect(client.apiPost).toHaveBeenCalledWith(
      '/api/k12/creative-works/work%20%2F%201/generate-feedback',
      { agent: 'tutor/小明', command_id: 'feedback-command-1' },
      { timeout: 240_000, signal: controller.signal },
    )
  })

  it('does not expose retired CreativeWork actions while preserving legacy read-only facts', () => {
    expect(apiSource).not.toMatch(/\ballowed_actions\b/)
    expect(apiSource).not.toMatch(/\bpractice_card(?:_done_at)?\b/)
    expect(apiSource).not.toContain('creative_observation_card')
    expect(apiSource).toMatch(
      /WorkStatus\s*=\s*'draft'\s*\|\s*'feedback_ready'\s*\|\s*'revised'\s*\|\s*'archived'/,
    )
    expect(apiSource).toMatch(/source:\s*'ai'\s*\|\s*'parent'/)
  })

  it('reads a completed image task only through the owner-scoped public result endpoint', async () => {
    const controller = new AbortController()
    const expected = {
      dispatch_id: 'dispatch / 1',
      task_intent: 'completed_homework',
      status: 'routed',
      result: {
        kind: 'completed_homework',
        payload: {
          mode: 'grade',
          task_intent: 'completed_homework',
          result_surface: 'annotated_homework',
          items: [],
          markdown: '# 批改结果',
          image_warning: '',
          annotated_image: {
            mime: 'image/png',
            data_base64: 'QU5OT1RBVEVE',
            digest: 'sha256:annotated',
          },
        },
      },
    }
    client.apiGet.mockResolvedValue(expected)

    const resultFn = (k12Api as Record<string, unknown>).k12GetImageTaskResult
    expect(resultFn).toBeTypeOf('function')
    if (typeof resultFn !== 'function') return

    const result = await resultFn('tutor/小明', 'dispatch / 1', controller.signal)

    expect(result).toEqual(expected)
    expect(client.apiGet).toHaveBeenCalledWith(
      '/api/k12/image-tasks/dispatch%20%2F%201/result',
      { agent: 'tutor/小明' },
      { signal: controller.signal },
    )
  })

  it('keeps archive reads owner-scoped and restores the exact checksum-covered envelope', async () => {
    const archive = {
      version: 4,
      archive_id: 'archive-1',
      agent_name: 'tutor-a',
      exported_at: 1_784_400_000,
      records: [],
      assets: [],
      creative_work_ocr: [],
      checksum: 'sha256:archive',
    }
    client.apiGet.mockResolvedValueOnce(archive).mockResolvedValueOnce({
      format: 'markdown',
      content: '# 小明学习档案\n\n$x^2$',
    })
    client.apiPost.mockResolvedValue({ restored: 0, snapshot: null })

    await k12Api.k12Backup('tutor-a')
    await k12Api.k12ExportMd('tutor-a')
    await k12Api.k12Restore(archive)

    expect(client.apiGet).toHaveBeenNthCalledWith(1, '/api/k12/backup', { agent: 'tutor-a' })
    expect(client.apiGet).toHaveBeenNthCalledWith(2, '/api/k12/export', {
      agent: 'tutor-a',
      format: 'md',
    })
    expect(client.apiPost).toHaveBeenCalledWith('/api/k12/restore', archive)
  })

  it.each([
    ['pdf', new Blob(['{"error":"renderer failed"}'], { type: 'application/json' })],
    ['docx', new Blob(['<html>not a docx</html>'], { type: 'text/html' })],
  ] as const)(
    'rejects a renderer payload that masquerades as %s before callers can save it',
    async (format, blob) => {
      client.api.mockResolvedValue(blob)

      await expect(
        k12Api.renderDocument({ content: '# 学习档案', format, title: '小明学习档案' }),
      ).rejects.toThrow(/render|文件|格式|magic|PDF|DOCX/i)
    },
  )
})
