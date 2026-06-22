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

const { apiGet, apiPost, api } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  api: vi.fn(),
}))

vi.mock('../client', () => ({ apiGet, apiPost, api }))
vi.mock('@/config/env', () => ({ env: { apiBase: 'http://localhost:16060' } }))

import { getVoiceStatus, textToSpeech, speechToText } from '../voice'
import type { VoiceStatus, STTResponse } from '../voice'

beforeEach(() => {
  vi.clearAllMocks()
})

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
  it('正常路径：委托 client.api（POST /api/v1/voice/synthesize + responseType blob），返回 blob', async () => {
    const audioBlob = new Blob(['fake-audio'], { type: 'audio/mpeg' })
    api.mockResolvedValueOnce(audioBlob)

    const result = await textToSpeech({ text: 'hello world', voice: 'zh-CN-XiaoxiaoNeural' })

    expect(api).toHaveBeenCalledTimes(1)
    const [url, opts] = api.mock.calls[0]! as [string, Record<string, unknown>]
    expect(url).toBe('/api/v1/voice/synthesize')
    expect(opts).toMatchObject({ method: 'POST', responseType: 'blob' })
    // body 作为对象交给 ofetch 序列化，含 text + voice
    expect(opts.body).toEqual({ text: 'hello world', voice: 'zh-CN-XiaoxiaoNeural' })
    expect(result).toBe(audioBlob)
  })

  it('voice 缺省时 body 只含 text', async () => {
    api.mockResolvedValueOnce(new Blob())
    await textToSpeech({ text: 'no voice given' })
    const body = (api.mock.calls[0]![1] as { body: Record<string, unknown> }).body
    expect(body.text).toBe('no voice given')
    expect('voice' in body).toBe(false)
  })

  it('后端错误（ApiError）经统一 client 向上传播，不再吞成 generic "TTS failed"', async () => {
    const apiErr = Object.assign(new Error('voice synth failed'), { code: 'SERVER_ERROR', status: 500 })
    api.mockRejectedValueOnce(apiErr)
    await expect(textToSpeech({ text: 'boom' })).rejects.toBe(apiErr)
  })

  it('网络层 reject 向上传播原始错误', async () => {
    api.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(textToSpeech({ text: 'x' })).rejects.toThrow('Failed to fetch')
  })

  it('边界：空 text 仍照常委托 api（当前无前端校验）', async () => {
    api.mockResolvedValueOnce(new Blob())
    await textToSpeech({ text: '' })
    expect((api.mock.calls[0]![1] as { body: { text: string } }).body.text).toBe('')
  })

  it('边界：超长 text 完整进入 body，不被截断', async () => {
    const longText = 'a'.repeat(50_000)
    api.mockResolvedValueOnce(new Blob())
    await textToSpeech({ text: longText })
    expect((api.mock.calls[0]![1] as { body: { text: string } }).body.text).toHaveLength(50_000)
  })

  it('边界：含引号/换行/中文/emoji 的 text 原样进入 body（由 ofetch 序列化）', async () => {
    const tricky = '他说："你好\n世界" 🎤 \\backslash'
    api.mockResolvedValueOnce(new Blob())
    await textToSpeech({ text: tricky })
    expect((api.mock.calls[0]![1] as { body: { text: string } }).body.text).toBe(tricky)
  })
})

// ─── speechToText ──────────────────────────────────────
describe('speechToText', () => {
  it('正常路径：POST FormData 到 transcribe endpoint；format/language 走 URL query（后端从 query 读）', async () => {
    const stt: STTResponse = { text: '识别结果', confidence: 0.95, language: 'zh', duration: 3.2 }
    apiPost.mockResolvedValueOnce(stt)
    const file = new File(['audio-bytes'], 'clip.wav', { type: 'audio/wav' })

    const result = await speechToText(file, 'zh')

    expect(apiPost).toHaveBeenCalledTimes(1)
    const [url, body] = apiPost.mock.calls[0]!
    // format/language 现作为 URL query 传递（后端 handler_misc.go 从 r.URL.Query() 读取）
    const parsed = new URL(url as string, 'http://x')
    expect(parsed.pathname).toBe('/api/v1/voice/transcribe')
    expect(parsed.searchParams.get('format')).toBe('wav') // clip.wav → format=wav
    expect(parsed.searchParams.get('language')).toBe('zh')
    expect(body).toBeInstanceOf(FormData)
    const form = body as FormData
    // 音频仍走 FormData，字段名是 'audio'（注意：不是 'file'）
    const audio = form.get('audio')
    expect(audio).toBeInstanceOf(File)
    expect((audio as File).name).toBe('clip.wav')
    // language 不再放进 FormData body
    expect(form.has('language')).toBe(false)
    expect(result).toEqual(stt)
  })

  it('language 缺省时 URL query 不含 language（format 仍由音频容器推断）', async () => {
    apiPost.mockResolvedValueOnce({ text: '', confidence: 0, language: '', duration: 0 })
    const file = new File(['x'], 'a.mp3', { type: 'audio/mpeg' })

    await speechToText(file)

    const [url, body] = apiPost.mock.calls[0]!
    const parsed = new URL(url as string, 'http://x')
    expect((body as FormData).get('audio')).toBeInstanceOf(File)
    expect((body as FormData).has('language')).toBe(false)
    expect(parsed.searchParams.has('language')).toBe(false)
    // audio/mpeg → format=mp3
    expect(parsed.searchParams.get('format')).toBe('mp3')
  })

  it('language 为空字符串视为缺省（falsy），不写入 query/FormData', async () => {
    apiPost.mockResolvedValueOnce({ text: '', confidence: 0, language: '', duration: 0 })
    const file = new File(['x'], 'a.mp3', { type: 'audio/mpeg' })

    await speechToText(file, '')

    const [url, body] = apiPost.mock.calls[0]!
    expect((body as FormData).has('language')).toBe(false)
    expect(new URL(url as string, 'http://x').searchParams.has('language')).toBe(false)
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

    const [url, body] = apiPost.mock.calls[0]!
    const form = body as FormData
    expect((form.get('audio') as File).name).toBe(weirdName)
    // language 现走 URL query（被 URLSearchParams 安全编码后解析回原值）
    expect(new URL(url as string, 'http://x').searchParams.get('language')).toBe('zh-CN')
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
