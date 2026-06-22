/**
 * BUG-20260623 · 左侧栏「Hexagon engine」版本号显示错误 + 点击未开「关于」窗口
 *
 * 语义（已与用户确认）：左下角「Hexagon engine vX」里的版本 = **hexagon 框架**版本，
 * 即 /api/v1/version 的 `engine_version` 字段（后端 = hexagon.Version）。**不是** hexclaw
 * sidecar 自身的 `version` 字段。
 *
 * 症状（复现 RED）：
 *   - 发布构建里 hexagon.Version 由 build info 的 hexagon 依赖版本解析 → 例如 "0.5.2"。
 *   - go.work 开发构建拿到 "(devel)" 占位 → 旧代码直接显示 "Hexagon engine v(devel)"。
 *   正确：取 engine_version（hexagon），显示 "Hexagon engine v0.5.2"；
 *        engine_version 为 (devel)/空 时宁可不显示版本，也不回退去显示 hexclaw 的 version。
 *
 * 需求（同批）：点击引擎名打开「关于」窗口（useAboutWindow）。
 *
 * 永久回归护栏：版本类断言用 vi.waitFor 轮询（fetchEngineVersion 走动态 import 有冷加载延迟）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'

const getVersionMock = vi.fn()
vi.mock('@/api/system', () => ({
  getVersion: getVersionMock,
}))

const openAboutMock = vi.fn()
vi.mock('@/composables/useAboutWindow', () => ({
  useAboutWindow: () => openAboutMock,
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/chat' }),
  useRouter: () => ({ push: vi.fn() }),
}))

import Sidebar from '../Sidebar.vue'
import { useAppStore } from '@/stores/app'

const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } })

function mountSidebar() {
  return mount(Sidebar, {
    global: {
      plugins: [i18n],
      stubs: {
        'router-link': { template: '<a><slot /></a>' },
        RouterLink: { template: '<a><slot /></a>' },
      },
    },
  })
}

describe('BUG-20260623: 左侧栏 Hexagon engine 版本号(hexagon 框架) + 点击开关于窗口', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getVersionMock.mockReset()
    openAboutMock.mockReset()
  })

  it('BUG-20260623-A: 显示 hexagon 框架版本 engine_version(0.5.2)，不显示 hexclaw 的 version', async () => {
    // engine_version = hexagon 框架版本；version = hexclaw sidecar 版本（不该显示）
    getVersionMock.mockResolvedValue({ version: 'v0.4.5', engine: 'Hexagon', engine_version: '0.5.2' })
    const store = useAppStore()
    store.sidecarStatus = 'running' // immediate watch → fetchEngineVersion
    const wrapper = mountSidebar()

    await vi.waitFor(() => expect(wrapper.text()).toContain('Hexagon engine v0.5.2'))
    expect(wrapper.text()).not.toContain('v0.4.5') // 不是 hexclaw 的 version
    expect(wrapper.text()).not.toContain('(devel)')
  })

  it('BUG-20260623-B: engine_version 已带 v 前缀不重复加 v', async () => {
    getVersionMock.mockResolvedValue({ version: 'v0.4.5', engine: 'Hexagon', engine_version: 'v0.5.2' })
    const store = useAppStore()
    store.sidecarStatus = 'running'
    const wrapper = mountSidebar()

    await vi.waitFor(() => expect(wrapper.text()).toContain('Hexagon engine v0.5.2'))
    expect(wrapper.text()).not.toContain('vv0.5.2')
  })

  it('BUG-20260623-C: engine_version 无 v 前缀自动补 v', async () => {
    getVersionMock.mockResolvedValue({ version: 'v0.4.5', engine: 'Hexagon', engine_version: '0.5.2' })
    const store = useAppStore()
    store.sidecarStatus = 'running'
    const wrapper = mountSidebar()

    await vi.waitFor(() => expect(wrapper.text()).toContain('Hexagon engine v0.5.2'))
  })

  it('BUG-20260623-D: dev 构建 engine_version=(devel) 时不显示 (devel)，也不回退 hexclaw version', async () => {
    getVersionMock.mockResolvedValue({ version: 'v-local', engine: 'Hexagon', engine_version: '(devel)' })
    const store = useAppStore()
    store.sidecarStatus = 'running'
    const wrapper = mountSidebar()
    await flushPromises()

    expect(wrapper.text()).not.toContain('(devel)')
    expect(wrapper.text()).not.toContain('v-local')
    expect(wrapper.text()).toContain('Hexagon engine') // 退化为无版本号，不谎报
  })

  it('BUG-20260623-E: 点击引擎名调用 openAbout 打开关于窗口', async () => {
    getVersionMock.mockResolvedValue({ version: 'v0.4.5', engine: 'Hexagon', engine_version: '0.5.2' })
    const store = useAppStore()
    store.sidecarStatus = 'running'
    const wrapper = mountSidebar()
    await flushPromises()

    await wrapper.get('.hc-sidebar__engine-label').trigger('click')
    expect(openAboutMock).toHaveBeenCalledTimes(1)
  })
})
