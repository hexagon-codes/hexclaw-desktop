import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
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

vi.mock('@/api/webhook', () => ({
  getWebhooks,
  createWebhook,
  deleteWebhook,
  webhookUrlFor: (name: string) => `http://localhost:16060/api/v1/webhooks/${name}`,
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => toast,
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

  it('loads, creates, and deletes webhooks', async () => {
    const hooks: { id: string; name: string; type: string; prompt: string; enabled: boolean; event_count: number }[] = [
      { id: 'a', name: 'hook-a', type: 'generic', prompt: 'p-a', enabled: true, event_count: 0 },
    ]
    getWebhooks.mockImplementation(async () => ({ webhooks: [...hooks] }))
    createWebhook.mockImplementation(async (payload) => {
      hooks.push({ id: 'new', name: payload.name, type: payload.type, prompt: payload.prompt, enabled: true, event_count: 0 })
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

    expect((wrapper.find('input[placeholder="my-webhook"]').element as HTMLInputElement).value).toBe('')
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('')
  })

  it('does not start a second delete request for the same webhook while the first one is still running', async () => {
    let resolveDelete!: () => void
    getWebhooks.mockResolvedValue({
      webhooks: [{ id: 'a', name: 'hook-a', type: 'generic', prompt: 'p', enabled: true, event_count: 0 }],
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
    type Wh = { id: string; name: string; type: string; prompt: string; enabled: boolean; event_count: number }
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
      webhooks: [{ id: 'new', name: 'hook-new', type: 'generic', prompt: 'p', enabled: true, event_count: 0 }],
    })
    await flushPromises()

    expect(wrapper.text()).toContain('hook-new')

    resolveFirst({
      webhooks: [{ id: 'old', name: 'hook-old', type: 'generic', prompt: 'p', enabled: true, event_count: 0 }],
    })
    await flushPromises()

    expect(wrapper.text()).toContain('hook-new')
    expect(wrapper.text()).not.toContain('hook-old')
  })
})
