/**
 * Conversation automation composable
 *
 * Extracts task/knowledge automation logic from ChatView:
 * parsing AI responses, building action cards, executing CronJob / Knowledge operations.
 */

import {
  createCronJob,
  deleteCronJob,
  getCronJobs,
  pauseCronJob,
  resumeCronJob,
  triggerCronJob,
} from '@/api/tasks'
import {
  addDocument,
  deleteDocument,
  getDocuments,
  reindexDocument,
  searchKnowledge,
} from '@/api/knowledge'
import { createMemoryEntry } from '@/api/memory'
import type { MemoryType, MemorySource } from '@/types'
import { emit } from '@/utils/eventBus'
import {
  CHAT_AUTOMATION_METADATA_KEY,
  buildConversationAutomationActions,
  getConversationAutomationActions,
  getParsedDocumentContentFromMessage,
  type ConversationAutomationAction,
  type ConversationAutomationResult,
} from '@/utils/chat-automation'
import type { ChatMessage, CronJob, KnowledgeDoc } from '@/types'
import type { useChatStore } from '@/stores/chat'
import type { useToast } from './useToast'

type ChatStore = ReturnType<typeof useChatStore>
type Toast = ReturnType<typeof useToast>
type TFunc = (key: string, fallback?: string) => string

export function useConversationAutomation(chatStore: ChatStore, toast: Toast, t?: TFunc) {
  const tr = (key: string, fallback: string) => t ? t(key, fallback) : fallback
  function clipAutomationText(value: string, maxLength = 180): string {
    const normalized = value.trim()
    if (normalized.length <= maxLength) return normalized
    return `${normalized.slice(0, maxLength)}...`
  }

  function normalizeLookupValue(value: string): string {
    return value.replace(/\s+/g, '').toLowerCase()
  }

  function findPreviousUserMessage(messageId: string): ChatMessage | null {
    const idx = chatStore.messages.findIndex((message) => message.id === messageId)
    if (idx < 0) return null
    for (let i = idx - 1; i >= 0; i--) {
      if (chatStore.messages[i]?.role === 'user') {
        return chatStore.messages[i] as ChatMessage
      }
    }
    return null
  }

  function mergeConversationActions(
    current: ConversationAutomationAction[],
    incoming: ConversationAutomationAction[],
  ): ConversationAutomationAction[] {
    const merged = [...current]
    for (const action of incoming) {
      const exists = merged.some(
        (item) => item.kind === action.kind && item.description === action.description,
      )
      if (!exists) merged.push(action)
    }
    return merged
  }

  function getVisibleConversationActions(message: ChatMessage): ConversationAutomationAction[] {
    return getConversationAutomationActions(message).filter(
      (action) => action.status !== 'dismissed',
    )
  }

  async function attachConversationAutomationActions(params: {
    userText: string
    assistantMessage: ChatMessage | null
    attachment?: {
      fileName: string
      parsedText?: string
    } | null
  }) {
    if (!params.assistantMessage) return

    const sourceMessage = findPreviousUserMessage(params.assistantMessage.id)
    if (!sourceMessage) return

    let actions = buildConversationAutomationActions({
      userText: params.userText,
      assistantContent: params.assistantMessage.content,
      sourceMessageId: sourceMessage.id,
      attachment: params.attachment,
    })

    // Dedup: if the backend Agent already saved memory via metadata.memory_saved,
    // drop the frontend-generated save_memory action to avoid double-saving.
    if (params.assistantMessage.metadata?.memory_saved) {
      actions = actions.filter((a) => a.kind !== 'save_memory')
    }

    if (!actions.length) return

    await chatStore.updateMessage(params.assistantMessage.id, (current) => ({
      ...current,
      metadata: {
        ...current.metadata,
        [CHAT_AUTOMATION_METADATA_KEY]: mergeConversationActions(
          getConversationAutomationActions(current),
          actions,
        ),
      },
    }))
  }

  function automationStatusLabel(status: ConversationAutomationAction['status']): string {
    switch (status) {
      case 'running': return tr('chat.automationRunning', '执行中')
      case 'completed': return tr('chat.automationCompleted', '已完成')
      case 'failed': return tr('chat.automationFailed', '失败')
      case 'dismissed': return tr('chat.automationDismissed', '已忽略')
      default: return tr('chat.automationPending', '待确认')
    }
  }

  function automationExecuteLabel(action: ConversationAutomationAction): string {
    if (action.status === 'failed') return tr('chat.automationRetry', '重试')
    switch (action.kind) {
      case 'create_task': return tr('chat.automationCreateTask', '创建任务')
      case 'pause_task': return tr('chat.automationPauseTask', '暂停')
      case 'resume_task': return tr('chat.automationResumeTask', '恢复')
      case 'trigger_task': return tr('chat.automationTriggerTask', '立即执行')
      case 'delete_task': return tr('chat.automationDeleteTask', '删除任务')
      case 'add_text_to_knowledge':
      case 'add_attachment_to_knowledge': return tr('chat.automationAddKnowledge', '写入知识库')
      case 'search_knowledge': return tr('chat.automationSearchKnowledge', '执行搜索')
      case 'reindex_document': return tr('chat.automationReindex', '重建索引')
      case 'delete_document': return tr('chat.automationDeleteDocument', '删除文档')
      case 'save_memory': return tr('chat.automationSaveMemory', '保存到记忆')
    }
  }

  async function updateConversationAction(
    messageId: string,
    actionId: string,
    updater: (action: ConversationAutomationAction) => ConversationAutomationAction,
  ) {
    await chatStore.updateMessage(messageId, (current) => {
      const actions = getConversationAutomationActions(current)
      return {
        ...current,
        metadata: {
          ...current.metadata,
          [CHAT_AUTOMATION_METADATA_KEY]: actions.map((action) =>
            action.id === actionId ? updater(action) : action,
          ),
        },
      }
    })
  }

  async function dismissConversationAction(messageId: string, actionId: string) {
    await updateConversationAction(messageId, actionId, (action) => ({
      ...action,
      status: 'dismissed',
      error: undefined,
    }))
  }

  async function resolveTaskByName(targetName: string): Promise<CronJob> {
    const response = await getCronJobs()
    const jobs = response.jobs || []
    const target = normalizeLookupValue(targetName)

    const exact = jobs.find((job) => normalizeLookupValue(job.name) === target)
    if (exact) return exact

    const fuzzy = jobs.filter((job) => normalizeLookupValue(job.name).includes(target))
    if (fuzzy.length === 1) return fuzzy[0] as CronJob
    if (fuzzy.length > 1) {
      throw new Error(
        `找到多个匹配任务：${fuzzy
          .slice(0, 3)
          .map((job) => job.name)
          .join('、')}`,
      )
    }

    throw new Error(`未找到任务：${targetName}`)
  }

  async function resolveDocumentByTitle(targetTitle: string): Promise<KnowledgeDoc> {
    const response = await getDocuments()
    const docs = response.documents || []
    const target = normalizeLookupValue(targetTitle)

    const exact = docs.find((doc) => normalizeLookupValue(doc.title) === target)
    if (exact) return exact

    const fuzzy = docs.filter((doc) => normalizeLookupValue(doc.title).includes(target))
    if (fuzzy.length === 1) return fuzzy[0] as KnowledgeDoc
    if (fuzzy.length > 1) {
      throw new Error(
        `找到多个匹配文档：${fuzzy
          .slice(0, 3)
          .map((doc) => doc.title)
          .join('、')}`,
      )
    }

    throw new Error(`未找到知识文档：${targetTitle}`)
  }

  async function executeConversationAction(
    action: ConversationAutomationAction,
  ): Promise<ConversationAutomationResult> {
    switch (action.kind) {
      case 'create_task': {
        const created = await createCronJob(action.payload)
        return {
          summary: `已创建任务「${created.name || action.payload.name}」`,
          items: [
            { title: '计划', content: action.payload.schedule },
            { title: '下一次执行', content: created.next_run_at || '等待调度' },
          ],
        }
      }
      case 'pause_task': {
        const job = await resolveTaskByName(action.payload.targetName)
        await pauseCronJob(job.id)
        return { summary: `已暂停任务「${job.name}」` }
      }
      case 'resume_task': {
        const job = await resolveTaskByName(action.payload.targetName)
        await resumeCronJob(job.id)
        return { summary: `已恢复任务「${job.name}」` }
      }
      case 'trigger_task': {
        const job = await resolveTaskByName(action.payload.targetName)
        await triggerCronJob(job.id)
        return { summary: `已触发任务「${job.name}」` }
      }
      case 'delete_task': {
        const job = await resolveTaskByName(action.payload.targetName)
        await deleteCronJob(job.id)
        return { summary: `已删除任务「${job.name}」` }
      }
      case 'add_text_to_knowledge': {
        await addDocument(action.payload.title, action.payload.content, action.payload.source)
        return {
          summary: `已写入知识库文档「${action.payload.title}」`,
          items: [
            {
              title: '内容预览',
              content: clipAutomationText(action.payload.content, 120),
            },
          ],
        }
      }
      case 'add_attachment_to_knowledge': {
        const sourceMessage = chatStore.messages.find(
          (message) => message.id === action.payload.sourceMessageId,
        )
        const parsedDocument = getParsedDocumentContentFromMessage(sourceMessage)
        if (!parsedDocument) {
          throw new Error('未找到可写入知识库的附件文本内容')
        }
        await addDocument(action.payload.title, parsedDocument.content, action.payload.source)
        return {
          summary: `已将附件写入知识库「${action.payload.title}」`,
          items: [
            {
              title: '内容预览',
              content: clipAutomationText(parsedDocument.content, 120),
            },
          ],
        }
      }
      case 'search_knowledge': {
        const response = await searchKnowledge(action.payload.query, action.payload.topK)
        const results = response.result || []
        return {
          summary: results.length
            ? `找到 ${results.length} 条与「${action.payload.query}」相关的知识库结果`
            : `未找到与「${action.payload.query}」相关的知识库内容`,
          items: results.slice(0, action.payload.topK).map((item, index) => {
            const metaParts: string[] = []
            if (item.source) metaParts.push(item.source)
            if (typeof item.chunk_index === 'number') {
              const total = typeof item.chunk_count === 'number' ? `/${item.chunk_count}` : ''
              metaParts.push(`Chunk ${item.chunk_index + 1}${total}`)
            }
            return {
              title: item.doc_title || item.source || `结果 ${index + 1}`,
              subtitle: metaParts.join(' · ') || undefined,
              content: clipAutomationText(item.content, 140),
            }
          }),
        }
      }
      case 'reindex_document': {
        const doc = await resolveDocumentByTitle(action.payload.targetTitle)
        await reindexDocument(doc.id)
        return { summary: `已触发文档「${doc.title}」重建索引` }
      }
      case 'delete_document': {
        const doc = await resolveDocumentByTitle(action.payload.targetTitle)
        await deleteDocument(doc.id)
        return { summary: `已删除知识文档「${doc.title}」` }
      }
      case 'save_memory': {
        await createMemoryEntry(
          action.payload.content,
          (action.payload.type as MemoryType) || undefined,
          (action.payload.source as MemorySource) || 'chat_extract',
        )
        emit('memory:updated')
        return { summary: `已记住: ${clipAutomationText(action.payload.content, 60)}` }
      }
    }
  }

  async function handleConversationAction(messageId: string, actionId: string) {
    const message = chatStore.messages.find((item) => item.id === messageId)
    if (!message) return

    const action = getConversationAutomationActions(message).find((item) => item.id === actionId)
    if (!action || action.status === 'running' || action.status === 'completed') return

    await updateConversationAction(messageId, actionId, (current) => ({
      ...current,
      status: 'running',
      error: undefined,
    }))

    try {
      const result = await executeConversationAction(action)
      await updateConversationAction(messageId, actionId, (current) => ({
        ...current,
        status: 'completed',
        result,
        error: undefined,
      }))
      toast.success(result.summary)
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      await updateConversationAction(messageId, actionId, (current) => ({
        ...current,
        status: 'failed',
        error: messageText,
      }))
      toast.error(messageText)
    }
  }

  return {
    clipAutomationText,
    getVisibleConversationActions,
    attachConversationAutomationActions,
    automationStatusLabel,
    automationExecuteLabel,
    handleConversationAction,
    dismissConversationAction,
  }
}
