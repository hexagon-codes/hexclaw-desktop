/**
 * Voice Chat API — 全场景覆盖
 *
 * 覆盖每个导出：
 *  - getVoiceChatStatus  : endpoint + 方法 + 正常/错误传播
 *  - voiceChat           : endpoint + 方法 + body 透传 + 边界(空 text/空 audio/缺 voice) + 错误传播
 *  - audioToSrc          : 纯函数全分支（持久化路径 / base64 data URL / mime 缺省 / 两者皆缺兜底）
 *
 * mock 约定：
 *  - mock `../client` 的 apiGet / apiPost（隔离 ofetch / HTTP 栈，只验调用契约与传播）
 *  - mock `@/config/env`，给 audioToSrc 一个确定的 apiBase，让输出断言精确不依赖运行时环境推导
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// audioToSrc 拼 URL 用到 env.apiBase；固定值让断言精确。
vi.mock('@/config/env', () => ({
  env: { apiBase: 'http://api.test' },
}))

const apiGet = vi.hoisted(() => vi.fn())
const apiPost = vi.hoisted(() => vi.fn())
vi.mock('../client', () => ({
  apiGet,
  apiPost,
}))

import { getVoiceChatStatus, voiceChat, audioToSrc } from '../voicechat'
import type { VoiceChatRequest, VoiceChatResult, VoiceChatStatus } from '../voicechat'

describe('Voice Chat API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiGet.mockReset()
    apiPost.mockReset()
  })

  // ─── getVoiceChatStatus ─────────────────────────────

  describe('getVoiceChatStatus', () => {
    it('calls apiGet with /api/v1/voicechat/status and returns payload', async () => {
      const status: VoiceChatStatus = {
        enabled: true,
        providers: ['openai', 'zhipu'],
        models: ['gpt-4o-audio-preview', 'glm-4-voice'],
      }
      apiGet.mockResolvedValue(status)

      const result = await getVoiceChatStatus()

      expect(apiGet).toHaveBeenCalledTimes(1)
      expect(apiGet).toHaveBeenCalledWith('/api/v1/voicechat/status')
      // 无多余参数（GET 不带 query）
      expect(apiGet.mock.calls[0]).toEqual(['/api/v1/voicechat/status'])
      expect(result).toBe(status)
    })

    it('passes through a disabled status payload unchanged', async () => {
      const status: VoiceChatStatus = { enabled: false, providers: [], models: [] }
      apiGet.mockResolvedValue(status)
      const result = await getVoiceChatStatus()
      expect(result.enabled).toBe(false)
      expect(result.providers).toEqual([])
      expect(result.models).toEqual([])
    })

    it('propagates rejection from the client (network down)', async () => {
      apiGet.mockRejectedValue(new Error('ECONNREFUSED'))
      await expect(getVoiceChatStatus()).rejects.toThrow('ECONNREFUSED')
    })

    it('propagates a 500 server error', async () => {
      apiGet.mockRejectedValue(Object.assign(new Error('voicechat unavailable'), { status: 500 }))
      await expect(getVoiceChatStatus()).rejects.toThrow('voicechat unavailable')
    })
  })

  // ─── voiceChat ──────────────────────────────────────

  describe('voiceChat', () => {
    it('calls apiPost with /api/v1/voicechat/chat, the request body, and returns result', async () => {
      const req: VoiceChatRequest = {
        provider: 'openai',
        model: 'gpt-4o-audio-preview',
        audio: 'BASE64AUDIO==',
        voice: 'alloy',
        format: 'wav',
        system: 'be concise',
        history: [{ role: 'user', text: 'hi', audio_id: 'a1' }],
      }
      const res: VoiceChatResult = {
        provider: 'openai',
        model: 'gpt-4o-audio-preview',
        transcript: 'hello there',
        user_text: 'hi',
        audio: 'OUT64==',
        format: 'wav',
        usage_ms: 1234,
      }
      apiPost.mockResolvedValue(res)

      const result = await voiceChat(req)

      expect(apiPost).toHaveBeenCalledTimes(1)
      expect(apiPost).toHaveBeenCalledWith('/api/v1/voicechat/chat', req)
      // body 必须原样透传（同一引用），不做转换
      expect(apiPost.mock.calls[0]![1]).toBe(req)
      expect(result).toBe(res)
    })

    it('boundary: text-only request (no audio) still forwards body verbatim', async () => {
      const req: VoiceChatRequest = { model: 'glm-4-voice', text: 'tell me a joke' }
      apiPost.mockResolvedValue({ provider: 'zhipu', model: 'glm-4-voice', transcript: 'ha' })
      await voiceChat(req)
      const sentBody = apiPost.mock.calls[0]![1] as VoiceChatRequest
      expect(sentBody.text).toBe('tell me a joke')
      expect(sentBody.audio).toBeUndefined()
    })

    it('boundary: empty text string is forwarded (not dropped)', async () => {
      const req: VoiceChatRequest = { model: 'glm-4-voice', text: '' }
      apiPost.mockResolvedValue({ provider: 'zhipu', model: 'glm-4-voice' })
      await voiceChat(req)
      const sentBody = apiPost.mock.calls[0]![1] as VoiceChatRequest
      expect(sentBody.text).toBe('')
      expect('text' in sentBody).toBe(true)
    })

    it('boundary: empty audio string is forwarded (not dropped)', async () => {
      const req: VoiceChatRequest = { model: 'gpt-4o-audio-preview', audio: '' }
      apiPost.mockResolvedValue({ provider: 'openai', model: 'gpt-4o-audio-preview' })
      await voiceChat(req)
      const sentBody = apiPost.mock.calls[0]![1] as VoiceChatRequest
      expect(sentBody.audio).toBe('')
    })

    it('boundary: missing voice — body has no voice field, forwarded as-is', async () => {
      const req: VoiceChatRequest = { model: 'gpt-4o-audio-preview', audio: 'A==' }
      apiPost.mockResolvedValue({ provider: 'openai', model: 'gpt-4o-audio-preview' })
      await voiceChat(req)
      const sentBody = apiPost.mock.calls[0]![1] as VoiceChatRequest
      expect(sentBody.voice).toBeUndefined()
      expect('voice' in sentBody).toBe(false)
    })

    it('boundary: minimal request (only required model) is forwarded', async () => {
      const req: VoiceChatRequest = { model: 'glm-4-voice' }
      apiPost.mockResolvedValue({ provider: 'zhipu', model: 'glm-4-voice' })
      await voiceChat(req)
      expect(apiPost).toHaveBeenCalledWith('/api/v1/voicechat/chat', { model: 'glm-4-voice' })
    })

    it('propagates rejection from the client (network down)', async () => {
      apiPost.mockRejectedValue(new Error('socket hang up'))
      await expect(voiceChat({ model: 'glm-4-voice', text: 'x' })).rejects.toThrow('socket hang up')
    })

    it('propagates a 400 bad-request error', async () => {
      apiPost.mockRejectedValue(Object.assign(new Error('audio required'), { status: 400 }))
      await expect(voiceChat({ model: 'glm-4-voice' })).rejects.toThrow('audio required')
    })

    it('propagates a 502 upstream error', async () => {
      apiPost.mockRejectedValue(Object.assign(new Error('upstream model error'), { status: 502 }))
      await expect(voiceChat({ model: 'gpt-4o-audio-preview', audio: 'A==' })).rejects.toThrow(
        'upstream model error',
      )
    })
  })

  // ─── audioToSrc (纯函数全分支) ──────────────────────

  describe('audioToSrc', () => {
    // 分支 1：持久化路径优先 —— 返回 apiBase + 固定 files 前缀 + 路径
    it('branch[file_path]: returns generated-files URL built from apiBase', () => {
      const r = { provider: 'p', model: 'm', audio_file_path: 'voice/abc.wav' } as VoiceChatResult
      expect(audioToSrc(r)).toBe('http://api.test/api/v1/files/generated/voice/abc.wav')
    })

    it('branch[file_path]: prepends apiBase even when path already looks absolute (current behavior, no passthrough)', () => {
      // 注：docstring 称"或返回 http url"，但实现总是拼 apiBase 前缀，并未对绝对/http 路径做透传判断。
      const r = { provider: 'p', model: 'm', audio_file_path: 'https://cdn.x/a.wav' } as VoiceChatResult
      expect(audioToSrc(r)).toBe('http://api.test/api/v1/files/generated/https://cdn.x/a.wav')
    })

    it('branch[file_path]: file_path takes priority over inline audio (audio ignored)', () => {
      const r = {
        provider: 'p',
        model: 'm',
        audio_file_path: 'voice/x.wav',
        audio: 'SHOULD_BE_IGNORED',
        format: 'mp3',
      } as VoiceChatResult
      expect(audioToSrc(r)).toBe('http://api.test/api/v1/files/generated/voice/x.wav')
    })

    it('branch[audio+mp3]: builds audio/mpeg data URL when format === mp3', () => {
      const r = { provider: 'p', model: 'm', audio: 'MP3DATA', format: 'mp3' } as VoiceChatResult
      expect(audioToSrc(r)).toBe('data:audio/mpeg;base64,MP3DATA')
    })

    it('branch[audio+wav]: builds audio/wav data URL when format === wav', () => {
      const r = { provider: 'p', model: 'm', audio: 'WAVDATA', format: 'wav' } as VoiceChatResult
      expect(audioToSrc(r)).toBe('data:audio/wav;base64,WAVDATA')
    })

    it('branch[audio+mime-default]: defaults to audio/wav when format is undefined', () => {
      const r = { provider: 'p', model: 'm', audio: 'NOFMT' } as VoiceChatResult
      expect(audioToSrc(r)).toBe('data:audio/wav;base64,NOFMT')
    })

    it('branch[audio+ogg]: format === ogg maps to audio/ogg (V-6 修复：不再误退化为 wav)', () => {
      const r = { provider: 'p', model: 'm', audio: 'OGGDATA', format: 'ogg' } as VoiceChatResult
      expect(audioToSrc(r)).toBe('data:audio/ogg;base64,OGGDATA')
    })

    it('branch[audio+flac]: format === flac maps to audio/flac (V-6 修复)', () => {
      const r = { provider: 'p', model: 'm', audio: 'FLACDATA', format: 'flac' } as VoiceChatResult
      expect(audioToSrc(r)).toBe('data:audio/flac;base64,FLACDATA')
    })

    it('branch[audio+unknown]: 未知 format 仍兜底 audio/wav', () => {
      const r = { provider: 'p', model: 'm', audio: 'XDATA', format: 'xyz' } as VoiceChatResult
      expect(audioToSrc(r)).toBe('data:audio/wav;base64,XDATA')
    })

    it('branch[empty]: returns empty string when neither file_path nor audio present', () => {
      const r = { provider: 'p', model: 'm', transcript: 'text-only reply' } as VoiceChatResult
      expect(audioToSrc(r)).toBe('')
    })

    it('branch[empty]: empty-string file_path AND empty-string audio → empty (no illegal data:;base64, emitted)', () => {
      const r = { provider: 'p', model: 'm', audio_file_path: '', audio: '' } as VoiceChatResult
      // 关键防御：空 audio 不应产出非法的 `data:audio/wav;base64,`，必须返回兜底空串
      expect(audioToSrc(r)).toBe('')
    })

    it('branch[empty]: empty file_path falls through to audio branch', () => {
      const r = { provider: 'p', model: 'm', audio_file_path: '', audio: 'FALLBACK', format: 'mp3' } as VoiceChatResult
      expect(audioToSrc(r)).toBe('data:audio/mpeg;base64,FALLBACK')
    })

    it('returns a string for every shape (never undefined/null)', () => {
      const shapes: VoiceChatResult[] = [
        { provider: 'p', model: 'm' } as VoiceChatResult,
        { provider: 'p', model: 'm', audio: 'a' } as VoiceChatResult,
        { provider: 'p', model: 'm', audio_file_path: 'x' } as VoiceChatResult,
      ]
      for (const s of shapes) {
        expect(typeof audioToSrc(s)).toBe('string')
      }
    })
  })
})
