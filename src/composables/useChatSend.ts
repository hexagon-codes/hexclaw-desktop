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
import { i18n } from '@/i18n'
import { formatContextBlock } from '@/utils/chat-context'
import { parseDocument } from '@/utils/file-parser'
import { registerDocPreview } from '@/utils/doc-preview'
import { logger } from '@/utils/logger'
import { normalizeMathMarkdown } from '@/utils/math-content'
import { useToast } from './useToast'
import type { ChatAttachment, ChatDocumentRef, ChatMessage } from '@/types'
import type { useChatStore } from '@/stores/chat'
import type { ChatRouteSnapshot } from '@/stores/chat-route-snapshot'
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
  // force=true：用户主动发送的瞬间必须无条件滚到底（即便之前上翻看历史）——发送是「我要看最新」
  // 的明确动作；流式回复到达走非 force（尊重当前滚动位置）。BUG-20260627。
  scrollToBottom: (force?: boolean) => void
  attachConversationAutomationActions: (params: {
    userText: string
    assistantMessage: ChatMessage | null
    attachment?: { fileName: string; parsedText?: string } | null
  }) => Promise<void>
  captureRouteSnapshot?: () => ChatRouteSnapshot
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
    captureRouteSnapshot,
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
    options?: {
      contextRefs?: import('@/types').ChatContextRef[]
      skillNames?: string[]
      // 预置附件（编辑/重试重发时带回原消息的图片等，BUG-20260625），与 files/preview 合并
      attachments?: ChatAttachment[]
      /** 内部定向发送：编辑版本写入新分支时，当前可见会话仍保持 source。 */
      targetSessionId?: string
      /** 编辑确认时冻结的源会话路由；普通新消息不传。 */
      routeSnapshot?: ChatRouteSnapshot
    },
  ): Promise<boolean> {
    // Shared canonical boundary: covers composer sends as well as edit/retry and
    // any future callers that bypass ChatInput's paste adapter.
    const intendedSessionId =
      options?.targetSessionId?.trim() || chatStore.currentSessionId?.trim() || ''
    if (intendedSessionId && chatStore.isSessionExecuting(intendedSessionId)) {
      return false
    }
    text = normalizeMathMarkdown(text)

    // Validate model selection before sending
    // model=undefined means "let backend decide" (Agent mode) — valid
    const model = chatStore.chatParams.model
    if (model !== undefined && model.trim() === '') {
      return false
    }

    // ✦ Layer 0 — slash command (`/cron add 30m "..."` / `/cron list` / 等)
    //   (D3.2：附件路径不走 slash，与 fast-path 同等约束)
    if (
      !options?.targetSessionId
      && !files?.length
      && !attachmentPreview.value
      && !parsedDocument.value
      && !options?.attachments?.length
    ) {
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
        scrollToBottom(true) // 用户发送瞬间无条件到底
        return true
      }
    }

    // ✦ 4 层 Intent Resolver — tier=1 fast-path 跳过 LLM，避开 tool_use_id 链路 bug
    //   (附件路径不走 fast-path：用户带文件的意图通常超出"纯创建任务"，留给 LLM)
    if (
      !options?.targetSessionId
      && !files?.length
      && !attachmentPreview.value
      && !parsedDocument.value
      && !options?.attachments?.length
    ) {
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
          scrollToBottom(true) // 用户发送瞬间无条件到底
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

    const toast = useToast()

    // 将附件转为 base64（支持多文件）
    // 预置附件（编辑/重试重发带回的原图片等，data 已是 base64/URL）置前，再叠加本次新上传。
    const attachments: ChatAttachment[] = options?.attachments?.length ? [...options.attachments] : []
    // 解析失败 / 无文本的文档名，循环后统一弹错。
    // 后端只接受图片附件（adapter.ValidateAttachments），文档绝不以二进制下发——
    // 否则必被后端拒绝并回「目前仅支持发送图片」的误导文案。
    const failedDocs: string[] = []
    const emptyDocs: string[] = []

    // 从旧的 attachmentPreview（兼容拖拽等路径）
    if (legacyAttachment) {
      const { file, type } = legacyAttachment
      if (type === 'image' || type === 'video') {
        const data = await fileToBase64(file)
        attachments.push({ type, name: file.name, mime: file.type, data })
      } else if (!legacyParsedDocument) {
        // 文档解析失败（handleFileUpload catch 后 parsedDocument 为 null）：绝不发二进制。
        failedDocs.push(file.name)
      } else if (!legacyParsedDocument.text.trim()) {
        // 解析成功但无文本（扫描件 / 纯图片 PDF）。
        emptyDocs.push(file.name)
      }
      // type==='file' 且已解析出文本：文本在下方 legacyParsedDocument 分支拼入正文。
    }

    // 从新的多文件参数：图片/视频作为 attachment，文档解析为文本（进隐藏上下文）+ 文件卡片
    const docTexts: string[] = []
    const documentRefs: ChatDocumentRef[] = []
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
          // 文档（PDF/TXT/DOCX 等）：本地解析提取文本拼入正文。
          // 解析失败/无文本一律记录后报错并跳过，绝不静默吞错降级成二进制附件
          // （后端只收图片，二进制必被拒，用户只会看到误导性的「仅支持图片」）。
          try {
            const parsed = await parseDocument(file)
            if (parsed.text.trim()) {
              const pageInfo = parsed.pageCount ? ` (${parsed.pageCount}页)` : ''
              docTexts.push(`[文件: ${parsed.fileName}${pageInfo}]\n\n${parsed.text}`)
              const docId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
              registerDocPreview(docId, file)
              documentRefs.push({ name: file.name, mime: file.type, size: file.size, id: docId })
            } else {
              emptyDocs.push(file.name)
            }
          } catch (err) {
            logger.error(`[chat] 文档解析失败：${file.name}: ${err instanceof Error ? err.message : String(err)}`)
            failedDocs.push(file.name)
          }
        }
      }
    }

    // 旧拖拽路径的已解析文档：同样进隐藏上下文 + 文件卡片。
    if (legacyParsedDocument && legacyParsedDocument.text.trim()) {
      const doc = legacyParsedDocument
      const pageInfo = doc.pageCount ? ` (${doc.pageCount}页)` : ''
      docTexts.unshift(`[文件: ${doc.fileName}${pageInfo}]\n\n${doc.text}`)
      if (legacyAttachment) {
        const docId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        registerDocPreview(docId, legacyAttachment.file)
        documentRefs.unshift({ name: doc.fileName, mime: legacyAttachment.file.type, size: legacyAttachment.file.size, id: docId })
      }
    }
    // ★ 文档正文只进**隐藏上下文**（backendText），不灌进可见气泡/可编辑正文。
    // 可见消息只保留用户文字 + 文件卡片（见下方 documents 透传）。
    const docContextBlock = docTexts.length > 0 ? docTexts.join('\n\n---\n\n') : ''
    const finalText = text

    // 文档解析失败 / 无文本：明确弹给用户（取代「静默吞错 + 后端误导性拒绝」）。
    for (const name of failedDocs) {
      toast.error(i18n.global.t('chat.parseDocFailed', { name }))
    }
    for (const name of emptyDocs) {
      toast.warning(i18n.global.t('chat.parseDocEmpty', { name }))
    }
    // 内容全部来自解析失败/无文本的文档（没有有效文本 / 图片 / 视频）→ 中止发送：
    // 既不向模型发空洞消息，也不丢用户已输入的内容（返回 false 时 ChatInput 不清空草稿）。
    const hasUsableContent = docTexts.length > 0 || attachments.length > 0
    if (!hasUsableContent && (failedDocs.length > 0 || emptyDocs.length > 0)) {
      return false
    }

    // ★ 隐藏上下文（只进 backendText、不进可见气泡）：附件文档正文 + @显式上下文。
    // ⚠️ 客户端 Auto-RAG 通道已删除（BUG-20260712-M，勿加回）：知识注入唯一来源=引擎侧
    // QueryHits（fail-closed，B8 + 降级态扩展），并回传结构化 knowledge_hits 渲染命中卡。
    // 此前这里用显式检索接口（宽召回）+ 0.35 门槛作用在组内 min-max 归一分上——最佳垃圾
    // 恒 1.0 必过（真机取证：天气 query 注入《Go面试题》），且与引擎注入对同一 query 重复。
    const explicitContextBlock = formatContextBlock(options?.contextRefs ?? [])
    const resolveBackendText = async (): Promise<string | undefined> => {
      const contextParts: string[] = []
      // 附件文档正文（PDF/DOCX/…）——气泡只显示文件卡片，正文走这里给模型。
      if (docContextBlock) {
        contextParts.push(`[附件文档内容 - 请基于以下文档回答用户问题]\n${docContextBlock}`)
      }
      // `@` 显式召唤的上下文（知识/连接/会话）：前置。
      if (explicitContextBlock) {
        contextParts.unshift(explicitContextBlock)
      }
      return contextParts.length > 0 ? `${contextParts.join('\n\n')}\n\n[用户问题]\n${finalText}` : undefined
    }
    // 注意：技能激活**不**经正文 @name 注入——`@skill` 会被后端当 mention/tool 致空回答。
    // skillNames 作为前向兼容字段透传，由专用激活通道处理（不写进 backendText）。

    // 深度思考是当前收件人的推理模式，不是改换收件人。已有绑定 Agent（含场景实例）必须保留，
    // 否则 sceneCtx/chips/placeholder 与 pinned_agent 会在发送瞬间一起漂移。
    // 只有没有显式/会话绑定收件人的普通 research 才使用通用 researcher。
    if (chatStore.chatMode === 'research') {
      if (!chatStore.agentRole) chatStore.agentRole = 'researcher'
    } else if (chatStore.agentRole === 'researcher') {
      chatStore.agentRole = ''
    }

    const previousMessageCount = Array.isArray(chatStore.messages) ? chatStore.messages.length : 0
    const skillNames = options?.skillNames ?? []
    // backendText 始终以 thunk 传入（Auto-RAG 始终尝试）；sendMessage 在乐观 push 后再 await 解析，
    // 解析为空则后端用可见文本（thunk 内 contextParts 为空时返回 undefined）。
    const sendOptions = {
      backendText: resolveBackendText,
      skillNames,
      documents: documentRefs.length ? documentRefs : undefined,
      targetSessionId: options?.targetSessionId,
      routeSnapshot: options?.routeSnapshot ?? captureRouteSnapshot?.(),
    }
    const sendPromise = chatStore.sendMessage(
      finalText,
      attachments.length > 0 ? attachments : undefined,
      sendOptions,
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
    scrollToBottom(true) // 用户发送瞬间无条件到底（即便此前上翻看历史）
    return true
  }

  return {
    handleSend,
    fileToBase64,
  }
}
