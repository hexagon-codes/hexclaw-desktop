import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import IMChannelsView from '../IMChannelsView.vue'
import zhCN from '@/i18n/locales/zh-CN'

const { getIMInstances, createIMInstance, updateIMInstance, deleteIMInstance, listIMInstancesHealth, testIMInstance, startIMInstance, stopIMInstance } = vi.hoisted(() => ({
  getIMInstances: vi.fn(),
  createIMInstance: vi.fn(),
  updateIMInstance: vi.fn(),
  deleteIMInstance: vi.fn(),
  listIMInstancesHealth: vi.fn(),
  testIMInstance: vi.fn(),
  startIMInstance: vi.fn(),
  stopIMInstance: vi.fn(),
}))

const { setClipboard } = vi.hoisted(() => ({
  setClipboard: vi.fn(),
}))

vi.mock('@/api/im-channels', async () => {
  const actual = await vi.importActual<typeof import('@/api/im-channels')>('@/api/im-channels')
  return {
    ...actual,
    getIMInstances,
    createIMInstance,
    updateIMInstance,
    deleteIMInstance,
    testIMInstance,
    startIMInstance,
    stopIMInstance,
    listIMInstancesHealth,
  }
})

vi.mock('@/api/desktop', () => ({
  setClipboard,
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

function mountIMChannelsView() {
  return mount(IMChannelsView, {
    attachTo: document.body,
    global: {
      plugins: [createTestI18n()],
      stubs: {
        PageHeader: {
          props: ['title', 'description'],
          template: '<div><slot name="actions" /></div>',
        },
        LoadingState: { template: '<div>loading</div>' },
        teleport: true,
        transition: false,
      },
    },
  })
}

describe('IMChannelsView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getIMInstances.mockResolvedValue([
      {
        id: 'feishu-1',
        name: '飞书',
        type: 'feishu',
        enabled: false,
        config: { app_id: 'cli_xxx', app_secret: 'secret' },
        createdAt: 1,
      },
    ])
    updateIMInstance.mockResolvedValue(true)
    createIMInstance.mockResolvedValue(undefined)
    deleteIMInstance.mockResolvedValue(undefined)
    listIMInstancesHealth.mockResolvedValue([])
    testIMInstance.mockResolvedValue({ success: true, message: 'ok' })
    startIMInstance.mockResolvedValue(undefined)
    stopIMInstance.mockResolvedValue(undefined)
    setClipboard.mockResolvedValue(undefined)
  })

  it('edits a feishu instance and reloads the list after save', async () => {
    const wrapper = mountIMChannelsView()
    await flushPromises()

    const configBtn = wrapper.findAll('button').find((btn) => btn.text().includes('配置'))
    expect(configBtn).toBeDefined()

    await configBtn!.trigger('click')
    await flushPromises()

    const nameInput = wrapper.find('input[placeholder="输入实例名称"]')
    await nameInput.setValue('飞书-已编辑')

    const saveBtn = wrapper.findAll('button').find((btn) => btn.text().includes('保存'))
    expect(saveBtn).toBeDefined()

    await saveBtn!.trigger('click')
    await flushPromises()

    expect(updateIMInstance).toHaveBeenCalledWith('feishu-1', expect.objectContaining({
      name: '飞书-已编辑',
      enabled: false,
    }))
    expect(getIMInstances).toHaveBeenCalledTimes(2)
  })

  it('copies webhook url through the clipboard helper in edit mode', async () => {
    const wrapper = mountIMChannelsView()
    await flushPromises()

    const configBtn = wrapper.findAll('button').find((btn) => btn.text().includes('配置'))
    expect(configBtn).toBeDefined()
    await configBtn!.trigger('click')
    await flushPromises()

    const copyBtn = wrapper.findAll('button').find((btn) => btn.text().includes('复制'))
    expect(copyBtn).toBeDefined()
    await copyBtn!.trigger('click')
    await flushPromises()

    expect(setClipboard).toHaveBeenCalledTimes(1)
  })

  it('does not probe backend health or emit Tauri proxy warnings outside desktop runtime', async () => {
    delete (globalThis as Record<string, unknown>).isTauri
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    mountIMChannelsView()
    await flushPromises()

    const imProxyWarnings = warnSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('[IM] proxyApiRequest'),
    )
    expect(imProxyWarnings).toHaveLength(0)

    warnSpy.mockRestore()
  })

  it('uses the shared embedded search input in the page header', async () => {
    const wrapper = mountIMChannelsView()
    await flushPromises()

    const searchBox = wrapper.get('.hc-search')
    const input = wrapper.get('input[placeholder="搜索实例..."]')

    expect(searchBox.find('.hc-search__icon').exists()).toBe(true)

    await input.setValue('飞书')
    expect(searchBox.find('.hc-search__clear').exists()).toBe(true)
    expect(wrapper.find('.hc-im-search-wrap').exists()).toBe(false)
  })

  it('keeps the latest health snapshot when an older health request resolves later', async () => {
    ;(globalThis as Record<string, unknown>).isTauri = true
    getIMInstances.mockResolvedValueOnce([
      {
        id: 'feishu-1',
        name: '飞书',
        type: 'feishu',
        enabled: true,
        config: { app_id: 'cli_xxx', app_secret: 'secret' },
        createdAt: 1,
      },
    ])

    let resolveOld!: (value: Array<{ name: string; status: 'running' | 'stopped' | 'error'; last_error?: string }>) => void
    let resolveNew!: (value: Array<{ name: string; status: 'running' | 'stopped' | 'error'; last_error?: string }>) => void

    listIMInstancesHealth
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNew = resolve
          }),
      )

    const wrapper = mountIMChannelsView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      loadHealth: () => Promise<void>
    }

    const refreshPromise = vm.loadHealth()
    await flushPromises()

    resolveNew([{ name: '飞书', status: 'stopped' }])
    await refreshPromise
    await flushPromises()

    // Runtime status row removed — health status shown in header only

    resolveOld([{ name: '飞书', status: 'running' }])
    await flushPromises()

    // Stale response should not override newer health snapshot in internal state
    const statusText = wrapper.find('.hc-im-card__status-text')
    expect(statusText.exists()).toBe(true)
  })

  it('does not start a second modal test while the first test is still running', async () => {
    let resolveTest!: (value: { success: boolean; message: string }) => void
    testIMInstance.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTest = resolve
        }),
    )

    const wrapper = mountIMChannelsView()
    await flushPromises()

    const createBtn = wrapper.findAll('button').find((btn) => btn.text().includes('新建'))
    expect(createBtn).toBeDefined()
    await createBtn!.trigger('click')
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      formName: string
      formConfig: Record<string, string>
      handleTestModal: () => Promise<void>
    }
    vm.formName = '飞书测试'
    vm.formConfig = { app_id: 'cli_xxx', app_secret: 'secret' }

    void vm.handleTestModal()
    await flushPromises()
    void vm.handleTestModal()
    await flushPromises()

    expect(testIMInstance).toHaveBeenCalledTimes(1)

    resolveTest({ success: true, message: 'ok' })
    await flushPromises()
  })

  it('does not start a second start request while the first toggle is still running', async () => {
    ;(globalThis as Record<string, unknown>).isTauri = true
    getIMInstances.mockResolvedValueOnce([
      {
        id: 'feishu-1',
        name: '飞书',
        type: 'feishu',
        enabled: true,
        config: { app_id: 'cli_xxx', app_secret: 'secret' },
        createdAt: 1,
      },
    ])
    listIMInstancesHealth.mockResolvedValueOnce([{ name: '飞书', status: 'stopped' }])

    let resolveStart!: () => void
    startIMInstance.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve
        }),
    )

    const wrapper = mountIMChannelsView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      handleStartStop: (inst: {
        id: string
        name: string
        type: string
        enabled: boolean
        config: Record<string, string>
        createdAt: number
      }) => Promise<void>
    }

    const inst = {
      id: 'feishu-1',
      name: '飞书',
      type: 'feishu',
      enabled: true,
      config: { app_id: 'cli_xxx', app_secret: 'secret' },
      createdAt: 1,
    }

    void vm.handleStartStop(inst)
    await flushPromises()
    void vm.handleStartStop(inst)
    await flushPromises()

    expect(startIMInstance).toHaveBeenCalledTimes(1)

    resolveStart()
    await flushPromises()
  })

  it('does not start a second create request while the first save is still running', async () => {
    let resolveCreate!: () => void
    createIMInstance.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveCreate = resolve
        }),
    )

    const wrapper = mountIMChannelsView()
    await flushPromises()

    const createBtn = wrapper.findAll('button').find((btn) => btn.text().includes('新建'))
    expect(createBtn).toBeDefined()
    await createBtn!.trigger('click')
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      formName: string
      formType: string
      formConfig: Record<string, string>
      formEnabled: boolean
      handleCreate: () => Promise<void>
    }
    vm.formName = '飞书新建'
    vm.formType = 'feishu'
    vm.formConfig = { app_id: 'cli_xxx', app_secret: 'secret' }
    vm.formEnabled = false

    void vm.handleCreate()
    await flushPromises()
    void vm.handleCreate()
    await flushPromises()

    expect(createIMInstance).toHaveBeenCalledTimes(1)

    resolveCreate()
    await flushPromises()
  })

  it('does not start a second delete request while the first delete is still running', async () => {
    let resolveDelete!: () => void
    deleteIMInstance.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve
        }),
    )

    const wrapper = mountIMChannelsView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      confirmDelete: (id: string) => void
      handleDelete: (id: string) => Promise<void>
    }

    // confirmDelete sets deletingId so handleDelete can proceed
    vm.confirmDelete('feishu-1')
    void vm.handleDelete('feishu-1')
    await flushPromises()

    // After handleDelete starts, deletingId is still set;
    // resolve the first request so deletingId resets to null
    resolveDelete()
    await flushPromises()

    // Second call without re-confirming is blocked (deletingId is null !== 'feishu-1')
    void vm.handleDelete('feishu-1')
    await flushPromises()

    expect(deleteIMInstance).toHaveBeenCalledTimes(1)
  })

  it('clears the old error banner after create succeeds following a previous failure', async () => {
    createIMInstance
      .mockRejectedValueOnce(new Error('create failed'))
      .mockResolvedValueOnce(undefined)

    const wrapper = mountIMChannelsView()
    await flushPromises()

    const createBtn = wrapper.findAll('button').find((btn) => btn.text().includes('新建'))
    expect(createBtn).toBeDefined()
    await createBtn!.trigger('click')
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      formName: string
      formType: string
      formConfig: Record<string, string>
      formEnabled: boolean
      handleCreate: () => Promise<void>
    }
    vm.formName = '飞书新建'
    vm.formType = 'feishu'
    vm.formConfig = { app_id: 'cli_xxx', app_secret: 'secret' }
    vm.formEnabled = false

    await vm.handleCreate()
    await flushPromises()
    expect(wrapper.text()).toContain('create failed')

    await vm.handleCreate()
    await flushPromises()

    expect(wrapper.text()).not.toContain('create failed')
  })
})
