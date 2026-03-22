import { beforeEach, describe, expect, it, vi } from 'vitest'

const { checkMock, relaunchMock, downloadAndInstallMock } = vi.hoisted(() => ({
  checkMock: vi.fn(),
  relaunchMock: vi.fn(),
  downloadAndInstallMock: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: checkMock,
}))

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: relaunchMock,
}))

async function loadComposable() {
  return import('../useAutoUpdate')
}

describe('useAutoUpdate', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    downloadAndInstallMock.mockResolvedValue(undefined)
    relaunchMock.mockResolvedValue(undefined)
  })

  it('marks update available when updater returns a release', async () => {
    checkMock.mockResolvedValue({
      version: '0.0.3',
      downloadAndInstall: downloadAndInstallMock,
    })

    const { useAutoUpdate } = await loadComposable()
    const autoUpdate = useAutoUpdate()
    const result = await autoUpdate.checkForUpdate()

    expect(result).toEqual({
      status: 'available',
      version: '0.0.3',
    })
    expect(autoUpdate.updateAvailable.value).toBe(true)
    expect(autoUpdate.updateVersion.value).toBe('0.0.3')
    expect(autoUpdate.lastCheckedAt.value).not.toBe('')
  })

  it('clears stale update state when no update is available', async () => {
    checkMock
      .mockResolvedValueOnce({
        version: '0.0.3',
        downloadAndInstall: downloadAndInstallMock,
      })
      .mockResolvedValueOnce(null)

    const { useAutoUpdate } = await loadComposable()
    const autoUpdate = useAutoUpdate()

    await autoUpdate.checkForUpdate()
    const result = await autoUpdate.checkForUpdate()

    expect(result).toEqual({ status: 'up-to-date' })
    expect(autoUpdate.updateAvailable.value).toBe(false)
    expect(autoUpdate.updateVersion.value).toBe('')
  })

  it('downloads and relaunches when installing an available update', async () => {
    checkMock.mockResolvedValue({
      version: '0.0.3',
      downloadAndInstall: downloadAndInstallMock,
    })

    const { useAutoUpdate } = await loadComposable()
    const autoUpdate = useAutoUpdate()
    const result = await autoUpdate.installUpdate()

    expect(result).toEqual({ status: 'installed' })
    expect(downloadAndInstallMock).toHaveBeenCalledTimes(1)
    expect(relaunchMock).toHaveBeenCalledTimes(1)
  })
})
