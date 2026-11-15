import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  prepareArtifact: vi.fn(),
  prepareMarkdown: vi.fn(),
  artifactContent: vi.fn(),
  getPaper: vi.fn(),
  retry: vi.fn(),
  render: vi.fn(),
  prepareFinal: vi.fn(),
  invoke: vi.fn(),
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
  k12PrepareGradingFinalArtifactOutput: (...args: unknown[]) => h.prepareFinal(...args),
  k12SendGradingFinalArtifact: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
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
import { createFinalArtifactActionHandler } from '../final-artifact-action'

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
    h.prepareFinal.mockReset().mockResolvedValue({ artifact: {
      artifact_id: 'artifact-final', source_kind: 'grading_final_artifact',
      source_ref: 'final_artifact:final-1:sha256:source', title: '家长辅导指南',
    } })
    h.invoke.mockReset().mockResolvedValue({ receipt: { status: 'printed' } })
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

  it('同一终稿打印完成后再明确打印，通过共享器创建新的持久命令', async () => {
    h.artifactContent.mockReset().mockResolvedValue(new Blob(['frozen-pdf']))
    const handler = createFinalArtifactActionHandler({
      agent: () => 'mingming',
      browserPrint: vi.fn(),
      openPrint: async (request) => {
        const prepared = await preparePersistentPrint(request)
        if (prepared.status !== 'preview') throw new Error('Expected print preview')
        await prepared.confirm()
      },
    })
    const intent = {
      action: 'print' as const, artifact_id: 'final-1',
      artifact_digest: 'sha256:source', artifact_title: '家长辅导指南',
    }

    await handler.run(intent)
    await handler.run(intent)

    expect(h.prepareFinal).toHaveBeenCalledOnce()
    expect(h.prepareArtifact).toHaveBeenCalledTimes(2)
    const requests = h.prepareArtifact.mock.calls.map(([request]) => request)
    expect(requests.map((request) => request.artifact_id)).toEqual(['artifact-final', 'artifact-final'])
    expect(requests[1].idempotency_key).not.toBe(requests[0].idempotency_key)
    expect(h.invoke).toHaveBeenCalledTimes(2)
  })

  it('同一周练快照打印成功后的新意图使用新键，仍消费原冻结产物', async () => {
    h.artifactContent.mockReset().mockResolvedValue(new Blob(['frozen-pdf']))
    const request = {
      agent: 'mingming', sourceKind: 'weekly_practice_snapshot' as const,
      sourceRef: 'snapshot-30', title: '本周该练', artifactId: 'artifact-30', browserPrint: vi.fn(),
    }
    for (let intent = 0; intent < 2; intent++) {
      const prepared = await preparePersistentPrint(request)
      if (prepared.status !== 'preview') throw new Error('Expected print preview')
      await prepared.confirm()
    }

    expect(h.prepareArtifact).toHaveBeenCalledTimes(2)
    expect(h.prepareArtifact.mock.calls[1]![0].idempotency_key)
      .not.toBe(h.prepareArtifact.mock.calls[0]![0].idempotency_key)
    expect(h.artifactContent.mock.calls).toEqual([
      ['mingming', 'artifact-30'], ['mingming', 'artifact-30'],
    ])
    expect(h.invoke).toHaveBeenCalledTimes(2)
  })
})
