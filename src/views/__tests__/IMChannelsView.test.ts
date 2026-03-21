import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import IMChannelsView from '../IMChannelsView.vue'
import zhCN from '@/i18n/locales/zh-CN'

const { getIMInstances, updateIMInstance } = vi.hoisted(() => ({
  getIMInstances: vi.fn(),
  updateIMInstance: vi.fn(),
}))

vi.mock('@/api/im-channels', async () => {
  const actual = await vi.importActual<typeof import('@/api/im-channels')>('@/api/im-channels')
  return {
    ...actual,
    getIMInstances,
    createIMInstance: vi.fn(),
    updateIMInstance,
    deleteIMInstance: vi.fn(),
    testIMInstance: vi.fn(),
  }
})

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
})
