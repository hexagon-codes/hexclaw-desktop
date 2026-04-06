import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createRouter, createMemoryHistory } from 'vue-router'
import KnowledgeCenterView from '../KnowledgeCenterView.vue'
import IntegrationView from '../IntegrationView.vue'
import ChannelsView from '../ChannelsView.vue'
import zhCN from '@/i18n/locales/zh-CN'

const { getDocuments, uploadDocument } = vi.hoisted(() => ({
  getDocuments: vi.fn(),
  uploadDocument: vi.fn(),
}))

const { getSkills, setSkillEnabled } = vi.hoisted(() => ({
  getSkills: vi.fn(),
  setSkillEnabled: vi.fn(),
}))

const { getIMInstances, updateIMInstance } = vi.hoisted(() => ({
  getIMInstances: vi.fn(),
  updateIMInstance: vi.fn(),
}))

const { getRuntimeConfig } = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
}))

vi.mock('@/api/knowledge', () => ({
  getDocuments,
  addDocument: vi.fn(),
  deleteDocument: vi.fn(),
  searchKnowledge: vi.fn(),
  uploadDocument,
}))

vi.mock('@/api/settings', () => ({
  getRuntimeConfig,
}))

vi.mock('@/api/skills', () => ({
  getSkills,
  installSkill: vi.fn(),
  uninstallSkill: vi.fn(),
  setSkillEnabled,
  searchClawHub: vi.fn().mockResolvedValue([]),
  installFromHub: vi.fn(),
  CLAWHUB_CATEGORIES: ['all', 'coding', 'research', 'writing', 'data', 'automation', 'productivity'],
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

vi.mock('@/views/MemoryView.vue', () => ({
  default: { template: '<div data-testid="memory-view">Memory View</div>' },
}))

vi.mock('@/views/McpView.vue', () => ({
  default: { template: '<div data-testid="mcp-view">MCP View</div>' },
}))

vi.mock('@/stores/logs', () => ({
  useLogsStore: () => ({
    entries: [],
    connected: false,
    filteredEntries: [],
    connect: vi.fn(),
    disconnect: vi.fn(),
    loadHistory: vi.fn(),
    loadStats: vi.fn(),
    setFilter: vi.fn(),
    clear: vi.fn(),
  }),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: vi.fn().mockResolvedValue(() => {}),
  }),
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

async function mountWithRouter(component: object, initialPath: string) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/knowledge', component: KnowledgeCenterView },
      { path: '/knowledge/memory', component: KnowledgeCenterView },
      { path: '/integration', component: IntegrationView },
      { path: '/integration/mcp', component: IntegrationView },
      { path: '/channels', component: ChannelsView },
    ],
  })

  await router.push(initialPath)
  await router.isReady()

  const wrapper = mount(component, {
    attachTo: document.body,
    global: {
      plugins: [createPinia(), router, createTestI18n()],
      stubs: {
        PageHeader: {
          props: ['title', 'description'],
          template: '<div><slot name="actions" /></div>',
        },
        EmptyState: { template: '<div><slot /></div>' },
        LoadingState: { template: '<div>loading</div>' },
        ConfirmDialog: { template: '<div />' },
        SearchInput: {
          props: ['modelValue', 'placeholder'],
          emits: ['update:modelValue'],
          template: '<input :value="modelValue" :placeholder="placeholder" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
        teleport: true,
        transition: false,
      },
    },
  })

  return { wrapper, router }
}

describe('Workspace flows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()

    getDocuments.mockResolvedValue({ documents: [], total: 0 })
    uploadDocument.mockImplementation(async (_file: File, onProgress?: (pct: number) => void) => {
      onProgress?.(100)
      return { id: 'doc-1', title: 'Doc', chunk_count: 1, created_at: new Date().toISOString() }
    })

    getSkills.mockResolvedValue({
      dir: '/tmp/skills',
      skills: [{ name: 'demo-skill', description: 'demo', version: '1.0.0', triggers: [], tags: [] }],
    })
    setSkillEnabled.mockResolvedValue(true)

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
    getRuntimeConfig.mockResolvedValue({
      knowledge: { enabled: true },
    })
  })

  it('uploads documents from Knowledge Center and can switch to memory tab', async () => {
    const { wrapper, router } = await mountWithRouter(KnowledgeCenterView, '/knowledge')
    await flushPromises()

    expect(wrapper.text()).toContain('知识库')

    const fileInput = wrapper.find('input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', {
      configurable: true,
      value: [new File(['alpha'], 'alpha.md', { type: 'text/markdown' })],
    })

    await fileInput.trigger('change')
    await flushPromises()

    expect(uploadDocument).toHaveBeenCalledTimes(1)
    expect(getDocuments).toHaveBeenCalledTimes(2)

    const memoryTab = wrapper.findAll('button').find((btn) => btn.text().includes('记忆'))
    expect(memoryTab).toBeDefined()
    await memoryTab!.trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/knowledge/memory')
    expect(wrapper.find('[data-testid="memory-view"]').exists()).toBe(true)
  })

  it('switches to Skills tab in Integration and toggles a skill', async () => {
    localStorage.setItem('hexclaw_disabled_skills', JSON.stringify(['demo-skill']))

    const { wrapper, router } = await mountWithRouter(IntegrationView, '/integration')
    await flushPromises()

    const skillsTab = wrapper.findAll('button').find((btn) => btn.text().includes('工具能力'))
    expect(skillsTab).toBeDefined()
    await skillsTab!.trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/integration')
    expect(wrapper.text()).toContain('demo-skill')

    const skillTitle = wrapper.findAll('button').find((btn) => btn.text().includes('demo-skill'))
    expect(skillTitle).toBeDefined()
    await skillTitle!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('已禁用')

    const enableBtn = wrapper.findAll('button').find((btn) => btn.attributes('title') === '启用技能')
    expect(enableBtn).toBeDefined()
    await enableBtn!.trigger('click')
    await flushPromises()

    expect(setSkillEnabled).toHaveBeenCalledWith('demo-skill', true)
    expect(wrapper.text()).toContain('已启用')
  })

  it('edits a feishu instance on Channels page', async () => {
    const { wrapper } = await mountWithRouter(ChannelsView, '/channels')
    await flushPromises()

    expect(wrapper.text()).toContain('飞书')

    const configBtn = wrapper.findAll('button').find((btn) => btn.text().includes('配置'))
    expect(configBtn).toBeDefined()
    await configBtn!.trigger('click')
    await flushPromises()

    const nameInput = wrapper.find('input[placeholder="输入实例名称"]')
    await nameInput.setValue('飞书-工作台')

    const saveBtn = wrapper.findAll('button').find((btn) => btn.text().includes('保存'))
    expect(saveBtn).toBeDefined()
    await saveBtn!.trigger('click')
    await flushPromises()

    expect(updateIMInstance).toHaveBeenCalledWith('feishu-1', expect.objectContaining({
      name: '飞书-工作台',
    }))
    expect(getIMInstances).toHaveBeenCalledTimes(2)
  })
})
