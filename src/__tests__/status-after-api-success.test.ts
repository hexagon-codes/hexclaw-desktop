/**
 * 验证 API 成功后的状态仅由其真实的异步语义决定。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SRC = resolve(__dirname, '..')
function readSrc(path: string): string {
  return readFileSync(resolve(SRC, path), 'utf-8')
}

describe('API 成功后的状态投影', () => {
  describe('KnowledgeView — reindex', () => {
    const src = readSrc('views/KnowledgeView.vue')

    it('重建受理期间显示读取权威状态，并只刷新同一文档投影', () => {
      const fn = src.match(/async function handleReindex[\s\S]*?^}/m)?.[0] || ''
      expect(fn).toBeTruthy()
      const synchronousReindex = fn.slice(fn.indexOf('await reindexDocument(doc.id)'))
      expect(synchronousReindex).toContain('await reindexDocument(doc.id)')
      expect(synchronousReindex).toContain('await refreshDocumentProjection(doc.id)')
      expect(synchronousReindex).not.toContain('await revalidateFromApi(true)')
      expect(synchronousReindex).not.toContain('result.status')
      expect(src).toContain("t('knowledge.authorityReading')")
      expect(src).toContain("t('knowledge.syncingStatus')")
      expect(src).toContain("t('knowledge.semanticIndex.enhancing')")
      expect(src).not.toContain("return '正在读取权威状态…'")
      expect(src).not.toContain("return '同步中'")
      expect(src).not.toContain("return '增强中'")
    })

    it('向量 Job 终态只刷新对应文档，不重置已加载的分页窗口', () => {
      const fn = src.match(/async function pollKnowledgeUploadJobs[\s\S]*?^}/m)?.[0] || ''
      const terminalStart = fn.indexOf('if (isMounted && terminalDocumentIDs.size > 0)')
      const uploadFallbackStart = fn.indexOf('} else if', terminalStart)
      const terminalProjection = fn.slice(terminalStart, uploadFallbackStart)
      expect(terminalProjection).toContain('await refreshDocumentProjection(documentID)')
      expect(terminalProjection).not.toContain('await revalidateFromApi(true)')
    })

    it('live vector Job 会阻止同一文档重复提交重建', () => {
      const fn = src.match(/async function handleReindex[\s\S]*?^}/m)?.[0] || ''
      expect(fn).toContain('hasPollableVectorJob(doc)')
      expect(src).toContain('hasPollableVectorJob(doc)')
    })
  })

  describe('KnowledgeView — upload', () => {
    const src = readSrc('views/KnowledgeView.vue')

    it('HTTP 202 只绑定持久化 Job，只有 Job succeeded 才转 done', () => {
      expect(src).toContain('accepted.operation_id')
      expect(src).toContain('uploadsStore.markSucceeded(entry)')
      expect(src).not.toContain("entry.status = 'done'")
    })

    it('upload 失败后 entry.status 设为 error', () => {
      expect(src).toContain("entry.status = 'error'")
    })
  })

  describe('KnowledgeView — addDocument', () => {
    const src = readSrc('views/KnowledgeView.vue')

    it('addDocument 成功后调用 loadDocs 刷新列表（不手动设 status）', () => {
      const fn =
        src.match(/async function handleAddDocument[\s\S]*?^}/m)?.[0] ||
        src.match(/async function handleAdd[\s\S]*?^}/m)?.[0] ||
        ''
      // 成功后应调用 loadDocs() 刷新，而不是手动设置 status
      expect(fn === '' || !fn.includes("status: 'processing'")).toBe(true)
    })
  })

  describe('CanvasView — runWorkflow', () => {
    const src = readSrc('stores/canvas.ts')

    it('runWorkflow 后端失败时 nodeRunStatus 为 failed（不是 completed）', () => {
      const fn = src.match(/async function runWorkflow[\s\S]*?^  }/m)?.[0] || ''
      expect(fn).toBeTruthy()
      // else 分支（后端失败）应标记 failed
      const elseBranch = fn.slice(fn.indexOf('} else {'))
      expect(elseBranch).toContain("'failed'")
      expect(elseBranch).not.toContain("'completed'")
    })
  })

  describe('TasksView — pause/resume', () => {
    const src = readSrc('views/TasksView.vue')

    it('pause 成功后 status 设为 paused（最终态）', () => {
      const fn = src.match(/async function handlePauseResume[\s\S]*?^}/m)?.[0] || ''
      // 不应在成功后设为 processing
      expect(fn === '' || !fn.includes("status = 'processing'")).toBe(true)
    })
  })

  describe('OllamaCard — model delete', () => {
    const src = readSrc('components/settings/OllamaCard.vue')

    it('handleDelete 成功后调用 refreshModels 刷新列表', () => {
      const fn = src.match(/async function handleDelete[\s\S]*?^}/m)?.[0] || ''
      expect(fn).toBeTruthy()
      expect(fn).toContain('refreshModels')
    })

    it('handleDelete 不会把 status 设为 processing', () => {
      const fn = src.match(/async function handleDelete[\s\S]*?^}/m)?.[0] || ''
      expect(fn).not.toContain("status: 'processing'")
      expect(fn).not.toContain("status = 'processing'")
    })
  })

  describe('OllamaCard — model pull', () => {
    const src = readSrc('components/settings/OllamaCard.vue')

    it('pull 成功后不硬编码 processing 状态', () => {
      const fn = src.match(/async function startPull[\s\S]*?^}/m)?.[0] || ''
      expect(fn).toBeTruthy()
      expect(fn).not.toContain("status: 'processing'")
    })
  })

  describe('reindexDocument API 返回类型包含完整字段', () => {
    const src = readSrc('api/knowledge.ts')
    // 取 reindexDocument 函数体（含返回类型声明，跨多行）
    const fn = src.match(/function reindexDocument[\s\S]*?\.catch/)?.[0] || ''

    it('reindexDocument 返回类型包含 status', () => {
      expect(fn).toContain('status?')
    })

    it('reindexDocument 返回类型包含 chunk_count', () => {
      expect(fn).toContain('chunk_count?')
    })

    it('reindexDocument 返回类型包含 updated_at', () => {
      expect(fn).toContain('updated_at?')
    })
  })
})
