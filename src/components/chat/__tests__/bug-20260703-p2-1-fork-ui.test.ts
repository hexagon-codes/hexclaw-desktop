/**
 * BUG-20260703 P2-1 — 会话 fork 补 UI 入口（此前后端/前端 api 全齐备、零 UI 触点）。
 *
 * 链路：MessageActions「由此分叉」按钮 → useChatActions.handleFork →
 * POST /sessions/{id}/fork（分支点 = 该消息，live 消息经 backend_message_id 解析）→
 * loadSessions + selectSession 切到新分支 → SessionList 用 parent_session_id 渲染
 * 分支徽标（messageService.loadAllSessions 透传该字段）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import MessageActions from '../MessageActions.vue'
import zhCN from '@/i18n/locales/zh-CN'

const { forkSession } = vi.hoisted(() => ({
  forkSession: vi.fn(),
}))
vi.mock('@/api/chat', () => ({ forkSession }))
vi.mock('@/services/messageService', () => ({ removeMessage: vi.fn() }))
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

import { useChatActions } from '@/composables/useChatActions'

function makeToast() {
  return { success: vi.fn(), error: vi.fn() }
}

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    messages: [
      { id: 'u1', role: 'user', content: 'hello', timestamp: '' },
      { id: 'live-a1', role: 'assistant', content: 'hi', timestamp: '', metadata: { backend_message_id: 'be-9' } },
    ],
    currentSessionId: 's-1',
    streaming: false,
    chatParams: { model: 'gpt-4' },
    loadSessions: vi.fn().mockResolvedValue(undefined),
    selectSession: vi.fn().mockResolvedValue(undefined),
    setMessageFeedback: vi.fn(),
    ...overrides,
  }
}

describe('BUG-20260703 P2-1 — handleFork 行为', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    forkSession.mockResolvedValue({ session: { id: 'branch-1', title: '分支' }, message: 'ok' })
  })

  it('分叉成功：以 backend_message_id 为分支点 → 刷新列表并切到新分支', async () => {
    const store = makeStore()
    const toast = makeToast()
    const { handleFork } = useChatActions(store as never, toast as never, vi.fn())
    await handleFork(1)

    expect(forkSession).toHaveBeenCalledWith('s-1', 'be-9')
    expect(store.loadSessions).toHaveBeenCalled()
    expect(store.selectSession).toHaveBeenCalledWith('branch-1')
    expect(toast.success).toHaveBeenCalled()
  })

  it('重载消息（无 backend_message_id 元数据）直接用消息 id 作分支点', async () => {
    const store = makeStore()
    store.messages[1] = { id: 'be-77', role: 'assistant', content: 'hi', timestamp: '', metadata: {} } as never
    const { handleFork } = useChatActions(store as never, makeToast() as never, vi.fn())
    await handleFork(1)
    expect(forkSession).toHaveBeenCalledWith('s-1', 'be-77')
  })

  it('流式中拦截：不发 fork 请求、toast 提示', async () => {
    const store = makeStore({ streaming: true })
    const toast = makeToast()
    const { handleFork } = useChatActions(store as never, toast as never, vi.fn())
    await handleFork(1)
    expect(forkSession).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
  })

  it('fork 失败：toast 报错、不切会话', async () => {
    forkSession.mockRejectedValue(new Error('boom-fork'))
    const store = makeStore()
    const toast = makeToast()
    const { handleFork } = useChatActions(store as never, toast as never, vi.fn())
    await handleFork(1)
    expect(store.selectSession).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('boom-fork')
  })
})

describe('BUG-20260703 P2-1 — MessageActions 分支菜单项', () => {
  it('assistant 把创建分支收进原型 More 菜单；user 菜单无此项', async () => {
    const i18n = createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })
    const w = mount(MessageActions, {
      props: { role: 'assistant', content: 'hi' },
      global: { plugins: [i18n] },
    })
    const btn = w.find('[data-testid="message-fork"]')
    expect(btn.exists()).toBe(true)
    expect(w.find('.hc-msg-actions > [data-testid="message-fork"]').exists()).toBe(false)
    await w.get('[data-testid="message-more"]').trigger('click')
    expect(btn.text()).toContain('创建分支')
    await btn.trigger('click')
    expect(w.emitted('fork')).toHaveLength(1)

    const wu = mount(MessageActions, {
      props: { role: 'user', content: 'hello' },
      global: { plugins: [i18n] },
    })
    expect(wu.find('[data-testid="message-fork"]').exists()).toBe(false)
  })
})
