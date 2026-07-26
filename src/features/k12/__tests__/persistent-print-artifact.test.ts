import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  prepareArtifact: vi.fn(),
  prepareMarkdown: vi.fn(),
  artifactContent: vi.fn(),
  getPaper: vi.fn(),
  retry: vi.fn(),
  render: vi.fn(),
}))

vi.mock('@/api/k12', () => ({
  k12PrepareArtifactPrintJob: (...args: unknown[]) => h.prepareArtifact(...args),
  k12PrepareGenericPrintJob: (...args: unknown[]) => h.prepareMarkdown(...args),
  k12GetPrintArtifactContent: (...args: unknown[]) => h.artifactContent(...args),
  k12GetGenericPrintArtifact: (...args: unknown[]) => h.getPaper(...args),
  k12GetGenericPrintJob: vi.fn(),
  k12CommitGenericPrintReceipt: vi.fn(),
  k12RecordGenericPrintEvent: vi.fn(),
  k12RetryGenericPrintJob: (...args: unknown[]) => h.retry(...args),
}))

vi.mock('@/utils/platform', () => ({ isTauri: () => true }))
vi.mock('../export', () => ({
  printPracticePaperWithReceipt: vi.fn(),
  renderPracticePaperPdf: (...args: unknown[]) => h.render(...args),
}))
vi.mock('../print-receipt', () => ({
  commitPrintReceiptWithConvergence: vi.fn(),
  recordDialogOpenWithConvergence: vi.fn(),
}))

import { preparePersistentPrint } from '../persistent-print'

describe('persistent print existing artifact path', () => {
  beforeEach(() => {
    h.prepareArtifact.mockReset().mockResolvedValue({
      print_job: {
        print_job_id: 'print-1',
        status: 'prepared',
      },
    })
    h.prepareMarkdown.mockReset()
    h.getPaper.mockReset()
    h.retry.mockReset()
    h.render.mockReset()
  })

  it('creates the shared print job with artifact_id and previews the existing PDF bytes', async () => {
    const pdf = new Blob(['frozen-pdf'], { type: 'application/pdf' })
    h.artifactContent.mockReset().mockResolvedValue(pdf)

    const result = await preparePersistentPrint({
      agent: 'mingming',
      idempotencyKey: 'print-artifact-1',
      sourceKind: 'weekly_practice_snapshot',
      sourceRef: 'snapshot-30',
      title: '本周该练',
      artifactId: 'artifact-30',
      browserPrint: vi.fn(),
    })

    expect(h.prepareArtifact).toHaveBeenCalledExactlyOnceWith({
      agent: 'mingming',
      idempotency_key: 'print-artifact-1',
      artifact_id: 'artifact-30',
    })
    expect(h.prepareMarkdown).not.toHaveBeenCalled()
    expect(h.getPaper).not.toHaveBeenCalled()
    expect(h.render).not.toHaveBeenCalled()
    expect(h.artifactContent).toHaveBeenCalledExactlyOnceWith('mingming', 'artifact-30')
    expect(result).toMatchObject({ status: 'preview', title: '本周该练', pdf })
  })
})
