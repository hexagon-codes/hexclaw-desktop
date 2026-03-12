import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAgentsStore } from '../agents'

vi.mock('@/api/agents', () => ({
  getRoles: vi.fn().mockResolvedValue({
    roles: [
      { id: 'r1', name: 'assistant', display_name: 'Assistant', description: 'Help users', system_prompt: '', tools: [], skills: [], model: 'gpt-4o', temperature: 0.7, created_at: '', updated_at: '', status: 'active' },
    ],
  }),
  createRole: vi.fn().mockImplementation((input) =>
    Promise.resolve({ id: 'r2', ...input, created_at: '', updated_at: '', status: 'active' }),
  ),
  updateRole: vi.fn().mockImplementation((id, input) =>
    Promise.resolve({ id, name: 'updated', display_name: 'Updated', description: '', system_prompt: '', tools: [], skills: [], model: 'gpt-4o', temperature: 0.7, created_at: '', updated_at: '', status: 'active', ...input }),
  ),
  deleteRole: vi.fn().mockResolvedValue({}),
}))

describe('useAgentsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('has empty initial state', () => {
    const store = useAgentsStore()
    expect(store.roles).toEqual([])
    expect(store.selectedRoleId).toBeNull()
    expect(store.loading).toBe(false)
  })

  it('loads roles', async () => {
    const store = useAgentsStore()
    await store.loadRoles()
    expect(store.roles).toHaveLength(1)
    expect(store.roles[0]!.name).toBe('assistant')
  })

  it('creates role', async () => {
    const store = useAgentsStore()
    const role = await store.createRole({
      name: 'coder',
      display_name: 'Coder',
      description: 'Write code',
      system_prompt: 'You are a coder',
      model: 'gpt-4o',
    })
    expect(role.id).toBe('r2')
    expect(store.roles).toHaveLength(1)
  })

  it('updates role', async () => {
    const store = useAgentsStore()
    await store.loadRoles()
    const role = await store.updateRole('r1', { name: 'updated' })
    expect(role.name).toBe('updated')
    expect(store.roles[0]!.name).toBe('updated')
  })

  it('deletes role', async () => {
    const store = useAgentsStore()
    await store.loadRoles()
    store.selectedRoleId = 'r1'
    await store.deleteRole('r1')
    expect(store.roles).toHaveLength(0)
    expect(store.selectedRoleId).toBeNull()
  })
})
