import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import WebhookPanel from '../WebhookPanel.vue'

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

function mountPanel() {
  return mount(WebhookPanel, {
    attachTo: document.body,
    // 新建表单已改为 Teleport 弹窗：stub teleport 使其内联渲染，便于在 wrapper 内查询。
    global: { plugins: [createTestI18n()], stubs: { teleport: true } },
  })
}

const getWebhooks = vi.hoisted(() => vi.fn())
const createWebhook = vi.hoisted(() => vi.fn())
const deleteWebhook = vi.hoisted(() => vi.fn())
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}))
const setClipboard = vi.hoisted(() => vi.fn())

vi.mock('@/api/webhook', () => ({
  getWebhooks,
  createWebhook,
  deleteWebhook,
  updateWebhookEnabled: vi.fn().mockResolvedValue({ name: 'x', enabled: true }),
  webhookUrlFor: (name: string) => `http://localhost:16060/api/v1/webhooks/${name}`,
}))
// 自动化权限治理 API：组件挂载即静默预检/总览，测试里一律 mock 成全绿空态。
vi.mock('@/api/autonomy', () => ({
  preflightAutonomy: vi.fn().mockResolvedValue({
    source: 'webhook',
    profile: 'function_first',
    capabilities: [],
    estimated: [],
    needs_decision: [],
    all_clear: true,
  }),
  createAutonomyGrant: vi.fn().mockResolvedValue({ grant: { id: 'g-1' } }),
  getAutonomySummary: vi.fn().mockResolvedValue({
    profile: 'function_first',
    counts: { tasks: 0, ready: 0, pending: 0, grants: 0 },
    pending: [],
    tasks: [],
  }),
  listAutonomyDecisions: vi.fn().mockResolvedValue({ decisions: [], total: 0 }),
  listAutonomyGrants: vi.fn().mockResolvedValue({ grants: [], total: 0 }),
  revokeAutonomyGrant: vi.fn().mockResolvedValue({ message: 'ok' }),
  getAutonomyProfile: vi.fn().mockResolvedValue({
    profile: 'function_first',
    profiles: [],
    matrix: { profile: 'function_first', categories: [], rows: [] },
  }),
  updateAutonomyProfile: vi.fn(),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => toast,
}))

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

