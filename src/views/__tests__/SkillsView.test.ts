import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import SkillsView from '../SkillsView.vue'
import { useAppStore } from '@/stores/app'
import zhCN from '@/i18n/locales/zh-CN'

const { getSkills, setSkillEnabled, searchClawHub, installFromHub, uninstallSkill, installSkill, getHubSkillContent, getSkillContent } = vi.hoisted(() => ({
  getSkills: vi.fn(),
  setSkillEnabled: vi.fn(),
  searchClawHub: vi.fn(),
  installFromHub: vi.fn(),
  uninstallSkill: vi.fn(),
  installSkill: vi.fn(),
  getHubSkillContent: vi.fn(),
  // SkillsView v0.5.0 重构新增依赖：mock 缺此导出时 vitest 报错文本渲染进组件文本、
  // 连带运行时状态分支渲染反态（此前「已启用/已禁用」2 例失败的真根因，非组件 bug）
  getSkillContent: vi.fn().mockResolvedValue({ name: 's', path: '/tmp/skills/s/SKILL.md', content: '# s' }),
}))

vi.mock('@/api/skills', () => ({
  getSkills,
  installSkill,
  uninstallSkill,
  setSkillEnabled,
  searchClawHub,
  installFromHub,
  getHubSkillContent,
  getSkillContent,
  CLAWHUB_CATEGORIES: ['all', 'coding', 'research', 'writing', 'data', 'automation', 'productivity'],
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue('ok'),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: vi.fn().mockResolvedValue(() => {}),
  }),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn().mockResolvedValue(null),
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
        SkillMarkdownPreview: {
          props: ['content', 'collapsible', 'showFrontmatter', 'allowRawToggle'],
          template: '<div class="smp-stub">{{ content }}</div>',
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

enableAutoUnmount(afterEach)

describe('SkillsView', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    getSkills.mockReset()
    setSkillEnabled.mockReset()
    searchClawHub.mockReset()
    installFromHub.mockReset()
    uninstallSkill.mockReset()
    installSkill.mockReset()
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

    const enableBtn = wrapper.findAll('button').find((btn) => btn.attributes('title') === '启用 Skill')
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

    const enableBtn = wrapper.findAll('button').find((btn) => btn.attributes('title') === '启用 Skill')
    await enableBtn!.trigger('click')
    await flushPromises()

    expect(setSkillEnabled).toHaveBeenCalledWith('runtime-skill', true)
    expect(wrapper.text()).toContain('已启用')
  })

  it('reverts optimistic toggle state when runtime enable request throws', async () => {
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
    setSkillEnabled.mockRejectedValueOnce(new Error('toggle failed'))

    const wrapper = mountSkillsView()
    await flushPromises()

    const titleBtn = wrapper.findAll('button').find((btn) => btn.text().includes('runtime-skill'))
    expect(titleBtn).toBeDefined()
    await titleBtn!.trigger('click')
    await flushPromises()

    const enableBtn = wrapper.findAll('button').find((btn) => btn.attributes('title') === '启用 Skill')
    expect(enableBtn).toBeDefined()
    await expect(enableBtn!.trigger('click')).resolves.toBeUndefined()
    await flushPromises()

    expect(wrapper.text()).toContain('已禁用')
    expect(wrapper.text()).toContain('toggle failed')
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

    const disableBtn = wrapper.findAll('button').find((btn) => btn.attributes('title') === '禁用 Skill')
    await disableBtn!.trigger('click')
    await flushPromises()

    expect(appStore.restartSidecar).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('已禁用')
  })

  it('preloads hub catalog on mount so the 市场 tab count shows without clicking it', async () => {
    searchClawHub.mockResolvedValue([
      { name: 'a', display_name: 'A', description: '', category: 'coding' },
      { name: 'b', display_name: 'B', description: '', category: 'research' },
    ])
    const wrapper = mountSkillsView()
    await flushPromises()

    // 进入页面即后台预读（无需点击市场 tab）；一次拉全量（无参），分类/搜索改客户端过滤。
    expect(searchClawHub).toHaveBeenCalledWith()
    // 「市场」tab 标签直接带上总条数
    const hubTab = wrapper.findAll('button').find((btn) => btn.text().includes('市场'))
    expect(hubTab).toBeDefined()
    expect(hubTab!.text()).toContain('2')

    // 再点市场 tab 不重复拉取（已预读）
    searchClawHub.mockClear()
    await hubTab!.trigger('click')
    await flushPromises()
    expect(searchClawHub).not.toHaveBeenCalled()
  })

  it('surfaces hub search errors instead of masking them with mock data', async () => {
    // 持续失败：mount 预读失败 + 切到市场 tab 仍失败，错误提示保留（不伪装成"即将上线"）。
    searchClawHub.mockRejectedValue(new Error('hub unavailable'))

    const wrapper = mountSkillsView()
    await flushPromises()

    const hubTab = wrapper.findAll('button').find((btn) => btn.text().includes('市场'))
    await hubTab!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('hub unavailable')
    expect(wrapper.text()).not.toContain('即将上线')
  })

  it('filters hub skills client-side by category pill without re-fetching', async () => {
    searchClawHub.mockResolvedValueOnce([
      { name: 'research-skill', description: 'r', author: 'openclaw', version: '1.0.0', tags: [], downloads: 1, category: 'research' },
      { name: 'coding-skill', description: 'c', author: 'openclaw', version: '1.0.0', tags: [], downloads: 1, category: 'coding' },
    ])

    const wrapper = mountSkillsView()
    await flushPromises()

    const hubTab = wrapper.findAll('button').find((btn) => btn.text().includes('市场'))
    await hubTab!.trigger('click')
    await flushPromises()

    // 「全部」下两类都在
    expect(wrapper.text()).toContain('research-skill')
    expect(wrapper.text()).toContain('coding-skill')

    // 点「研究」pill：仅客户端过滤出 research 分类，不再发起请求
    const researchChip = wrapper.findAll('button').find((btn) => btn.text().trim() === '研究')
    expect(researchChip).toBeDefined()
    await researchChip!.trigger('click')
    await flushPromises()

    expect(searchClawHub).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('research-skill')
    expect(wrapper.text()).not.toContain('coding-skill')
  })

  it('previews a hub skill SKILL.md before install, then installs from the preview modal', async () => {
    getSkills.mockResolvedValue({ dir: '/tmp/skills', skills: [] })
    searchClawHub.mockResolvedValue([
      { name: 'demo', description: 'a hub skill', version: '1.0.0', author: 'hex', tags: [], downloads: 3, category: 'coding' },
    ])
    getHubSkillContent.mockResolvedValue({ name: 'demo', content: '---\nname: demo\n---\n# Demo body' })

    const wrapper = mountSkillsView()
    const appStore = useAppStore()
    vi.spyOn(appStore, 'restartSidecar').mockResolvedValue(true)
    await flushPromises()

    const hubTab = wrapper.findAll('button').find((btn) => btn.text().includes('市场'))
    await hubTab!.trigger('click')
    await flushPromises()

    // 打开「安装前预览」
    const previewBtn = wrapper.findAll('button').find((btn) => btn.text() === '预览')
    expect(previewBtn).toBeDefined()
    await previewBtn!.trigger('click')
    await flushPromises()

    expect(getHubSkillContent).toHaveBeenCalledWith('demo')
    // 弹层把拉到的 SKILL.md 交给 SkillMarkdownPreview（stub 透出 content）
    expect(wrapper.find('.smp-stub').exists()).toBe(true)
    expect(wrapper.find('.smp-stub').text()).toContain('# Demo body')

    // 从预览弹层底部「安装」——取最后一个，定位到弹层内（非卡片）按钮
    const installBtns = wrapper.findAll('button').filter((btn) => btn.text() === '安装')
    expect(installBtns.length).toBeGreaterThan(0)
    await installBtns[installBtns.length - 1]!.trigger('click')
    await flushPromises()

    expect(installFromHub).toHaveBeenCalledWith('demo')
    // 安装即关闭预览弹层
    expect(wrapper.find('.smp-stub').exists()).toBe(false)
  })

  it('discards a stale preview response when the user quickly switches to another skill', async () => {
    getSkills.mockResolvedValue({ dir: '/tmp/skills', skills: [] })
    searchClawHub.mockResolvedValue([
      { name: 'aaa', description: 'A', version: '1', author: 'x', tags: [], downloads: 0, category: 'coding' },
      { name: 'bbb', description: 'B', version: '1', author: 'x', tags: [], downloads: 0, category: 'coding' },
    ])
    const dA = deferred<{ name: string; content: string }>()
    getHubSkillContent.mockImplementation((name: string) =>
      name === 'aaa' ? dA.promise : Promise.resolve({ name, content: '# BBB body' }),
    )

    const wrapper = mountSkillsView()
    await flushPromises()
    const hubTab = wrapper.findAll('button').find((b) => b.text().includes('市场'))
    await hubTab!.trigger('click')
    await flushPromises()

    const previewBtns = wrapper.findAll('button').filter((b) => b.text() === '预览')
    expect(previewBtns.length).toBe(2)

    // 先点 aaa（响应挂起未决），再点 bbb（立即返回）
    await previewBtns[0]!.trigger('click')
    await previewBtns[1]!.trigger('click')
    await flushPromises()
    expect(wrapper.find('.smp-stub').text()).toContain('# BBB body')

    // aaa 的过期响应迟到 —— 守卫必须丢弃，不得覆盖 bbb
    dA.resolve({ name: 'aaa', content: '# AAA body' })
    await flushPromises()
    expect(wrapper.find('.smp-stub').text()).toContain('# BBB body')
    expect(wrapper.find('.smp-stub').text()).not.toContain('# AAA body')
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

    const hubTab = wrapper.findAll('button').find((btn) => btn.text().includes('市场'))
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

  it('does not start a second hub install for the same skill while the first install is still running', async () => {
    const installDeferred = deferred<void>()
    getSkills.mockResolvedValueOnce({ dir: '/tmp/skills', skills: [] })
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
    installFromHub.mockImplementationOnce(() => installDeferred.promise)

    const wrapper = mountSkillsView()
    await flushPromises()

    const hubTab = wrapper.findAll('button').find((btn) => btn.text().includes('市场'))
    await hubTab!.trigger('click')
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      handleHubInstall: (skill: {
        name: string
        description: string
        version: string
        author: string
        tags: string[]
        downloads: number
        category: string
      }) => Promise<void>
    }
    const skill = {
      name: 'hub-skill',
      description: 'from hub',
      version: '1.0.0',
      author: 'openclaw',
      tags: [],
      downloads: 2,
      category: 'coding',
    }

    void vm.handleHubInstall(skill)
    await flushPromises()
    void vm.handleHubInstall(skill)
    await flushPromises()

    expect(installFromHub).toHaveBeenCalledTimes(1)

    installDeferred.resolve(undefined)
    await flushPromises()
  })

  it('restarts the engine after local skill install', async () => {
    getSkills.mockReset()
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
      .mockResolvedValue({
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

    installSkill.mockReset()
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

    const input = wrapper.find('input[type="text"][placeholder]')
    expect(input.exists()).toBe(true)
    await input.setValue('https://example.com/skills/local-skill.md')

    const installBtn = wrapper.findAll('button').find((btn) => btn.text() === '安装')
    expect(installBtn).toBeDefined()
    await installBtn!.trigger('click')
    await flushPromises()

    expect(installSkill).toHaveBeenCalledWith('https://example.com/skills/local-skill.md', 'url')
    expect(installSkill).toHaveBeenCalledTimes(1)
    expect(appStore.restartSidecar).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('local-skill')
    })
  })

  it('does not start a second local install while the first install is still running', async () => {
    const installDeferred = deferred<{
      name: string
      description: string
      version: string
      message: string
    }>()
    installSkill.mockImplementationOnce(() => installDeferred.promise)

    const wrapper = mountSkillsView()
    await flushPromises()

    ;(wrapper.vm as { openInstallDialog: () => void }).openInstallDialog()
    await flushPromises()

    const input = wrapper.find('input[type="text"][placeholder]')
    expect(input.exists()).toBe(true)
    await input.setValue('https://example.com/skills/local-skill.md')

    // Click the install button twice quickly
    const installBtn = wrapper.findAll('button').find((btn) => btn.text() === '安装')
    expect(installBtn).toBeDefined()
    await installBtn!.trigger('click')
    await flushPromises()
    await installBtn!.trigger('click')
    await flushPromises()

    expect(installSkill).toHaveBeenCalledTimes(1)

    installDeferred.resolve({
      name: 'local-skill',
      description: 'local',
      version: '1.0.0',
      message: 'installed',
    })
    await flushPromises()
  })

  it('resets the local install dialog state when it is closed and reopened after a failure', async () => {
    installSkill.mockRejectedValueOnce(new Error('install failed'))

    const wrapper = mountSkillsView()
    await flushPromises()

    ;(wrapper.vm as { openInstallDialog: () => void }).openInstallDialog()
    await flushPromises()

    const input = wrapper.find('input[type="text"][placeholder]')
    expect(input.exists()).toBe(true)
    await input.setValue('https://example.com/skills/bad-skill.md')

    const installBtn = wrapper.findAll('button').find((btn) => btn.text() === '安装')
    expect(installBtn).toBeDefined()
    await installBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('install failed')

    // Close the dialog via the X button (no explicit "取消" button exists)
    // The close button is the one with an SVG that calls closeInstallDialog
    const closeBtn = wrapper.findAll('button').find((btn) => btn.find('svg').exists() && !btn.text().trim())
    expect(closeBtn).toBeDefined()
    await closeBtn!.trigger('click')
    await flushPromises()

    ;(wrapper.vm as { openInstallDialog: () => void }).openInstallDialog()
    await flushPromises()

    const reopenedInput = wrapper.find('input[type="text"][placeholder]')
    expect((reopenedInput.element as HTMLInputElement).value).toBe('')
    expect(wrapper.text()).not.toContain('install failed')
  })

  it('clears a stale hub install error after switching away from the hub tab', async () => {
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
    installFromHub.mockRejectedValueOnce(new Error('install failed'))

    const wrapper = mountSkillsView()
    await flushPromises()

    const hubTab = wrapper.findAll('button').find((btn) => btn.text().includes('市场'))
    expect(hubTab).toBeDefined()
    await hubTab!.trigger('click')
    await flushPromises()

    const installBtn = wrapper.findAll('button').find((btn) => btn.text() === '安装')
    expect(installBtn).toBeDefined()
    await installBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('hub-skill: install failed')

    const installedTab = wrapper.findAll('button').find((btn) => btn.text().includes('已安装'))
    expect(installedTab).toBeDefined()
    await installedTab!.trigger('click')
    await flushPromises()

    await hubTab!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).not.toContain('hub-skill: install failed')
  })
})
