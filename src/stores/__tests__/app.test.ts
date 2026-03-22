import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAppStore } from '../app'

const { checkHealth, invoke } = vi.hoisted(() => ({
  checkHealth: vi.fn(),
  invoke: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  checkHealth,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useAppStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    checkHealth.mockResolvedValue(true)
    invoke.mockResolvedValue('sidecar restarted')
  })

  it('allows manual restart while the engine is stopped', async () => {
    const store = useAppStore()
    store.sidecarStatus = 'stopped'

    const result = await store.restartSidecar()

    expect(result).toBe(true)
    expect(invoke).toHaveBeenCalledWith('restart_sidecar')
    expect(checkHealth).toHaveBeenCalledTimes(1)
    expect(store.sidecarStatus).toBe('running')
    expect(store.isRestarting).toBe(false)
  })

  it('deduplicates concurrent restart requests', async () => {
    const restart = deferred<string>()
    invoke.mockReturnValueOnce(restart.promise)

    const store = useAppStore()
    store.sidecarStatus = 'running'

    const first = store.restartSidecar()
    const second = store.restartSidecar()

    expect(store.isRestarting).toBe(true)

    restart.resolve('sidecar restarted')
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(store.sidecarStatus).toBe('running')
    expect(store.isRestarting).toBe(false)
  })
})
