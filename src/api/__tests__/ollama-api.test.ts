/**
 * Ollama API comprehensive tests
 *
 * Covers: getOllamaStatus, getOllamaRunning, unloadOllamaModel,
 * deleteOllamaModel, restartOllama, and pullOllamaModel (stream parsing,
 * error handling, AbortSignal).
 *
 * getOllamaStatus/getOllamaRunning use native fetch directly to Ollama.
 * unloadOllamaModel/deleteOllamaModel/restartOllama use ofetch (apiPost/apiDelete).
 * pullOllamaModel uses raw fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── ofetch mock (for non-streaming functions) ──────────
const mockOfetch = vi.hoisted(() => vi.fn())
vi.mock('ofetch', () => ({
  ofetch: { create: () => mockOfetch },
}))

vi.mock('@/config/env', () => ({
  OLLAMA_BASE: 'http://localhost:11434', env: { apiBase: 'http://localhost:16060', wsBase: 'ws://localhost:16060', timeout: 5000 },
}))

import {
  getOllamaStatus,
  getOllamaRunning,
  unloadOllamaModel,
  deleteOllamaModel,
  restartOllama,
  pullOllamaModel,
} from '../ollama'

// ─── Helpers ──────────���──────────────────────────────���──

function mockFetchStream(chunks: string[], ok = true, status = 200) {
  const encoder = new TextEncoder()
  let idx = 0
  const stream = new ReadableStream({
    pull(controller) {
      if (idx < chunks.length) {
        controller.enqueue(encoder.encode(chunks[idx]!))
        idx++
      } else {
        controller.close()
      }
    },
  })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok,
    status,
    body: stream,
    json: () => Promise.resolve({ error: `HTTP ${status}` }),
  }))
}

// ─── Tests ──────────────────────────────────────────────

describe('Ollama API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // ─── 1. getOllamaStatus calls Ollama native API directly ────────
  it('getOllamaStatus calls Ollama native endpoints and returns status', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: 'm1', size: 100, modified_at: '2024-01-01' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: '0.5.1' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await getOllamaStatus()

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:11434/api/tags', expect.anything())
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:11434/api/version', expect.anything())
    expect(result.running).toBe(true)
    expect(result.version).toBe('0.5.1')
    expect(result.model_count).toBe(1)
  })

  // ─── 2. getOllamaRunning calls Ollama /api/ps directly ─────────
  it('getOllamaRunning returns models array from native Ollama /api/ps', async () => {
    const models = [
      { name: 'llama3.1', size: 4_000_000, size_vram: 3_000_000, expires_at: '2024-12-01', context_length: 8192 },
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ models }), { status: 200 }),
    ))

    const result = await getOllamaRunning()

    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('llama3.1')
  })

  // ─── 3. getOllamaRunning returns [] when models undefined
  it('getOllamaRunning returns empty array when models is undefined', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    ))

    const result = await getOllamaRunning()

    expect(result).toEqual([])
  })

  // ─── 4. getOllamaRunning returns [] when models null-ish
  it('getOllamaRunning returns empty array when models is null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ models: null }), { status: 200 }),
    ))

    const result = await getOllamaRunning()

    expect(result).toEqual([])
  })

  // ─── 5. unloadOllamaModel sends model name in body ────
  it('unloadOllamaModel sends model name in request body', async () => {
    mockOfetch.mockResolvedValue(undefined)

    await unloadOllamaModel('qwen3:14b')

    expect(mockOfetch).toHaveBeenCalledWith(
      '/api/v1/ollama/unload',
      expect.objectContaining({ method: 'POST', body: { model: 'qwen3:14b' } }),
    )
  })

  // ─���─ 6. deleteOllamaModel URL-encodes model name ──────
  it('deleteOllamaModel URL-encodes the model name (colon in name)', async () => {
    mockOfetch.mockResolvedValue(undefined)

    await deleteOllamaModel('model:7b')

    expect(mockOfetch).toHaveBeenCalledWith(
      `/api/v1/ollama/models/${encodeURIComponent('model:7b')}`,
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  // ─── 7. restartOllama returns status string ────────────
  it('restartOllama returns status string from response', async () => {
    mockOfetch.mockResolvedValue({ status: 'restarted' })

    const result = await restartOllama()

    expect(mockOfetch).toHaveBeenCalledWith(
      '/api/v1/ollama/restart',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(result).toBe('restarted')
  })

  // ─── 8. restartOllama returns "unknown" when status undefined
  it('restartOllama returns "unknown" when status is undefined', async () => {
    mockOfetch.mockResolvedValue({})

    const result = await restartOllama()

    expect(result).toBe('unknown')
  })

  // ─── pullOllamaModel (uses raw fetch) ─────────────────

  describe('pullOllamaModel', () => {

    // ─── 9. stream parsing with progress callbacks ──────
    it('parses single-line, multi-line, and error in stream', async () => {
      mockFetchStream([
        '{"status":"pulling","completed":50,"total":100}\n',
        '{"status":"downloading","completed":75,"total":100}\n{"status":"success"}\n',
      ])

      const progress: Array<{ status: string; completed?: number }> = []
      await pullOllamaModel('llama3.1', (p) => progress.push(p as typeof progress[0]))

      expect(progress).toHaveLength(3)
      expect(progress[0]!.status).toBe('pulling')
      expect(progress[0]!.completed).toBe(50)
      expect(progress[1]!.status).toBe('downloading')
      expect(progress[2]!.status).toBe('success')
    })

    it('parses data: SSE prefix lines', async () => {
      mockFetchStream([
        'data: {"status":"pulling","completed":10,"total":100}\n',
        'data: {"status":"success"}\n',
      ])

      const progress: Array<{ status: string }> = []
      await pullOllamaModel('llama3.1', (p) => progress.push(p as typeof progress[0]))

      expect(progress).toHaveLength(2)
      expect(progress[0]!.status).toBe('pulling')
      expect(progress[1]!.status).toBe('success')
    })

    it('does not fail when the stream ends after writing manifest without an explicit success event', async () => {
      mockFetchStream([
        '{"status":"pulling manifest"}\n',
        '{"status":"verifying sha256 digest"}\n{"status":"writing manifest"}\n',
      ])

      const progress: Array<{ status: string }> = []

      await expect(
        pullOllamaModel('llama3.1', (p) => progress.push(p as typeof progress[0])),
      ).resolves.toBeUndefined()

      expect(progress).toEqual([
        { status: 'pulling manifest' },
        { status: 'verifying sha256 digest' },
        { status: 'writing manifest' },
      ])
    })

    it('throws when stream contains an error field', async () => {
      mockFetchStream([
        '{"status":"downloading","completed":50,"total":100}\n',
        '{"status":"error","error":"disk full"}\n',
      ])

      const progress = vi.fn()
      await expect(pullOllamaModel('llama3.1', progress)).rejects.toThrow('disk full')
      expect(progress).toHaveBeenCalledTimes(2)
    })

    // ─── 10. throws on HTTP error response ──────────────
    it('throws on non-ok HTTP response', async () => {
      mockFetchStream([], false, 404)

      const progress = vi.fn()
      await expect(pullOllamaModel('nonexistent', progress)).rejects.toThrow('HTTP 404')
      expect(progress).not.toHaveBeenCalled()
    })

    it('throws with server error message from JSON body', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        body: null,
        json: () => Promise.resolve({ error: 'invalid model name' }),
      }))

      const progress = vi.fn()
      await expect(pullOllamaModel('bad', progress)).rejects.toThrow('invalid model name')
    })

    // ─── 11. throws when no response body ───────────────
    it('throws when response has no body', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: null,
        json: () => Promise.resolve({}),
      }))

      const progress = vi.fn()
      await expect(pullOllamaModel('llama3.1', progress)).rejects.toThrow('No response body')
    })

    // ─── 12. handles AbortSignal ────────────────────────
    it('passes AbortSignal to fetch and aborts the request', async () => {
      const controller = new AbortController()
      const fetchMock = vi.fn().mockImplementation(() => {
        return new Promise((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        })
      })
      vi.stubGlobal('fetch', fetchMock)

      const progress = vi.fn()
      const pullPromise = pullOllamaModel('llama3.1', progress, controller.signal)

      controller.abort()

      await expect(pullPromise).rejects.toThrow('aborted')

      // Verify signal was passed to fetch
      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: controller.signal }),
      )
    })
  })
})
