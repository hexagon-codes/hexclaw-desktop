import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: Record<string, unknown> }>,
  rejectUpload: null as ((error: Error) => void) | null,
}))

vi.mock('@/config/env', () => ({ env: { apiBase: 'http://localhost:16060' } }))
vi.mock('@tauri-apps/api/core', () => {
  class Channel<T> {
    constructor(private readonly listener: (event: T) => void) {}

    emit(event: T) {
      this.listener(event)
    }
  }

  return {
    Channel,
    invoke: vi.fn((command: string, args: Record<string, unknown>) => {
      native.calls.push({ command, args })
      if (command === 'upload_file_grant') {
        return new Promise((_resolve, reject) => {
          native.rejectUpload = reject
        })
      }
      return Promise.resolve(undefined)
    }),
  }
})

describe('native file transfer cancellation registration', () => {
  beforeEach(() => {
    native.calls.length = 0
    native.rejectUpload = null
  })

  it('defers cancel-before-register until Rust acknowledges the operation', async () => {
    const { uploadGrantedFile } = await import('../native-files')
    const abort = new AbortController()
    const pending = uploadGrantedFile({
      grant: {
        grantId: 'grant-1',
        operationId: 'upload:1',
        purpose: 'knowledge_upload',
        name: 'book.pdf',
        mime: 'application/pdf',
        size: 7,
      },
      url: '/api/v1/knowledge/documents?user_id=child-1',
      idempotencyKey: 'knowledge:1',
      signal: abort.signal,
    })

    await vi.waitFor(() => {
      expect(native.calls.some((call) => call.command === 'upload_file_grant')).toBe(true)
    })
    abort.abort()
    expect(native.calls.some((call) => call.command === 'cancel_file_transfer')).toBe(false)

    const upload = native.calls.find((call) => call.command === 'upload_file_grant')!
    const registered = upload.args.onRegistered as { emit(event: null): void }
    expect(registered).toEqual(expect.any(Object))
    registered.emit(null)
    await vi.waitFor(() => {
      expect(native.calls.some((call) => call.command === 'cancel_file_transfer')).toBe(true)
    })
    expect(
      native.calls.find((call) => call.command === 'cancel_file_transfer')?.args.operationId,
    ).toBe('upload:1')

    native.rejectUpload?.(new Error('file transfer cancelled'))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
