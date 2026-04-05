import { beforeEach, describe, expect, it, vi } from 'vitest'

const { checkMock, relaunchMock } = vi.hoisted(() => ({
  checkMock: vi.fn(),
  relaunchMock: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: checkMock,
}))

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: relaunchMock,
}))

describe('useAutoUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('shares the in-flight update check result instead of returning a stale up-to-date status', async () => {
    let resolveCheck!: (value: { version: string; downloadAndInstall: () => Promise<void> } | null) => void
    checkMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve
        }),
    )

    const { useAutoUpdate } = await import('../useAutoUpdate')
    const updater = useAutoUpdate()

    const first = updater.checkForUpdate()
    const second = updater.checkForUpdate()
    await vi.waitFor(() => {
      expect(checkMock).toHaveBeenCalledTimes(1)
    })

    resolveCheck({
      version: '1.2.3',
      downloadAndInstall: async () => {},
    })

    await expect(first).resolves.toEqual({ status: 'available', version: '1.2.3' })
    await expect(second).resolves.toEqual({ status: 'available', version: '1.2.3' })
  })

  it('shares the in-flight install result instead of reporting no-update to concurrent callers', async () => {
    let resolveInstall!: () => void
    checkMock.mockResolvedValue({
      version: '1.2.3',
      downloadAndInstall: () =>
        new Promise<void>((resolve) => {
          resolveInstall = resolve
        }),
    })

    const { useAutoUpdate } = await import('../useAutoUpdate')
    const updater = useAutoUpdate()

    const first = updater.installUpdate()
    const second = updater.installUpdate()
    await vi.waitFor(() => {
      expect(checkMock).toHaveBeenCalledTimes(1)
    })

    resolveInstall()

    await expect(first).resolves.toEqual({ status: 'installed' })
    await expect(second).resolves.toEqual({ status: 'installed' })
  })
})
