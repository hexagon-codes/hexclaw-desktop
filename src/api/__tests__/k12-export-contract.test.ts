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

const EXPECTED_RUNTIME_EXPORTS = [
  'k12AddAccumulation',
  'k12AddGrounding',
  'k12AddToBasket',
  'k12AdvancePracticeSet',
  'k12ArchiveCreativeWork',
  'k12AssetURL',
  'k12AttachWorkFeedback',
  'k12Backup',
  'k12BindIM',
  'k12CancelGradingJob',
  'k12CancelPracticeSet',
  'k12ColdStart',
  'k12CommitGenericPrintReceipt',
  'k12CommitPracticePrintReceipt',
  'k12ConfirmCreativeWorkOCR',
  'k12ConfirmGradingJob',
  'k12CreateCreativeWork',
  'k12CreateCreativeWorkOCR',
  'k12CreateGradingJob',
  'k12DeleteMistake',
  'k12ExportMd',
  'k12FillPracticeBasket',
  'k12FinalizePracticeSet',
  'k12GenerateCustomPaper',
  'k12GenerateWorkFeedback',
  'k12GetCreativeWork',
  'k12GetCreativeWorkOCR',
  'k12GetDeliveryReceipt',
  'k12GetGenericPrintArtifact',
  'k12GetGenericPrintJob',
  'k12GetGradingJob',
  'k12GetGradingJobResult',
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
  'k12MarkPracticeCardDone',
  'k12PrepCard',
  'k12PrepareGenericPrintJob',
  'k12PreparePracticePrintJob',
  'k12ProvisionCron',
  'k12QueryDeliveryReceipt',
  'k12RecordMistake',
  'k12RecordGenericPrintEvent',
  'k12RecordPracticePrintEvent',
  'k12RemoveFromBasket',
  'k12Restore',
  'k12RestoreAs',
  'k12RetryCreativeWorkOCR',
  'k12RetryDeliveryReceipt',
  'k12RetryGenericPrintJob',
  'k12RetryGradingJob',
  'k12RetryPracticePrintJob',
  'k12ReviewQueue',
  'k12ReviewRetry',
  'k12RollbackRestoreAs',
  'k12SendPrepCard',
  'k12SendWorkFeedback',
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

  it('reads a completed GradingJob only through the owner-scoped public result endpoint', async () => {
    const controller = new AbortController()
    const expected = {
      job_id: 'job / 1',
      result: { mode: 'grade', items: [], markdown: '# 批改结果' },
    }
    client.apiGet.mockResolvedValue(expected)

    const resultFn = (k12Api as Record<string, unknown>).k12GetGradingJobResult
    expect(resultFn).toBeTypeOf('function')
    if (typeof resultFn !== 'function') return

    const result = await resultFn('tutor/小明', 'job / 1', controller.signal)

    expect(result).toEqual(expected)
    expect(client.apiGet).toHaveBeenCalledWith(
      '/api/k12/grading-jobs/job%20%2F%201/result',
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
  ] as const)('rejects a renderer payload that masquerades as %s before callers can save it', async (format, blob) => {
    client.api.mockResolvedValue(blob)

    await expect(
      k12Api.renderDocument({ content: '# 学习档案', format, title: '小明学习档案' }),
    ).rejects.toThrow(/render|文件|格式|magic|PDF|DOCX/i)
  })
})
