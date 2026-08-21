import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  tauri: true,
  prepare: vi.fn(),
  prepareArtifact: vi.fn(),
  getJob: vi.fn(),
  paper: vi.fn(),
  artifactContent: vi.fn(),
  retry: vi.fn(),
  renderPdf: vi.fn(),
  browserPrint: vi.fn(),
  invoke: vi.fn(),
}))

vi.mock('@/utils/platform', () => ({ isTauri: () => h.tauri }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}))
vi.mock('@/api/k12', () => ({
  k12PrepareGenericPrintJob: (...args: unknown[]) => h.prepare(...args),
  k12PrepareArtifactPrintJob: (...args: unknown[]) => h.prepareArtifact(...args),
  k12GetGenericPrintJob: (...args: unknown[]) => h.getJob(...args),
  k12GetGenericPrintArtifact: (...args: unknown[]) => h.paper(...args),
  k12GetPrintArtifactContent: (...args: unknown[]) => h.artifactContent(...args),
  k12RetryGenericPrintJob: (...args: unknown[]) => h.retry(...args),
}))
vi.mock('../export', () => ({
  renderPracticePaperPdf: (...args: unknown[]) => h.renderPdf(...args),
}))

import { preparePersistentPrint } from '../persistent-print'

const request = {
  agent: 'tutor-a',
  idempotencyKey: 'desktop:tutoring-tips:1',
  sourceKind: 'tutoring_tips' as const,
  sourceRef: 'submission:s1',
  title: '辅导要点',
  canonicalMarkdown: '# 辅导要点\n\n小数点对齐',
  browserPrint: h.browserPrint,
}

function job(status = 'preparing') {
  return {
    print_job_id: 'gprint-a',
    idempotency_key: 'desktop:tutoring-tips:1',
    status,
    artifact_kind: 'tutoring_tips',
    artifact_id: 'part-a',
    source_kind: 'tutoring_tips',
    source_ref: 'submission:s1',
    title: '辅导要点',
    source_digest: 'abc',
    attempt_count: 1,
    prepared_at: 1,
    updated_at: 1,
    version: 0,
  }
}

const printedReceipt = {
  receipt: {
    status: 'printed',
    native_job_id: 'native-a',
    native_receipt_id: 'receipt-a',
    printer_snapshot: { printer: 'Office', paper: 'A4' },
  },
}

