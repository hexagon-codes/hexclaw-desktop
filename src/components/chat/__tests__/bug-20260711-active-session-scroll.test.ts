/**
 * BUG-20260711-G（复现→修复→锁定）：点智能体进入会话后「列表里看不到」，发消息收到回复后才出现。
 *
 * 真机取证（20260711，会话 4wWtKGn1Lh05「翻译官」）：会话 07-08 已存在，07-11 点击 agent
 * 走「复用已有会话」被正确选中——但其 updated_at 仍是三天前，条目排在「更早」分组视口外；
 * 发消息后 updated_at 刷新才跳进「今天」。即条目一直都在列表里，只是**选中后不滚动进视口**，
 * 用户视角=「不显示」。
 *
 * 根修：SessionList 监听 currentSessionId，选中变化时把活动条目 scrollIntoView（block:nearest），
 * 活动会话永远可见——不重排列表（保持按活跃时间分组的稳定心智）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { nextTick } from 'vue'
import SessionList from '../SessionList.vue'
import zhCN from '@/i18n/locales/zh-CN'
import { useChatStore } from '@/stores/chat'
import type { ChatSession } from '@/types'

vi.mock('@/api/chat', () => ({
  updateSessionTitle: vi.fn().mockResolvedValue({}),
  listSessions: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
  searchMessages: vi.fn().mockResolvedValue({ results: [], total: 0, query: '' }),
  listActiveStreams: vi.fn().mockResolvedValue({ streams: [], total: 0 }),
  getSessionBranches: vi.fn().mockResolvedValue({ branches: [], total: 0 }),
}))
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

function i18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })
}

function makeSessions(): ChatSession[] {
  // 30 条今天的会话把「更早」的老会话挤出视口 + 1 条三天前的老会话（翻译官场景）
  const today: ChatSession[] = Array.from({ length: 30 }, (_, i) => ({
    id: `s-today-${i}`,
    title: `今日会话 ${i}`,
    created_at: '2026-07-11T10:00:00Z',
    updated_at: '2026-07-11T10:00:00Z',
    message_count: 2,
  } as ChatSession))
  const old: ChatSession = {
    id: 's-old-translator',
    title: '翻译官',
    created_at: '2026-07-08T21:11:46Z',
    updated_at: '2026-07-08T21:11:46Z',
    message_count: 1,
  } as ChatSession
  return [...today, old]
}

describe('BUG-20260711-G：选中会话必须滚动进视口（活动会话永远可见）', () => {
  let scrollSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // jsdom 无 scrollIntoView 实现，先补桩再 spy
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {}
    }
    scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
  })
  afterEach(() => scrollSpy.mockRestore())

  function mountList() {
    document.body.innerHTML = ''
    const pinia = createPinia()
    setActivePinia(pinia)
    const chat = useChatStore()
    chat.sessions = makeSessions()
    // attachTo：滚动逻辑走 document.querySelector，组件必须真实挂进 document
    const w = mount(SessionList, {
      global: { plugins: [pinia, i18n()], stubs: { ContextMenu: { template: '<div/>' } } },
      attachTo: document.body,
    })
    return { chat, w }
  }

  it('★currentSessionId 切到「更早」分组的老会话 → 该条目 scrollIntoView', async () => {
    const { chat } = mountList()
    chat.currentSessionId = 's-today-0'
    await nextTick()
    scrollSpy.mockClear()

    chat.currentSessionId = 's-old-translator' // = 点击 agent 复用老会话被选中
    await nextTick()
    await nextTick() // watcher 内部 nextTick 后才查 DOM

    const scrolledIds = scrollSpy.mock.instances.map(
      (el: unknown) => (el as HTMLElement).getAttribute?.('data-session-id'),
    )
    expect(scrolledIds, '活动条目必须被 scrollIntoView（否则老会话选中后在视口外=「列表里不显示」')
      .toContain('s-old-translator')
  })

  it('清空选中（新建空白会话）→ 不触发滚动（无目标不乱滚）', async () => {
    const { chat } = mountList()
    chat.currentSessionId = 's-old-translator'
    await nextTick()
    await nextTick()
    scrollSpy.mockClear()

    chat.currentSessionId = null
    await nextTick()
    await nextTick()
    expect(scrollSpy).not.toHaveBeenCalled()
  })
})
