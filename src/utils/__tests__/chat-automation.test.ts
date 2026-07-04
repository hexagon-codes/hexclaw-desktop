import { describe, expect, it } from 'vitest'
import {
  buildConversationAutomationActions,
  getParsedDocumentContentFromMessage,
  type ConversationAutomationAction,
} from '../chat-automation'

type ActionByKind<T extends ConversationAutomationAction['kind']> = ConversationAutomationAction & {
  kind: T
}

function findAction<T extends ConversationAutomationAction['kind']>(
  actions: ConversationAutomationAction[],
  kind: T,
) {
  return actions.find((action): action is ActionByKind<T> => action.kind === kind)
}

describe('chat automation parser', () => {
  it('识别创建定时任务并解析中文时间', () => {
    const actions = buildConversationAutomationActions({
      userText: '增加一个自动收集整理实时热点新闻的任务，每天0点自动执行一次，整理的数据加入到知识库',
      assistantContent: '好的，我可以帮你整理热点。',
      sourceMessageId: 'user-1',
    })

    const action = findAction(actions, 'create_task')
    expect(action).toBeTruthy()
    expect(action?.payload.schedule).toBe('0 0 * * *')
    expect(action?.payload.name).toContain('自动收集整理实时热点新闻')
    expect(action?.payload.prompt).toContain('整理的数据加入到知识库')
    expect(findAction(actions, 'add_text_to_knowledge')).toBeUndefined()
  })

  it('识别将当前回答写入知识库', () => {
    const actions = buildConversationAutomationActions({
      userText: '把当前回答加入知识库',
      assistantContent: '这是整理后的要点总结',
      sourceMessageId: 'user-2',
    })

    const action = findAction(actions, 'add_text_to_knowledge')
    expect(action).toBeTruthy()
    expect(action?.payload.content).toBe('这是整理后的要点总结')
  })

  it('识别将解析后的附件写入知识库', () => {
    const actions = buildConversationAutomationActions({
      userText: '把这个文件加入知识库',
      assistantContent: '已读取附件。',
      sourceMessageId: 'user-3',
      attachment: {
        fileName: 'weekly-report.md',
        parsedText: '# weekly report',
      },
    })

    const action = findAction(actions, 'add_attachment_to_knowledge')
    expect(action).toBeTruthy()
    expect(action?.payload.title).toBe('weekly-report.md')
    expect(action?.payload.sourceMessageId).toBe('user-3')
  })

  it('识别知识库搜索和文档索引动作', () => {
    const actions = buildConversationAutomationActions({
      userText: '搜索知识库里关于“向量数据库”的内容，并重建索引文档“RAG 设计说明”',
      assistantContent: '',
      sourceMessageId: 'user-4',
    })

    const searchAction = findAction(actions, 'search_knowledge')
    const reindexAction = findAction(actions, 'reindex_document')

    expect(searchAction?.payload.query).toBe('向量数据库')
    expect(reindexAction?.payload.targetTitle).toBe('RAG 设计说明')
  })

  it('解析用户消息里的文档内容片段', () => {
    const parsed = getParsedDocumentContentFromMessage({
      id: 'msg-1',
      role: 'user',
      timestamp: '2026-03-22T00:00:00.000Z',
      content: '[文件: roadmap.md]\n\n第一段\n第二段\n\n---\n请帮我总结',
    })

    expect(parsed).toEqual({
      title: 'roadmap.md',
      content: '第一段\n第二段',
    })
  })
})

describe('BUG-20260703 GAP-5: 会话建任务生成的 cron 必须语法合法（分钟不越界）', () => {
  // scheduleFromPhrase 的 daily/weekly 分支调 toCronSchedule 后不过 isPlausibleCron，
  // "每天8点70分" → minute=70 → "70 8 * * *"（cron 分钟合法域 0-59，语法非法）逃到后端才报错。
  // 契约：会话确定性 fast-path 产出的 schedule 绝不能是语法非法的 cron——非法时间应让路
  //（不产 create_task 卡片），落 LLM 主路径澄清，而非把烂表达式塞给后端。
  function cronMinuteValid(schedule: string): boolean {
    const m = Number(schedule.trim().split(/\s+/)[0])
    return Number.isInteger(m) && m >= 0 && m <= 59
  }

  it('每天8点70分（非法分钟）→ 不产出语法非法的 create_task schedule', () => {
    const actions = buildConversationAutomationActions({
      userText: '增加一个采集科技新闻的任务，每天8点70分执行一次，写进知识库',
      assistantContent: '好的',
      sourceMessageId: 'user-gap5',
    })
    const action = findAction(actions, 'create_task')
    // action 为空（让路 LLM）也可接受——只要不产非法 schedule；
    // 无条件断言写法以满足 vitest/no-conditional-expect。
    expect(
      action == null || cronMinuteValid(action.payload.schedule),
      `GAP-5: 会话 fast-path 产出语法非法 cron: ${action?.payload.schedule}`,
    ).toBe(true)
  })

  it('每天8点66分（非法分钟）同样不得产出非法 cron', () => {
    const actions = buildConversationAutomationActions({
      userText: '增加一个采集新闻的任务，每天8点66分执行一次',
      assistantContent: '好的',
      sourceMessageId: 'user-gap5c',
    })
    const action = findAction(actions, 'create_task')
    expect(
      action == null || cronMinuteValid(action.payload.schedule),
      `GAP-5: ${action?.payload.schedule}`,
    ).toBe(true)
  })

  it('每天9点30分（合法）→ 正常产出 30 9 * * *', () => {
    const actions = buildConversationAutomationActions({
      userText: '增加一个采集科技新闻的任务，每天9点30分执行一次，写进知识库',
      assistantContent: '好的',
      sourceMessageId: 'user-gap5b',
    })
    const action = findAction(actions, 'create_task')
    expect(action?.payload.schedule).toBe('30 9 * * *')
  })
})
