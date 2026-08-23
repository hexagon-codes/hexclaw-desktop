import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: Record<string, unknown> }>,
  appendError: null as Error | null,
  resolveAppend: null as ((offset: number) => void) | null,
}))

vi.mock('@/config/env', () => ({ env: { apiBase: 'http://localhost:16060' } }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((command: string, args: Record<string, unknown>) => {
    native.calls.push({ command, args })
    if (command === 'create_staging_file_grant') {
      return Promise.resolve({
        grantId: 'grant-1',
        operationId: 'stage:test',
        purpose: 'save_copy',
        name: 'artifact.txt',
        mime: 'text/plain',
        size: 3,
      })
    }
    if (command === 'append_file_grant_chunk') {
      if (native.appendError) return Promise.reject(native.appendError)
      return new Promise<number>((resolve) => {
        native.resolveAppend = resolve
      })
    }
    if (command === 'seal_file_grant') return Promise.resolve({})
    return Promise.resolve(undefined)
  }),
}))

describe('native staging cleanup', () => {
  beforeEach(() => {
    native.calls.length = 0
    native.appendError = null
    native.resolveAppend = null
  })

  it('discards the private .part grant when a chunk write fails', async () => {
    native.appendError = new Error('disk full')
    const { stageBlob } = await import('../native-files')

    await expect(
      stageBlob(new Blob(['abc'], { type: 'text/plain' }), 'artifact.txt', {
        purpose: 'save_copy',
        operationId: 'stage:test',
      }),
    ).rejects.toThrow('disk full')

    expect(native.calls.find((call) => call.command === 'discard_file_grant')?.args).toMatchObject({
      grantId: 'grant-1',
      operationId: 'stage:test',
      purpose: 'save_copy',
    })
  })

  it('discards the private .part grant when cancellation arrives during a chunk write', async () => {
    const { stageBlob } = await import('../native-files')
    const abort = new AbortController()
    const pending = stageBlob(new Blob(['abc'], { type: 'text/plain' }), 'artifact.txt', {
      purpose: 'save_copy',
      operationId: 'stage:test',
      signal: abort.signal,
    })

    await vi.waitFor(() => expect(native.resolveAppend).not.toBeNull())
    abort.abort()
    native.resolveAppend?.(3)

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(native.calls.some((call) => call.command === 'seal_file_grant')).toBe(false)
    expect(native.calls.some((call) => call.command === 'discard_file_grant')).toBe(true)
  })
})

describe('managed Sidecar native transfer URL', () => {
  it('接受 managed same-origin 的绝对/相对 URL，拒绝 foreign、凭据、hash 与 data URL', async () => {
    const { validateManagedSidecarURL } = await import('../native-files')

    expect(() => validateManagedSidecarURL('/api/v1/files/generated/result.png')).not.toThrow()
    expect(() =>
      validateManagedSidecarURL('http://localhost:16060/api/v1/files/generated/result.png'),
    ).not.toThrow()
    expect(() => validateManagedSidecarURL('https://example.com/result.png')).toThrow(
      'managed Sidecar origin',
    )
    expect(() => validateManagedSidecarURL('http://user@localhost:16060/result.png')).toThrow(
      'managed Sidecar origin',
    )
    expect(() => validateManagedSidecarURL('http://localhost:16060/result.png#fragment')).toThrow(
      'managed Sidecar origin',
    )
    expect(() => validateManagedSidecarURL('data:image/png;base64,AAAA')).toThrow(
      'managed Sidecar origin',
    )
  })
})
