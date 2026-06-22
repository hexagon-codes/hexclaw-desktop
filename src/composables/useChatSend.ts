/**
 * Chat send composable
 *
 * Extracts the main send handler (with Auto-RAG) and file-to-base64 conversion
 * from ChatView.
 *
 * 入口 4 层路由（Confidence-Tiered Routing）：
 *   tier 0: slash command（/cron add ...）        → 直接解析（暂未实施）
 *   tier 1: 正则 fast-path（OpenClaw 模式）        → 0 token，跳过 LLM
 *   tier 2: LLM JSON 解析（response_format=json）  → ~500 token，绕开 tool_call
 *   tier 3: LLM 反问澄清（tools=nil）              → 多轮文字，绕开 tool_call
 *
 * 全程不让 LLM 走 tool_call 创建 cron，从协议层根除 tool_use_id 链路 400 bug。
 */

import { nextTick, type Ref } from 'vue'
import { searchKnowledge } from '@/api/knowledge'
import { formatContextBlock } from '@/utils/chat-context'
import { parseDocument } from '@/utils/file-parser'
import type { ChatAttachment, ChatMessage } from '@/types'
import type { useChatStore } from '@/stores/chat'
import {
  buildConversationAutomationActions,
  CHAT_AUTOMATION_METADATA_KEY,
  type CreateTaskAction,
} from '@/utils/chat-automation'
import { parseCronSlashCommand } from './useCronSlashParser'

type ChatStore = ReturnType<typeof useChatStore>

export interface ChatSendDeps {
  chatStore: ChatStore
  parsedDocument: Ref<{ text: string; fileName: string; pageCount?: number } | null>
  attachmentPreview: Ref<{
    url: string
    name: string
    type: 'image' | 'video' | 'file'
    file: File
  } | null>
  clearAttachmentPreview: () => void
  scrollToBottom: () => void
  attachConversationAutomationActions: (params: {
    userText: string
    assistantMessage: ChatMessage | null
    attachment?: { fileName: string; parsedText?: string } | null
  }) => Promise<void>
}

/**
 * 4 层路由的分类结果。
 * tier=1 含完整 payload，可直接走 fast-path 跳过 LLM。
 * tier=2 关键字命中但参数缺，需走 Layer 2 LLM JSON 解析。
 * tier=3 完全无 cron 意图（或意图极弱），走 Layer 3 反问澄清或原 LLM 路径。
 */
export interface CronIntentResult {
  tier: 1 | 2 | 3
  confidence: number
  payload?: CreateTaskAction['payload']
  raw?: CreateTaskAction
}

/**
 * 用户输入意图分类。完全 deterministic 不调任何外部依赖，<50ms。
 *
 * 高置信契约（tier=1）：
 *   - chat-automation 的 maybeCreateTaskAction 能识别（trigger 词 + schedule 表达）
 *   - 提取的 payload 三个字段（name/schedule/prompt）非空
 *   - confidence >= 0.85
 */
export function classifyCronIntent(text: string): CronIntentResult {
  const actions = buildConversationAutomationActions({ userText: text, sourceMessageId: 'cron-intent-probe' })
  const create = actions.find((a): a is CreateTaskAction => a.kind === 'create_task')

  if (create) {
    const p = create.payload
    const complete = !!(p.name && p.schedule && p.prompt && p.prompt.trim().length > 2)
    if (complete) {
      return { tier: 1, confidence: 0.95, payload: p, raw: create }
    }
    return { tier: 2, confidence: 0.6, payload: p, raw: create }
  }

  // 弱意图词（无 schedule）— 后续 Layer 2/3 处理
  const hasCronHint = /(?:提醒|定时|每天|每周|每月|每隔|每次|每年|^cron\b)/i.test(text)
  if (hasCronHint) {
    return { tier: 2, confidence: 0.4 }
  }
  return { tier: 3, confidence: 0 }
}

/**
 * tier=1 fast-path 时构造的 assistant 提示 message，含可点击的 CreateTaskAction 卡片。
 *
 * 关键契约：
 *   - role='assistant'
 *   - metadata 含 CHAT_AUTOMATION_METADATA_KEY → CreateTaskAction[]
 *   - content 是 K12 家长友好中文，永不含技术词
 */
