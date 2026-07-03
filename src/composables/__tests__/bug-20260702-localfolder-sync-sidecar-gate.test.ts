/**
 * BUG-20260702（P1）：本地目录授权同步存在启动竞态且失败无重试。
 *
 * 现状：useLocalFolderAllowedPathsSync 在 App.vue setup 立即执行且 watch immediate:true，
 * 绕过了工程既有的 sidecar 就绪门（AppLayout.vue 的 `watch(() => appStore.sidecarReady, ...)`，
 * 其他启动期后端调用都等这个门）；同步失败只 logger.warn 一次、无重试——冷启动 sidecar 未就绪时
 * 首帧 updateConfig 大概率失败，沙箱授权静默缺失直到用户碰连接器。
 *
 * 修复契约：
 *  ① 同步动作必须等 appStore.sidecarReady 为 true 后才执行（首个 immediate 同步挂在就绪门后；
 *     后续变更若 sidecar 未就绪则缓存，待就绪后补发最新值）。
 *  ② 失败时有限次指数退避重试（3 次：1s/3s/9s），退避调度函数可注入便于假时钟测试。
 *  ③ 最小 in-flight 串行化：同一时刻只有一个 updateConfig 在飞，在飞期间的多次变更合并为
 *     最新一次（防止快速启停两个连接器时完成序错乱互相覆盖）。
 *
 * 修复前 RED（旧代码立即调用 / 不重试 / 并发直发），修复后 GREEN。
 */
import { defineComponent, ref } from 'vue'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const harness = vi.hoisted(() => ({
  list: { value: [] as unknown[] },
}))
vi.mock('@/composables/useConnectorInstances', () => ({
  useConnectorInstances: () => ({
    list: harness.list,
    addInstance: vi.fn(),
    updateInstance: vi.fn(),
    removeInstance: vi.fn(),
  }),
}))

const { getRuntimeConfig, updateConfig } = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
  updateConfig: vi.fn(),
}))
vi.mock('@/api/settings', () => ({ updateConfig, getRuntimeConfig }))

vi.mock('@/api/client', () => ({ checkHealth: vi.fn().mockResolvedValue(false) }))

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('@/utils/logger', () => ({
  logger: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn(), log: vi.fn() },
}))

import { useLocalFolderAllowedPathsSync } from '@/composables/useLocalFolderAllowedPathsSync'
import { useAppStore } from '@/stores/app'

type SyncOptions = { delay?: (ms: number) => Promise<void> }

function folder(path: string, enabled: boolean, id = path) {
  return { id, type: 'localFolder', name: `目录 ${path}`, config: { path }, enabled }
}

function makeHarness(options?: SyncOptions) {
  return defineComponent({
    setup() {
      // 旧签名无参：多传的 options 在运行时被忽略 → RED 阶段测试仍可执行
      ;(useLocalFolderAllowedPathsSync as (o?: SyncOptions) => void)(options)
      return () => null
    },
  })
}

const mounted: ReturnType<typeof mount>[] = []
function mountHarness(options?: SyncOptions) {
  const wrapper = mount(makeHarness(options))
  mounted.push(wrapper)
  return wrapper
}

