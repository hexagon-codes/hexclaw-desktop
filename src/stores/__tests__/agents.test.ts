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

  // BUG-20260712 #A：会话标题被 session-title-heal 自愈成 display_name 后，「据标题反查 agent」
  // 若只按内部名（findAgent）必失败 → 从「会话」列表打开 K12 会话恢复不出 agentRole → 辅导 UI 不显示。
  it('findAgentByNameOrDisplay 按内部名 + 显示名都能反查（标题自愈后仍可恢复 agent）', async () => {
    vi.mocked(getAgents).mockResolvedValue({
      agents: [
        {
          name: 'k12-tutor-KKE5v8zQ',
          display_name: '小王的辅导助手 · 五年级',
          model: 'qwen3.5:9b',
          provider: 'Ollama (本地)',
          metadata: { scenario: 'k12-tutor' },
        },
      ],
      total: 1,
      default: 'k12-tutor-KKE5v8zQ',
    } as Awaited<ReturnType<typeof getAgents>>)

    const store = useAgentsStore()
    await store.loadAgents()

    // 旧 findAgent 只认内部名：显示名（=自愈后的标题）查不到 = bug 根因
    expect(store.findAgent('小王的辅导助手 · 五年级')).toBeUndefined()
    expect(store.findAgent('k12-tutor-KKE5v8zQ')).toBeDefined()

    // 新方法：内部名 + 显示名都能反查（RED：修前无此方法 / 显示名恢复不出）
    expect(store.findAgentByNameOrDisplay('小王的辅导助手 · 五年级')?.name).toBe('k12-tutor-KKE5v8zQ')
    expect(store.findAgentByNameOrDisplay('k12-tutor-KKE5v8zQ')?.name).toBe('k12-tutor-KKE5v8zQ')
    // 恢复出的 agent 带 scenario metadata → isK12Instance 成立 → 辅导 UI 显示
    expect(store.findAgentByNameOrDisplay('小王的辅导助手 · 五年级')?.metadata?.scenario).toBe('k12-tutor')
    // 无关字符串不误命中
    expect(store.findAgentByNameOrDisplay('不存在的会话')).toBeUndefined()
  })
})
