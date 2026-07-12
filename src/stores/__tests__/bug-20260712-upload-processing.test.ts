import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useKnowledgeUploadsStore } from '../knowledge-uploads'

// BUG-20260712 #8 知识库上传「卡 100% 不动」前端相：字节传完(100%)后端仍在解析+嵌入，
// 这段无法上报百分比，旧实现继续显示「100% uploading」→ 被误读为卡死。
// 修：新增 processing 相 + markProcessing() 迁移，让 UI 显「处理中…」。

describe('BUG-20260712 #8 上传进度 100% 后切「处理中」相，不再假死在 100%', () => {
  beforeEach(() => setActivePinia(createPinia()))

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
})
