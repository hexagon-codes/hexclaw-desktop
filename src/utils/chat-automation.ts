import { nanoid } from 'nanoid'
import type { ChatMessage } from '@/types'

export const CHAT_AUTOMATION_METADATA_KEY = 'conversation_actions'

export type ConversationAutomationActionStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'dismissed'

export interface ConversationAutomationResultItem {
  title: string
  subtitle?: string
  content?: string
}

export interface ConversationAutomationResult {
  summary: string
  items?: ConversationAutomationResultItem[]
}

interface ConversationAutomationActionBase {
  id: string
  title: string
  description: string
  status: ConversationAutomationActionStatus
  result?: ConversationAutomationResult
  error?: string
}

export interface CreateTaskAction extends ConversationAutomationActionBase {
  kind: 'create_task'
  payload: {
    name: string
    schedule: string
    prompt: string
  }
}

export interface TaskTargetAction extends ConversationAutomationActionBase {
  kind: 'pause_task' | 'resume_task' | 'trigger_task' | 'delete_task'
  payload: {
    targetName: string
  }
}

export interface AddTextToKnowledgeAction extends ConversationAutomationActionBase {
  kind: 'add_text_to_knowledge'
  payload: {
    title: string
    content: string
    source?: string
  }
}

export interface AddAttachmentToKnowledgeAction extends ConversationAutomationActionBase {
  kind: 'add_attachment_to_knowledge'
  payload: {
    title: string
    sourceMessageId: string
    source?: string
  }
}

export interface SearchKnowledgeAction extends ConversationAutomationActionBase {
  kind: 'search_knowledge'
  payload: {
    query: string
    topK: number
  }
}

export interface DocumentTargetAction extends ConversationAutomationActionBase {
  kind: 'reindex_document' | 'delete_document'
  payload: {
    targetTitle: string
  }
}

export interface SaveMemoryAction extends ConversationAutomationActionBase {
  kind: 'save_memory'
  payload: {
    content: string
    type?: string
    source?: string
  }
}

export type ConversationAutomationAction =
  | CreateTaskAction
  | TaskTargetAction
  | AddTextToKnowledgeAction
  | AddAttachmentToKnowledgeAction
  | SearchKnowledgeAction
  | DocumentTargetAction
  | SaveMemoryAction

