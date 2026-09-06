/**
 * BUG-20260711-H（复现→修复→锁定）：作业辅导助手（K12 场景实例）不能选择 LLM 模型。
 *
 * 根因：K12 建档写死 model:''/provider:''（跟随全局默认），改档表单（K12ProfileForm）没有
 * 模型选择入口，而场景实例卡的「编辑」只开 K12ProfileForm——普通智能体编辑弹窗的
 * 服务商→模型级联对 K12 实例不可达。
 *
 * 根修（对齐原型 app.html tutorForm「模型 · 默认已配好强推理模型，可不管」高级折叠）：
 * K12ProfileForm 高级区新增 服务商→模型 两级级联（与 AgentsView 同数据源
 * settingsStore.runtimeProviders/availableModels），默认 ''=跟随全局默认；
 * 建档/改档均随 registerAgent/updateAgent 回写 provider/model。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12ProfileForm from '../views/K12ProfileForm.vue'
import HcSelect from '@/components/common/HcSelect.vue'
import { useSettingsStore } from '@/stores/settings'

const h = vi.hoisted(() => ({
  registerSpy: vi.fn().mockResolvedValue({}),
  updateSpy: vi.fn().mockResolvedValue({}),
  bundleSpy: vi.fn().mockResolvedValue({}),
}))
vi.mock('@/api/agents', () => ({
  registerAgent: (a: unknown) => h.registerSpy(a),
  unregisterAgent: vi.fn().mockResolvedValue({}),
  updateAgent: (name: string, u: unknown) => h.updateSpy(name, u),
  getAgents: vi.fn().mockResolvedValue({ agents: [], total: 0, default: '' }),
  getRoles: vi.fn().mockResolvedValue({ roles: [] }),
}))
vi.mock('@/api/k12', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/k12')>()),
  k12UpdateProfileBundle: (r: unknown) => h.bundleSpy(r),
  k12GetTextbookBindingOptions: vi.fn().mockResolvedValue({ items: [] }),
  k12GetProfile: vi.fn().mockResolvedValue({
    child_name: '小明', grade_term: '五年级上', textbook_edition: '人教版', revision: 0,
  }),
  k12GetCurriculumProgress: vi.fn().mockResolvedValue({
    progress: {
      revision: 1,
      textbook_manifest_id: 'manifest-1',
      volume: '五年级上册',
      unit_id: 'unit-1',
    },
  }),
  k12GetWeeklyPracticeSettings: vi.fn().mockResolvedValue({
    revision: 1,
    timezone: 'Asia/Shanghai',
    due_review_enabled: true,
    textbook_consolidation_enabled: false,
    arithmetic_warmup_enabled: false,
    arithmetic_minutes: 2,
  }),
  k12ProvisionCron: vi.fn().mockResolvedValue({ provisioned: [] }),
}))

function i18n() {
  return createI18n({
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}
const B = () => new DOMWrapper(document.body)

/** 预置两个已启用 Provider（zhipu 两模型 / deepseek 一模型），K12 表单应与 AgentsView 同数据源 */
function seedProviders() {
  const s = useSettingsStore()
  s.config = {
    llm: {
      defaultModel: 'glm-4.5', defaultProviderId: 'p-zhipu',
      providers: [
        { id: 'p-zhipu', name: '智谱 AI', type: 'zhipu', backendKey: 'zhipu', enabled: true, apiKey: 'k', baseUrl: '', models: [{ id: 'glm-4.5', name: 'GLM-4.5' }, { id: 'glm-5.2', name: 'GLM-5.2' }], selectedModelId: 'glm-4.5' },
        { id: 'p-ds', name: 'DeepSeek', type: 'deepseek', backendKey: 'deepseek', enabled: true, apiKey: 'k', baseUrl: '', models: [{ id: 'deepseek-r2', name: 'DeepSeek R2' }], selectedModelId: 'deepseek-r2' },
      ],
    },
    security: { gateway_enabled: true, injection_detection: true, pii_filter: false, content_filter: true, max_tokens_per_request: 8192, rate_limit_rpm: 60 },
    general: { language: 'zh-CN', log_level: 'info', data_dir: '', auto_start: false, defaultAgentRole: '' },
    notification: { system_enabled: true, sound_enabled: false, agent_complete: true },
    mcp: { default_protocol: 'stdio' },
  } as unknown as typeof s.config
}

function mountEdit(pinia: ReturnType<typeof createPinia>) {
  return mount(K12ProfileForm, {
    props: {
      agent: {
        name: 'k12-tutor-x',
        display_name: '小明的辅导助手 · 五年级',
        provider: '',
        model: '',
        metadata: { scenario: 'k12-tutor', 'k12.child_name': '小明', 'k12.grade_term': '五年级上', 'k12.textbook_edition': '人教版', avatar: '🎓' },
      },
    },
    global: { plugins: [pinia, i18n()], stubs: { MarkdownRenderer: true } },
    attachTo: document.body,
  })
}

describe('BUG-20260711-H：K12 辅导助手必须能选择 LLM 模型（高级折叠·跟随默认可不管）', () => {
  let pinia: ReturnType<typeof createPinia>
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia) // 与组件共享同一 pinia，seedProviders 写的正是组件读的 settings store
    document.body.innerHTML = ''
    h.registerSpy.mockClear()
    h.updateSpy.mockClear()
    h.bundleSpy.mockReset().mockResolvedValue({})
    seedProviders()
  })

  it('★改档表单含 服务商→模型 级联，选模型后由唯一 bundle 的 agent_config 原子回写', async () => {
    const w = mountEdit(pinia)
    const modelFold = B().find('[data-testid="k12pf-model"]')
    expect(modelFold.exists(), '高级区必须有模型选择折叠（对齐原型 tutorForm）').toBe(true)

    // 级联：选服务商 智谱 → 模型下拉出现该 provider 的模型
    const selects = w.findAllComponents(HcSelect)
    const providerSel = selects.find((s) => (s.attributes('data-testid') || '') === 'k12pf-provider')!
    expect(providerSel, '服务商下拉存在').toBeTruthy()
    providerSel.vm.$emit('update:modelValue', 'zhipu')
    await flushPromises()
    const modelSel = w.findAllComponents(HcSelect).find((s) => (s.attributes('data-testid') || '') === 'k12pf-model-select')!
    const opts = (modelSel.props('options') as { value: string; label: string }[]).map((o) => o.value)
    expect(opts).toContain('glm-5.2')
    modelSel.vm.$emit('update:modelValue', 'glm-5.2')
    await flushPromises()

    await B().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()
    const upd = h.bundleSpy.mock.calls[0]![0] as {
      agent_config: { provider?: string; model?: string }
    }
    expect(upd.agent_config.provider).toBe('zhipu')
    expect(upd.agent_config.model).toBe('glm-5.2')
    expect(h.updateSpy).not.toHaveBeenCalled()
  })

  it('默认不动模型（跟随全局默认）：改档保存不把 provider/model 写成非空值', async () => {
    const w = mountEdit(pinia)
    void w
    await flushPromises()
    await B().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()
    const upd = h.bundleSpy.mock.calls[0]![0] as {
      agent_config: { provider?: string; model?: string }
    }
    expect(upd.agent_config.provider ?? '').toBe('')
    expect(upd.agent_config.model ?? '').toBe('')
    expect(h.updateSpy).not.toHaveBeenCalled()
  })
})
