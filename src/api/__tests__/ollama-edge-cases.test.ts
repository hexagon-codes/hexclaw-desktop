/**
 * Ollama API Edge Cases — 覆盖未测试的函数
 *
 * getOllamaStatus / getOllamaRunning / unloadOllamaModel /
 * deleteOllamaModel / restartOllama + error paths
 *
 * getOllamaStatus/getOllamaRunning 直连 Ollama 原生 API（fetch）。
 * unloadOllamaModel/deleteOllamaModel/restartOllama 走 ofetch（apiPost/apiDelete）。
 * pullOllamaModel 仍用 raw fetch。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── ofetch mock（非流式函数） ────────────────────────
const mockOfetch = vi.hoisted(() => vi.fn())
vi.mock('ofetch', () => ({
  ofetch: { create: () => mockOfetch },
}))

// ─── raw fetch mock（pullOllamaModel 专用） ──────────
const mockFetchFn = vi.hoisted(() => vi.fn())
vi.stubGlobal('fetch', mockFetchFn)

vi.mock('@/config/env', () => ({
  env: { apiBase: 'http://localhost:16060', wsBase: 'ws://localhost:16060', timeout: 5000 },
  OLLAMA_BASE: 'http://localhost:11434',
}))

import {
  getOllamaStatus, getOllamaRunning, unloadOllamaModel,
  deleteOllamaModel, restartOllama, pullOllamaModel,
} from '../ollama'

describe('Ollama API Edge Cases', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ─── getOllamaStatus ────────────────────────────

  describe('getOllamaStatus', () => {
    it('returns status on success', async () => {
      mockFetchFn
        .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: 'm1', size: 100, modified_at: '2024-01-01' }] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ version: '0.3.0' }), { status: 200 }))
      const result = await getOllamaStatus()
      expect(result.running).toBe(true)
      expect(result.version).toBe('0.3.0')
    })

    it('returns { running: false } on error (no longer throws)', async () => {
      mockFetchFn.mockRejectedValue(new Error('500'))
      const result = await getOllamaStatus()
      expect(result.running).toBe(false)
    })

    it('calls Ollama native endpoints directly', async () => {
      mockFetchFn
        .mockResolvedValueOnce(new Response(JSON.stringify({ models: [] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ version: '0.5.0' }), { status: 200 }))
      await getOllamaStatus()
      expect(mockFetchFn).toHaveBeenCalledWith('http://localhost:11434/api/tags', expect.anything())
      expect(mockFetchFn).toHaveBeenCalledWith('http://localhost:11434/api/version', expect.anything())
    })
  })

  // ─── getOllamaRunning ───────────────────────────

  describe('getOllamaRunning', () => {
    it('returns running models', async () => {
      mockFetchFn.mockResolvedValue(new Response(JSON.stringify({
        models: [{ name: 'llama3.1', size: 4000000, size_vram: 3000000, expires_at: '2024-01-01', context_length: 8192 }],
      }), { status: 200 }))
      const result = await getOllamaRunning()
      expect(result).toHaveLength(1)
      expect(result[0]!.name).toBe('llama3.1')
    })

    it('returns empty array when no models field', async () => {
      mockFetchFn.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }))
      const result = await getOllamaRunning()
      expect(result).toEqual([])
    })

    it('returns empty array on error (no longer throws)', async () => {
      mockFetchFn.mockRejectedValue(new Error('503'))
      const result = await getOllamaRunning()
      expect(result).toEqual([])
    })
  })

  // ─── unloadOllamaModel ──────────────────────────

  describe('unloadOllamaModel', () => {
    it('sends POST with model name', async () => {
      mockOfetch.mockResolvedValue(undefined)
      await unloadOllamaModel('llama3.1')
      expect(mockOfetch).toHaveBeenCalledWith(
        '/api/v1/ollama/unload',
        expect.objectContaining({ method: 'POST', body: { model: 'llama3.1' } }),
      )
    })

    it('throws on failure', async () => {
      mockOfetch.mockRejectedValue(new Error('404'))
      await expect(unloadOllamaModel('nonexistent')).rejects.toThrow()
    })
  })

  // ─── deleteOllamaModel ──────────────────────────

  describe('deleteOllamaModel', () => {
    it('sends DELETE with URL-encoded name', async () => {
      mockOfetch.mockResolvedValue(undefined)
      await deleteOllamaModel('qwen3:14b')
      expect(mockOfetch).toHaveBeenCalledWith(
        `/api/v1/ollama/models/${encodeURIComponent('qwen3:14b')}`,
        expect.objectContaining({ method: 'DELETE' }),
      )
    })

    it('throws on failure', async () => {
      mockOfetch.mockRejectedValue(new Error('500'))
      await expect(deleteOllamaModel('bad')).rejects.toThrow()
    })
  })

  // ─── restartOllama ──────────────────────────────

  describe('restartOllama', () => {
    it('returns status on success', async () => {
      mockOfetch.mockResolvedValue({ status: 'restarted' })
      const result = await restartOllama()
      expect(result).toBe('restarted')
    })

    it('returns "unknown" when no status field', async () => {
      mockOfetch.mockResolvedValue({})
      const result = await restartOllama()
      expect(result).toBe('unknown')
    })

    it('throws on failure', async () => {
      mockOfetch.mockRejectedValue(new Error('500'))
      await expect(restartOllama()).rejects.toThrow()
    })
  })

  // ─── pullOllamaModel (仍走 raw fetch) ──────────

  describe('pullOllamaModel', () => {
    it('throws on non-ok response with error body', async () => {
      mockFetchFn.mockResolvedValue(new Response(JSON.stringify({ error: 'model not found' }), { status: 404 }))
      const onProgress = vi.fn()
      await expect(pullOllamaModel('bad-model', onProgress)).rejects.toThrow('model not found')
    })

    it('throws on non-ok response with non-JSON body', async () => {
      mockFetchFn.mockResolvedValue(new Response('not json', { status: 500 }))
      const onProgress = vi.fn()
      await expect(pullOllamaModel('bad-model', onProgress)).rejects.toThrow('HTTP 500')
    })

    it('throws when response has no body', async () => {
      const resp = new Response(null, { status: 200 })
      Object.defineProperty(resp, 'body', { value: null })
      mockFetchFn.mockResolvedValue(resp)
      const onProgress = vi.fn()
      await expect(pullOllamaModel('model', onProgress)).rejects.toThrow('No response body')
    })

    it('throws when stream contains error field', async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"status":"downloading"}\n{"error":"disk full"}\n'))
          controller.close()
        },
      })
      const resp = new Response(body, { status: 200 })
      mockFetchFn.mockResolvedValue(resp)
      const onProgress = vi.fn()
      await expect(pullOllamaModel('model', onProgress)).rejects.toThrow('disk full')
      expect(onProgress).toHaveBeenCalledTimes(2)
    })

    it('calls onProgress for each JSON line', async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"status":"pulling","completed":50,"total":100}\n{"status":"success"}\n'))
          controller.close()
        },
      })
      const resp = new Response(body, { status: 200 })
      mockFetchFn.mockResolvedValue(resp)
      const onProgress = vi.fn()
      await pullOllamaModel('model', onProgress)
      expect(onProgress).toHaveBeenCalledTimes(2)
      expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ status: 'pulling', completed: 50 }))
    })

    it('handles data: prefix in SSE format', async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"status":"success"}\n'))
          controller.close()
        },
      })
      const resp = new Response(body, { status: 200 })
      mockFetchFn.mockResolvedValue(resp)
      const onProgress = vi.fn()
      await pullOllamaModel('model', onProgress)
      expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }))
    })
  })
})
