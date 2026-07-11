/**
 * BUG-20260710 · 知识库上传态随组件卸载丢失（用户两图取证）。
 *
 * 复现：上传到 100% → 切到别的页面再切回 → 上传条目消失、文档列表里也没有（后端仍在
 * 异步构建索引，getDocuments 还查不到）→ 家长以为上传丢了；等索引完成再切回才出现。
 *
 * 根因：`uploadingFiles` 是 KnowledgeView 组件本地 ref，卸载即丢；且 done 条目 3 秒
 * 定时清除，与「文档真正出现在列表里」无关——两个生命周期都错绑在组件/定时器上。
 *
 * 优雅方案：上传态提升为 Pinia store（stores/knowledge-uploads，跨挂载存活）；
 * done 条目**直到文档在 getDocuments 结果里落地才移除**（settleAgainstDocs），
 * 不再用「3 秒后消失」这种与真实状态无关的定时器。
 *
 * 断言的是正确行为——未修复代码上本文件 FAIL（RED 证据）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import fs from 'node:fs'
import path from 'node:path'
import { useKnowledgeUploadsStore } from '@/stores/knowledge-uploads'

describe('BUG-20260710 · 知识库上传态跨挂载存活', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('track 的条目挂在 store 上（组件卸载/重挂载后依然可渲染），且返回的 entry 是响应式可变更的', () => {
    const store = useKnowledgeUploadsStore()
    const entry = store.track({ name: 'Go面试题new.pdf', progress: 0, status: 'uploading' })

    entry.progress = 100
    entry.status = 'done'

    // 模拟组件卸载→重挂载：新组件实例从同一 store 读取
    const storeAgain = useKnowledgeUploadsStore()
    expect(storeAgain.items).toHaveLength(1)
    expect(storeAgain.items[0]!.name).toBe('Go面试题new.pdf')
    expect(storeAgain.items[0]!.progress).toBe(100)
    expect(storeAgain.items[0]!.status).toBe('done')
  })

  it('done 条目在文档列表未出现前保留（索引中窗口不消失），落地后 settle 移除', () => {
    const store = useKnowledgeUploadsStore()
    const entry = store.track({ name: 'Go面试题new.pdf', progress: 100, status: 'uploading' })
    entry.status = 'done'

    // 索引尚未完成：getDocuments 里没有该文档 → 条目必须保留
    store.settleAgainstDocs([{ source: 'upload:MySQL索引设计与最佳实践.pdf', title: 'MySQL索引设计与最佳实践' }])
    expect(store.items, '索引窗口内条目不得消失（用户切页回来要能看到）').toHaveLength(1)

    // 索引完成：文档以 upload:<文件名> 来源出现 → settle 移除
    store.settleAgainstDocs([
      { source: 'upload:MySQL索引设计与最佳实践.pdf', title: 'MySQL索引设计与最佳实践' },
      { source: 'upload:Go面试题new.pdf', title: 'Go面试题new' },
    ])
    expect(store.items).toHaveLength(0)
  })

  it('uploading / error 条目不被 settle 清除（上传中不动，错误留给用户看）', () => {
    const store = useKnowledgeUploadsStore()
    store.track({ name: 'a.pdf', progress: 40, status: 'uploading' })
    const bad = store.track({ name: 'b.pdf', progress: 0, status: 'uploading' })
    bad.status = 'error'
    bad.error = 'boom'

    store.settleAgainstDocs([{ source: 'upload:a.pdf' }, { source: 'upload:b.pdf' }])
    expect(store.items.map((e) => e.name)).toEqual(['a.pdf', 'b.pdf'])
  })

  it('KnowledgeView 不再持有组件本地 uploadingFiles ref（状态必须来自 store）', () => {
    // 源码级锁：防回潮——组件里重新出现本地 `const uploadingFiles = ref` 即失败
    const body = fs.readFileSync(
      path.resolve(__dirname, '../views/KnowledgeView.vue'),
      'utf8',
    )
    expect(body).not.toMatch(/const uploadingFiles = ref</)
    expect(body).toContain('useKnowledgeUploadsStore')
    // 3 秒定时清除的旧机制必须退役（与真实索引状态无关）
    expect(body).not.toMatch(/setTimeout\(\(\) => \{\s*uploadingFiles/)
  })
})
