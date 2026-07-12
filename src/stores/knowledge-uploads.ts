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
 *  - done：上传+处理完成、索引构建中——**直到文档真正出现在 getDocuments 结果里**才由
 *    settleAgainstDocs 移除（不用「N 秒后消失」这种与真实状态无关的定时器）。
 *  - error：保留给用户看，由下一轮上传开始时 clearErrors 清理。
 */
import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'

export interface KnowledgeUploadEntry {
  name: string
  progress: number
  status: 'uploading' | 'processing' | 'done' | 'error'
  error?: string
  warning?: string
}

/** settle 匹配用的最小文档形状（api Document 的子集） */
interface DocLike {
  source?: string
  title?: string
}

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

  /** 文档落地判定：后端上传来源统一是 `upload:<文件名>`；标题兜底匹配（去扩展名的场景交给 source） */
  function landed(entry: KnowledgeUploadEntry, docs: DocLike[]): boolean {
    return docs.some(
      (d) => d.source === `upload:${entry.name}` || (d.source ?? '').endsWith(`:${entry.name}`) || d.title === entry.name,
    )
  }

  /** 用最新文档列表结算：done 且已在列表出现 → 移除；uploading/error 一律保留 */
  function settleAgainstDocs(docs: DocLike[]): void {
    items.value = items.value.filter((e) => !(e.status === 'done' && landed(e, docs)))
  }

  /** 是否还有等待「落地」的 done 条目（KnowledgeView 据此做挂载期轻量轮询） */
  function hasAwaitingIndex(): boolean {
    return items.value.some((e) => e.status === 'done')
  }

  /** 新一轮上传开始前清掉旧错误条目 */
  function clearErrors(): void {
    items.value = items.value.filter((e) => e.status !== 'error')
  }

  return { items, track, markProcessing, settleAgainstDocs, hasAwaitingIndex, clearErrors }
})
