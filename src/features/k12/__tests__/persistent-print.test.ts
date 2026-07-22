import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  tauri: true,
  prepare: vi.fn(),
  paper: vi.fn(),
  event: vi.fn(),
  retry: vi.fn(),
  nativePrint: vi.fn(),
  renderPdf: vi.fn(),
  browserPrint: vi.fn(),
}))

vi.mock('@/utils/platform', () => ({ isTauri: () => h.tauri }))
vi.mock('@/api/k12', () => ({
  k12PrepareGenericPrintJob: (...args: unknown[]) => h.prepare(...args),
  k12GetGenericPrintArtifact: (...args: unknown[]) => h.paper(...args),
  k12RecordGenericPrintEvent: (...args: unknown[]) => h.event(...args),
  k12RetryGenericPrintJob: (...args: unknown[]) => h.retry(...args),
}))
vi.mock('../export', () => ({
  printPracticePaperWithReceipt: (...args: unknown[]) => h.nativePrint(...args),
  renderPracticePaperPdf: (...args: unknown[]) => h.renderPdf(...args),
}))

import { preparePersistentPrint } from '../persistent-print'

const request = {
  agent: 'tutor-a',
  idempotencyKey: 'desktop:prep:1',
  sourceKind: 'prep_card' as const,
  sourceRef: 'submission:s1',
  title: '辅导要点',
  canonicalMarkdown: '# 辅导要点\n\n小数点对齐',
  browserPrint: h.browserPrint,
}

function job(status = 'preparing') {
  return {
    print_job_id: 'gprint-a',
    idempotency_key: 'desktop:prep:1',
    status,
    artifact_kind: 'prep_card',
    artifact_id: 'part-a',
    source_kind: 'prep_card',
    source_ref: 'submission:s1',
    title: '辅导要点',
    source_digest: 'abc',
    attempt_count: 1,
    prepared_at: 1,
    updated_at: 1,
    version: 0,
  }
}

describe('persistent generic PrintJob orchestration', () => {
  const exactPdf = new Blob(['%PDF-frozen-artifact'], { type: 'application/pdf' })

  beforeEach(() => {
    h.tauri = true
    h.prepare.mockReset().mockResolvedValue({ print_job: job() })
    h.paper.mockReset().mockResolvedValue({
      print_job_id: 'gprint-a',
      artifact_id: 'part-a',
      source_kind: 'prep_card',
      source_ref: 'submission:s1',
      title: '冻结标题',
      source_digest: 'abc',
      markdown: '# 服务端冻结内容',
    })
    h.event.mockReset().mockImplementation(async (_agent, _id, event) => ({
      print_job: job(event.status),
    }))
    h.retry.mockReset().mockResolvedValue({ print_job: job() })
    h.nativePrint.mockReset().mockResolvedValue({
      status: 'printed',
      native_job_id: 'native-a',
      native_receipt_id: 'receipt-a',
      printer_snapshot: { printer: 'Office', paper: 'A4' },
    })
    h.renderPdf.mockReset().mockResolvedValue(exactPdf)
    h.browserPrint.mockReset().mockResolvedValue(true)
  })

  it('browser/dev stays on window.print path and never writes a PrintJob', async () => {
    h.tauri = false
    await expect(preparePersistentPrint(request)).resolves.toEqual({
      status: 'completed',
      printed: true,
    })
    expect(h.browserPrint).toHaveBeenCalledTimes(1)
    expect(h.prepare).not.toHaveBeenCalled()
  })

  it('Tauri freezes and renders backend Artifact, but cannot open native dialog before visible preview confirmation', async () => {
    const prepared = await preparePersistentPrint(request)
    expect(prepared.status).toBe('preview')

    expect(h.prepare).toHaveBeenCalledWith({
      agent: 'tutor-a',
      idempotency_key: 'desktop:prep:1',
      source_kind: 'prep_card',
      source_ref: 'submission:s1',
      title: '辅导要点',
      canonical_markdown: '# 辅导要点\n\n小数点对齐',
    })
    expect(h.paper).toHaveBeenCalledWith('tutor-a', 'gprint-a')
    expect(h.renderPdf).toHaveBeenCalledWith('# 服务端冻结内容', '冻结标题')
    expect(h.nativePrint).not.toHaveBeenCalled()
    expect(h.event).not.toHaveBeenCalled()

    if (prepared.status !== 'preview') throw new Error('expected preview')
    await expect(prepared.confirm()).resolves.toBe(true)
    expect(h.nativePrint).toHaveBeenCalledWith(exactPdf)
    expect(h.event.mock.calls.map((call) => call[2])).toEqual([
      { status: 'dialog_open' },
      { status: 'submitted', native_job_id: 'native-a' },
      {
        status: 'printed',
        native_job_id: 'native-a',
        native_receipt_id: 'receipt-a',
        printer_snapshot: { printer: 'Office', paper: 'A4' },
      },
    ])
  })

  it('coalesces a double click so one Artifact cannot create two preview preparations', async () => {
    const first = preparePersistentPrint(request)
    const second = preparePersistentPrint(request)
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(h.prepare).toHaveBeenCalledTimes(1)
    expect(h.nativePrint).not.toHaveBeenCalled()
  })

  it('definitive cancellation is durable and can retry the same bounded job next click', async () => {
    const cachedKeyRequest = { ...request, idempotencyKey: undefined }
    h.nativePrint.mockResolvedValueOnce({
      status: 'cancelled',
      native_job_id: 'native-cancel',
      printer_snapshot: { printer: 'Office' },
    })
    const first = await preparePersistentPrint(cachedKeyRequest)
    if (first.status !== 'preview') throw new Error('expected preview')
    await expect(first.confirm()).resolves.toBe(false)
    expect(h.event).toHaveBeenLastCalledWith('tutor-a', 'gprint-a', {
      status: 'cancelled',
      native_job_id: 'native-cancel',
      printer_snapshot: { printer: 'Office' },
    })

    h.prepare.mockResolvedValueOnce({ print_job: job('cancelled') })
    const retried = await preparePersistentPrint(cachedKeyRequest)
    if (retried.status !== 'preview') throw new Error('expected preview')
    await expect(retried.confirm()).resolves.toBe(true)
    expect(h.retry).toHaveBeenCalledWith('tutor-a', 'gprint-a')
    const [firstPrepare, secondPrepare] = h.prepare.mock.calls
    expect(firstPrepare?.[0].idempotency_key).toBe(secondPrepare?.[0].idempotency_key)
  })

  it.each(['dialog_open', 'submitted', 'outcome_unknown'])(
    'does not blindly reopen unresolved %s job',
    async (status) => {
      h.prepare.mockResolvedValueOnce({ print_job: job(status) })
      await expect(preparePersistentPrint(request)).rejects.toThrow('未决')
      expect(h.nativePrint).not.toHaveBeenCalled()
    },
  )

  it('records outcome_unknown when the native adapter gives no definitive receipt', async () => {
    h.nativePrint.mockRejectedValueOnce(new Error('driver disconnected'))
    const prepared = await preparePersistentPrint(request)
    if (prepared.status !== 'preview') throw new Error('expected preview')
    await expect(prepared.confirm()).rejects.toThrow('driver disconnected')
    expect(h.event).toHaveBeenLastCalledWith('tutor-a', 'gprint-a', {
      status: 'outcome_unknown',
      failure_kind: 'native_receipt_unavailable',
      failure_detail: '原生打印结果未能确认',
    })
  })
})
