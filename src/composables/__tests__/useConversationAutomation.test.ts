import { describe, it, expect, vi } from 'vitest'

// Test the pure utility functions exported from useConversationAutomation
// The composable itself requires reactive deps, but the logic functions are testable directly

vi.mock('@/api/tasks', () => ({
  createCronJob: vi.fn(), deleteCronJob: vi.fn(), getCronJobs: vi.fn(),
  pauseCronJob: vi.fn(), resumeCronJob: vi.fn(), triggerCronJob: vi.fn(),
}))
vi.mock('@/api/knowledge', () => ({
  addDocument: vi.fn(), deleteDocument: vi.fn(), getDocuments: vi.fn(),
  reindexDocument: vi.fn(), searchKnowledge: vi.fn(),
}))
vi.mock('@/utils/chat-automation', () => ({
  CHAT_AUTOMATION_METADATA_KEY: 'conversation_actions',
  buildConversationAutomationActions: vi.fn().mockReturnValue([]),
  getConversationAutomationActions: vi.fn().mockReturnValue([]),
  getParsedDocumentContentFromMessage: vi.fn().mockReturnValue(null),
}))

// Import after mocks
import { useConversationAutomation } from '../useConversationAutomation'

function makeMockStore() {
  return {
    messages: [] as any[],
    updateMessage: vi.fn().mockResolvedValue(null),
  }
}

function makeMockToast() {
  return { success: vi.fn(), error: vi.fn() }
}

describe('useConversationAutomation', () => {
  it('clipAutomationText truncates long text', () => {
    const store = makeMockStore()
    const toast = makeMockToast()
    const { clipAutomationText } = useConversationAutomation(store as any, toast as any)
    const long = 'a'.repeat(200)
    expect(clipAutomationText(long, 10)).toBe('a'.repeat(10) + '...')
  })

  it('clipAutomationText returns short text unchanged', () => {
    const { clipAutomationText } = useConversationAutomation(makeMockStore() as any, makeMockToast() as any)
    expect(clipAutomationText('hello')).toBe('hello')
  })

  it('getVisibleConversationActions filters dismissed', async () => {
    const { getVisibleConversationActions } = useConversationAutomation(makeMockStore() as any, makeMockToast() as any)
    const chatAutomation = await import('@/utils/chat-automation')
    const mock = vi.mocked(chatAutomation.getConversationAutomationActions)
    mock.mockReturnValueOnce([
      { id: '1', status: 'pending', kind: 'search_knowledge' } as any,
      { id: '2', status: 'dismissed', kind: 'create_task' } as any,
      { id: '3', status: 'completed', kind: 'add_text_to_knowledge' } as any,
    ])
    const visible = getVisibleConversationActions({ id: 'm1', role: 'assistant', content: '', timestamp: '' })
    expect(visible).toHaveLength(2)
    expect(visible.every((a: any) => a.status !== 'dismissed')).toBe(true)
  })

  it('automationStatusLabel returns correct labels', () => {
    const { automationStatusLabel } = useConversationAutomation(makeMockStore() as any, makeMockToast() as any)
    expect(automationStatusLabel('running')).toBe('执行中')
    expect(automationStatusLabel('completed')).toBe('已完成')
    expect(automationStatusLabel('failed')).toBe('失败')
    expect(automationStatusLabel('dismissed')).toBe('已忽略')
    expect(automationStatusLabel('pending')).toBe('待确认')
  })

  it('automationExecuteLabel returns retry for failed actions', () => {
    const { automationExecuteLabel } = useConversationAutomation(makeMockStore() as any, makeMockToast() as any)
    expect(automationExecuteLabel({ status: 'failed', kind: 'create_task' } as any)).toBe('重试')
  })

  it('automationExecuteLabel returns kind-specific labels', () => {
    const { automationExecuteLabel } = useConversationAutomation(makeMockStore() as any, makeMockToast() as any)
    expect(automationExecuteLabel({ status: 'pending', kind: 'create_task' } as any)).toBe('创建任务')
    expect(automationExecuteLabel({ status: 'pending', kind: 'search_knowledge' } as any)).toBe('执行搜索')
    expect(automationExecuteLabel({ status: 'pending', kind: 'add_text_to_knowledge' } as any)).toBe('写入知识库')
    expect(automationExecuteLabel({ status: 'pending', kind: 'delete_document' } as any)).toBe('删除文档')
  })
})
