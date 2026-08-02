import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendViaBackend = vi.hoisted(() => vi.fn())

vi.mock('@/services/chat-service-compat', () => ({ sendViaBackend }))

import { sendChatViaBackend } from '../chat'

describe('sendChatViaBackend WebSocket compatibility adapter', () => {
  beforeEach(() => {
    sendViaBackend.mockReset()
    sendViaBackend.mockResolvedValue({ reply: 'ok', session_id: 's1' })
  })

  it('maps the compatibility request into the shared WebSocket service', async () => {
    const result = await sendChatViaBackend('hello', {
      sessionId: 's1',
      provider: '智谱',
      model: 'glm-5',
    })

    expect(sendViaBackend).toHaveBeenCalledWith(
      'hello',
      's1',
      { provider: '智谱', model: 'glm-5', temperature: undefined, maxTokens: undefined },
      '',
      undefined,
      undefined,
      undefined,
    )
    expect(result.reply).toBe('ok')
  })

  it('maps temperature and maxTokens when provided', async () => {
    await sendChatViaBackend('hi', { sessionId: 's1', temperature: 0.8, maxTokens: 2048 })
    expect(sendViaBackend.mock.calls[0]![2]).toMatchObject({ temperature: 0.8, maxTokens: 2048 })
  })

  it('passes metadata without renderer serialization', async () => {
    await sendChatViaBackend('hi', { sessionId: 's1', metadata: { thinking: 'off' } })
    expect(sendViaBackend.mock.calls[0]![5]).toEqual({ thinking: 'off' })
  })

  it('keeps omitted optional values undefined', async () => {
    await sendChatViaBackend('hi', { sessionId: 's1' })
    expect(sendViaBackend.mock.calls[0]![2]).toEqual({
      provider: undefined,
      model: undefined,
      temperature: undefined,
      maxTokens: undefined,
    })
  })

  it('passes opaque attachment receipts to the shared service', async () => {
    const attachments = [{
      type: 'image' as const,
      name: 'test.png',
      mime: 'image/png',
      attachmentId: 'attachment-1',
    }]
    await sendChatViaBackend('describe', { sessionId: 's1', attachments })
    expect(sendViaBackend.mock.calls[0]![4]).toEqual(attachments)
  })

  it('returns the normalized WebSocket response unchanged', async () => {
    const response = { reply: 'hello', session_id: 's2', metadata: { model: 'gpt-4' } }
    sendViaBackend.mockResolvedValueOnce(response)
    await expect(sendChatViaBackend('test', { sessionId: 's2' })).resolves.toBe(response)
  })
})