describe('persistent PrintJob orchestration', () => {
  const exactPdf = new Blob(['%PDF-frozen-artifact'], { type: 'application/pdf' })

  beforeEach(() => {
    h.tauri = true
    h.prepare.mockReset().mockResolvedValue({ print_job: job() })
    h.prepareArtifact.mockReset()
    h.getJob.mockReset().mockResolvedValue({ print_job: job('dialog_open') })
    h.paper.mockReset().mockResolvedValue({
      print_job_id: 'gprint-a',
      artifact_id: 'part-a',
      source_kind: 'tutoring_tips',
      source_ref: 'submission:s1',
      title: '冻结标题',
      source_digest: 'abc',
      markdown: '# 服务端冻结内容',
    })
    h.artifactContent.mockReset().mockResolvedValue(exactPdf)
    h.retry.mockReset().mockResolvedValue({ print_job: job() })
    h.renderPdf.mockReset().mockResolvedValue(exactPdf)
    h.browserPrint.mockReset().mockResolvedValue(true)
    h.invoke.mockReset().mockResolvedValue(printedReceipt)
  })

  it('keeps browser development on window.print without creating a job', async () => {
    h.tauri = false

    await expect(preparePersistentPrint(request)).resolves.toEqual({
      status: 'completed',
      printed: true,
    })
    expect(h.browserPrint).toHaveBeenCalledOnce()
    expect(h.prepare).not.toHaveBeenCalled()
    expect(h.invoke).not.toHaveBeenCalled()
  })

  it('previews the frozen artifact and gives Rust only the durable job identity', async () => {
    const prepared = await preparePersistentPrint(request)

    expect(prepared).toMatchObject({ status: 'preview', title: '冻结标题', pdf: exactPdf })
    expect(h.prepare).toHaveBeenCalledWith({
      agent: 'tutor-a',
      idempotency_key: 'desktop:tutoring-tips:1',
      source_kind: 'tutoring_tips',
      source_ref: 'submission:s1',
      title: '辅导要点',
      canonical_markdown: '# 辅导要点\n\n小数点对齐',
    })
    expect(h.artifactContent).toHaveBeenCalledExactlyOnceWith('tutor-a', 'part-a')
    expect(h.renderPdf).not.toHaveBeenCalled()
    expect(h.invoke).not.toHaveBeenCalled()

    if (prepared.status !== 'preview') throw new Error('expected preview')
    await expect(prepared.confirm()).resolves.toBe(true)
    expect(h.invoke).toHaveBeenCalledExactlyOnceWith('execute_print_job', {
      request: { agent: 'tutor-a', printJobId: 'gprint-a' },
    })
  })

  it('BUG-20260802-014 canonicalMarkdown path consumes immutable artifact bytes', async () => {
    h.artifactContent.mockResolvedValueOnce(exactPdf)

    const prepared = await preparePersistentPrint(request)

    expect(prepared).toMatchObject({ status: 'preview', pdf: exactPdf })
    expect(h.artifactContent).toHaveBeenCalledExactlyOnceWith('tutor-a', 'part-a')
    expect(h.renderPdf).not.toHaveBeenCalled()
  })

  it('coalesces a double click into one preview preparation', async () => {
    const [first, second] = await Promise.all([
      preparePersistentPrint(request),
      preparePersistentPrint(request),
    ])

    expect(first).toBe(second)
    expect(h.prepare).toHaveBeenCalledOnce()
    expect(h.invoke).not.toHaveBeenCalled()
  })

  it('retries a cancelled durable attempt with the same operation identity', async () => {
    const withoutExplicitKey = { ...request, idempotencyKey: undefined }
    h.invoke
      .mockResolvedValueOnce({
        receipt: {
          status: 'cancelled',
          native_job_id: 'native-cancelled',
          printer_snapshot: { printer: 'Office' },
        },
      })
      .mockResolvedValueOnce(printedReceipt)

    const first = await preparePersistentPrint(withoutExplicitKey)
    if (first.status !== 'preview') throw new Error('expected preview')
    await expect(first.confirm()).resolves.toBe(false)

    h.prepare.mockResolvedValueOnce({ print_job: job('cancelled') })
    const second = await preparePersistentPrint(withoutExplicitKey)
    if (second.status !== 'preview') throw new Error('expected preview')
    await expect(second.confirm()).resolves.toBe(true)

    expect(h.retry).toHaveBeenCalledWith('tutor-a', 'gprint-a')
    expect(h.prepare.mock.calls[0]?.[0].idempotency_key).toBe(
      h.prepare.mock.calls[1]?.[0].idempotency_key,
    )
  })

  it.each(['dialog_open', 'submitted', 'outcome_unknown'])(
    'resumes unresolved %s through the same Rust coordinator',
    async (status) => {
      h.prepare.mockResolvedValueOnce({ print_job: job(status) })

      const prepared = await preparePersistentPrint(request)
      if (prepared.status !== 'preview') throw new Error('expected preview')
      await expect(prepared.confirm()).resolves.toBe(true)

      expect(h.getJob).toHaveBeenCalledWith('tutor-a', 'gprint-a')
      expect(h.invoke).toHaveBeenCalledExactlyOnceWith('execute_print_job', {
        request: { agent: 'tutor-a', printJobId: 'gprint-a' },
      })
    },
  )

  it('allows convergence replay after an ambiguous IPC response', async () => {
    h.invoke
      .mockRejectedValueOnce(new Error('native response channel closed'))
      .mockResolvedValueOnce(printedReceipt)
    const prepared = await preparePersistentPrint(request)
    if (prepared.status !== 'preview') throw new Error('expected preview')

    await expect(prepared.confirm()).rejects.toThrow('native response channel closed')
    await expect(prepared.confirm()).resolves.toBe(true)

    expect(h.invoke).toHaveBeenCalledTimes(2)
  })

  it('propagates a deterministic native failure without a renderer callback', async () => {
    h.invoke.mockResolvedValueOnce({
      receipt: {
        status: 'failed',
        native_job_id: 'native-failed',
        printer_snapshot: { adapter: 'appkit' },
        failure_kind: 'pdf_page_limit_exceeded',
        failure_detail: '打印 PDF 页数超过限制',
      },
    })
    const prepared = await preparePersistentPrint(request)
    if (prepared.status !== 'preview') throw new Error('expected preview')

    await expect(prepared.confirm()).rejects.toThrow('打印 PDF 页数超过限制')
    expect(h.invoke).toHaveBeenCalledOnce()
  })

  it('returns an already committed printed job without opening another dialog', async () => {
    h.prepare.mockResolvedValueOnce({ print_job: job('printed') })

    await expect(preparePersistentPrint(request)).resolves.toEqual({
      status: 'completed',
      printed: true,
    })
    expect(h.paper).not.toHaveBeenCalled()
    expect(h.invoke).not.toHaveBeenCalled()
  })
})
