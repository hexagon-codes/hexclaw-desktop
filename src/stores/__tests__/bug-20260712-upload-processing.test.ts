import { nextTick } from 'vue'
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useKnowledgeUploadsStore } from '../knowledge-uploads'

// BUG-20260712 #8 知识库上传「卡 100% 不动」前端相：字节传完(100%)后端仍在解析+嵌入，
// 这段无法上报百分比，旧实现继续显示「100% uploading」→ 被误读为卡死。
// 修：新增 processing 相 + markProcessing() 迁移，让 UI 显「处理中…」。

describe('BUG-20260712 #8 上传进度 100% 后切「处理中」相，不再假死在 100%', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('uploading 条目 markProcessing → status 变 processing（RED：无此方法/相）', () => {
    const store = useKnowledgeUploadsStore()
    const entry = store.track({ name: '五年级下册.pdf', progress: 100, status: 'uploading' })
    store.markProcessing(entry)
    expect(entry.status).toBe('processing')
  })

  it('done/error 是终态，markProcessing 不回退', () => {
    const store = useKnowledgeUploadsStore()
    const done = store.track({ name: 'a.txt', progress: 100, status: 'done' })
    const err = store.track({ name: 'b.txt', progress: 0, status: 'error', error: 'x' })
    store.markProcessing(done)
    store.markProcessing(err)
    expect(done.status).toBe('done')
    expect(err.status).toBe('error')
  })

  it('processing 条目不被 settleAgainstDocs 误清（仍在处理中，未落库）', () => {
    const store = useKnowledgeUploadsStore()
    const entry = store.track({ name: 'c.pdf', progress: 100, status: 'uploading' })
    store.markProcessing(entry)
    // 即便文档列表已含同名（极端并发），processing 也只清 done 相
    store.settleAgainstDocs([{ source: 'upload:c.pdf' }])
    expect(store.items).toHaveLength(1)
    expect(store.items[0]!.status).toBe('processing')
  })

  it('tracks a durable job while processing and reaches cancelled explicitly', () => {
    const store = useKnowledgeUploadsStore()
    const entry = store.track({ name: 'book.pdf', progress: 100, status: 'processing' })

    store.attachJob(entry, 'doc-1', 'job-1')
    expect(store.hasAwaitingIndex()).toBe(true)
    expect(entry).toMatchObject({ documentId: 'doc-1', jobId: 'job-1' })

    store.markCancelled(entry)
    expect(entry.status).toBe('cancelled')
    expect(store.hasAwaitingIndex()).toBe(false)
  })

  it('rehydrates accepted durable jobs after a desktop process restart', async () => {
    const beforeRestart = useKnowledgeUploadsStore()
    const entry = beforeRestart.track({ name: '六上数学.pdf', progress: 100, status: 'processing' })
    beforeRestart.attachJob(entry, 'doc-durable', 'job-durable')
    await nextTick()

    setActivePinia(createPinia())
    const afterRestart = useKnowledgeUploadsStore()

    expect(afterRestart.items).toEqual([
      expect.objectContaining({
        name: '六上数学.pdf',
        progress: 100,
        status: 'processing',
        documentId: 'doc-durable',
        jobId: 'job-durable',
      }),
    ])
    expect(afterRestart.hasAwaitingIndex()).toBe(true)
  })

  it('persists an explicit response-unknown row without pretending it has a pollable job', async () => {
    const beforeRestart = useKnowledgeUploadsStore()
    const entry = beforeRestart.track({ name: 'lost-202.pdf', progress: 100, status: 'uploading' })
    beforeRestart.bindIntent(entry, {
      idempotencyKey: 'knowledge-upload:lost-202',
      sourceSha256: 'a'.repeat(64),
    })
    beforeRestart.markPendingResponse(entry, '响应未知，请重新选择同一文件恢复')
    await nextTick()

    setActivePinia(createPinia())
    const afterRestart = useKnowledgeUploadsStore()

    expect(afterRestart.items).toEqual([
      expect.objectContaining({
        name: 'lost-202.pdf',
        status: 'pending-response',
        intentKey: 'knowledge-upload:lost-202',
        sourceSha256: 'a'.repeat(64),
      }),
    ])
    expect(afterRestart.hasAwaitingIndex()).toBe(false)
  })

  it('reselecting the same durable intent resumes one UI row instead of appending a duplicate', () => {
    const store = useKnowledgeUploadsStore()
    const original = store.track({ name: 'same.pdf', progress: 100, status: 'pending-response' })
    store.bindIntent(original, {
      idempotencyKey: 'knowledge-upload:same',
      sourceSha256: 'b'.repeat(64),
    })
    const duplicate = store.track({ name: 'same.pdf', progress: 0, status: 'uploading' })

    const resumed = store.bindIntent(duplicate, {
      idempotencyKey: 'knowledge-upload:same',
      sourceSha256: 'b'.repeat(64),
    })

    expect(resumed).toBe(original)
    expect(store.items).toHaveLength(1)
    expect(original).toMatchObject({ status: 'uploading', progress: 0, error: undefined })
  })
})
