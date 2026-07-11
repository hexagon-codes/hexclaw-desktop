/**
 * 知识库上传/索引进度 store（BUG-20260710）。
 *
 * 为什么是 store 而不是组件 ref：上传→索引是**跨页面生命周期**的后台过程——用户上传到 100%
 * 切去别的页面再回来，KnowledgeView 已经历卸载/重挂载，组件本地 ref 必然丢失；而后端此刻
 * 仍在异步构建索引，getDocuments 还查不到该文档 → 界面上「哪儿都看不见」，用户以为上传丢了。
 *
 * 生命周期正确性：
 *  - uploading：上传请求进行中，条目常驻（进度条）。
 *  - done：上传完成、索引构建中——**直到文档真正出现在 getDocuments 结果里**才由
 *    settleAgainstDocs 移除（不用「N 秒后消失」这种与真实状态无关的定时器）。
 *  - error：保留给用户看，由下一轮上传开始时 clearErrors 清理。
 */
import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'

export interface KnowledgeUploadEntry {
  name: string
  progress: number
  status: 'uploading' | 'done' | 'error'
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

  return { items, track, settleAgainstDocs, hasAwaitingIndex, clearErrors }
})
