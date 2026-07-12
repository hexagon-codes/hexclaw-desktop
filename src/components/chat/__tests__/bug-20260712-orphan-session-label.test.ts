/**
 * BUG-20260712-治标（复现→修复→锁定）：智能体删除后，其存量会话在列表里裸显内部 ID
 * （如 `k12-tutor-2O99CPr_`）——治本（标题快照显示名）只保护新会话，存量会话需要孤儿态兜底。
 *
 * 根修三件套：
 *  ① session-agent-binding 墓碑化：BUG-20260710 守卫从「清绑定」改为「标记孤儿」
 *     （getSessionAgent 对墓碑返回空=发送/恢复语义不变；getSessionAgentTombstone 供显示层取名）；
 *  ② scenarioRegistry 实例名模式：场景包注册内部名 pattern（K12：`k12-tutor-*`），
 *     shell 零场景知识地识别「标题=某场景实例内部名」的遗留孤儿（绑定早已被旧守卫清掉的场景）；
 *  ③ SessionList.sessionTitle：命中孤儿信号且标题未被手动改名 → 显示「已删除的智能体」。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import SessionList from '../SessionList.vue'
import zhCN from '@/i18n/locales/zh-CN'
import { useChatStore } from '@/stores/chat'
import { useAgentsStore } from '@/stores/agents'
import {
  bindSessionAgent,
  getSessionAgent,
  getSessionAgentTombstone,
  markSessionAgentOrphaned,
} from '@/stores/session-agent-binding'
import { scenarioRegistry } from '@/shell/scenario/registry'
import { registerK12Scenario } from '@/features/k12/register'
import type { ChatSession } from '@/types'

// 真实装配 K12 场景包（幂等）——顺带验证 register.ts 注册了实例名 pattern
registerK12Scenario()

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

function session(id: string, title: string): ChatSession {
  return { id, title, created_at: '2026-07-08T10:00:00Z', updated_at: '2026-07-08T10:00:00Z', message_count: 3 } as ChatSession
}

function mountList(sessions: ChatSession[]) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const chat = useChatStore()
  const agents = useAgentsStore()
  agents.registeredAgents = [] as never // 所有 agent 已删除
  agents.agentsLoaded = true
  chat.sessions = sessions
  return mount(SessionList, {
    global: { plugins: [pinia, i18n()], stubs: { ContextMenu: { template: '<div/>' } } },
  })
}

describe('BUG-20260712：孤儿会话必须显示「已删除的智能体」而非裸内部 ID', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('★墓碑绑定：BUG-20260710 守卫标记孤儿后（绑定→墓碑），列表显示孤儿文案', () => {
    bindSessionAgent('s-1', 'translator-abc')
    markSessionAgentOrphaned('s-1')
    const w = mountList([session('s-1', 'translator-abc')])
    const title = w.find('.hc-sessions__title').text()
    expect(title).not.toContain('translator-abc')
    expect(title).toContain('已删除的智能体')
  })

  it('★遗留场景孤儿（绑定已被旧守卫清掉）：标题命中场景实例名 pattern → 孤儿文案', () => {
    // K12 场景包注册的实例名 pattern（register.ts），shell 据 registry 识别、零场景知识
    expect(scenarioRegistry.matchesInstanceId('k12-tutor-2O99CPr_'), '前置：registry 能识别 K12 实例名').toBe(true)
    const w = mountList([session('s-2', 'k12-tutor-2O99CPr_')])
    const title = w.find('.hc-sessions__title').text()
    expect(title, '裸内部 ID 是技术泄漏，家长看不懂').not.toContain('k12-tutor-2O99CPr_')
    expect(title).toContain('已删除的智能体')
  })

  it('对照：手动改过名的孤儿会话保留自定义标题（用户资产优先）', () => {
    bindSessionAgent('s-3', 'translator-abc')
    markSessionAgentOrphaned('s-3')
    const w = mountList([session('s-3', '周三翻译练习')])
    expect(w.find('.hc-sessions__title').text()).toBe('周三翻译练习')
  })

  it('对照：普通会话（无关联、标题非实例名）零影响', () => {
    const w = mountList([session('s-4', '写一首关于月亮的诗')])
    expect(w.find('.hc-sessions__title').text()).toBe('写一首关于月亮的诗')
  })

  it('墓碑语义：getSessionAgent 返回空（发送/恢复不再用死 role），tombstone 单独可取，重绑覆盖墓碑', () => {
    bindSessionAgent('s-5', 'k12-tutor-x')
    markSessionAgentOrphaned('s-5')
    expect(getSessionAgent('s-5'), '墓碑不得再作为活绑定恢复').toBe('')
    expect(getSessionAgentTombstone('s-5')).toBe('k12-tutor-x')
    bindSessionAgent('s-5', 'k12-tutor-y') // 用户重建/重绑 → 墓碑被活绑定覆盖
    expect(getSessionAgent('s-5')).toBe('k12-tutor-y')
    expect(getSessionAgentTombstone('s-5')).toBe('')
  })
})
