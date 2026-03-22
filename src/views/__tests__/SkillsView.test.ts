import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import SkillsView from '../SkillsView.vue'
import { useAppStore } from '@/stores/app'
import zhCN from '@/i18n/locales/zh-CN'

const { getSkills, setSkillEnabled, searchClawHub, installFromHub, uninstallSkill, installSkill } = vi.hoisted(() => ({
  getSkills: vi.fn(),
  setSkillEnabled: vi.fn(),
  searchClawHub: vi.fn(),
  installFromHub: vi.fn(),
  uninstallSkill: vi.fn(),
  installSkill: vi.fn(),
}))

vi.mock('@/api/skills', () => ({
  getSkills,
  installSkill,
  uninstallSkill,
  setSkillEnabled,
  searchClawHub,
  installFromHub,
  CLAWHUB_CATEGORIES: ['all', 'coding', 'research', 'writing', 'data', 'automation', 'productivity'],
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue('ok'),
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
  const pinia = createPinia()
  setActivePinia(pinia)
  return mount(SkillsView, {
    attachTo: document.body,
    global: {
      plugins: [createTestI18n(), pinia],
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
        teleport: true,
        transition: false,
      },
    },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
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
    installSkill.mockResolvedValue({
      name: 'demo-skill',
      description: 'demo',
      version: '1.0.0',
      message: 'installed',
    })
    searchClawHub.mockResolvedValue([])
    installFromHub.mockResolvedValue(undefined)
    uninstallSkill.mockResolvedValue(undefined)
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

  it('restarts the engine after a runtime toggle that requires restart', async () => {
    getSkills
      .mockResolvedValueOnce({
        dir: '/tmp/skills',
        skills: [
          {
            name: 'runtime-skill',
            description: 'runtime',
            version: '1.0.0',
            triggers: [],
            tags: [],
            enabled: true,
          },
        ],
      })
      .mockResolvedValueOnce({
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
      enabled: false,
      effective_enabled: false,
      requires_restart: true,
      source: 'backend',
      message: '配置已保存，需重启引擎后生效。',
    })

    const wrapper = mountSkillsView()
    const appStore = useAppStore()
    vi.spyOn(appStore, 'restartSidecar').mockResolvedValue(true)
    await flushPromises()

    const titleBtn = wrapper.findAll('button').find((btn) => btn.text().includes('runtime-skill'))
    await titleBtn!.trigger('click')
    await flushPromises()

    const disableBtn = wrapper.findAll('button').find((btn) => btn.attributes('title') === '禁用技能')
    await disableBtn!.trigger('click')
    await flushPromises()

    expect(appStore.restartSidecar).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('已禁用')
  })

  it('loads hub catalog only after switching to the hub tab', async () => {
    const wrapper = mountSkillsView()
    await flushPromises()

    expect(searchClawHub).not.toHaveBeenCalled()

    const hubTab = wrapper.findAll('button').find((btn) => btn.text().includes('技能市场'))
    expect(hubTab).toBeDefined()
    await hubTab!.trigger('click')
    await flushPromises()

    expect(searchClawHub).toHaveBeenCalledWith(undefined, 'all')
  })

  it('surfaces hub search errors instead of masking them with mock data', async () => {
    searchClawHub.mockRejectedValueOnce(new Error('hub unavailable'))

    const wrapper = mountSkillsView()
    await flushPromises()

    const hubTab = wrapper.findAll('button').find((btn) => btn.text().includes('技能市场'))
    await hubTab!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('hub unavailable')
    expect(wrapper.text()).not.toContain('即将上线')
  })

  it('keeps the latest hub results when an earlier request resolves later', async () => {
    const first = deferred<Array<Record<string, unknown>>>()
    const second = deferred<Array<Record<string, unknown>>>()

    searchClawHub
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)

    const wrapper = mountSkillsView()
    await flushPromises()

    const hubTab = wrapper.findAll('button').find((btn) => btn.text().includes('技能市场'))
    await hubTab!.trigger('click')
    await flushPromises()

    const researchChip = wrapper.findAll('button').find((btn) => btn.text().includes('研究'))
    expect(researchChip).toBeDefined()
    await researchChip!.trigger('click')
    await flushPromises()

    second.resolve([
      {
        name: 'fresh-skill',
        description: 'fresh',
        author: 'openclaw',
        version: '1.0.0',
        tags: [],
        downloads: 1,
        category: 'research',
      },
    ])
    await flushPromises()

    expect(wrapper.text()).toContain('fresh-skill')

    first.resolve([
      {
        name: 'stale-skill',
        description: 'stale',
        author: 'openclaw',
        version: '1.0.0',
        tags: [],
        downloads: 1,
        category: 'coding',
      },
    ])
    await flushPromises()

    expect(wrapper.text()).toContain('fresh-skill')
    expect(wrapper.text()).not.toContain('stale-skill')
  })

  it('updates hub install state after install and uninstall in the same session', async () => {
    getSkills
      .mockResolvedValueOnce({ dir: '/tmp/skills', skills: [] })
      .mockResolvedValueOnce({
        dir: '/tmp/skills',
        skills: [
          {
            name: 'hub-skill',
            description: 'from hub',
            version: '1.0.0',
            author: 'openclaw',
            triggers: [],
            tags: [],
          },
        ],
      })
      .mockResolvedValueOnce({ dir: '/tmp/skills', skills: [] })
    searchClawHub.mockResolvedValueOnce([
      {
        name: 'hub-skill',
        description: 'from hub',
        version: '1.0.0',
        author: 'openclaw',
        tags: [],
        downloads: 2,
        category: 'coding',
      },
    ])

    const wrapper = mountSkillsView()
    const appStore = useAppStore()
    vi.spyOn(appStore, 'restartSidecar').mockResolvedValue(true)
    await flushPromises()

    const hubTab = wrapper.findAll('button').find((btn) => btn.text().includes('技能市场'))
    await hubTab!.trigger('click')
    await flushPromises()

    const installBtn = wrapper.findAll('button').find((btn) => btn.text() === '安装')
    expect(installBtn).toBeDefined()
    await installBtn!.trigger('click')
    await flushPromises()

    expect(installFromHub).toHaveBeenCalledWith('hub-skill')
    expect(appStore.restartSidecar).toHaveBeenCalledTimes(1)
    expect(
      wrapper.findAll('button').some((btn) => btn.text() === '已安装' && btn.attributes('disabled') !== undefined),
    ).toBe(true)

    const installedTab = wrapper.findAll('button').find((btn) => btn.text().includes('已安装'))
    await installedTab!.trigger('click')
    await flushPromises()

    const uninstallBtn = wrapper.findAll('button').find((btn) => btn.attributes('title') === '删除')
    expect(uninstallBtn).toBeDefined()
    await uninstallBtn!.trigger('click')
    await flushPromises()

    const confirmBtn = wrapper.findAll('button').find((btn) => btn.text() === '删除')
    expect(confirmBtn).toBeDefined()
    await confirmBtn!.trigger('click')
    await flushPromises()

    expect(uninstallSkill).toHaveBeenCalledWith('hub-skill')
    expect(appStore.restartSidecar).toHaveBeenCalledTimes(2)

    await hubTab!.trigger('click')
    await flushPromises()

    expect(wrapper.findAll('button').some((btn) => btn.text() === '安装')).toBe(true)
    expect(
      wrapper.findAll('button').some((btn) => btn.text() === '已安装' && btn.attributes('disabled') !== undefined),
    ).toBe(false)
  })

  it('restarts the engine after local skill install', async () => {
    getSkills
      .mockResolvedValueOnce({ dir: '/tmp/skills', skills: [] })
      .mockResolvedValueOnce({
        dir: '/tmp/skills',
        skills: [
          {
            name: 'local-skill',
            description: 'local',
            version: '1.0.0',
            author: 'openclaw',
            triggers: [],
            tags: [],
          },
        ],
      })

    installSkill.mockResolvedValueOnce({
      name: 'local-skill',
      description: 'local',
      version: '1.0.0',
      message: 'installed',
    })

    const wrapper = mountSkillsView()
    const appStore = useAppStore()
    vi.spyOn(appStore, 'restartSidecar').mockResolvedValue(true)
    await flushPromises()

    ;(wrapper.vm as { openInstallDialog: () => void }).openInstallDialog()
    await flushPromises()

    const input = wrapper.find('input[placeholder*="例如"]')
    expect(input.exists()).toBe(true)
    await input.setValue('skills/local-skill')

    const installBtn = wrapper.findAll('button').find((btn) => btn.text() === '安装')
    expect(installBtn).toBeDefined()
    await installBtn!.trigger('click')
    await flushPromises()

    expect(installSkill).toHaveBeenCalledWith('skills/local-skill')
    expect(appStore.restartSidecar).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('local-skill')
  })
})
