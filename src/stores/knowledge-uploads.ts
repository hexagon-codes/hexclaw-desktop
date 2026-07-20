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
import { reactive, ref, watch } from 'vue'

const DURABLE_UPLOADS_STORAGE_KEY = 'hexclaw:knowledge-upload-jobs:v1'

export interface KnowledgeUploadEntry {
  name: string
  progress: number
  status: 'uploading' | 'pending-response' | 'processing' | 'done' | 'error' | 'cancelled'
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
  source?: string
  title?: string
}

function loadDurableUploadEntries(): KnowledgeUploadEntry[] {
  try {
    const raw = globalThis.localStorage?.getItem(DURABLE_UPLOADS_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((value): KnowledgeUploadEntry[] => {
      if (typeof value !== 'object' || value === null) return []
      const candidate = value as Partial<KnowledgeUploadEntry>
      if (typeof candidate.name !== 'string') {
        return []
      }
      if (candidate.status === 'pending-response') {
        if (
          typeof candidate.intentKey !== 'string' ||
          !candidate.intentKey.startsWith('knowledge-upload:') ||
          typeof candidate.sourceSha256 !== 'string' ||
          !/^[0-9a-f]{64}$/.test(candidate.sourceSha256)
        ) {
          return []
        }
        return [
          {
            name: candidate.name,
            progress: 100,
            status: 'pending-response',
            intentKey: candidate.intentKey,
            sourceSha256: candidate.sourceSha256,
            error: typeof candidate.error === 'string' ? candidate.error : undefined,
          },
        ]
      }
      if (
        typeof candidate.documentId !== 'string' ||
        typeof candidate.jobId !== 'string' ||
        (candidate.status !== 'processing' && candidate.status !== 'done')
      )
        return []
      return [
        {
          name: candidate.name,
          progress: 100,
          status: candidate.status,
          documentId: candidate.documentId,
          jobId: candidate.jobId,
          stage: typeof candidate.stage === 'string' ? candidate.stage : undefined,
        },
      ]
    })
  } catch {
    return []
  }
}

export const useKnowledgeUploadsStore = defineStore('knowledgeUploads', () => {
  const items = ref<KnowledgeUploadEntry[]>(loadDurableUploadEntries())

  watch(
    items,
    (current) => {
      try {
        const durable = current.flatMap<KnowledgeUploadEntry>((entry): KnowledgeUploadEntry[] => {
          if (entry.status === 'pending-response' && entry.intentKey && entry.sourceSha256) {
            return [
              {
                name: entry.name,
                progress: 100,
                status: entry.status,
                intentKey: entry.intentKey,
                sourceSha256: entry.sourceSha256,
                error: entry.error,
              },
            ]
          }
          if (
            (entry.status === 'processing' || entry.status === 'done') &&
            entry.documentId &&
            entry.jobId
          ) {
            return [
              {
                name: entry.name,
                progress: 100,
                status: entry.status,
                documentId: entry.documentId,
                jobId: entry.jobId,
                stage: entry.stage,
              },
            ]
          }
          return []
        })
        if (durable.length === 0) {
          globalThis.localStorage?.removeItem(DURABLE_UPLOADS_STORAGE_KEY)
        } else {
          globalThis.localStorage?.setItem(DURABLE_UPLOADS_STORAGE_KEY, JSON.stringify(durable))
        }
      } catch {
        // Browser storage can be unavailable (private mode/quota). The server
        // Job remains durable; this only disables local progress restoration.
      }
    },
    { deep: true },
  )

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
    entry.error = error
  }

  /** Bind the accepted upload to the durable backend state machine returned by HTTP 202. */
  function attachJob(entry: KnowledgeUploadEntry, documentId: string, jobId: string): void {
    entry.documentId = documentId
    entry.jobId = jobId
    entry.status = 'processing'
    entry.progress = 100
    entry.intentKey = undefined
    entry.sourceSha256 = undefined
    entry.error = undefined
  }

  function markSucceeded(entry: KnowledgeUploadEntry): void {
    if (entry.status === 'processing') entry.status = 'done'
    entry.cancelling = false
  }

  function markFailed(entry: KnowledgeUploadEntry, error: string): void {
    if (entry.status !== 'done' && entry.status !== 'cancelled') entry.status = 'error'
    entry.error = error
    entry.cancelling = false
  }

  function markCancelled(entry: KnowledgeUploadEntry): void {
    if (entry.status !== 'done') entry.status = 'cancelled'
    entry.cancelling = false
  }

  /** 文档落地判定：后端上传来源统一是 `upload:<文件名>`；标题兜底匹配（去扩展名的场景交给 source） */
  function landed(entry: KnowledgeUploadEntry, docs: DocLike[]): boolean {
    return docs.some(
      (d) =>
        d.source === `upload:${entry.name}` ||
        (d.source ?? '').endsWith(`:${entry.name}`) ||
        d.title === entry.name,
    )
  }

  /** 用最新文档列表结算：done 且已在列表出现 → 移除；uploading/error 一律保留 */
  function settleAgainstDocs(docs: DocLike[]): void {
    items.value = items.value.filter((e) => !(e.status === 'done' && landed(e, docs)))
  }

  /** 是否还有持久化 Job 或等待列表投影落地的条目。 */
  function hasAwaitingIndex(): boolean {
    return items.value.some(
      (e) => e.status === 'done' || (e.status === 'processing' && Boolean(e.jobId)),
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
    hasAwaitingIndex,
    clearErrors,
  }
})