describe('WebhookPanel CRUD', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads, creates, and deletes webhooks', async () => {
    vi.useFakeTimers()
    const hooks: {
      id: string
      name: string
      type: string
      prompt: string
      enabled: boolean
      event_count: number
    }[] = [
      { id: 'a', name: 'hook-a', type: 'generic', prompt: 'p-a', enabled: true, event_count: 0 },
    ]
    getWebhooks.mockImplementation(async () => ({ webhooks: [...hooks] }))
    createWebhook.mockImplementation(async (payload) => {
      hooks.push({
        id: 'new',
        name: payload.name,
        type: payload.type,
        prompt: payload.prompt,
        enabled: true,
        event_count: 0,
      })
      return {}
    })
    deleteWebhook.mockImplementation(async (name) => {
      // 2026-06-22：按 name 删（对齐后端 DELETE /webhooks/{name}）
      const idx = hooks.findIndex((h) => h.name === name)
      if (idx >= 0) hooks.splice(idx, 1)
    })

    const wrapper = mountPanel()
    await flushPromises()

    expect(getWebhooks).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('hook-a')

    // 创建入口已上移到工具栏（对齐原型）；面板通过 openCreateForm 暴露该入口
    ;(wrapper.vm as unknown as { openCreateForm: () => void }).openCreateForm()
    await flushPromises()

    await wrapper.find('input[placeholder="my-webhook"]').setValue('hook-b')
    await wrapper.find('textarea').setValue('汇总事件并通知我')
    const buttons = wrapper.findAll('.webhook-modal__actions button')
    const createBtn = buttons[1]!
    await createBtn.trigger('click')
    await flushPromises()

    expect(createWebhook).toHaveBeenCalled()
    expect(getWebhooks).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('hook-b')

    const targetItem = wrapper
      .findAll('.webhook-panel__item')
      .find((item) => item.text().includes('hook-b'))
    expect(targetItem).toBeDefined()
    await targetItem!.find('.webhook-panel__delete').trigger('click')
    await flushPromises()

    const confirmDialog = wrapper.findComponent(ConfirmDialog)
    expect(confirmDialog.exists()).toBe(true)
    expect(confirmDialog.props('confirmDelayMs')).toBe(1500)
    expect(deleteWebhook).not.toHaveBeenCalledWith('hook-b')

    vi.advanceTimersByTime(1499)
    await flushPromises()
    expect(confirmDialog.get('button.hc-dialog__btn--danger').attributes('disabled')).toBeDefined()

    vi.advanceTimersByTime(1)
    await flushPromises()
    await confirmDialog.get('button.hc-dialog__btn--danger').trigger('click')
    await flushPromises()

    expect(deleteWebhook).toHaveBeenCalledWith('hook-b')
    expect(wrapper.text()).not.toContain('hook-b')
  })

  it('does not start a second create request while the first one is still running', async () => {
    let resolveCreate!: () => void
    createWebhook.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveCreate = resolve
        }),
    )
    getWebhooks.mockResolvedValue({ webhooks: [] })

    const wrapper = mountPanel()
    await flushPromises()
    ;(wrapper.vm as unknown as { openCreateForm: () => void }).openCreateForm()
    await flushPromises()

    await wrapper.find('input[placeholder="my-webhook"]').setValue('hook-a')
    await wrapper.find('textarea').setValue('处理指令')

    const createBtn = wrapper.findAll('.webhook-modal__actions button')[1]!
    await createBtn.trigger('click')
    await flushPromises()
    await createBtn.trigger('click')
    await flushPromises()

    expect(createWebhook).toHaveBeenCalledTimes(1)

    resolveCreate()
    await flushPromises()
  })

  it('resets the create form when it is closed and reopened after a failure', async () => {
    getWebhooks.mockResolvedValue({ webhooks: [] })
    createWebhook.mockRejectedValueOnce(new Error('create failed'))

    const wrapper = mountPanel()
    await flushPromises()
    ;(wrapper.vm as unknown as { openCreateForm: () => void }).openCreateForm()
    await flushPromises()

    await wrapper.find('input[placeholder="my-webhook"]').setValue('hook-a')
    await wrapper.find('textarea').setValue('处理指令')

    const formButtons = wrapper.findAll('.webhook-modal__actions button')
    await formButtons[1]!.trigger('click')
    await flushPromises()

    expect(toast.error).toHaveBeenCalledWith('create failed')

    await formButtons[0]!.trigger('click')
    await flushPromises()
    ;(wrapper.vm as unknown as { openCreateForm: () => void }).openCreateForm()
    await flushPromises()

    expect(
      (wrapper.find('input[placeholder="my-webhook"]').element as HTMLInputElement).value,
    ).toBe('')
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('')
  })

  it('does not start a second delete request for the same webhook while the first one is still running', async () => {
    vi.useFakeTimers()
    let resolveDelete!: () => void
    getWebhooks.mockResolvedValue({
      webhooks: [
        { id: 'a', name: 'hook-a', type: 'generic', prompt: 'p', enabled: true, event_count: 0 },
      ],
    })
    deleteWebhook.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve
        }),
    )

    const wrapper = mountPanel()
    await flushPromises()

    const deleteBtn = wrapper.find('.webhook-panel__delete')
    await deleteBtn.trigger('click')
    await flushPromises()
    const confirmDialog = wrapper.findComponent(ConfirmDialog)
    expect(confirmDialog.exists()).toBe(true)
    expect(deleteWebhook).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1500)
    await flushPromises()
    await confirmDialog.get('button.hc-dialog__btn--danger').trigger('click')
    await flushPromises()

    await deleteBtn.trigger('click')
    await flushPromises()

    expect(deleteWebhook).toHaveBeenCalledTimes(1)

    resolveDelete()
    await flushPromises()
  })

  it('surfaces webhook load failures instead of masking them as an empty list', async () => {
    getWebhooks.mockRejectedValueOnce(new Error('webhooks offline'))

    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.text()).toContain('webhooks offline')
    expect(wrapper.text()).not.toContain('暂无 Webhook')
  })

  it('keeps the latest webhook list when an earlier reload resolves later', async () => {
    type Wh = {
      id: string
      name: string
      type: string
      prompt: string
      enabled: boolean
      event_count: number
    }
    let resolveFirst!: (value: { webhooks: Wh[] }) => void
    let resolveSecond!: (value: { webhooks: Wh[] }) => void

    getWebhooks
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecond = resolve
        }),
      )

    const wrapper = mountPanel()
    const vm = wrapper.vm as unknown as { loadWebhooks: () => Promise<void> }
    await flushPromises()

    void vm.loadWebhooks()
    await flushPromises()

    resolveSecond({
      webhooks: [
        {
          id: 'new',
          name: 'hook-new',
          type: 'generic',
          prompt: 'p',
          enabled: true,
          event_count: 0,
        },
      ],
    })
    await flushPromises()

    expect(wrapper.text()).toContain('hook-new')

    resolveFirst({
      webhooks: [
        {
          id: 'old',
          name: 'hook-old',
          type: 'generic',
          prompt: 'p',
          enabled: true,
          event_count: 0,
        },
      ],
    })
    await flushPromises()

    expect(wrapper.text()).toContain('hook-new')
    expect(wrapper.text()).not.toContain('hook-old')
  })
})

describe('WebhookPanel — 复制 Webhook URL 反馈（回归锁）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function mountWithOneHook() {
    getWebhooks.mockResolvedValue({
      webhooks: [
        { id: 'a', name: 'hook-a', type: 'generic', prompt: 'p', enabled: true, event_count: 0 },
      ],
    })
    const wrapper = mountPanel()
    await flushPromises()
    return wrapper
  }

  it('复制成功 → toast.success（写入后端生成的真实接收 URL）', async () => {
    setClipboard.mockResolvedValue(undefined)
    const wrapper = await mountWithOneHook()
    const copyBtn = wrapper.find('.webhook-panel__copy')
    expect(copyBtn.exists()).toBe(true)
    await copyBtn.trigger('click')
    await flushPromises()
    expect(setClipboard).toHaveBeenCalledWith('http://localhost:16060/api/v1/webhooks/hook-a')
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('复制失败（剪贴板抛错）→ toast.error（不静默吞错）', async () => {
    setClipboard.mockRejectedValue(new Error('clipboard denied'))
    const wrapper = await mountWithOneHook()
    await wrapper.find('.webhook-panel__copy').trigger('click')
    await flushPromises()
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.success).not.toHaveBeenCalled()
  })
})
