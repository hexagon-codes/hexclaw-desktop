import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '@/features/k12/i18n/zh-CN'
import K12ProfileForm from '@/features/k12/views/K12ProfileForm.vue'
import { scenarioRegistry } from '@/shell/scenario/registry'

const api = vi.hoisted(() => ({
  getRoles: vi.fn().mockResolvedValue({ roles: [], total: 0 }),
  getAgents: vi.fn().mockResolvedValue({ agents: [], total: 0, default: '' }),
  getRules: vi.fn().mockResolvedValue({ rules: [], total: 0 }),
}))

vi.mock('@/api/agents', () => ({
  ...api,
  addRule: vi.fn(),
  deleteRule: vi.fn(),
  setDefaultAgent: vi.fn(),
  registerAgent: vi.fn(),
  unregisterAgent: vi.fn(),
  updateAgent: vi.fn(),
}))
vi.mock('@/api/assistant', () => ({
  getAssistantSoul: vi.fn().mockResolvedValue({ soul: '', default_prompt: '' }),
  updateAssistantSoul: vi.fn(),
}))
vi.mock('@/api/skills', () => ({
  getSkills: vi.fn().mockResolvedValue({ skills: [], total: 0 }),
}))
vi.mock('@/api/config', () => ({
  getLLMConfig: vi
    .fn()
    .mockResolvedValue({ default: '', providers: {}, routing: { enabled: false }, cache: {} }),
  updateLLMConfig: vi.fn(),
}))
vi.mock('@/api/ollama', () => ({
  getOllamaStatus: vi.fn().mockResolvedValue({ running: false, models: [] }),
}))
vi.mock('@/utils/secure-store', () => ({
  saveSecureValue: vi.fn(),
  loadSecureValue: vi.fn().mockResolvedValue(null),
  removeSecureValue: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-store', () => {
  class MockLazyStore {
    async get() {
      return null
    }
    async set() {}
    async save() {}
    async delete() {}
  }
  return { LazyStore: MockLazyStore }
})

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

async function mountView() {
  const AgentsView = (await import('../AgentsView.vue')).default
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/agents', component: AgentsView }],
  })
  await router.push('/agents')
  await router.isReady()

  return mount(AgentsView, {
    global: {
      plugins: [createPinia(), i18n(), router],
      stubs: {
        PageToolbar: { template: '<div><slot name="tabs" /><slot name="actions" /></div>' },
        LoadingState: { template: '<div>loading</div>' },
        ConfirmDialog: { template: '<div />' },
        teleport: true,
        transition: false,
      },
    },
    attachTo: document.body,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  scenarioRegistry.reset()
  scenarioRegistry.registerScenarioTemplate({
    key: 'k12-tutor',
    icon: '🎓',
    nameKey: 'k12.templateName',
    descKey: 'k12.templateDesc',
    form: K12ProfileForm,
  })
})

afterEach(() => scenarioRegistry.reset())

describe('K12 专属建档表单的宿主返回链路', () => {
  it('上一步回到通用“选择起点”可见终态，且专属表单没有伪造示例入口', async () => {
    const wrapper = await mountView()
    await flushPromises()

    await wrapper.find('[data-testid="segmented-templates"]').trigger('click')
    await wrapper
      .findAll('.hc-tplcard')
      .find((card) => card.text().includes('作业辅导助手'))!
      .trigger('click')
    expect(wrapper.find('.k12pf').exists()).toBe(true)
    expect(wrapper.find('[data-testid="k12pf-preview"]').exists()).toBe(false)

    await wrapper.find('[data-testid="k12pf-back"]').trigger('click')
    await flushPromises()
    await nextTick()
    await nextTick()

    expect(wrapper.find('.k12pf').exists()).toBe(false)
    expect(wrapper.find('[data-testid="start-blank"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="start-from-library"]').exists()).toBe(true)
    const dialog = document.body.querySelector<HTMLElement>('[data-testid="add-agent-dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('role')).toBe('dialog')
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(dialog)
    expect(document.activeElement).not.toBe(document.body)
  })
})
