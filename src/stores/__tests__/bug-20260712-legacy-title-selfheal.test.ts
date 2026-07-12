/**
 * BUG-20260712-治本终章（复现→修复→锁定）：存量会话「标题=agent 内部名」的脏数据自愈。
 *
 * 背景：治本（建会话即快照显示名）只保护新会话；存量会话仍靠**运行时反查**显示可读名——
 * agent 一删就只剩「已删除的智能体」泛化兜底（信息已销毁，恢复不了「小明的辅导助手」）。
 * 真正的治本：趁 agent 还活着，把内部名标题**一次性落库为显示名**（运行时反查 → 持久快照），
 * 并补写 session→agent 绑定（未来删除走墓碑链路，孤儿信号不再依赖名字形状启发式）。
 *
 * 自愈契约：
 *  ① 标题恰为某存活 agent 内部名 → PATCH 标题为其 display_name + 本地即时生效；
 *  ② 顺带补绑定（无绑定时），把关联持久化；
 *  ③ 幂等：愈后标题=显示名，不再命中条件，重复跑零副作用；
 *  ④ 不动用户资产：自定义标题 / 无匹配 agent / display_name 为空 → 全部跳过；
 *  ⑤ 单条失败不阻断其余（best-effort）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { healLegacySessionTitles } from '../session-title-heal'
import { getSessionAgent, bindSessionAgent } from '../session-agent-binding'
import type { ChatSession } from '@/types'

const { updateTitleSpy } = vi.hoisted(() => ({ updateTitleSpy: vi.fn() }))
vi.mock('@/api/chat', () => ({
  updateSessionTitle: (id: string, title: string) => updateTitleSpy(id, title),
}))

function session(id: string, title: string): ChatSession {
  return { id, title, created_at: '2026-07-01T10:00:00Z', updated_at: '2026-07-01T10:00:00Z', message_count: 3 } as ChatSession
}

const AGENTS = new Map([
  ['k12-tutor-6GXQsQ7m', { name: 'k12-tutor-6GXQsQ7m', display_name: '小明的辅导助手 · 五年级' }],
  ['translator-abc', { name: 'translator-abc', display_name: '翻译官' }],
  ['no-display', { name: 'no-display', display_name: '' }],
])
const findAgent = (name: string) => AGENTS.get(name)

describe('BUG-20260712：存量内部名标题自愈（运行时反查 → 持久快照）', () => {
  beforeEach(() => {
    localStorage.clear()
    updateTitleSpy.mockReset().mockResolvedValue({})
  })

  it('★标题=存活 agent 内部名 → 落库显示名 + 本地即时生效 + 补绑定', async () => {
    const sessions = [session('s-1', 'k12-tutor-6GXQsQ7m'), session('s-2', 'translator-abc')]
    const healed = await healLegacySessionTitles(sessions, findAgent)

    expect(healed).toBe(2)
    expect(updateTitleSpy).toHaveBeenCalledWith('s-1', '小明的辅导助手 · 五年级')
    expect(updateTitleSpy).toHaveBeenCalledWith('s-2', '翻译官')
    expect(sessions[0]!.title).toBe('小明的辅导助手 · 五年级')
    expect(sessions[1]!.title).toBe('翻译官')
    // 关联持久化：agent 将来被删走墓碑链路，孤儿信号不再靠名字形状猜
    expect(getSessionAgent('s-1')).toBe('k12-tutor-6GXQsQ7m')
    expect(getSessionAgent('s-2')).toBe('translator-abc')
  })

  it('幂等：愈后再跑零副作用（标题已是显示名，不再命中）', async () => {
    const sessions = [session('s-1', 'k12-tutor-6GXQsQ7m')]
    await healLegacySessionTitles(sessions, findAgent)
    updateTitleSpy.mockClear()
    const second = await healLegacySessionTitles(sessions, findAgent)
    expect(second).toBe(0)
    expect(updateTitleSpy).not.toHaveBeenCalled()
  })

  it('不动用户资产：自定义标题 / agent 已删 / display_name 空 → 全部跳过', async () => {
    const sessions = [
      session('s-3', '周三数学复习'), // 自定义标题
      session('s-4', 'k12-tutor-2O99CPr_'), // agent 已删（交给孤儿文案层）
      session('s-5', 'no-display'), // display_name 空，快照无意义
    ]
    const healed = await healLegacySessionTitles(sessions, findAgent)
    expect(healed).toBe(0)
    expect(updateTitleSpy).not.toHaveBeenCalled()
    expect(sessions.map((s) => s.title)).toEqual(['周三数学复习', 'k12-tutor-2O99CPr_', 'no-display'])
  })

  it('best-effort：单条 PATCH 失败不阻断其余，失败条目本地不改（下次启动重试）', async () => {
    updateTitleSpy
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({})
    const sessions = [session('s-1', 'k12-tutor-6GXQsQ7m'), session('s-2', 'translator-abc')]
    const healed = await healLegacySessionTitles(sessions, findAgent)
    expect(healed).toBe(1)
    expect(sessions[0]!.title, '落库失败不得只改本地（重启即回退，还丢了自愈机会）').toBe('k12-tutor-6GXQsQ7m')
    expect(sessions[1]!.title).toBe('翻译官')
  })

  it('已有绑定不覆盖（含指向他人的绑定——绑定是权威关联，标题只是显示资产）', async () => {
    bindSessionAgent('s-1', 'translator-abc')
    const sessions = [session('s-1', 'k12-tutor-6GXQsQ7m')]
    await healLegacySessionTitles(sessions, findAgent)
    expect(getSessionAgent('s-1')).toBe('translator-abc')
  })
})
