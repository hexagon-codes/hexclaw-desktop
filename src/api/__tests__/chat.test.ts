import { describe, it, expect, vi, beforeEach } from 'vitest'

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue('{"reply":"ok","session_id":"s1"}'))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { sendChatViaBackend } from '../chat'

describe('sendChatViaBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invoke.mockResolvedValue('{"reply":"ok","session_id":"s1"}')
  })

  it('invokes backend_chat with correct params', async () => {
    const result = await sendChatViaBackend('hello', { sessionId: 's1', provider: '智谱', model: 'glm-5' })
    expect(invoke).toHaveBeenCalledWith('backend_chat', {
      params: expect.objectContaining({
        message: 'hello',
        session_id: 's1',
        provider: '智谱',
        model: 'glm-5',
      }),
    })
    expect(result.reply).toBe('ok')
  })

  it('passes temperature and maxTokens when provided', async () => {
    await sendChatViaBackend('hi', { temperature: 0.8, maxTokens: 2048 })
    const params = invoke.mock.calls[0]![1].params
    expect(params.temperature).toBe(0.8)
    expect(params.max_tokens).toBe(2048)
  })

  it('passes null for temperature/maxTokens when not provided', async () => {
    await sendChatViaBackend('hi')
    const params = invoke.mock.calls[0]![1].params
    expect(params.temperature).toBeNull()
    expect(params.max_tokens).toBeNull()
  })

  it('includes attachments in params', async () => {
    const attachments = [{ type: 'image', name: 'test.png', mime: 'image/png', data: 'base64data' }]
    await sendChatViaBackend('describe', { attachments })
    const params = invoke.mock.calls[0]![1].params
    expect(params.attachments).toEqual(attachments)
  })

  it('parses JSON response correctly', async () => {
    invoke.mockResolvedValueOnce('{"reply":"hello","session_id":"s2","metadata":{"model":"gpt-4"}}')
    const result = await sendChatViaBackend('test')
    expect(result.reply).toBe('hello')
    expect(result.session_id).toBe('s2')
    expect(result.metadata?.model).toBe('gpt-4')
  })
})
