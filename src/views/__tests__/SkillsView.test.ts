import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import SkillsView from '../SkillsView.vue'
import zhCN from '@/i18n/locales/zh-CN'

const { getSkills, setSkillEnabled } = vi.hoisted(() => ({
  getSkills: vi.fn(),
  setSkillEnabled: vi.fn(),
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

function mountSkillsView() {
  return mount(SkillsView, {
    global: {
      plugins: [createTestI18n()],
      stubs: {
        PageHeader: {
          props: ['title', 'description'],
          template: '<div><slot name="actions" /></div>',
        },
        EmptyState: { template: '<div><slot /></div>' },
        LoadingState: { template: '<div>loading</div>' },
        SearchInput: {
          props: ['modelValue', 'placeholder'],
          emits: ['update:modelValue'],
          template: '<input :value="modelValue" :placeholder="placeholder" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
      },
    },
  })
}

describe('SkillsView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    localStorage.setItem('hexclaw_disabled_skills', JSON.stringify(['demo-skill']))
    getSkills.mockResolvedValue({
      dir: '/tmp/skills',
      skills: [
        {
          name: 'demo-skill',
          description: 'demo',
          version: '1.0.0',
          triggers: [],
          tags: [],
        },
      ],
    })
    setSkillEnabled.mockResolvedValue({
      success: false,
      enabled: true,
      source: 'local-fallback',
    })
  })

  it('keeps local disabled state when backend does not return enabled and can re-enable it', async () => {
    const wrapper = mountSkillsView()
    await flushPromises()

    const titleBtn = wrapper.findAll('button').find((btn) => btn.text().includes('demo-skill'))
    expect(titleBtn).toBeDefined()
    await titleBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('已禁用')

    const enableBtn = wrapper.findAll('button').find((btn) => btn.attributes('title') === '启用技能')
    expect(enableBtn).toBeDefined()
    await enableBtn!.trigger('click')
    await flushPromises()

    expect(setSkillEnabled).toHaveBeenCalledWith('demo-skill', true)
    expect(wrapper.text()).toContain('已启用')
    expect(wrapper.text()).toContain('本地偏好')
  })

  it('uses runtime state when backend exposes enabled status', async () => {
    getSkills.mockResolvedValueOnce({
      dir: '/tmp/skills',
      skills: [
        {
          name: 'runtime-skill',
          description: 'runtime',
          version: '1.0.0',
          triggers: [],
          tags: [],
          enabled: false,
        },
      ],
    })
    setSkillEnabled.mockResolvedValueOnce({
      success: true,
      enabled: true,
      effective_enabled: true,
      source: 'backend',
      message: 'ok',
    })

    const wrapper = mountSkillsView()
    await flushPromises()

    const titleBtn = wrapper.findAll('button').find((btn) => btn.text().includes('runtime-skill'))
    await titleBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('运行时状态')

    const enableBtn = wrapper.findAll('button').find((btn) => btn.attributes('title') === '启用技能')
    await enableBtn!.trigger('click')
    await flushPromises()

    expect(setSkillEnabled).toHaveBeenCalledWith('runtime-skill', true)
    expect(wrapper.text()).toContain('已启用')
  })
})