export function buildFastPathAssistantMessage(userText: string): ChatMessage | null {
  const intent = classifyCronIntent(userText)
  if (intent.tier !== 1 || !intent.raw) return null

  const action = intent.raw
  return {
    id: `fastpath-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    role: 'assistant',
    content: `已识别到「创建定时任务」的意图，下方卡片可直接确认或修改后创建。`,
    timestamp: new Date().toISOString(),
    metadata: {
      [CHAT_AUTOMATION_METADATA_KEY]: [action],
      source_tier: '1',
    },
  } as ChatMessage
}

/**
 * 把 slash 命令分发结果翻译成 assistant 提示 message。
 *
 * - kind=add + intent.tier=1：附 CreateTaskAction 卡片（fast-path）
 * - kind=add + intent.tier!=1：让用户补全（不直接调 LLM 避开 tool_use_id 风险）
 * - kind=list/pause/resume/remove/run：未来调 /api/v1/cronjob unified endpoint
 */
function buildSlashAssistantMessage(
  slash: ReturnType<typeof import('./useCronSlashParser').parseCronSlashCommand> & object,
): ChatMessage {
  const baseId = `slash-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const ts = new Date().toISOString()

  if (slash.kind === 'add') {
    if (slash.intent.tier === 1 && slash.intent.raw) {
      return {
        id: baseId,
        role: 'assistant',
        content: '已识别 slash 命令，下方卡片可直接确认或修改后创建。',
        timestamp: ts,
        metadata: {
          [CHAT_AUTOMATION_METADATA_KEY]: [slash.intent.raw],
          source_tier: '0',
        },
      } as ChatMessage
    }
    return {
      id: baseId,
      role: 'assistant',
      content:
        'slash 命令需要更多信息。例：/cron add 每天 8 点 "采集新闻头条"，或 /cron add 30m "检查汇率"',
      timestamp: ts,
      metadata: { source_tier: '0' },
    } as ChatMessage
  }

  if (slash.kind === 'unknown') {
    return {
      id: baseId,
      role: 'assistant',
      content: slash.suggestion,
      timestamp: ts,
      metadata: { source_tier: '0' },
    } as ChatMessage
  }

  // list / pause / resume / remove / run
  return {
    id: baseId,
    role: 'assistant',
    content: `已收到 slash 命令：${slash.kind}${'jobId' in slash ? ` ${slash.jobId}` : ''}。请到「任务」页面操作或稍后会自动执行。`,
    timestamp: ts,
    metadata: { source_tier: '0', slash_kind: slash.kind },
  } as ChatMessage
}

export function useChatSend(deps: ChatSendDeps) {
  const {
    chatStore,
    parsedDocument,
    attachmentPreview,
    clearAttachmentPreview,
    scrollToBottom,
    attachConversationAutomationActions,
  } = deps

  /** File -> Base64 */
  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = reader.result as string
        // 去掉 data:xxx;base64, 前缀
        resolve(result.split(',')[1] || result)
      }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  async function handleSend(
    text: string,
    files?: File[],
    options?: { contextRefs?: import('@/types').ChatContextRef[]; skillNames?: string[] },
  ): Promise<boolean> {
    // Validate model selection before sending
    // model=undefined means "let backend decide" (Agent mode) — valid
    const model = chatStore.chatParams.model
    if (model !== undefined && model.trim() === '') {
      return false
    }

    // ✦ Layer 0 — slash command (`/cron add 30m "..."` / `/cron list` / 等)
    //   (D3.2：附件路径不走 slash，与 fast-path 同等约束)
    if (!files?.length && !attachmentPreview.value && !parsedDocument.value) {
      const slash = parseCronSlashCommand(text)
      if (slash) {
        // 不论 kind，都先把 user 原始输入 push 到 chat，符合用户预期
        chatStore.messages.push({
          id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          role: 'user',
          content: text,
          timestamp: new Date().toISOString(),
        } as ChatMessage)
        const slashReply = buildSlashAssistantMessage(slash)
        chatStore.messages.push(slashReply)
        await nextTick()
        scrollToBottom()
        return true
      }
    }

    // ✦ 4 层 Intent Resolver — tier=1 fast-path 跳过 LLM，避开 tool_use_id 链路 bug
    //   (附件路径不走 fast-path：用户带文件的意图通常超出"纯创建任务"，留给 LLM)
    if (!files?.length && !attachmentPreview.value && !parsedDocument.value) {
      const intent = classifyCronIntent(text)
      if (intent.tier === 1) {
        const fastMessage = buildFastPathAssistantMessage(text)
        if (fastMessage) {
          // 不调 chatStore.sendMessage —— 直接 push user + assistant
          chatStore.messages.push({
            id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            role: 'user',
            content: text,
            timestamp: new Date().toISOString(),
          } as ChatMessage)
          chatStore.messages.push(fastMessage)
          await nextTick()
          scrollToBottom()
          return true
        }
      }
    }

    const legacyAttachment = attachmentPreview.value
    const legacyParsedDocument = parsedDocument.value
    const attachmentAutomation =
      legacyAttachment?.type === 'file' && legacyParsedDocument
        ? {
            fileName: legacyAttachment.name,
            parsedText: legacyParsedDocument.text,
          }
        : null

    // 将附件转为 base64（支持多文件）
    const attachments: ChatAttachment[] = []

    // 从旧的 attachmentPreview（兼容拖拽等路径）
    if (legacyAttachment) {
      const { file, type } = legacyAttachment
      const data = await fileToBase64(file)
      attachments.push({ type, name: file.name, mime: file.type, data })
    }

    // 从新的多文件参数：图片/视频作为 attachment，文档解析为文本
    const docTexts: string[] = []
    if (files?.length) {
      for (const file of files) {
        const isImage = file.type.startsWith('image/')
        const isVideo = file.type.startsWith('video/')
        if (isImage) {
          // 图片：作为 attachment 发送给支持 vision 的模型
          const data = await fileToBase64(file)
          attachments.push({ type: 'image', name: file.name, mime: file.type, data })
        } else if (isVideo) {
          // 视频：保留 video 类型
          const data = await fileToBase64(file)
          attachments.push({ type: 'video', name: file.name, mime: file.type, data })
        } else {
          // 文档（PDF/TXT/DOCX 等）：解析提取文本，拼入消息内容
          try {
            const parsed = await parseDocument(file)
            if (parsed.text.trim()) {
              const pageInfo = parsed.pageCount ? ` (${parsed.pageCount}页)` : ''
              docTexts.push(`[文件: ${parsed.fileName}${pageInfo}]\n\n${parsed.text}`)
            }
          } catch {
            // 解析失败时作为普通附件发送
            const data = await fileToBase64(file)
            attachments.push({ type: 'file', name: file.name, mime: file.type, data })
          }
        }
      }
    }

    // 拼接文档文本到消息内容
    let finalText = text
    if (legacyParsedDocument) {
      const doc = legacyParsedDocument
      const pageInfo = doc.pageCount ? ` (${doc.pageCount}页)` : ''
      docTexts.unshift(`[文件: ${doc.fileName}${pageInfo}]\n\n${doc.text}`)
    }
    if (docTexts.length > 0) {
      finalText = docTexts.join('\n\n---\n\n') + '\n\n---\n' + text
    }

    // Auto-RAG: 自动检索知识库，将相关内容注入后端上下文
    let backendText: string | undefined
    try {
      const { result: knowledgeHits } = await searchKnowledge(text, 3)
      const relevant = knowledgeHits.filter((hit) => hit.score >= 0.35 && hit.content)
      if (relevant.length > 0) {
        const contextBlock = relevant
          .map((hit, i) => {
            const source = hit.doc_title || hit.source || `片段${i + 1}`
            return `[来源: ${source}]\n${hit.content}`
          })
          .join('\n\n')
        backendText = `[知识库参考信息 - 请优先参考以下内容回答用户问题]\n${contextBlock}\n\n[用户问题]\n${finalText}`
      }
    } catch {
      // 知识库搜索失败不阻塞聊天
    }

    // `@` 显式召唤的上下文（知识/连接/会话）：前置到 backendText，与 Auto-RAG 叠加，
    // 只进后端文本、不污染用户气泡（显示仍为 finalText）。
    const explicitContextBlock = formatContextBlock(options?.contextRefs ?? [])
    if (explicitContextBlock) {
      backendText = backendText
        ? `${explicitContextBlock}\n\n${backendText}`
        : `${explicitContextBlock}\n\n[用户问题]\n${finalText}`
    }
    // 注意：技能激活**不**经正文 @name 注入——`@skill` 会被后端当 mention/tool 致空回答。
    // skillNames 作为前向兼容字段透传，由专用激活通道处理（不写进 backendText）。

    // Set agent role for research mode; clear stale role when not in research
    if (chatStore.chatMode === 'research') {
      chatStore.agentRole = 'researcher'
    } else if (chatStore.agentRole === 'researcher') {
      chatStore.agentRole = ''
    }

    const previousMessageCount = Array.isArray(chatStore.messages) ? chatStore.messages.length : 0
    const skillNames = options?.skillNames ?? []
    const sendPromise = chatStore.sendMessage(
      finalText,
      attachments.length > 0 ? attachments : undefined,
      backendText || skillNames.length ? { backendText, skillNames } : undefined,
    )
    const accepted = Array.isArray(chatStore.messages) && chatStore.messages.length > previousMessageCount
    if (!accepted) {
      const assistantMessage = await sendPromise
      return !!assistantMessage
    }

    if (legacyAttachment || legacyParsedDocument) {
      clearAttachmentPreview()
    }

    void sendPromise
      .then(async (assistantMessage) => {
        if (!assistantMessage) return
        await attachConversationAutomationActions({
          userText: text,
          assistantMessage,
          attachment: attachmentAutomation,
        })
        await nextTick()
        scrollToBottom()
      })
      .catch(() => {})

    await nextTick()
    scrollToBottom()
    return true
  }

  return {
    handleSend,
    fileToBase64,
  }
}