describe('BUG-20260702 本地目录授权同步：sidecar 就绪门 + 退避重试 + in-flight 串行化', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    getRuntimeConfig.mockResolvedValue({})
    updateConfig.mockResolvedValue({})
    harness.list = ref<unknown[]>([]) as unknown as { value: unknown[] }
  })

  afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount()
  })

  it('① sidecar 未就绪时绝不发 updateConfig；就绪后补发首个同步', async () => {
    const appStore = useAppStore()
    appStore.sidecarReady = false
    harness.list.value = [folder('/Users/hexagon/work', true)]

    mountHarness()
    await flushPromises()

    // RED：旧代码 watch immediate:true 立即调 updateConfig
    expect(updateConfig).not.toHaveBeenCalled()

    appStore.sidecarReady = true
    await flushPromises()

    expect(updateConfig).toHaveBeenCalledTimes(1)
    expect(updateConfig).toHaveBeenCalledWith({
      sandbox: { allowed_paths: ['/Users/hexagon/work'] },
    })
  })

  it('① 后续变更发生在 sidecar 未就绪期间 → 缓存，就绪后补发最新值', async () => {
    const appStore = useAppStore()
    appStore.sidecarReady = true
    harness.list.value = [] // 首帧空：沿用「首帧不下发空数组」契约，不得清空他源配置

    mountHarness()
    await flushPromises()
    expect(updateConfig).not.toHaveBeenCalled()

    appStore.sidecarReady = false
    await flushPromises()
    harness.list.value = [folder('/data/a', true)]
    await flushPromises()
    expect(updateConfig).not.toHaveBeenCalled() // 未就绪：先扣住

    appStore.sidecarReady = true
    await flushPromises()
    expect(updateConfig).toHaveBeenCalledTimes(1)
    expect(updateConfig).toHaveBeenCalledWith({ sandbox: { allowed_paths: ['/data/a'] } })
  })

  it('② 同步失败按 1s/3s/9s 指数退避重试直至成功', async () => {
    const appStore = useAppStore()
    appStore.sidecarReady = true
    harness.list.value = [folder('/data/retry', true)]

    const delays: number[] = []
    const delay = vi.fn(async (ms: number) => {
      delays.push(ms)
    })
    updateConfig
      .mockRejectedValueOnce(new Error('sidecar starting'))
      .mockRejectedValueOnce(new Error('sidecar starting'))
      .mockResolvedValueOnce({})

    mountHarness({ delay })
    await flushPromises()

    // RED：旧代码失败只 warn 一次，不重试（callCount=1）
    expect(updateConfig).toHaveBeenCalledTimes(3)
    expect(delays).toEqual([1000, 3000])
    expect(updateConfig).toHaveBeenLastCalledWith({ sandbox: { allowed_paths: ['/data/retry'] } })
  })

  it('② 重试有限次（3 次退避）后放弃，不无限重试', async () => {
    const appStore = useAppStore()
    appStore.sidecarReady = true
    harness.list.value = [folder('/data/giveup', true)]

    const delays: number[] = []
    const delay = vi.fn(async (ms: number) => {
      delays.push(ms)
    })
    updateConfig.mockRejectedValue(new Error('permanent failure'))

    mountHarness({ delay })
    await flushPromises()

    expect(updateConfig).toHaveBeenCalledTimes(4) // 首发 + 3 次重试
    expect(delays).toEqual([1000, 3000, 9000])
    expect(warn).toHaveBeenCalled() // 放弃时留痕
  })

  it('③ in-flight 串行化：在飞期间的多次变更合并为最新一次，不并发直发', async () => {
    const appStore = useAppStore()
    appStore.sidecarReady = true
    harness.list.value = [folder('/data/a', true, 'f1')]

    let resolveFirst!: () => void
    const firstCall = new Promise<Record<string, never>>((resolve) => {
      resolveFirst = () => resolve({})
    })
    updateConfig.mockImplementationOnce(() => firstCall).mockResolvedValue({})

    mountHarness()
    await flushPromises()
    expect(updateConfig).toHaveBeenCalledTimes(1) // 首个同步在飞

    // 在飞期间快速启停两个连接器（两次变更）
    harness.list.value = [folder('/data/a', true, 'f1'), folder('/data/b', true, 'f2')]
    await flushPromises()
    harness.list.value = [
      folder('/data/a', true, 'f1'),
      folder('/data/b', true, 'f2'),
      folder('/data/c', true, 'f3'),
    ]
    await flushPromises()

    // RED：旧代码每次变更立即直发 → callCount=3
    expect(updateConfig).toHaveBeenCalledTimes(1)

    resolveFirst()
    await flushPromises()

    // 合并等待：两次变更只补发一次，且带最终态（完成序不会互相覆盖）
    expect(updateConfig).toHaveBeenCalledTimes(2)
    expect(updateConfig.mock.calls[1]![0]).toEqual({
      sandbox: { allowed_paths: ['/data/a', '/data/b', '/data/c'] },
    })
  })

  it('④ 同步 localFolder 时保留后端已有非本地目录授权，并移除上次同步后被停用的目录', async () => {
    const appStore = useAppStore()
    appStore.sidecarReady = true
    harness.list.value = [folder('/data/a', true, 'f1')]
    getRuntimeConfig.mockResolvedValueOnce({
      sandbox: { allowed_paths: ['/Users/hexagon/work'] },
    })

    mountHarness()
    await flushPromises()

    expect(updateConfig).toHaveBeenLastCalledWith({
      sandbox: { allowed_paths: ['/Users/hexagon/work', '/data/a'] },
    })

    getRuntimeConfig.mockResolvedValueOnce({
      sandbox: { allowed_paths: ['/Users/hexagon/work', '/data/a'] },
    })
    harness.list.value = [folder('/data/a', false, 'f1')]
    await flushPromises()

    expect(updateConfig).toHaveBeenLastCalledWith({
      sandbox: { allowed_paths: ['/Users/hexagon/work'] },
    })
  })
})
