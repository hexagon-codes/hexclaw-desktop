/**
 * BUG-20260626：用户在「数据连接器」加了本地目录(/Users/<u>/work)并已连接，但 Agent code_exec
 * 读不到。根因（前端侧）：localFolder/native 连接器只存在 localStorage，从不告诉后端 → 后端沙箱
 * allowed_paths 永远为空。
 *
 * 修复：ConnectionsView 把「所有启用的 localFolder 连接器路径」汇总，写进后端
 * skill.sandbox.filesystem.allowed_paths（PUT /config）。仅 enabled 的 localFolder 计入，
 * 停用的/非本地目录类型不计入。
 *
 * 本测试：挂载即应把启用的本地目录路径同步给后端。修复前 RED（updateConfig 从未带 allowed_paths），修复后 GREEN。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'

const { connectorList, addInstance, updateInstance, removeInstance } = vi.hoisted(() => ({
  connectorList: { value: [] as unknown[] },
  addInstance: vi.fn(),
  updateInstance: vi.fn(),
  removeInstance: vi.fn(),
}))
vi.mock('@/composables/useConnectorInstances', () => ({
  useConnectorInstances: () => ({ list: connectorList, addInstance, updateInstance, removeInstance }),
}))

const { updateConfig } = vi.hoisted(() => ({ updateConfig: vi.fn().mockResolvedValue({}) }))
vi.mock('@/api/settings', () => ({ updateConfig, getRuntimeConfig: vi.fn().mockResolvedValue({}) }))

const { removeMcpServer, getMcpServerStatus } = vi.hoisted(() => ({
  removeMcpServer: vi.fn(),
  getMcpServerStatus: vi.fn(),
}))
vi.mock('@/api/mcp', () => ({ addMcpServer: vi.fn(), removeMcpServer, getMcpServerStatus }))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}))
vi.mock('@/components/channels/ConnectorConfigModal.vue', () => ({
  default: { template: '<div class="connector-modal-stub" />' },
}))
vi.mock('@/components/channels/ConnectionChannelCards.vue', () => ({
  default: { template: '<div class="channel-cards-stub" />' },
}))
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

import ConnectionsView from '../ConnectionsView.vue'

function mountView() {
  return mount(ConnectionsView, {
    global: {
      plugins: [createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })],
      stubs: { teleport: true },
    },
  })
}

describe('BUG-20260626 本地目录连接器 → 后端 allowed_paths 同步', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    removeMcpServer.mockResolvedValue({ message: 'ok' })
    getMcpServerStatus.mockResolvedValue({ statuses: {}, servers: [] })
    connectorList.value = [
      { id: 'f1', type: 'localFolder', name: '工作目录', config: { path: '/Users/hexagon/work' }, enabled: true },
      { id: 'f2', type: 'localFolder', name: '停用目录', config: { path: '/Users/hexagon/disabled' }, enabled: false },
      { id: 'm1', type: 'mysql', name: '生产库', config: { host: 'h' }, enabled: true },
    ]
  })

  it('挂载即把「启用的本地目录」路径同步进后端 allowed_paths（仅 enabled localFolder）', async () => {
    mountView()
    await flushPromises()

    expect(updateConfig).toHaveBeenCalled()
    const call = updateConfig.mock.calls.find(
      (c) => (c[0] as { sandbox?: { allowed_paths?: string[] } })?.sandbox?.allowed_paths !== undefined,
    )
    expect(call, 'updateConfig 应带 sandbox.allowed_paths').toBeTruthy()
    const paths = (call![0] as { sandbox: { allowed_paths: string[] } }).sandbox.allowed_paths
    expect(paths).toEqual(['/Users/hexagon/work']) // 停用目录 + mysql 不计入
  })

  // 挑刺回归：无本地目录连接器时，挂载不得把后端 allowed_paths 清空（误抹手动/他源配置）。
  it('挂载时若无启用的本地目录连接器，不得清空后端 allowed_paths（首帧不下发空数组）', async () => {
    connectorList.value = [
      { id: 'm1', type: 'mysql', name: '生产库', config: { host: 'h' }, enabled: true },
      { id: 'f2', type: 'localFolder', name: '停用目录', config: { path: '/x' }, enabled: false },
    ]
    mountView()
    await flushPromises()

    const clobber = updateConfig.mock.calls.find(
      (c) => (c[0] as { sandbox?: { allowed_paths?: string[] } })?.sandbox?.allowed_paths !== undefined,
    )
    expect(clobber, '首帧无本地目录连接器时不应下发 allowed_paths（避免清空他源配置）').toBeUndefined()
  })
})
