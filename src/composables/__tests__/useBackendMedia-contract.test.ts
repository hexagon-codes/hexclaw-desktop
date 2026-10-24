import { afterEach, describe, expect, it, vi } from 'vitest'

const { sidecarFetch, releaseHooks, native } = vi.hoisted(() => ({
  sidecarFetch: vi.fn(),
  releaseHooks: [] as Array<() => void>,
  native: { enabled: false },
}))
vi.mock('@/utils/platform', () => ({ isTauri: () => native.enabled }))
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: () => 'hexclaw-media://localhost/asset' }))
vi.mock('@/config/env', () => ({ env: { apiBase: 'http://localhost:5173/_hexclaw' } }))
vi.mock('@/api/client', () => ({ sidecarFetch }))
vi.mock('vue', async (importOriginal) => ({
  ...await importOriginal<typeof import('vue')>(),
  onBeforeUnmount: (callback: () => void) => releaseHooks.push(callback),
}))

import { backendMediaURL, isGeneratedMediaSource, useBackendMedia } from '../useBackendMedia'
import { backendContext } from '@/services/backend-context'

afterEach(() => {
  releaseHooks.splice(0).forEach(callback => callback())
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  native.enabled = false
  backendContext.value = null
})

describe('generated media request contract', () => {
  it('uses scoped native media reads without transferring the file through JSON IPC', async () => {
    native.enabled = true
    backendContext.value = { connectionId: 'fixture', backendId: 'fixture-backend', configRevision: 2, activationGeneration: 3, kind: 'remote', apiBase: 'http://localhost:5173/_hexclaw', wsBase: '', hasToken: true }
    const source = `/api/v1/files/generated/202610/${'a'.repeat(64)}.mp4`
    const media = useBackendMedia()
    const url = new URL(await media.load(source))
    expect(url.protocol).toBe('hexclaw-media:')
    expect(url.searchParams.get('path')).toBe(source)
    expect(JSON.parse(url.searchParams.get('scope')!)).toEqual(['fixture', 'fixture-backend', 2, 3])
    expect(sidecarFetch).not.toHaveBeenCalled()
    expect(backendMediaURL(`202610/${'a'.repeat(64)}.mp4`)).toBe(backendMediaURL(source))
  })
  it('keeps the backend proxy prefix for relative files and preserves unrelated sources', () => {
    expect(backendMediaURL('/api/v1/files/generated/media/clip.mp4'))
      .toBe('http://localhost:5173/_hexclaw/api/v1/files/generated/media/clip.mp4')
    expect(isGeneratedMediaSource('/api/v1/files/generated/media/clip.mp4')).toBe(true)
    expect(backendMediaURL('https://provider.example/media.png')).toBe('https://provider.example/media.png')
    expect(isGeneratedMediaSource('https://provider.example/api/v1/files/generated/media.png')).toBe(false)
  })

  it('fetches relative media through the authenticated client once and releases its temporary URL', async () => {
    const blob = new Blob(['media bytes'], { type: 'video/mp4' })
    sidecarFetch.mockResolvedValue({ ok: true, blob: async () => blob })
    const createObjectURL = vi.fn(() => 'blob:media-receipt')
    const revokeObjectURL = vi.fn()
    const NativeURL = URL
    vi.stubGlobal('URL', class extends NativeURL {
      static createObjectURL = createObjectURL
      static revokeObjectURL = revokeObjectURL
    })
    const media = useBackendMedia()
    const source = '/api/v1/files/generated/media/clip.mp4'
    await expect(media.load(source)).resolves.toBe('blob:media-receipt')
    await expect(media.load(source)).resolves.toBe('blob:media-receipt')
    expect(sidecarFetch).toHaveBeenCalledExactlyOnceWith(
      'http://localhost:5173/_hexclaw/api/v1/files/generated/media/clip.mp4',
      { signal: expect.any(AbortSignal) },
    )
    expect(createObjectURL).toHaveBeenCalledWith(blob)
    media.retain([])
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:media-receipt')
  })
})
