import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}))

vi.mock('../client', () => ({
  api: vi.fn(),
  apiGet: (...args: unknown[]) => h.get(...args),
  apiPost: (...args: unknown[]) => h.post(...args),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}))

import {
  k12GetGenericPrintArtifact,
  k12PrepareGenericPrintJob,
  k12GetPracticePrintJob,
  k12GetPracticePrintJobPaper,
  k12PreparePracticePrintJob,
  k12RecordPracticePrintEvent,
  k12RetryPracticePrintJob,
} from '../k12'

describe('DD-023A Practice PrintJob API contract', () => {
  beforeEach(() => {
    h.get.mockReset()
    h.post.mockReset()
  })

  it('prepares one immutable question-paper job with an explicit idempotency key', async () => {
    h.post.mockResolvedValue({})
    await k12PreparePracticePrintJob('tutor-a', 'set-a', 'print:tutor-a:set-a:v3', 'question')

    expect(h.post).toHaveBeenCalledWith('/api/k12/practice-sets/set-a/print-jobs', {
      agent: 'tutor-a',
      idempotency_key: 'print:tutor-a:set-a:v3',
      artifact_kind: 'question',
    })
  })

  it('reads frozen paper/job and records only typed native terminal events', async () => {
    h.get.mockResolvedValue({})
    h.post.mockResolvedValue({})

    await k12GetPracticePrintJob('tutor-a', 'print-a')
    await k12GetPracticePrintJobPaper('tutor-a', 'print-a', 'question')
    await k12RecordPracticePrintEvent('tutor-a', 'print-a', {
      status: 'printed',
      native_job_id: 'native-a',
      native_receipt_id: 'receipt-a',
      printer_snapshot: { adapter: 'appkit' },
    })
    await k12RetryPracticePrintJob('tutor-a', 'print-a')

    expect(h.get).toHaveBeenNthCalledWith(1, '/api/k12/print-jobs/print-a', {
      agent: 'tutor-a',
    })
    expect(h.get).toHaveBeenNthCalledWith(2, '/api/k12/print-jobs/print-a/paper', {
      agent: 'tutor-a',
      kind: 'question',
    })
    expect(h.post).toHaveBeenNthCalledWith(1, '/api/k12/print-jobs/print-a/events', {
      agent: 'tutor-a',
      status: 'printed',
      native_job_id: 'native-a',
      native_receipt_id: 'receipt-a',
      printer_snapshot: { adapter: 'appkit' },
    })
    expect(h.post).toHaveBeenNthCalledWith(2, '/api/k12/print-jobs/print-a/retry', {
      agent: 'tutor-a',
    })
  })

  it('prepares a generic immutable printable artifact on the shared PrintJob routes', async () => {
    h.post.mockResolvedValue({})
    h.get.mockResolvedValue({})

    await k12PrepareGenericPrintJob({
      agent: 'tutor-a',
      idempotency_key: 'desktop:prep:1',
      source_kind: 'prep_card',
      source_ref: 'submission:s1',
      title: '这份作业的辅导要点',
      canonical_markdown: '# 辅导要点\n\n小数点对齐',
    })
    await k12GetGenericPrintArtifact('tutor-a', 'gprint-a')

    expect(h.post).toHaveBeenCalledWith('/api/k12/print-jobs', {
      agent: 'tutor-a',
      idempotency_key: 'desktop:prep:1',
      source_kind: 'prep_card',
      source_ref: 'submission:s1',
      title: '这份作业的辅导要点',
      canonical_markdown: '# 辅导要点\n\n小数点对齐',
    })
    expect(h.get).toHaveBeenCalledWith('/api/k12/print-jobs/gprint-a/paper', {
      agent: 'tutor-a',
    })
  })
})
