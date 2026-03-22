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
