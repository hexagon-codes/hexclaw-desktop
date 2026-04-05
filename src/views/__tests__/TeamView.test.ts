import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import TeamView from '../TeamView.vue'
import zhCN from '@/i18n/locales/zh-CN'

const {
  getSharedAgents,
  deleteSharedAgent,
  getTeamMembers,
  inviteTeamMember,
  removeTeamMember,
  exportAllConfig,
  importConfig,
} = vi.hoisted(() => ({
  getSharedAgents: vi.fn(),
  deleteSharedAgent: vi.fn(),
  getTeamMembers: vi.fn(),
  inviteTeamMember: vi.fn(),
  removeTeamMember: vi.fn(),
  exportAllConfig: vi.fn(),
  importConfig: vi.fn(),
}))

vi.mock('@/api/team', () => ({
  getSharedAgents,
  deleteSharedAgent,
  getTeamMembers,
  inviteTeamMember,
  removeTeamMember,
  exportAllConfig,
  importConfig,
}))

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

function mountTeamView() {
  return mount(TeamView, {
    global: {
      plugins: [createTestI18n()],
      stubs: {
        PageHeader: { template: '<div><slot name="actions" /></div>' },
        teleport: true,
        transition: false,
      },
    },
  })
}

describe('TeamView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSharedAgents.mockReset()
    deleteSharedAgent.mockReset()
    getTeamMembers.mockReset()
    inviteTeamMember.mockReset()
    removeTeamMember.mockReset()
    exportAllConfig.mockReset()
    importConfig.mockReset()
    getSharedAgents.mockResolvedValue([])
    getTeamMembers.mockResolvedValue([])
    inviteTeamMember.mockResolvedValue({
      id: 'member-default',
      name: '默认成员',
      email: 'default@example.com',
      role: 'member',
      last_active: '刚刚',
    })
    removeTeamMember.mockResolvedValue(undefined)
  })

  it('copying a shared-agent link should fail gracefully when clipboard API is unavailable', async () => {
    const wrapper = mountTeamView()

    await flushPromises()

    const vm = wrapper.vm as unknown as {
      copyShareLink: (agent: { id: string }) => void
    }

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })

    expect(() => vm.copyShareLink({ id: 'agent-1' })).not.toThrow()
  })

  it('keeps the loading state visible until both initial requests finish', async () => {
    let resolveShared!: (value: unknown) => void
    let resolveMembers!: (value: unknown) => void

    getSharedAgents.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveShared = resolve
        }),
    )
    getTeamMembers.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMembers = resolve
        }),
    )

    const wrapper = mountTeamView()

    await flushPromises()
    expect(wrapper.html()).toContain('animate-spin')

    resolveShared([])
    await flushPromises()

    expect(wrapper.html()).toContain('animate-spin')

    resolveMembers([])
    await flushPromises()

    expect(wrapper.html()).not.toContain('animate-spin')
  })

  it('keeps the latest shared-agent list when an earlier refresh resolves later', async () => {
    let resolveInitialShared!: (value: unknown) => void
    let resolveRefreshShared!: (value: unknown) => void

    getSharedAgents
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitialShared = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefreshShared = resolve
          }),
      )
    getTeamMembers.mockResolvedValue([])

    const wrapper = mountTeamView()

    await flushPromises()

    const refreshBtn = wrapper.findAll('button').find((btn) => btn.text().includes('邀请成员'))?.element
    expect(refreshBtn).toBeDefined()

    const iconOnlyRefreshBtn = wrapper.findAll('button')[0]
    await iconOnlyRefreshBtn!.trigger('click')
    await flushPromises()

    resolveRefreshShared([
      {
        id: 'fresh-agent',
        name: '新 Agent',
        description: 'fresh',
        author: 'team',
        downloads: 2,
        visibility: 'team',
      },
    ])
    await flushPromises()

    expect(wrapper.html()).toContain('animate-spin')

    resolveInitialShared([
      {
        id: 'stale-agent',
        name: '旧 Agent',
        description: 'stale',
        author: 'team',
        downloads: 1,
        visibility: 'team',
      },
    ])
    await flushPromises()

    expect(wrapper.text()).toContain('新 Agent')
    expect(wrapper.text()).not.toContain('旧 Agent')
  })

  it('keeps the latest team-members list when an earlier refresh resolves later', async () => {
    let resolveInitialMembers!: (value: unknown) => void
    let resolveRefreshMembers!: (value: unknown) => void

    getSharedAgents.mockResolvedValue([])
    getTeamMembers
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitialMembers = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefreshMembers = resolve
          }),
      )

    const wrapper = mountTeamView()

    await flushPromises()

    const teamTab = wrapper.findAll('button').find((btn) => btn.text().includes('团队成员'))
    expect(teamTab).toBeDefined()
    await teamTab!.trigger('click')
    await flushPromises()

    const iconOnlyRefreshBtn = wrapper.findAll('button')[0]
    await iconOnlyRefreshBtn!.trigger('click')
    await flushPromises()

    resolveRefreshMembers([
      {
        id: 'fresh-member',
        name: '新成员',
        email: 'fresh@example.com',
        role: 'member',
        last_active: '刚刚',
      },
    ])
    await flushPromises()

    expect(wrapper.html()).toContain('animate-spin')

    resolveInitialMembers([
      {
        id: 'stale-member',
        name: '旧成员',
        email: 'stale@example.com',
        role: 'viewer',
        last_active: '昨天',
      },
    ])
    await flushPromises()

    expect(wrapper.text()).toContain('新成员')
    expect(wrapper.text()).not.toContain('旧成员')
  })

  it('clears the old error banner after invite succeeds following a previous failure', async () => {
    inviteTeamMember
      .mockRejectedValueOnce(new Error('邀请失败'))
      .mockResolvedValueOnce({
        id: 'member-1',
        name: 'Alice',
        email: 'alice@example.com',
        role: 'member',
        last_active: '刚刚',
      })

    const wrapper = mountTeamView()
    await flushPromises()

    const openInviteBtn = wrapper.findAll('button').find((btn) => btn.text().includes('邀请成员'))
    expect(openInviteBtn).toBeDefined()
    await openInviteBtn!.trigger('click')
    await flushPromises()

    const emailInput = wrapper.get('input[type="email"]')
    await emailInput.setValue('alice@example.com')

    const sendBtn = wrapper.findAll('button').find((btn) => btn.text().includes('发送邀请'))
    expect(sendBtn).toBeDefined()
    await sendBtn!.trigger('click')
    await flushPromises()

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('邀请失败')
    })

    const resendBtn = wrapper.findAll('button').find((btn) => btn.text().includes('发送邀请'))
    expect(resendBtn).toBeDefined()
    await resendBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).not.toContain('邀请失败')

    const teamTab = wrapper.findAll('button').find((btn) => btn.text().includes('团队成员'))
    expect(teamTab).toBeDefined()
    await teamTab!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Alice')
  })

  it('resets invite form state when the modal is closed and reopened after a failure', async () => {
    inviteTeamMember.mockRejectedValueOnce(new Error('邀请失败'))

    const wrapper = mountTeamView()
    await flushPromises()

    const openInviteBtn = wrapper.findAll('button').find((btn) => btn.text().includes('邀请成员'))
    expect(openInviteBtn).toBeDefined()
    await openInviteBtn!.trigger('click')
    await flushPromises()

    const emailInput = wrapper.get('input[type="email"]')
    await emailInput.setValue('stale@example.com')

    const sendBtn = wrapper.findAll('button').find((btn) => btn.text().includes('发送邀请'))
    expect(sendBtn).toBeDefined()
    await sendBtn!.trigger('click')
    await flushPromises()

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('邀请失败')
    })

    const cancelBtn = wrapper.findAll('button').find((btn) => btn.text() === '取消')
    expect(cancelBtn).toBeDefined()
    await cancelBtn!.trigger('click')
    await flushPromises()

    await openInviteBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).not.toContain('邀请失败')
    expect((wrapper.get('input[type="email"]').element as HTMLInputElement).value).toBe('')
  })

  it('clears the old error banner after removing a member succeeds following a previous failure', async () => {
    getTeamMembers.mockResolvedValueOnce([
      {
        id: 'member-1',
        name: 'Alice',
        email: 'alice@example.com',
        role: 'member',
        last_active: '刚刚',
      },
    ])
    removeTeamMember
      .mockRejectedValueOnce(new Error('移除失败'))
      .mockResolvedValueOnce({})

    vi.spyOn(window, 'confirm').mockReturnValue(true)

    const wrapper = mountTeamView()
    await flushPromises()

    const teamTab = wrapper.findAll('button').find((btn) => btn.text().includes('团队成员'))
    expect(teamTab).toBeDefined()
    await teamTab!.trigger('click')
    await flushPromises()

    const removeBtn = wrapper.findAll('button').find((btn) => btn.classes().includes('hc-btn-danger'))
    expect(removeBtn).toBeDefined()

    await removeBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('移除失败')

    await removeBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).not.toContain('移除失败')
    expect(wrapper.text()).not.toContain('Alice')
  })

  it('clears the old error banner after deleting a shared agent succeeds following a previous failure', async () => {
    getSharedAgents.mockResolvedValueOnce([
      {
        id: 'agent-1',
        name: '共享 Agent',
        description: 'shared',
        author: 'team',
        downloads: 1,
        visibility: 'team',
      },
    ])
    deleteSharedAgent
      .mockRejectedValueOnce(new Error('删除失败'))
      .mockResolvedValueOnce(undefined)

    vi.spyOn(window, 'confirm').mockReturnValue(true)

    const wrapper = mountTeamView()
    await flushPromises()

    const deleteBtn = wrapper.findAll('button').find((btn) => btn.classes().includes('hc-btn-danger'))
    expect(deleteBtn).toBeDefined()

    await deleteBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('删除失败')

    const retryDeleteBtn = wrapper.findAll('button').find((btn) => btn.classes().includes('hc-btn-danger'))
    expect(retryDeleteBtn).toBeDefined()
    await retryDeleteBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).not.toContain('删除失败')
    expect(wrapper.text()).not.toContain('共享 Agent')
  })

  it('switching tabs should not keep showing an old error from another tab', async () => {
    getSharedAgents.mockResolvedValueOnce([
      {
        id: 'agent-1',
        name: '共享 Agent',
        description: 'shared',
        author: 'team',
        downloads: 1,
        visibility: 'team',
      },
    ])
    deleteSharedAgent.mockRejectedValueOnce(new Error('删除失败'))
    getTeamMembers.mockResolvedValueOnce([
      {
        id: 'member-1',
        name: 'Alice',
        email: 'alice@example.com',
        role: 'member',
        last_active: '刚刚',
      },
    ])

    vi.spyOn(window, 'confirm').mockReturnValue(true)

    const wrapper = mountTeamView()
    await flushPromises()

    const deleteBtn = wrapper.findAll('button').find((btn) => btn.classes().includes('hc-btn-danger'))
    expect(deleteBtn).toBeDefined()
    await deleteBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('删除失败')

    const teamTab = wrapper.findAll('button').find((btn) => btn.text().includes('团队成员'))
    expect(teamTab).toBeDefined()
    await teamTab!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).not.toContain('删除失败')
    expect(wrapper.text()).toContain('Alice')
  })

  it('clears the old error banner after export succeeds following a previous failure', async () => {
    exportAllConfig
      .mockRejectedValueOnce(new Error('导出失败'))
      .mockResolvedValueOnce({
        version: '1.0.0',
        exported_at: '2026-01-01T00:00:00Z',
        agents: [],
      })

    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:team-export')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const click = vi.fn()
    const originalCreateElement = document.createElement.bind(document)
    const createElement = vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName === 'a') {
        return {
          click,
          href: '',
          download: '',
        } as unknown as HTMLAnchorElement
      }
      return originalCreateElement(tagName)
    })

    const wrapper = mountTeamView()
    await flushPromises()

    const importTab = wrapper.findAll('button').find((btn) => btn.text().includes('导入/导出'))
    expect(importTab).toBeDefined()
    await importTab!.trigger('click')
    await flushPromises()

    const exportCard = wrapper.findAll('.hc-team__import-card')
      .find((card) => card.text().includes('导出全部配置'))
    expect(exportCard).toBeDefined()

    await exportCard!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('导出失败')

    await exportCard!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).not.toContain('导出失败')
    expect(click).toHaveBeenCalled()

    createObjectURL.mockRestore()
    revokeObjectURL.mockRestore()
    createElement.mockRestore()
  })

  it('does not start a second export while the previous export is still running', async () => {
    let resolveExport!: (value: { version: string; exported_at: string; agents: [] }) => void
    exportAllConfig.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveExport = resolve
        }),
    )

    const wrapper = mountTeamView()
    await flushPromises()

    const importTab = wrapper.findAll('button').find((btn) => btn.text().includes('导入/导出'))
    expect(importTab).toBeDefined()
    await importTab!.trigger('click')
    await flushPromises()

    const exportCard = wrapper.findAll('.hc-team__import-card')
      .find((card) => card.text().includes('导出全部配置'))
    expect(exportCard).toBeDefined()

    await exportCard!.trigger('click')
    await flushPromises()
    await exportCard!.trigger('click')
    await flushPromises()

    expect(exportAllConfig).toHaveBeenCalledTimes(1)

    resolveExport({
      version: '1.0.0',
      exported_at: '2026-01-01T00:00:00Z',
      agents: [],
    })
    await flushPromises()
  })

  it('does not open a second file picker while a previous import is still running', async () => {
    let resolveImport!: (value: { imported: number }) => void
    importConfig.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveImport = resolve
        }),
    )

    const inputStub = {
      type: '',
      accept: '',
      files: [{
        text: vi.fn().mockResolvedValue(JSON.stringify({
          version: '1.0.0',
          exported_at: '2026-01-01T00:00:00Z',
          agents: [],
        })),
      }],
      onchange: null as null | (() => void | Promise<void>),
      click: vi.fn(),
    }

    const originalCreateElement = document.createElement.bind(document)
    const createElement = vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName === 'input') {
        return inputStub as unknown as HTMLInputElement
      }
      return originalCreateElement(tagName)
    })

    const wrapper = mountTeamView()
    await flushPromises()

    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})

    const importTab = wrapper.findAll('button').find((btn) => btn.text().includes('导入/导出'))
    expect(importTab).toBeDefined()
    await importTab!.trigger('click')
    await flushPromises()

    const importCard = wrapper.findAll('.hc-team__import-card')
      .find((card) => card.text().includes('导入智能体配置'))
    expect(importCard).toBeDefined()

    await importCard!.trigger('click')
    expect(inputStub.click).toHaveBeenCalledTimes(1)

    void inputStub.onchange?.()
    await flushPromises()

    await importCard!.trigger('click')
    await flushPromises()

    expect(inputStub.click).toHaveBeenCalledTimes(1)

    resolveImport({ imported: 0 })
    await flushPromises()

    createElement.mockRestore()
    alertSpy.mockRestore()
  })

  it('does not send duplicate shared-agent delete requests while a deletion is still in flight', async () => {
    let resolveDelete!: () => void
    getSharedAgents.mockResolvedValueOnce([
      {
        id: 'agent-1',
        name: '共享 Agent',
        description: 'shared',
        author: 'team',
        downloads: 1,
        visibility: 'team',
      },
    ])
    deleteSharedAgent.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve
        }),
    )

    vi.spyOn(window, 'confirm').mockReturnValue(true)

    const wrapper = mountTeamView()
    await flushPromises()

    const deleteBtn = wrapper.findAll('button').find((btn) => btn.classes().includes('hc-btn-danger'))
    expect(deleteBtn).toBeDefined()

    await deleteBtn!.trigger('click')
    await flushPromises()
    await deleteBtn!.trigger('click')
    await flushPromises()

    expect(deleteSharedAgent).toHaveBeenCalledTimes(1)

    resolveDelete()
    await flushPromises()
  })

  it('does not send duplicate member-removal requests while a removal is still in flight', async () => {
    let resolveRemove!: () => void
    getTeamMembers.mockResolvedValueOnce([
      {
        id: 'member-1',
        name: 'Alice',
        email: 'alice@example.com',
        role: 'member',
        last_active: '刚刚',
      },
    ])
    removeTeamMember.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRemove = resolve
        }),
    )

    vi.spyOn(window, 'confirm').mockReturnValue(true)

    const wrapper = mountTeamView()
    await flushPromises()

    const teamTab = wrapper.findAll('button').find((btn) => btn.text().includes('团队成员'))
    expect(teamTab).toBeDefined()
    await teamTab!.trigger('click')
    await flushPromises()

    const removeBtn = wrapper.findAll('button').find((btn) => btn.classes().includes('hc-btn-danger'))
    expect(removeBtn).toBeDefined()

    await removeBtn!.trigger('click')
    await flushPromises()
    await removeBtn!.trigger('click')
    await flushPromises()

    expect(removeTeamMember).toHaveBeenCalledTimes(1)

    resolveRemove()
    await flushPromises()
  })

  it('clears the old import error as soon as a new import starts', async () => {
    let resolveImport!: (value: { imported: number }) => void
    importConfig
      .mockRejectedValueOnce(new Error('导入失败'))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveImport = resolve
          }),
      )

    const inputStub = {
      type: '',
      accept: '',
      files: [{
        text: vi.fn().mockResolvedValue(JSON.stringify({
          version: '1.0.0',
          exported_at: '2026-01-01T00:00:00Z',
          agents: [],
        })),
      }],
      onchange: null as null | (() => void | Promise<void>),
      click: vi.fn(),
    }

    const originalCreateElement = document.createElement.bind(document)
    const createElement = vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName === 'input') {
        return inputStub as unknown as HTMLInputElement
      }
      return originalCreateElement(tagName)
    })

    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const wrapper = mountTeamView()
    await flushPromises()

    const importTab = wrapper.findAll('button').find((btn) => btn.text().includes('导入/导出'))
    expect(importTab).toBeDefined()
    await importTab!.trigger('click')
    await flushPromises()

    const importCard = wrapper.findAll('.hc-team__import-card')
      .find((card) => card.text().includes('导入智能体配置'))
    expect(importCard).toBeDefined()

    await importCard!.trigger('click')
    void inputStub.onchange?.()
    await flushPromises()

    expect(wrapper.text()).toContain('导入失败')

    await importCard!.trigger('click')
    void inputStub.onchange?.()
    await flushPromises()

    expect(wrapper.text()).not.toContain('导入失败')

    resolveImport({ imported: 0 })
    await flushPromises()

    createElement.mockRestore()
    alertSpy.mockRestore()
  })
})
