import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  tauri: true,
  prepare: vi.fn(),
  paper: vi.fn(),
  event: vi.fn(),
  retry: vi.fn(),
  nativePrint: vi.fn(),
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
}))

import { printPersistentArtifact } from '../persistent-print'

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
    h.browserPrint.mockReset().mockResolvedValue(true)
  })

  it('browser/dev stays on window.print path and never writes a PrintJob', async () => {
    h.tauri = false
    await expect(printPersistentArtifact(request)).resolves.toBe(true)
    expect(h.browserPrint).toHaveBeenCalledTimes(1)
    expect(h.prepare).not.toHaveBeenCalled()
  })

  it('Tauri freezes then prints backend Artifact and persists the typed receipt chain', async () => {
    await expect(printPersistentArtifact(request)).resolves.toBe(true)

    expect(h.prepare).toHaveBeenCalledWith({
      agent: 'tutor-a',
      idempotency_key: 'desktop:prep:1',
      source_kind: 'prep_card',
      source_ref: 'submission:s1',
      title: '辅导要点',
      canonical_markdown: '# 辅导要点\n\n小数点对齐',
    })
    expect(h.paper).toHaveBeenCalledWith('tutor-a', 'gprint-a')
    expect(h.nativePrint).toHaveBeenCalledWith('# 服务端冻结内容', '冻结标题')
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

  it('coalesces a double click so one Artifact cannot open two native dialogs', async () => {
    const first = printPersistentArtifact(request)
    const second = printPersistentArtifact(request)
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(h.prepare).toHaveBeenCalledTimes(1)
    expect(h.nativePrint).toHaveBeenCalledTimes(1)
  })

  it('definitive cancellation is durable and can retry the same bounded job next click', async () => {
    const cachedKeyRequest = { ...request, idempotencyKey: undefined }
    h.nativePrint.mockResolvedValueOnce({
      status: 'cancelled',
      native_job_id: 'native-cancel',
      printer_snapshot: { printer: 'Office' },
    })
    await expect(printPersistentArtifact(cachedKeyRequest)).resolves.toBe(false)
    expect(h.event).toHaveBeenLastCalledWith('tutor-a', 'gprint-a', {
      status: 'cancelled',
      native_job_id: 'native-cancel',
    })

    h.prepare.mockResolvedValueOnce({ print_job: job('cancelled') })
    await expect(printPersistentArtifact(cachedKeyRequest)).resolves.toBe(true)
    expect(h.retry).toHaveBeenCalledWith('tutor-a', 'gprint-a')
    const [firstPrepare, secondPrepare] = h.prepare.mock.calls
    expect(firstPrepare?.[0].idempotency_key).toBe(secondPrepare?.[0].idempotency_key)
  })

  it.each(['dialog_open', 'submitted', 'outcome_unknown'])(
    'does not blindly reopen unresolved %s job',
    async (status) => {
      h.prepare.mockResolvedValueOnce({ print_job: job(status) })
      await expect(printPersistentArtifact(request)).rejects.toThrow('未决')
      expect(h.nativePrint).not.toHaveBeenCalled()
    },
  )

  it('records outcome_unknown when the native adapter gives no definitive receipt', async () => {
    h.nativePrint.mockRejectedValueOnce(new Error('driver disconnected'))
    await expect(printPersistentArtifact(request)).rejects.toThrow('driver disconnected')
    expect(h.event).toHaveBeenLastCalledWith('tutor-a', 'gprint-a', {
      status: 'outcome_unknown',
      failure_kind: 'native_receipt_unavailable',
      failure_detail: '原生打印结果未能确认',
    })
  })
})