export interface ConversationAutomationParseInput {
  userText: string
  assistantContent?: string
  sourceMessageId: string
  attachment?: {
    fileName: string
    parsedText?: string
  } | null
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function trimEdgePunctuation(value: string): string {
  return value
    .replace(/^[\s"'“”'‘’:：,，。.!！？；;()（）【】[-]+/, '')
    .replace(/[\s"'“”'‘’:：,，。.!！？；;()（）【】[-]+$/, '')
    .trim()
}

function normalizeComparable(value: string): string {
  return collapseWhitespace(value).toLowerCase()
}

function clipTitle(value: string, maxLength = 28): string {
  const normalized = collapseWhitespace(value)
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength)}...`
}

function extractQuotedText(text: string): string | null {
  const match = text.match(/["“”'‘’]([^"“”'‘’]{1,120})["“”'‘’]/)
  return match ? trimEdgePunctuation(match[1] || '') : null
}

function scheduleFromPhrase(text: string): { schedule: string; fragment: string } | null {
  const explicitInterval = text.match(/@every\s*\d+\s*[smhd]/i)
  if (explicitInterval?.[0]) {
    return { schedule: explicitInterval[0].replace(/\s+/g, ' '), fragment: explicitInterval[0] }
  }

  const preset = text.match(/@(daily|hourly|weekly|monthly|yearly)/i)
  if (preset?.[0]) {
    return { schedule: preset[0].toLowerCase(), fragment: preset[0] }
  }

  const cron = text.match(/\b(?:[\d*/,?-]+\s+){4}[\d*/,?-]+\b/)
  if (cron?.[0]) {
    return { schedule: cron[0], fragment: cron[0] }
  }

  const everyMinute = text.match(/每\s*(\d+)\s*(分钟|分)\b/)
  if (everyMinute?.[1]) {
    return {
      schedule: `@every ${everyMinute[1]}m`,
      fragment: everyMinute[0],
    }
  }

  const everyHour = text.match(/每\s*(\d+)\s*(小时|时)\b/)
  if (everyHour?.[1]) {
    return {
      schedule: `@every ${everyHour[1]}h`,
      fragment: everyHour[0],
    }
  }

  if (/(每小时|每个小时)/.test(text)) {
    return { schedule: '@every 1h', fragment: '每小时' }
  }

  const daily = text.match(
    /(每天|每日)(凌晨|早上|上午|中午|下午|晚上|夜里|傍晚)?\s*(\d{1,2})\s*点(?:\s*(\d{1,2})\s*分)?/,
  )
  if (daily?.[0] && daily[3]) {
    return {
      schedule: toCronSchedule(daily[3], daily[4], daily[2], '*'),
      fragment: daily[0],
    }
  }

  const weekly = text.match(
    /每周([一二三四五六日天])(凌晨|早上|上午|中午|下午|晚上|夜里|傍晚)?\s*(\d{1,2})\s*点(?:\s*(\d{1,2})\s*分)?/,
  )
  if (weekly?.[0] && weekly[1] && weekly[3]) {
    return {
      schedule: toCronSchedule(weekly[3], weekly[4], weekly[2], weekdayToCron(weekly[1])),
      fragment: weekly[0],
    }
  }

  return null
}

function weekdayToCron(day: string): string {
  switch (day) {
    case '一':
      return '1'
    case '二':
      return '2'
    case '三':
      return '3'
    case '四':
      return '4'
    case '五':
      return '5'
    case '六':
      return '6'
    case '日':
    case '天':
      return '0'
    default:
      return '*'
  }
}

function toCronSchedule(
  hourRaw: string,
  minuteRaw?: string,
  period?: string,
  dayOfWeek = '*',
): string {
  let hour = Number.parseInt(hourRaw, 10)
  const minute = Number.parseInt(minuteRaw || '0', 10)
  if (Number.isNaN(hour) || Number.isNaN(minute)) return '0 0 * * *'
  if ((period === '下午' || period === '晚上' || period === '夜里' || period === '傍晚') && hour < 12) {
    hour += 12
  }
  if (period === '中午' && hour < 11) {
    hour += 12
  }
  if (hour >= 24) hour = hour % 24
  return `${minute} ${hour} * * ${dayOfWeek}`
}

function extractTaskName(text: string): string | null {
  const quoted = extractQuotedText(text)
  if (quoted) return clipTitle(quoted)

  const match = text.match(
    /(?:创建|新建|添加|增加|安排|设置)(?:一个|一下|个)?(.{1,48}?)(?:的)?(?:定时)?任务/,
  )
  if (match?.[1]) return clipTitle(trimEdgePunctuation(match[1]))
  return null
}

function buildTaskPrompt(text: string, scheduleFragment?: string): string {
  let prompt = text
  if (scheduleFragment) {
    prompt = prompt.replace(scheduleFragment, ' ')
  }
  prompt = prompt
    .replace(/^(请)?(帮我|给我|麻烦)?\s*/, '')
    .replace(/(创建|新建|添加|增加|安排|设置)(一个|一下|个)?/g, ' ')
    .replace(/(?:定时)?任务/g, ' ')
    .replace(/自动执行一次/g, ' ')
    .replace(/[，,。.!！？；;]+/g, ' ')

  const normalized = collapseWhitespace(prompt)
  return normalized || '按对话要求执行任务'
}

function createAction<T extends ConversationAutomationAction>(
  action: Omit<T, 'id' | 'status'>,
): T {
  return {
    ...action,
    id: nanoid(8),
    status: 'pending',
  } as T
}

function maybeCreateTaskAction(text: string): CreateTaskAction | null {
  const hasTaskIntent = /(?:创建|新建|添加|增加|安排|设置).*(?:定时)?任务|(?:定时|周期).{0,12}(?:执行|运行)/.test(
    text,
  )
  if (!hasTaskIntent) return null

  const schedule = scheduleFromPhrase(text)
  if (!schedule) return null

  const name = extractTaskName(text) || clipTitle(buildTaskPrompt(text, schedule.fragment))
  const prompt = buildTaskPrompt(text, schedule.fragment)

  return createAction<CreateTaskAction>({
    kind: 'create_task',
    title: '创建定时任务',
    description: `${name} · ${schedule.schedule}`,
    payload: {
      name,
      schedule: schedule.schedule,
      prompt,
    },
  })
}

function extractTaskTargetName(text: string): string | null {
  const quoted = extractQuotedText(text)
  if (quoted) return quoted

  const afterTask = text.match(/任务[：: ]*([^\n，。！？]+)/)
  if (afterTask?.[1]) {
    return trimEdgePunctuation(afterTask[1].replace(/^(名为|叫做|叫)\s*/, ''))
  }

  const beforeTask = text.match(/(?:暂停|恢复|继续|启用|停用|删除|移除|立即执行|马上执行|现在执行|触发)([^，。！？\n]{1,40})任务/)
  if (beforeTask?.[1]) {
    return trimEdgePunctuation(beforeTask[1].replace(/^(把|将)\s*/, ''))
  }

  return null
}

function maybeCreateTaskTargetAction(text: string): TaskTargetAction | null {
  if (!/任务/.test(text)) return null

  const targetName = extractTaskTargetName(text)
  if (!targetName) return null

  if (/(暂停|停用|关闭)/.test(text)) {
    return createAction<TaskTargetAction>({
      kind: 'pause_task',
      title: '暂停任务',
      description: `任务：${targetName}`,
      payload: { targetName },
    })
  }

  if (/(恢复|继续|启用)/.test(text)) {
    return createAction<TaskTargetAction>({
      kind: 'resume_task',
      title: '恢复任务',
      description: `任务：${targetName}`,
      payload: { targetName },
    })
  }

  if (/(立即执行|马上执行|现在执行|触发|运行一下)/.test(text)) {
    return createAction<TaskTargetAction>({
      kind: 'trigger_task',
      title: '立即执行任务',
      description: `任务：${targetName}`,
      payload: { targetName },
    })
  }

  if (/(删除|移除)/.test(text)) {
    return createAction<TaskTargetAction>({
      kind: 'delete_task',
      title: '删除任务',
      description: `任务：${targetName}`,
      payload: { targetName },
    })
  }

  return null
}

function maybeCreateSearchKnowledgeAction(text: string): SearchKnowledgeAction | null {
  const hasIntent = /(搜索知识库|查询知识库|查一下知识库|从知识库(?:里)?找|在知识库(?:里)?(?:搜索|查询|查找))/.test(
    text,
  )
  if (!hasIntent) return null

  const quoted = extractQuotedText(text)
  const queryFromSuffix = text
    .replace(/.*(?:搜索知识库|查询知识库|查一下知识库|从知识库(?:里)?找|在知识库(?:里)?(?:搜索|查询|查找))/, '')
    .replace(/^(关于|里|中|有没有|是否有)\s*/, '')
  const query = collapseWhitespace(quoted || trimEdgePunctuation(queryFromSuffix))
  if (!query) return null

  return createAction<SearchKnowledgeAction>({
    kind: 'search_knowledge',
    title: '搜索知识库',
    description: `关键词：${clipTitle(query, 36)}`,
    payload: {
      query,
      topK: 5,
    },
  })
}

function makeKnowledgeTitle(text: string): string {
  const firstLine = collapseWhitespace(text.split('\n')[0] || '')
  return clipTitle(firstLine || '会话整理记录', 32)
}

function maybeCreateAddKnowledgeAction(
  text: string,
  assistantContent: string,
): AddTextToKnowledgeAction | null {
  const hasIntent = /(加入|写入|导入|保存|存入|收录).{0,4}知识库|知识库.{0,4}(加入|写入|导入|保存|存入|收录)/.test(
    text,
  )
  if (!hasIntent) return null

  const explicitText = extractQuotedText(text)
  const refersReply = /(上面的结果|上述内容|当前回答|这条回复|这个回答|本次总结|刚才的结果)/.test(text)
  const content = explicitText || (refersReply ? assistantContent.trim() : '')
  if (!content) return null

  return createAction<AddTextToKnowledgeAction>({
    kind: 'add_text_to_knowledge',
    title: '写入知识库',
    description: clipTitle(content, 42),
    payload: {
      title: makeKnowledgeTitle(content),
      content,
      source: 'chat-conversation',
    },
  })
}

function maybeCreateAttachmentKnowledgeAction(
  text: string,
  sourceMessageId: string,
  attachment?: ConversationAutomationParseInput['attachment'],
): AddAttachmentToKnowledgeAction | null {
  if (!attachment?.parsedText?.trim()) return null
  const hasIntent = /(加入|写入|导入|保存|存入|收录|上传).{0,4}(知识库|入库)|(知识库|入库).{0,4}(加入|写入|导入|保存|存入|收录|上传)/.test(
    text,
  )
  if (!hasIntent) return null

  return createAction<AddAttachmentToKnowledgeAction>({
    kind: 'add_attachment_to_knowledge',
    title: '将附件写入知识库',
    description: attachment.fileName,
    payload: {
      title: attachment.fileName,
      sourceMessageId,
      source: 'chat-attachment',
    },
  })
}

function extractDocumentTarget(text: string): string | null {
  const explicit = text.match(/文档["“”'‘’]([^"“”'‘’]{1,120})["“”'‘’]/)
  if (explicit?.[1]) return trimEdgePunctuation(explicit[1])

  const quoted = extractQuotedText(text)
  if (quoted) return quoted

  const match = text.match(/(?:文档|知识库)[：: ]*([^\n，。！？]+)/)
  if (match?.[1]) return trimEdgePunctuation(match[1])
  return null
}

function maybeCreateDocumentTargetAction(text: string): DocumentTargetAction | null {
  if (!/(知识库|文档)/.test(text)) return null

  const targetTitle = extractDocumentTarget(text)
  if (!targetTitle) return null

  if (/(重建索引|重新索引|reindex)/i.test(text)) {
    return createAction<DocumentTargetAction>({
      kind: 'reindex_document',
      title: '重建知识文档索引',
      description: `文档：${targetTitle}`,
      payload: { targetTitle },
    })
  }

  if (/(删除|移除)/.test(text)) {
    return createAction<DocumentTargetAction>({
      kind: 'delete_document',
      title: '删除知识文档',
      description: `文档：${targetTitle}`,
      payload: { targetTitle },
    })
  }

  return null
}

// ─── Memory auto-extraction ──────────────────────────────

/**
 * Detect memory-worthy content in user messages.
 *
 * Two modes:
 * 1. Explicit: user says "记住/remember" → extract the fact
 * 2. Implicit: user states identity/preference patterns → extract concisely
 */
function maybeCreateSaveMemoryAction(
  text: string,
  assistantContent?: string,
): SaveMemoryAction | null {
  // Explicit: "记住 ..." / "请记住 ..." / "remember ..."
  const explicit = text.match(
    /(?:请?记住|帮我记住|记一下|remember(?:\s+that)?)\s*[：:,，]?\s*(.{2,120})/i,
  )
  if (explicit?.[1]) {
    const content = trimEdgePunctuation(explicit[1])
    if (content) {
      return createAction<SaveMemoryAction>({
        kind: 'save_memory',
        title: '保存到记忆',
        description: clipTitle(content, 42),
        payload: { content, source: 'chat_explicit' },
      })
    }
  }

  // Implicit: identity / preference / fact patterns
  const patterns: { re: RegExp; type: string; extract: (m: RegExpMatchArray) => string | null }[] = [
    { re: /(?:^|[，,。.；;！!？?\s])我是(.{2,60})$/,      type: 'identity',   extract: (m) => `用户是${trimEdgePunctuation(m[1]!)}` },
    { re: /我(?:偏好|喜欢|习惯)(.{2,60})$/,              type: 'preference', extract: (m) => `用户偏好${trimEdgePunctuation(m[1]!)}` },
    { re: /i\s+prefer\s+(.{2,60})$/i,                   type: 'preference', extract: (m) => `User prefers ${m[1]!.trim()}` },
    { re: /我(?:的名字|叫)(.{1,20})/,                    type: 'identity',   extract: (m) => `用户名字: ${trimEdgePunctuation(m[1]!)}` },
    { re: /(?:my name is|i'm|i am)\s+([A-Z][\w\s]{1,20})/i, type: 'identity', extract: (m) => `User name: ${m[1]!.trim()}` },
    { re: /我(?:在|用|使用)(.{2,40})(?:工作|开发|写代码|编程)/, type: 'fact',  extract: (m) => `用户${trimEdgePunctuation(m[0]!)}` },
  ]

  for (const { re, type, extract } of patterns) {
    const match = text.match(re)
    if (match) {
      const content = extract(match)
      if (content) {
        return createAction<SaveMemoryAction>({
          kind: 'save_memory',
          title: '保存到记忆',
          description: clipTitle(content, 42),
          payload: { content, type, source: 'chat_extract' },
        })
      }
    }
  }

  // AI-confirmed: if the assistant response indicates it will remember something
  if (assistantContent) {
    const aiConfirm = assistantContent.match(
      /(?:我(?:已经)?记住了|好的.*?记住|I['']ll remember|noted|got it.*?remember)\s*[：:,，]?\s*(.{2,80})/i,
    )
    if (aiConfirm?.[1]) {
      const content = trimEdgePunctuation(aiConfirm[1])
      if (content) {
        return createAction<SaveMemoryAction>({
          kind: 'save_memory',
          title: '保存到记忆',
          description: clipTitle(content, 42),
          payload: { content, source: 'chat_extract' },
        })
      }
    }
  }

  return null
}

export function buildConversationAutomationActions(
  input: ConversationAutomationParseInput,
): ConversationAutomationAction[] {
  const text = collapseWhitespace(input.userText)
  if (!text) return []

  const unique = new Map<string, ConversationAutomationAction>()
  const add = (action: ConversationAutomationAction | null) => {
    if (!action) return
    const key = `${action.kind}:${normalizeComparable(action.description)}`
    if (!unique.has(key)) unique.set(key, action)
  }

  const taskCreate = maybeCreateTaskAction(text)
  add(taskCreate)
  add(maybeCreateTaskTargetAction(text))
  add(maybeCreateSearchKnowledgeAction(text))
  add(maybeCreateDocumentTargetAction(text))

  if (!taskCreate) {
    add(maybeCreateAttachmentKnowledgeAction(text, input.sourceMessageId, input.attachment))
    add(maybeCreateAddKnowledgeAction(text, input.assistantContent || ''))
  }

  add(maybeCreateSaveMemoryAction(text, input.assistantContent))

  return [...unique.values()]
}

function isAutomationAction(value: unknown): value is ConversationAutomationAction {
  return !!value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string'
}

export function getConversationAutomationActions(message: ChatMessage): ConversationAutomationAction[] {
  const raw = message.metadata?.[CHAT_AUTOMATION_METADATA_KEY]
  return Array.isArray(raw) ? raw.filter(isAutomationAction) : []
}

export function getParsedDocumentContentFromMessage(
  message: ChatMessage | undefined,
): { content: string; title: string } | null {
  if (!message?.content) return null
  const match = message.content.match(/^\[文件:\s*(.+?)\]\n\n([\s\S]+?)\n\n---\n/)
  if (!match?.[1] || !match[2]) return null
  return {
    title: match[1],
    content: match[2].trim(),
  }
}
