import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiPost } from '../client'

describe('multipart request headers', () => {
  afterEach(() => vi.restoreAllMocks())

  it('forwards Idempotency-Key without forcing a multipart Content-Type', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const body = new FormData()
    body.append('file', new File(['%PDF-'], 'book.pdf', { type: 'application/pdf' }))

    await apiPost('/api/v1/knowledge/documents', body, {
      headers: { 'Idempotency-Key': 'knowledge-upload:test-intent' },
      timeout: false,
      expectedStatus: 202,
    })

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/knowledge/documents'),
      expect.objectContaining({
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': 'knowledge-upload:test-intent' },
      }),
    )
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit
    expect(new Headers(init.headers).has('Content-Type')).toBe(false)
  })

  it('rejects a generic 2xx response when the async create contract requires 202', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(
      apiPost('/api/v1/knowledge/documents', new FormData(), { expectedStatus: 202 }),
    ).rejects.toThrow('Invalid response')
  })
})
