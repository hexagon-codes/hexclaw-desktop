/**
 * BUG-20260703 P2-4 — Agent 温度/max_tokens/skills 契约三方齐备但 AgentsView 无录入口。
 *
 * 编辑弹窗补「高级参数」区；温度三态与后端 OptionalFloat 契约对齐：
 * 空输入 = null（清除回「未设跟随模型默认」）/ 显式 0 = 确定性采样 / 数值 = 设置。
 * 后端锁 api/bug_20260703_p2_4_agent_temperature_test.go +
 * router/bug_20260703_p2_4_temperature_migration_test.go +
 * engine/bug_20260703_p2_4_temperature_metadata_test.go。
 * harness 约定参考同目录 bug-20260703-d3-agent-edit-lockout.test.ts。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createRouter, createMemoryHistory } from 'vue-router'
import zhCN from '@/i18n/locales/zh-CN'

const { getRoles, getAgents, getRules, addRule, deleteRule, setDefaultAgent, registerAgent, unregisterAgent, updateAgent } = vi.hoisted(() => ({
  getRoles: vi.fn(),
  getAgents: vi.fn(),
  getRules: vi.fn(),
  addRule: vi.fn(),
  deleteRule: vi.fn(),
  setDefaultAgent: vi.fn(),
  registerAgent: vi.fn(),
  unregisterAgent: vi.fn(),
  updateAgent: vi.fn(),
}))
const { getSkills } = vi.hoisted(() => ({ getSkills: vi.fn() }))
const { getOllamaStatus } = vi.hoisted(() => ({ getOllamaStatus: vi.fn() }))
const { getAssistantSoul, updateAssistantSoul } = vi.hoisted(() => ({
  getAssistantSoul: vi.fn(),
  updateAssistantSoul: vi.fn(),
}))

vi.mock('@/api/config', () => ({
  getLLMConfig: vi.fn().mockResolvedValue({
    default: '智谱',
    providers: { 智谱: { api_key: '****z', base_url: 'https://x', model: 'glm-5', compatible: 'openai' } },
    routing: { enabled: false, strategy: 'cost-aware' },
    cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
  }),
  updateLLMConfig: vi.fn(),
}))
vi.mock('@/api/ollama', () => ({ getOllamaStatus }))
vi.mock('@/api/skills', () => ({ getSkills }))
vi.mock('@/utils/secure-store', () => ({
  saveSecureValue: vi.fn().mockResolvedValue(undefined),
  loadSecureValue: vi.fn().mockResolvedValue(null),
  removeSecureValue: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@tauri-apps/plugin-store', () => {
  class MockLazyStore {
    async get() { return null }
    async set() {}
    async save() {}
    async delete() {}
  }
  return { LazyStore: MockLazyStore }
})
vi.mock('@/api/agents', () => ({
  getRoles, getAgents, getRules, addRule, deleteRule, setDefaultAgent,
  registerAgent, unregisterAgent, updateAgent,
}))
vi.mock('@/api/assistant', () => ({ getAssistantSoul, updateAssistantSoul }))
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

async function mountView() {
  const AgentsView = (await import('../AgentsView.vue')).default
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/agents', component: AgentsView }] })
  await router.push('/agents')
  await router.isReady()
  return mount(AgentsView, {
    global: {
      plugins: [createPinia(), createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } }), router],
      stubs: {
        PageHeader: { template: '<div><slot name="actions" /></div>' },
        EmptyState: { template: '<div><slot /></div>' },
        LoadingState: { template: '<div>loading</div>' },
        SearchInput: { props: ['modelValue'], template: '<input />' },
        ConfirmDialog: { template: '<div />' },
        teleport: true,
        transition: false,
      },
    },
  })
}

type AdvVm = {
  editTemperature: string
  editMaxTokens: string
  editSkills: string[]
  editFormValid: boolean
}

async function openEdit(wrapper: Awaited<ReturnType<typeof mountView>>) {
  const editBtn = wrapper.findAll('button').find((b) => b.text().trim() === '编辑')
  expect(editBtn).toBeTruthy()
  await editBtn!.trigger('click')
  await flushPromises()
}

async function expandAdvanced(wrapper: Awaited<ReturnType<typeof mountView>>) {
  await wrapper.find('[data-testid="agent-adv-toggle"]').trigger('click')
  await flushPromises()
}

async function clickSave(wrapper: Awaited<ReturnType<typeof mountView>>) {
  const btn = wrapper.findAll('button').find((b) => b.text().trim() === '保存')
  expect(btn).toBeTruthy()
  await btn!.trigger('click')
  await flushPromises()
}

describe('BUG-20260703 P2-4 — Agent 高级参数录入口', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getOllamaStatus.mockResolvedValue({ running: false, models: [] })
    getAssistantSoul.mockResolvedValue({ system_prompt: '', is_custom: false, default_prompt: '你是小蟹。' })
    getRoles.mockResolvedValue({ roles: [] })
    getAgents.mockResolvedValue({
      agents: [{
        name: 'tutor', display_name: '家教', provider: '', model: '',
        system_prompt: '教数学', temperature: 0.7, max_tokens: 4096, skills: ['search'],
      }],
      total: 1, default: '',
    })
    getRules.mockResolvedValue({ rules: [], total: 0 })
    getSkills.mockResolvedValue({ skills: [
      { name: 'search', description: '联网搜索' },
      { name: 'summary', description: '本地摘要' },
    ], total: 2, dir: '' })
    updateAgent.mockResolvedValue(undefined)
  })

  it('展开高级区：温度/max_tokens 按存量预填，skills 拉取并高亮已挂载项', async () => {
    const w = await mountView()
    await flushPromises()
    await openEdit(w)
    await expandAdvanced(w)

    expect((w.find('[data-testid="agent-adv-temperature"]').element as HTMLInputElement).value).toBe('0.7')
    expect((w.find('[data-testid="agent-adv-maxtokens"]').element as HTMLInputElement).value).toBe('4096')
    expect(getSkills).toHaveBeenCalled()
    expect(w.find('[data-testid="agent-adv-skill-search"]').attributes('aria-pressed')).toBe('true')
    expect(w.find('[data-testid="agent-adv-skill-summary"]').attributes('aria-pressed')).toBe('false')
  })

  it('清空温度输入保存 → 发 temperature: null（清除回未设）', async () => {
    const w = await mountView()
    await flushPromises()
    await openEdit(w)
    await expandAdvanced(w)
    await w.find('[data-testid="agent-adv-temperature"]').setValue('')
    await clickSave(w)

    expect(updateAgent).toHaveBeenCalledWith('tutor', expect.objectContaining({ temperature: null }))
  })

  it('显式温度 0 保存 → 发 temperature: 0（确定性采样，不再被当未设吞掉）', async () => {
    const w = await mountView()
    await flushPromises()
    await openEdit(w)
    await expandAdvanced(w)
    await w.find('[data-testid="agent-adv-temperature"]').setValue('0')
    await clickSave(w)

    expect(updateAgent).toHaveBeenCalledWith('tutor', expect.objectContaining({ temperature: 0 }))
  })

  it('越界温度 → 表单无效、保存被拦', async () => {
    const w = await mountView()
    await flushPromises()
    await openEdit(w)
    await expandAdvanced(w)
    await w.find('[data-testid="agent-adv-temperature"]').setValue('3')
    await nextTick()

    expect((w.vm as unknown as AdvVm).editFormValid).toBe(false)
    await clickSave(w)
    expect(updateAgent).not.toHaveBeenCalled()
    expect(w.text()).toContain('温度须在 0 ~ 2 之间')
  })

  it('切换 skill 挂载并保存 → skills 全量覆盖发出', async () => {
    const w = await mountView()
    await flushPromises()
    await openEdit(w)
    await expandAdvanced(w)
    await w.find('[data-testid="agent-adv-skill-summary"]').trigger('click')
    await w.find('[data-testid="agent-adv-skill-search"]').trigger('click')
    await clickSave(w)

    expect(updateAgent).toHaveBeenCalledWith('tutor', expect.objectContaining({ skills: ['summary'] }))
  })

  it('max_tokens 清空保存 → 发 0（int 契约未设）', async () => {
    const w = await mountView()
    await flushPromises()
    await openEdit(w)
    await expandAdvanced(w)
    await w.find('[data-testid="agent-adv-maxtokens"]').setValue('')
    await clickSave(w)

    expect(updateAgent).toHaveBeenCalledWith('tutor', expect.objectContaining({ max_tokens: 0 }))
  })
})
