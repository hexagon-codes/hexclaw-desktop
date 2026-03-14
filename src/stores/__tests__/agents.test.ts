import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAgentsStore } from '../agents'

vi.mock('@/api/agents', () => ({
  getRoles: vi.fn().mockResolvedValue({
    roles: [
      { name: 'assistant', title: '助手', goal: '帮助用户完成任务' },
    ],
  }),
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
  })
})
