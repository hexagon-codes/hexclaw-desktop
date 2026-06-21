/**
 * Voice API — 全场景单元测试
 *
 * 覆盖每个导出函数：getVoiceStatus / textToSpeech / speechToText
 *  - 正常路径：endpoint 路径 + 方法 + 参数形态（TTS 的 JSON body；STT 的 FormData 字段）
 *  - 错误路径：网络层 reject / TTS !res.ok → 异常向上传播
 *  - 边界：空 text / 超长 text / language 缺省 / 文件名特殊字符 / 自定义 voice
 *
 * mock 仅限网络层：
 *  - `../client` 的 apiGet / apiPost（getVoiceStatus / speechToText 走这里）
 *  - 原生 fetch（textToSpeech 直接用 fetch，不经过 client）
 *  - `@/config/env` 固定 apiBase，使 textToSpeech 的 URL 断言确定
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { apiGet, apiPost } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}))

vi.mock('../client', () => ({ apiGet, apiPost }))
vi.mock('@/config/env', () => ({ env: { apiBase: 'http://localhost:16060' } }))

import { getVoiceStatus, textToSpeech, speechToText } from '../voice'
import type { VoiceStatus, STTResponse } from '../voice'

const API_BASE = 'http://localhost:16060'

// ─── fetch stub helper（仅 textToSpeech 用）────────────
const mockFetch = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', mockFetch)
})

/** 构造一个最小可用的 Response-like 对象（textToSpeech 只用 ok/status/blob） */
function makeResponse(opts: { ok: boolean; status: number; blob?: Blob }) {
  return {
    ok: opts.ok,
    status: opts.status,
    blob: vi.fn().mockResolvedValue(opts.blob ?? new Blob([], { type: 'audio/mpeg' })),
  }
}

// ─── getVoiceStatus ────────────────────────────────────
describe('getVoiceStatus', () => {
  it('调用 apiGet 且 endpoint 路径精确为 /api/v1/voice/status', async () => {
    const status: VoiceStatus = {
      stt_enabled: true,
      tts_enabled: false,
      stt_provider: 'whisper',
      tts_provider: 'edge-tts',
    }
    apiGet.mockResolvedValueOnce(status)

    const result = await getVoiceStatus()

    expect(apiGet).toHaveBeenCalledTimes(1)
    expect(apiGet).toHaveBeenCalledWith('/api/v1/voice/status')
    expect(result).toEqual(status)
  })

  it('原样返回后端响应（不做任何转换）', async () => {
    apiGet.mockResolvedValueOnce({
      stt_enabled: false,
      tts_enabled: true,
      stt_provider: '',
      tts_provider: 'azure',
    })
    const r = await getVoiceStatus()
    expect(r.tts_provider).toBe('azure')
    expect(r.stt_enabled).toBe(false)
  })

  it('网络错误向上传播', async () => {
    apiGet.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(getVoiceStatus()).rejects.toThrow('ECONNREFUSED')
  })

  it('传播带 status 的 5xx 错误', async () => {
    apiGet.mockRejectedValueOnce(Object.assign(new Error('voice service down'), { status: 503 }))
    await expect(getVoiceStatus()).rejects.toThrow('voice service down')
  })

  it('不传任何 query 参数（仅 url 单参调用）', async () => {
    apiGet.mockResolvedValueOnce({})
    await getVoiceStatus()
    expect(apiGet.mock.calls[0]).toHaveLength(1)
  })
})

// ─── textToSpeech ──────────────────────────────────────
describe('textToSpeech', () => {
  it('正常路径：POST 到 synthesize endpoint，JSON header + 序列化 body，返回 blob', async () => {
    const audioBlob = new Blob(['fake-audio'], { type: 'audio/mpeg' })
    const res = makeResponse({ ok: true, status: 200, blob: audioBlob })
    mockFetch.mockResolvedValueOnce(res)

    const result = await textToSpeech({ text: 'hello world', voice: 'zh-CN-XiaoxiaoNeural' })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0]!
    expect(url).toBe(`${API_BASE}/api/v1/voice/synthesize`)
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
    // body 必须是 JSON 字符串，且含 text + voice
    expect(typeof init.body).toBe('string')
    expect(JSON.parse(init.body)).toEqual({ text: 'hello world', voice: 'zh-CN-XiaoxiaoNeural' })
    // 返回值就是 res.blob() 的结果
    expect(result).toBe(audioBlob)
    expect(res.blob).toHaveBeenCalledTimes(1)
  })

  it('voice 缺省时 body 只含 text（voice 字段为 undefined，序列化后省略）', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ ok: true, status: 200 }))
    await textToSpeech({ text: 'no voice given' })
    const init = mockFetch.mock.calls[0]![1]
    const parsed = JSON.parse(init.body)
    expect(parsed.text).toBe('no voice given')
    expect('voice' in parsed).toBe(false)
  })

  it('!res.ok 时抛出包含状态码的错误，且不调用 blob()', async () => {
    const res = makeResponse({ ok: false, status: 500 })
    mockFetch.mockResolvedValueOnce(res)
    await expect(textToSpeech({ text: 'boom' })).rejects.toThrow('TTS failed: 500')
    expect(res.blob).not.toHaveBeenCalled()
  })

  it('404 也按 !res.ok 抛出对应状态码', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ ok: false, status: 404 }))
    await expect(textToSpeech({ text: 'x' })).rejects.toThrow('TTS failed: 404')
  })

  it('fetch 本身 reject（网络断开）向上传播原始错误', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(textToSpeech({ text: 'x' })).rejects.toThrow('Failed to fetch')
  })

  it('边界：空 text 仍会照常发请求（当前实现无前端校验）', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ ok: true, status: 200 }))
    await textToSpeech({ text: '' })
    const parsed = JSON.parse(mockFetch.mock.calls[0]![1].body)
    expect(parsed.text).toBe('')
  })

  it('边界：超长 text 完整进入 body，不被截断', async () => {
    const longText = 'a'.repeat(50_000)
    mockFetch.mockResolvedValueOnce(makeResponse({ ok: true, status: 200 }))
    await textToSpeech({ text: longText })
    const parsed = JSON.parse(mockFetch.mock.calls[0]![1].body)
    expect(parsed.text).toHaveLength(50_000)
    expect(parsed.text).toBe(longText)
  })

  it('边界：含引号/换行/中文/emoji 的 text 经 JSON.stringify 正确转义且可往返还原', async () => {
    const tricky = '他说："你好\n世界" 🎤 \\backslash'
    mockFetch.mockResolvedValueOnce(makeResponse({ ok: true, status: 200 }))
    await textToSpeech({ text: tricky })
    const rawBody = mockFetch.mock.calls[0]![1].body as string
    // 原始 body 中换行被转义为字面 \n（不应出现真实换行破坏 JSON）
    expect(rawBody).not.toContain('\n')
    expect(JSON.parse(rawBody).text).toBe(tricky)
  })
})

