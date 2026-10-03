/**
 * Ollama API comprehensive tests
 *
 * Covers: getOllamaStatus, getOllamaRunning, unloadOllamaModel,
 * deleteOllamaModel, restartOllama, and pullOllamaModel (stream parsing,
 * error handling, AbortSignal).
 *
 * getOllamaStatus/getOllamaRunning 消费当前后端的目标投影。
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
    vi.resetAllMocks()
    mockOfetch.mockResolvedValue({ ollama: { target_id: 'target-local', target_revision: 1 } })
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // ─── 1. getOllamaStatus 查询当前后端 ────────
  it('getOllamaStatus calls the current backend and returns the target status', async () => {
    mockOfetch.mockResolvedValueOnce({ target_id: 'target-local', target_revision: 1,
      running: true, version: '0.5.1', model_count: 1,
      models: [{ name: 'm1', size: 100, modified: '2024-01-01' }] })

    const result = await getOllamaStatus()

    expect(mockOfetch).toHaveBeenCalledExactlyOnceWith('/api/v1/ollama/status', expect.objectContaining({ method: 'GET' }))
    expect(result.running).toBe(true)
    expect(result.version).toBe('0.5.1')
    expect(result.model_count).toBe(1)
  })

  // ─── 2. getOllamaRunning 消费后端运行模型投影 ─────────
  it('getOllamaRunning returns models from the current backend projection', async () => {
    const models = [
      { name: 'llama3.1', size: 4_000_000, size_vram: 3_000_000, expires_at: '2024-12-01', context_length: 8192 },
    ]
    mockOfetch.mockResolvedValueOnce({ target_id: 'target-local', target_revision: 1, models })

    const result = await getOllamaRunning()

    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('llama3.1')
  })

  // ─── 3. getOllamaRunning returns [] when models undefined
  it('getOllamaRunning returns empty array when models is undefined', async () => {
    mockOfetch.mockResolvedValueOnce({ target_id: 'target-local', target_revision: 1 })

    const result = await getOllamaRunning()

    expect(result).toEqual([])
  })

  // ─── 4. getOllamaRunning returns [] when models null-ish
  it('getOllamaRunning returns empty array when models is null', async () => {
    mockOfetch.mockResolvedValueOnce({ target_id: 'target-local', target_revision: 1, models: null })

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
        'data: {"status":"pulling","completed":50,"total":100}\n',
        'data: {"status":"downloading","completed":75,"total":100}\ndata: {"status":"success","state":"succeeded"}\n',
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
        'data: {"status":"success","state":"succeeded"}\n',
      ])

      const progress: Array<{ status: string }> = []
      await pullOllamaModel('llama3.1', (p) => progress.push(p as typeof progress[0]))

      expect(progress).toHaveLength(2)
      expect(progress[0]!.status).toBe('pulling')
      expect(progress[1]!.status).toBe('success')
    })

    it('keeps the outcome unknown when the stream ends without a terminal state', async () => {
      mockFetchStream([
        'data: {"status":"pulling manifest"}\n',
        'data: {"status":"verifying sha256 digest"}\ndata: {"status":"writing manifest"}\n',
      ])

      const progress: Array<{ status: string }> = []

      await expect(
        pullOllamaModel('llama3.1', (p) => progress.push(p as typeof progress[0])),
      ).rejects.toThrow('Ollama pull outcome is unknown')

      expect(progress).toEqual([
        { status: 'pulling manifest' },
        { status: 'verifying sha256 digest' },
        { status: 'writing manifest' },
      ])
    })

    it('throws when stream contains an error field', async () => {
      mockFetchStream([
        'data: {"status":"downloading","completed":50,"total":100}\n',
        'data: {"status":"error","state":"failed","error":"disk full"}\n',
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

    it('rejects a failed HTTP request without claiming a terminal operation result', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        body: null,
        json: () => Promise.resolve({ error: 'invalid model name' }),
      }))

      const progress = vi.fn()
      await expect(pullOllamaModel('bad', progress)).rejects.toThrow('HTTP 400')
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
      await expect(pullOllamaModel('llama3.1', progress)).rejects.toThrow('Ollama pull response is unavailable')
    })

    // ─── 12. handles AbortSignal ────────────────────────
    it('passes AbortSignal to fetch and aborts the request', async () => {
      const controller = new AbortController()
      const fetchMock = vi.fn().mockImplementation(() => {
        return new Promise((_resolve, reject) => {
          if (controller.signal.aborted) {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
            return
          }
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
