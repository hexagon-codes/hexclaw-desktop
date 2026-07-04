/**
 * BUG-20260703 问题2：@ 召唤面板列出一堆用户根本没有的 Agent。
 *
 * 根因：ChatView 给 MentionPopup 传的是 `agentsStore.roles`（后端内置角色工厂列表：
 * 数据分析师/智能助手/高级编程助手/高级研究分析师/专业写作助手…），而「我的智能体」
 * 页面用的是 getAgents() 经 userVisibleAgents 过滤后的用户 Agent——两处数据源根本不同。
 *
 * 修复：store 提供单一来源 `mentionableAgents`（registeredAgents → MentionPopup item
 * 形状映射），ChatView 换绑；@ 面板从此与「我的智能体」同源（AP-108 单一可见性边界精神）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('@/api/agents', () => ({
  getRoles: vi.fn().mockResolvedValue({ roles: [], total: 0 }),
  getAgents: vi.fn().mockResolvedValue({
    agents: [
      { name: 'translator', display_name: '专业翻译', description: '提供准确、自然的翻译' },
      { name: 'general-assistant', display_name: '通用助手', description: '全能问答' },
      // 匿名频道默认模型 Agent：必须被 userVisibleAgents 边界剔除，不得进 @ 面板
      { name: '@im/telegram', display_name: '', description: '' },
    ],
    total: 3,
    default: 'translator',
  }),
}))

import { useAgentsStore } from '@/stores/agents'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('BUG-20260703 问题2：@ 召唤与「我的智能体」同源', () => {
  it('store 暴露 mentionableAgents：用户 Agent → MentionPopup 形状（name/title/goal）', async () => {
    const store = useAgentsStore()
    await store.loadAgents()

    expect(store.mentionableAgents, 'store 必须提供 mentionableAgents 单一来源').toBeDefined()
    expect(store.mentionableAgents.map((a: { name: string }) => a.name)).toEqual([
      'translator',
      'general-assistant',
    ])
    expect(store.mentionableAgents[0]).toMatchObject({
      name: 'translator',
      title: '专业翻译',
      goal: '提供准确、自然的翻译',
    })
  })

  it('契约锁：ChatView 的 @ 面板 agents 绑定 mentionableAgents，不得再用内置 roles', () => {
    const src = readFileSync(resolve(__dirname, '../../views/ChatView.vue'), 'utf-8')
    expect(src, 'ChatView 不得把内置角色工厂 roles 当作 @ 召唤数据源').not.toMatch(
      /:agents="agentsStore\.roles"/,
    )
    expect(src).toMatch(/:agents="agentsStore\.mentionableAgents"/)
  })
})
