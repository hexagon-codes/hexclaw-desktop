/**
 * BUG-20260626：用户在「数据连接器」加了本地目录(/Users/<u>/work)并已连接，但 Agent code_exec
 * 读不到。根因（前端侧）：localFolder/native 连接器只存在 localStorage，从不告诉后端 → 后端沙箱
 * allowed_paths 永远为空。
 *
 * 修复：App 启动时通过 useLocalFolderAllowedPathsSync 把「所有启用的 localFolder 连接器路径」汇总，
 * 写进后端 sandbox.allowed_paths。真正的文件访问由 HexClaw sidecar 第一方 FileAccess broker 执行，
 * 不再依赖运行时安装/重注册 filesystem MCP server。仅 enabled 的 localFolder 计入，停用的/非本地目录类型不计入。
 *
 * 本测试：composable 挂载即应把启用的本地目录路径同步给后端。修复前 RED（只写 config 或完全不写），
 * 修复后 GREEN。
 */
import { defineComponent } from 'vue'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

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

const { addMcpServer } = vi.hoisted(() => ({
  addMcpServer: vi.fn(),
}))
vi.mock('@/api/mcp', () => ({ addMcpServer }))

vi.mock('@/api/client', () => ({ checkHealth: vi.fn().mockResolvedValue(true) }))

import { useLocalFolderAllowedPathsSync } from '@/composables/useLocalFolderAllowedPathsSync'
import { useAppStore } from '@/stores/app'

const SyncHarness = defineComponent({
  setup() {
    useLocalFolderAllowedPathsSync()
    return () => null
  },
})

const mountedWrappers: ReturnType<typeof mount>[] = []

function mountSyncHarness() {
  const wrapper = mount(SyncHarness)
  mountedWrappers.push(wrapper)
  return wrapper
}

describe('BUG-20260626 本地目录连接器 → 后端 allowed_paths 同步', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // BUG-20260702：同步动作现挂在 sidecar 就绪门后（与 AppLayout 启动期后端调用同一道门）
    setActivePinia(createPinia())
    useAppStore().sidecarReady = true
    connectorList.value = [
      { id: 'f1', type: 'localFolder', name: '工作目录', config: { path: '/Users/hexagon/work' }, enabled: true },
      { id: 'f2', type: 'localFolder', name: '停用目录', config: { path: '/Users/hexagon/disabled' }, enabled: false },
      { id: 'm1', type: 'mysql', name: '生产库', config: { host: 'h' }, enabled: true },
    ]
  })

  afterEach(() => {
    for (const wrapper of mountedWrappers.splice(0)) wrapper.unmount()
  })

  it('挂载即把「启用的本地目录」路径同步进后端 allowed_paths（仅 enabled localFolder）', async () => {
    mountSyncHarness()
    await flushPromises()

    expect(updateConfig).toHaveBeenCalled()
    const call = updateConfig.mock.calls.find(
      (c) => (c[0] as { sandbox?: { allowed_paths?: string[] } })?.sandbox?.allowed_paths !== undefined,
    )
    expect(call, 'updateConfig 应带 sandbox.allowed_paths').toBeTruthy()
    const paths = (call![0] as { sandbox: { allowed_paths: string[] } }).sandbox.allowed_paths
    expect(paths).toEqual(['/Users/hexagon/work']) // 停用目录 + mysql 不计入
  })

  it('BUG-20260629 最佳实践：同步授权不再重注册 filesystem MCP server', async () => {
    mountSyncHarness()
    await flushPromises()

    expect(addMcpServer).not.toHaveBeenCalled()
  })

  // 挑刺回归：无本地目录连接器时，挂载不得把后端 allowed_paths 清空（误抹手动/他源配置）。
  it('挂载时若无启用的本地目录连接器，不得清空后端 allowed_paths（首帧不下发空数组）', async () => {
    connectorList.value = [
      { id: 'm1', type: 'mysql', name: '生产库', config: { host: 'h' }, enabled: true },
      { id: 'f2', type: 'localFolder', name: '停用目录', config: { path: '/x' }, enabled: false },
    ]
    mountSyncHarness()
    await flushPromises()

    const clobber = updateConfig.mock.calls.find(
      (c) => (c[0] as { sandbox?: { allowed_paths?: string[] } })?.sandbox?.allowed_paths !== undefined,
    )
    expect(clobber, '首帧无本地目录连接器时不应下发 allowed_paths（避免清空他源配置）').toBeUndefined()
  })
})