// ─── speechToText ──────────────────────────────────────
describe('speechToText', () => {
  it('正常路径：POST FormData 到 transcribe endpoint，含 audio 文件 + language', async () => {
    const stt: STTResponse = { text: '识别结果', confidence: 0.95, language: 'zh', duration: 3.2 }
    apiPost.mockResolvedValueOnce(stt)
    const file = new File(['audio-bytes'], 'clip.wav', { type: 'audio/wav' })

    const result = await speechToText(file, 'zh')

    expect(apiPost).toHaveBeenCalledTimes(1)
    const [url, body] = apiPost.mock.calls[0]!
    expect(url).toBe('/api/v1/voice/transcribe')
    expect(body).toBeInstanceOf(FormData)
    const form = body as FormData
    // 字段名是 'audio'（注意：不是 'file'）
    const audio = form.get('audio')
    expect(audio).toBeInstanceOf(File)
    expect((audio as File).name).toBe('clip.wav')
    expect(form.get('language')).toBe('zh')
    expect(result).toEqual(stt)
  })

  it('language 缺省时 FormData 不含 language 字段', async () => {
    apiPost.mockResolvedValueOnce({ text: '', confidence: 0, language: '', duration: 0 })
    const file = new File(['x'], 'a.mp3', { type: 'audio/mpeg' })

    await speechToText(file)

    const form = apiPost.mock.calls[0]![1] as FormData
    expect(form.get('audio')).toBeInstanceOf(File)
    expect(form.has('language')).toBe(false)
    expect(form.get('language')).toBeNull()
  })

  it('language 为空字符串视为缺省（falsy），不写入 FormData', async () => {
    apiPost.mockResolvedValueOnce({ text: '', confidence: 0, language: '', duration: 0 })
    const file = new File(['x'], 'a.mp3', { type: 'audio/mpeg' })

    await speechToText(file, '')

    const form = apiPost.mock.calls[0]![1] as FormData
    expect(form.has('language')).toBe(false)
  })

  it('原样返回后端识别结果', async () => {
    apiPost.mockResolvedValueOnce({ text: 'hi', confidence: 0.8, language: 'en', duration: 1.5 })
    const r = await speechToText(new File(['x'], 'a.wav'))
    expect(r.text).toBe('hi')
    expect(r.confidence).toBe(0.8)
    expect(r.duration).toBe(1.5)
  })

  it('错误路径：apiPost reject（上传失败）向上传播', async () => {
    apiPost.mockRejectedValueOnce(new Error('upload failed: 413'))
    await expect(speechToText(new File(['x'], 'big.wav'))).rejects.toThrow('upload failed: 413')
  })

  it('错误路径：传播带 status 的 4xx（不支持的音频格式）', async () => {
    apiPost.mockRejectedValueOnce(
      Object.assign(new Error('unsupported audio format'), { status: 415 }),
    )
    await expect(speechToText(new File(['x'], 'bad.xyz'))).rejects.toThrow('unsupported audio format')
  })

  it('边界：文件名含空格/斜杠/中文等特殊字符，原样保留进 FormData（不被前端编码）', async () => {
    apiPost.mockResolvedValueOnce({ text: '', confidence: 0, language: '', duration: 0 })
    const weirdName = 'my recording (1)/语音#备份.wav'
    const file = new File(['x'], weirdName, { type: 'audio/wav' })

    await speechToText(file, 'zh-CN')

    const form = apiPost.mock.calls[0]![1] as FormData
    expect((form.get('audio') as File).name).toBe(weirdName)
    expect(form.get('language')).toBe('zh-CN')
  })

  it('边界：空文件（0 字节）仍照常构造 FormData 并发送', async () => {
    apiPost.mockResolvedValueOnce({ text: '', confidence: 0, language: '', duration: 0 })
    const empty = new File([], 'silence.wav', { type: 'audio/wav' })

    await speechToText(empty)

    const form = apiPost.mock.calls[0]![1] as FormData
    const audio = form.get('audio') as File
    expect(audio).toBeInstanceOf(File)
    expect(audio.size).toBe(0)
  })

  it('apiPost 仅以 (url, FormData) 两参调用，不传第三个 options', async () => {
    apiPost.mockResolvedValueOnce({ text: '', confidence: 0, language: '', duration: 0 })
    await speechToText(new File(['x'], 'a.wav'), 'en')
    expect(apiPost.mock.calls[0]).toHaveLength(2)
  })
})
