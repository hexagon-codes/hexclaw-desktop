import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAgentsStore } from '../agents'
import { getAgents } from '@/api/agents'

vi.mock('@/api/agents', () => ({
  getRoles: vi.fn().mockResolvedValue({
    roles: [
      {
        name: 'assistant',
        title: '助手',
        goal: '帮助用户完成任务',
        backstory: '负责通用问答',
        expertise: ['通用问答', '任务规划'],
        constraints: ['不编造不确定信息'],
      },
    ],
  }),
  getAgents: vi.fn(),
}))

describe('useAgentsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('has empty initial state', () => {
    const store = useAgentsStore()
    expect(store.roles).toEqual([])
    expect(store.loading).toBe(false)
  })

  it('loads roles', async () => {
    const store = useAgentsStore()
    await store.loadRoles()
    expect(store.roles).toHaveLength(1)
    expect(store.roles[0]!.name).toBe('assistant')
    expect(store.roles[0]!.title).toBe('助手')
    expect(store.roles[0]!.backstory).toBe('负责通用问答')
    expect(store.roles[0]!.expertise).toEqual(['通用问答', '任务规划'])
    expect(store.roles[0]!.constraints).toEqual(['不编造不确定信息'])
  })

  // hex-test 审计（2026-06-27）：IM「频道默认模型」用匿名 Agent `@im/<platform>` 承载，
  // 必须从用户可见 Agent 列表过滤——否则泄漏进 Agent 管理页/路由下拉/聊天选择器。
  // registeredAgents 喂 ChatView/Inspector/ContextBar，是泄漏的总闸，必须在源头过滤。
  it('loadAgents 过滤匿名频道默认 Agent @im/*（不泄漏进用户可见列表）', async () => {
    vi.mocked(getAgents).mockResolvedValue({
      agents: [
        { name: 'assistant', display_name: '助手', model: '', provider: '' },
        { name: '@im/feishu', display_name: '频道默认模型', model: 'gpt-4o', provider: 'openai' },
        { name: '@im/telegram', display_name: '频道默认模型', model: 'qwen3-max', provider: 'siliconflow' },
      ],
      total: 3,
      default: 'assistant',
    } as Awaited<ReturnType<typeof getAgents>>)

    const store = useAgentsStore()
    await store.loadAgents()

    const names = store.registeredAgents.map((a) => a.name)
    expect(names).toContain('assistant')
    expect(names).not.toContain('@im/feishu')
    expect(names).not.toContain('@im/telegram')
    expect(store.registeredAgents).toHaveLength(1)
  })
})
