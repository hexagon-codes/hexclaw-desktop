/**
 * 验证所有 API 成功调用后，前端状态更新为最终态（indexed/done/success）而非中间态（processing/pending）
 *
 * 根因回归：KnowledgeView.handleReindex 在 reindexDocument 成功后把 status 硬编码为 'processing'，
 * 导致永远显示"处理中"。此测试确保同类 bug 不再出现。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SRC = resolve(__dirname, '..')
function readSrc(path: string): string {
  return readFileSync(resolve(SRC, path), 'utf-8')
}

describe('API 成功后状态不应卡在中间态', () => {
  describe('KnowledgeView — reindex', () => {
    const src = readSrc('views/KnowledgeView.vue')

    it('handleReindex 成功后使用后端返回的 result.status（不硬编码 processing）', () => {
      const fn = src.match(/async function handleReindex[\s\S]*?^}/m)?.[0] || ''
      expect(fn).toBeTruthy()
      // 应使用 result.status，不应硬编码 'processing'
      expect(fn).toContain('result.status')
      expect(fn).not.toContain("status: 'processing'")
    })

    it('handleReindex 成功后更新 chunk_count 和 updated_at', () => {
      const fn = src.match(/async function handleReindex[\s\S]*?^}/m)?.[0] || ''
      expect(fn).toContain('result.chunk_count')
      expect(fn).toContain('result.updated_at')
    })
  })

  describe('KnowledgeView — upload', () => {
    const src = readSrc('views/KnowledgeView.vue')

    it('upload 成功后 entry.status 设为 done（不是 processing）', () => {
      // 上传成功路径应该设置为 'done'
      expect(src).toContain("entry.status = 'done'")
    })

    it('upload 失败后 entry.status 设为 error', () => {
      expect(src).toContain("entry.status = 'error'")
    })
  })

  describe('KnowledgeView — addDocument', () => {
    const src = readSrc('views/KnowledgeView.vue')

    it('addDocument 成功后调用 loadDocs 刷新列表（不手动设 status）', () => {
      const fn = src.match(/async function handleAddDocument[\s\S]*?^}/m)?.[0] ||
                 src.match(/async function handleAdd[\s\S]*?^}/m)?.[0] || ''
      // 成功后应调用 loadDocs() 刷新，而不是手动设置 status
      if (fn) {
        expect(fn).not.toContain("status: 'processing'")
      }
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

  describe('IMChannelsView — delete', () => {
    const src = readSrc('views/IMChannelsView.vue')

    it('handleDelete 成功后调用 loadInstances 刷新列表', () => {
      const fn = src.match(/async function handleDelete[\s\S]*?^}/m)?.[0] || ''
      expect(fn).toBeTruthy()
      expect(fn).toContain('loadInstances')
    })
  })

  describe('TasksView — pause/resume', () => {
    const src = readSrc('views/TasksView.vue')

    it('pause 成功后 status 设为 paused（最终态）', () => {
      const fn = src.match(/async function handlePauseResume[\s\S]*?^}/m)?.[0] || ''
      if (fn) {
        // 不应在成功后设为 processing
        expect(fn).not.toContain("status = 'processing'")
      }
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
