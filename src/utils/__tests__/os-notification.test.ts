import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { granted, requestPermission, sendNotification } = vi.hoisted(() => ({
  granted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: () => granted(),
  requestPermission: () => requestPermission(),
  sendNotification: (arg: unknown) => sendNotification(arg),
}))

import { sendOsNotification } from '../os-notification'

describe('sendOsNotification', () => {
  beforeEach(() => {
    granted.mockReset()
    requestPermission.mockReset()
    sendNotification.mockReset()
  })

  afterEach(() => vi.clearAllMocks())

  it('sends directly when permission is already granted', async () => {
    granted.mockResolvedValue(true)
    await sendOsNotification('Title', 'Body')
    expect(requestPermission).not.toHaveBeenCalled()
    expect(sendNotification).toHaveBeenCalledWith({ title: 'Title', body: 'Body' })
  })

  it('requests permission first when not yet granted, then sends', async () => {
    granted.mockResolvedValue(false)
    requestPermission.mockResolvedValue('granted')
    await sendOsNotification('T')
    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(sendNotification).toHaveBeenCalledWith({ title: 'T' })
  })

  it('does not send when permission is denied', async () => {
    granted.mockResolvedValue(false)
    requestPermission.mockResolvedValue('denied')
    await sendOsNotification('T', 'B')
    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('never throws when the plugin is unavailable (non-Tauri env)', async () => {
    granted.mockRejectedValue(new Error('not in tauri'))
    await expect(sendOsNotification('T')).resolves.toBeUndefined()
    expect(sendNotification).not.toHaveBeenCalled()
  })
})
