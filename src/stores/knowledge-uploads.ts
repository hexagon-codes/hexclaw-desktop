/**
 * 知识库上传/索引进度 store（BUG-20260710）。
 *
 * 为什么是 store 而不是组件 ref：上传→索引是**跨页面生命周期**的后台过程——用户上传到 100%
 * 切去别的页面再回来，KnowledgeView 已经历卸载/重挂载，组件本地 ref 必然丢失；而后端此刻
 * 仍在异步构建索引，getDocuments 还查不到该文档 → 界面上「哪儿都看不见」，用户以为上传丢了。
 *
 * 生命周期正确性：
 *  - uploading：上传请求进行中（字节传输），进度条 0→100%。
 *  - processing：字节已传完(100%)、后端仍在解析(pdftotext/VLM)+向量嵌入——这段无法上报
 *    百分比，若继续显示「100%」会被误读成卡死（BUG-20260712 #8）；单列一相显「处理中…」。
 *  - done：持久化 Job 已 succeeded——**直到文档真正出现在 getDocuments 结果里**才由
 *    settleAgainstDocs 移除（不用「N 秒后消失」这种与真实状态无关的定时器）。
 *  - error：保留给用户看，由下一轮上传开始时 clearErrors 清理。
 */
import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'
import type { KnowledgeOperation, KnowledgeOperationState } from '@/api/knowledge'

export interface KnowledgeUploadEntry {
  name: string
  progress: number
  status: 'uploading' | 'pending-response' | 'processing' | 'done' | 'error' | 'cancelled'
  operationId?: string
  operationUpdatedAt?: string
  operationTerminal?: boolean
  intentKey?: string
  sourceSha256?: string
  documentId?: string
  jobId?: string
  stage?: string
  cancelling?: boolean
  error?: string
  warning?: string
}

/** settle 匹配用的最小文档形状（api Document 的子集） */
interface DocLike {
  id?: string
  source?: string
  title?: string
}

const OPERATION_STATUS = {
  receiving: 'uploading',
  pending_response: 'pending-response',
  queued: 'processing',
  running: 'processing',
  retry_wait: 'processing',
  succeeded: 'done',
  failed: 'error',
  cancelled: 'cancelled',
} as const satisfies Record<KnowledgeOperationState, KnowledgeUploadEntry['status']>

