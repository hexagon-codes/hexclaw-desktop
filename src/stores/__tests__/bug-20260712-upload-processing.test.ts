import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { KnowledgeOperation } from '@/api/knowledge'
import { useKnowledgeUploadsStore } from '../knowledge-uploads'

function operation(overrides: Partial<KnowledgeOperation> = {}): KnowledgeOperation {
  return {
    operation_id: 'job-durable',
    job_id: 'job-durable',
    document_id: 'doc-durable',
    title: '六上数学.pdf',
    display_name: '六上数学.pdf',
    content_digest: 'a'.repeat(64),
    state: 'running',
    stage: 'embedding',
    terminal: false,
    created_at: '2026-08-02T00:00:00Z',
    updated_at: '2026-08-02T00:00:00Z',
    ...overrides,
  }
}

describe('knowledge upload runtime projection', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('moves uploaded bytes into the processing phase', () => {
    const store = useKnowledgeUploadsStore()
    const entry = store.track({ name: '五年级下册.pdf', progress: 100, status: 'uploading' })

    store.markProcessing(entry)

    expect(entry.status).toBe('processing')
  })

  it('does not regress terminal rows or settle processing rows by filename', () => {
    const store = useKnowledgeUploadsStore()
    const done = store.track({ name: 'a.txt', progress: 100, status: 'done' })
    const failed = store.track({ name: 'b.txt', progress: 0, status: 'error', error: 'x' })
    const processing = store.track({ name: 'c.pdf', progress: 100, status: 'processing' })

    store.markProcessing(done)
    store.markProcessing(failed)
    store.settleAgainstDocs([{ source: 'upload:c.pdf' }])

    expect(done.status).toBe('done')
    expect(failed.status).toBe('error')
    expect(processing.status).toBe('processing')
  })

  it('REG-KNOWLEDGE-QUEUE-CANCELLED-001 keeps confirmed cancellations out of the visible queue without mutating the durable projection', () => {
    const store = useKnowledgeUploadsStore()
    const cancelled = operation({ state: 'cancelled', terminal: true })
    const durableSnapshot = { ...cancelled }

    store.reconcileRecoverableOperations([cancelled])

    expect(store.items).toEqual([])
    expect(cancelled).toEqual(durableSnapshot)

    store.reconcileRecoverableOperations([cancelled])

    expect(store.items).toEqual([])
    expect(cancelled).toEqual(durableSnapshot)

    const entry = store.track({ name: 'book.pdf', progress: 100, status: 'processing' })
    store.attachJob(entry, 'doc-1', 'job-1')
    expect(store.hasAwaitingIndex()).toBe(true)
    store.markCancelled(entry)

    expect(entry).toMatchObject({ documentId: 'doc-1', jobId: 'job-1', status: 'cancelled' })
    expect(store.items).toEqual([])
    expect(store.hasAwaitingIndex()).toBe(false)
  })

  it('rebuilds accepted jobs from the Sidecar operation projection', () => {
    const store = useKnowledgeUploadsStore()

    store.reconcileRecoverableOperations([operation()])

    expect(store.items).toEqual([
      expect.objectContaining({
        name: '六上数学.pdf',
        progress: 100,
        status: 'processing',
        documentId: 'doc-durable',
        jobId: 'job-durable',
        stage: 'embedding',
      }),
    ])
    expect(store.hasAwaitingIndex()).toBe(true)
  })

  it('removes stale renderer rows and projects failed Sidecar jobs', () => {
    const store = useKnowledgeUploadsStore()
    const stale = store.track({ name: 'stale.pdf', progress: 100, status: 'processing' })
    store.attachJob(stale, 'doc-stale', 'job-stale')

    store.reconcileRecoverableOperations([
      operation({ state: 'failed', terminal: true, error: 'embedding failed' }),
    ])

    expect(store.items).toHaveLength(1)
    expect(store.items[0]).toMatchObject({
      jobId: 'job-durable',
      documentId: 'doc-durable',
      status: 'error',
      error: 'embedding failed',
    })
  })

  it('keeps response-unknown identity only as a disposable runtime row', () => {
    const store = useKnowledgeUploadsStore()
    const entry = store.track({ name: 'lost-202.pdf', progress: 100, status: 'uploading' })
    store.bindIntent(entry, {
      idempotencyKey: `knowledge-upload:v3:${'a'.repeat(64)}`,
      sourceSha256: 'b'.repeat(64),
    })
    store.markPendingResponse(entry, '响应未知，请重新选择同一文件恢复')

    expect(entry).toMatchObject({ status: 'pending-response', progress: 100 })
    expect(store.hasAwaitingIndex()).toBe(false)
  })

  it('reselecting the same content-addressed intent resumes one row', () => {
    const store = useKnowledgeUploadsStore()
    const intent = {
      idempotencyKey: `knowledge-upload:v3:${'c'.repeat(64)}`,
      sourceSha256: 'd'.repeat(64),
    }
    const original = store.track({ name: 'same.pdf', progress: 100, status: 'pending-response' })
    store.bindIntent(original, intent)
    const duplicate = store.track({ name: 'same.pdf', progress: 0, status: 'uploading' })

    const resumed = store.bindIntent(duplicate, intent)

    expect(resumed).toBe(original)
    expect(store.items).toHaveLength(1)
    expect(original).toMatchObject({ status: 'uploading', progress: 0, error: undefined })
  })

  it('REG-KNOWLEDGE-QUEUE-CANCELLED-001 preserves non-cancelled durable queue states', () => {
    const cases = [
      ['receiving', 'uploading', false, true],
      ['pending_response', 'pending-response', false, true],
      ['queued', 'processing', false, true],
      ['running', 'processing', false, true],
      ['retry_wait', 'processing', false, true],
      ['succeeded', 'done', true, true],
      ['failed', 'error', true, true],
      ['cancelled', 'cancelled', true, false],
    ] as const

    for (const [state, status, terminal, visible] of cases) {
      setActivePinia(createPinia())
      const store = useKnowledgeUploadsStore()
      const hasAcceptedBody = state !== 'receiving'
      store.reconcileRecoverableOperations([
        {
          operation_id: `upload-${state}`,
          job_id: hasAcceptedBody ? `job-${state}` : '',
          document_id: hasAcceptedBody ? `doc-${state}` : '',
          title: 'book.pdf',
          display_name: 'book.pdf',
          content_digest: hasAcceptedBody ? 'a'.repeat(64) : undefined,
          state,
          stage: state === 'receiving' ? 'receiving' : 'extracting',
          terminal,
          error: state === 'failed' ? 'extract failed' : undefined,
          created_at: '2026-08-02T00:00:00Z',
          updated_at: '2026-08-02T00:00:01Z',
        } as KnowledgeOperation,
      ])

      expect(store.items).toHaveLength(visible ? 1 : 0)
      if (!visible) continue

      expect(store.items[0]).toMatchObject({
        operationId: `upload-${state}`,
        name: 'book.pdf',
        status,
      })
      const item = store.items[0]
      expect({
        hasDocumentId: Object.prototype.hasOwnProperty.call(item, 'documentId'),
        hasJobId: Object.prototype.hasOwnProperty.call(item, 'jobId'),
        documentId: item?.documentId,
        jobId: item?.jobId,
      }).toEqual(
        hasAcceptedBody
          ? {
              hasDocumentId: true,
              hasJobId: true,
              documentId: `doc-${state}`,
              jobId: `job-${state}`,
            }
          : {
              hasDocumentId: false,
              hasJobId: false,
              documentId: undefined,
              jobId: undefined,
            },
      )
    }
  })
})