export const useKnowledgeUploadsStore = defineStore('knowledgeUploads', () => {
  const items = ref<KnowledgeUploadEntry[]>([])

  /** 登记一个条目并返回其响应式引用——上传任务直接改 entry.progress/status 即驱动 UI */
  function track(init: KnowledgeUploadEntry): KnowledgeUploadEntry {
    const entry = reactive({ ...init })
    items.value.push(entry)
    return entry
  }

  /**
   * 字节传输已达 100%、后端进入解析+嵌入阶段：把 uploading 切到 processing。
   * 仅从 uploading 迁移（done/error 是终态，不回退），保证「处理中」相只出现在
   * 「传完但还没落库」的真实窗口里（BUG-20260712 #8「卡 100% 不动」根因）。
   */
  function markProcessing(entry: KnowledgeUploadEntry): void {
    if (entry.status === 'uploading') entry.status = 'processing'
  }

  /**
   * Bind the visible row to the API's persisted upload intent. If the same
   * source is reselected after an unknown response, resume the original row
   * and discard the provisional duplicate.
   */
  function bindIntent(
    entry: KnowledgeUploadEntry,
    intent: { idempotencyKey: string; sourceSha256: string },
  ): KnowledgeUploadEntry {
    const existing = items.value.find(
      (candidate) => candidate !== entry && candidate.intentKey === intent.idempotencyKey,
    )
    if (existing) {
      items.value = items.value.filter((candidate) => candidate !== entry)
      existing.name = entry.name
      existing.progress = 0
      existing.status = 'uploading'
      existing.error = undefined
      existing.warning = undefined
      existing.cancelling = false
      return existing
    }
    entry.intentKey = intent.idempotencyKey
    entry.sourceSha256 = intent.sourceSha256
    return entry
  }

  function markPendingResponse(entry: KnowledgeUploadEntry, error?: string): void {
    if (entry.status === 'done' || entry.status === 'cancelled') return
    entry.progress = 100
    entry.status = 'pending-response'
    entry.operationTerminal = false
    entry.error = error
  }

  /** Bind the accepted upload to the durable backend state machine returned by HTTP 202. */
  function attachJob(
    entry: KnowledgeUploadEntry,
    documentId: string,
    jobId: string,
    operationId?: string,
  ): void {
    if (operationId?.trim()) entry.operationId = operationId
    entry.documentId = documentId
    entry.jobId = jobId
    entry.status = 'processing'
    entry.progress = 100
    entry.operationTerminal = false
    entry.intentKey = undefined
    entry.error = undefined
  }

  function markSucceeded(entry: KnowledgeUploadEntry): void {
    if (entry.status === 'processing') entry.status = 'done'
    entry.operationTerminal = true
    entry.cancelling = false
  }

  function markFailed(entry: KnowledgeUploadEntry, error: string): void {
    if (entry.status !== 'done' && entry.status !== 'cancelled') entry.status = 'error'
    entry.operationTerminal = true
    entry.error = error
    entry.cancelling = false
  }

  function markCancelled(entry: KnowledgeUploadEntry): void {
    if (entry.status !== 'done') entry.status = 'cancelled'
    entry.operationTerminal = true
    entry.cancelling = false
  }

  /** A completed operation lands only when its stable document ID is listed. */
  function landed(entry: KnowledgeUploadEntry, docs: DocLike[]): boolean {
    return Boolean(entry.documentId && docs.some((document) => document.id === entry.documentId))
  }

  /** Settle terminal success by Sidecar identity; filename/source are presentation only. */
  function settleAgainstDocs(docs: DocLike[]): void {
    items.value = items.value.filter((e) => !(e.status === 'done' && landed(e, docs)))
  }

  /** Replace restartable rows with the Sidecar's durable upload-operation projection. */
  function reconcileRecoverableOperations(operations: KnowledgeOperation[]): void {
    const remoteOperationIDs = new Set(operations.map((operation) => operation.operation_id))
    const remoteJobIDs = new Set(
      operations.map((operation) => operation.job_id).filter((jobID) => Boolean(jobID)),
    )
    const remoteDocumentIDs = new Set(
      operations
        .map((operation) => operation.document_id)
        .filter((documentID) => Boolean(documentID)),
    )
    items.value = items.value.filter((entry) => {
      if (entry.status === 'done') return true
      if (!entry.operationId && !entry.jobId && !entry.documentId) return true
      return (
        Boolean(entry.operationId && remoteOperationIDs.has(entry.operationId)) ||
        Boolean(entry.jobId && remoteJobIDs.has(entry.jobId)) ||
        Boolean(entry.documentId && remoteDocumentIDs.has(entry.documentId))
      )
    })
    for (const operation of operations) {
      const existing = items.value.find(
        (entry) =>
          entry.operationId === operation.operation_id ||
          Boolean(operation.job_id && entry.jobId === operation.job_id) ||
          Boolean(operation.document_id && entry.documentId === operation.document_id) ||
          Boolean(
            operation.content_digest &&
              entry.sourceSha256 === operation.content_digest &&
              entry.name === (operation.display_name || operation.title),
          ),
      )
      if (
        existing?.operationUpdatedAt &&
        Date.parse(existing.operationUpdatedAt) > Date.parse(operation.updated_at)
      ) {
        continue
      }
      const status = OPERATION_STATUS[operation.state]
      const name =
        operation.display_name || operation.title || operation.document_id || operation.operation_id
      if (existing) {
        existing.name = name || existing.name
        existing.operationId = operation.operation_id
        existing.operationUpdatedAt = operation.updated_at
        existing.operationTerminal = operation.terminal
        if (operation.document_id) existing.documentId = operation.document_id
        if (operation.job_id) existing.jobId = operation.job_id
        if (operation.content_digest) existing.sourceSha256 = operation.content_digest
        existing.stage = operation.stage
        existing.progress = operation.state === 'receiving' ? existing.progress : 100
        existing.status = status
        existing.error = operation.state === 'failed' ? operation.error : undefined
        existing.warning = undefined
        existing.cancelling = false
        continue
      }
      items.value.push(
        reactive({
          name,
          progress: operation.state === 'receiving' ? 0 : 100,
          status,
          operationId: operation.operation_id,
          operationUpdatedAt: operation.updated_at,
          operationTerminal: operation.terminal,
          ...(operation.document_id ? { documentId: operation.document_id } : {}),
          ...(operation.job_id ? { jobId: operation.job_id } : {}),
          ...(operation.content_digest ? { sourceSha256: operation.content_digest } : {}),
          stage: operation.stage,
          ...(operation.state === 'failed' && operation.error ? { error: operation.error } : {}),
        }),
      )
    }
  }

  /** 是否还有持久化 Job 或等待列表投影落地的条目。 */
  function hasAwaitingIndex(): boolean {
    return items.value.some(
      (entry) =>
        entry.status === 'done' ||
        (!entry.operationTerminal && Boolean(entry.operationId || entry.jobId)),
    )
  }

  /** 新一轮上传开始前清掉旧错误条目 */
  function clearErrors(): void {
    items.value = items.value.filter((e) => e.status !== 'error' && e.status !== 'cancelled')
  }

  return {
    items,
    track,
    bindIntent,
    markProcessing,
    markPendingResponse,
    attachJob,
    markSucceeded,
    markFailed,
    markCancelled,
    settleAgainstDocs,
    reconcileRecoverableOperations,
    hasAwaitingIndex,
    clearErrors,
  }
})
