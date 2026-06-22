/**
 * BUG-20260622 — 媒体生成/语音 API 4 处运行时正确性修复的回归锁定测试。
 *
 *  A1  imageToSrc b64 MIME 硬编码 image/png → 应按 magic bytes 推断（jpeg/gif/webp），否则
 *      非 png 图被标错 MIME，下载/复制带错扩展名。
 *  A2  imageToSrc file_path 前导斜杠 → 产生 `.../generated//x` 双斜杠 URL（应规范化）。
 *  B   textToSpeech 裸 fetch 绕过统一 client → 无 env.timeout、无 ApiError 分类、不解析后端
 *      错误文案。应走 client 的 `api`（ofetch 实例：timeout + onResponseError→fromHttpStatus）。
 *  D   audioToSrc 同 A2：file_path 前导斜杠双斜杠；且完整 http(s) URL 被错误拼前缀。
 *
 * 闭环：本文件断言"修复后的正确行为"，在未修改源码上先 RED，修复后 GREEN，永久留作回归。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { VoiceChatResult } from '../voicechat'

// B：mock 统一 client 的 `api`，断言 textToSpeech 委托给它（而非裸 global fetch）
const apiMock = vi.hoisted(() => vi.fn())
vi.mock('@/config/env', () => ({ env: { apiBase: 'http://api.test', timeout: 30000 } }))
vi.mock('../client', async (orig) => {
  const actual = await orig<typeof import('../client')>()
  return { ...actual, api: apiMock }
})

import { imageToSrc } from '../imagegen'
import { audioToSrc } from '../voicechat'
import { textToSpeech } from '../voice'

// 各图像格式最小 base64（含 magic bytes 前缀）
const JPEG_B64 = '/9j/4AAQSkZJRgABAQ=='   // FF D8 FF
const GIF_B64 = 'R0lGODlhAQABAAAAACw='     // GIF8
const WEBP_B64 = 'UklGRiQAAABXRUJQVlA4'    // RIFF....WEBP
const PNG_B64 = 'iVBORw0KGgoAAAANSUhE'     // 89 50 4E 47

describe('BUG-20260622-A1: imageToSrc b64 MIME 按内容推断（不再恒 image/png）', () => {
  it('jpeg b64 → data:image/jpeg', () => {
    expect(imageToSrc({ b64_json: JPEG_B64 })).toBe(`data:image/jpeg;base64,${JPEG_B64}`)
  })
  it('gif b64 → data:image/gif', () => {
    expect(imageToSrc({ b64_json: GIF_B64 })).toBe(`data:image/gif;base64,${GIF_B64}`)
  })
  it('webp b64 → data:image/webp', () => {
    expect(imageToSrc({ b64_json: WEBP_B64 })).toBe(`data:image/webp;base64,${WEBP_B64}`)
  })
  it('png / 未知 b64 → data:image/png（兜底保持不变）', () => {
    expect(imageToSrc({ b64_json: PNG_B64 })).toBe(`data:image/png;base64,${PNG_B64}`)
  })
})

describe('BUG-20260622-A2: imageToSrc file_path 前导斜杠不产生双斜杠', () => {
  it('前导斜杠被规范化', () => {
    expect(imageToSrc({ file_path: '/202604/x.png' })).toBe(
      'http://api.test/api/v1/files/generated/202604/x.png',
    )
  })
  it('无前导斜杠保持不变', () => {
    expect(imageToSrc({ file_path: '202604/x.png' })).toBe(
      'http://api.test/api/v1/files/generated/202604/x.png',
    )
  })
})

describe('BUG-20260622-D: audioToSrc 路径规范化 + 完整 URL 透传', () => {
  const mk = (p: string): VoiceChatResult => ({ audio_file_path: p }) as unknown as VoiceChatResult
  it('前导斜杠不产生双斜杠', () => {
    expect(audioToSrc(mk('/v/a.wav'))).toBe('http://api.test/api/v1/files/generated/v/a.wav')
  })
  it('完整 http URL 直接透传（不再错误拼前缀）', () => {
    expect(audioToSrc(mk('https://cdn.x/a.wav'))).toBe('https://cdn.x/a.wav')
  })
})

describe('BUG-20260622-B: textToSpeech 走统一 client（timeout + ApiError），非裸 fetch', () => {
  beforeEach(() => {
    apiMock.mockReset()
    // 兜底 stub global fetch：未修复代码会调它，stub 让其干净返回而非真连网络/挂起
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(['legacy']) })),
    )
  })

  it('委托给 client.api：POST /api/v1/voice/synthesize + responseType blob', async () => {
    const blob = new Blob(['x'], { type: 'audio/mpeg' })
    apiMock.mockResolvedValue(blob)
    const res = await textToSpeech({ text: '你好' })
    expect(apiMock).toHaveBeenCalledTimes(1)
    const [url, opts] = apiMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(url).toBe('/api/v1/voice/synthesize')
    expect(opts).toMatchObject({ method: 'POST', responseType: 'blob' })
    expect(res).toBe(blob)
  })

  it('client 抛出的 ApiError 向上传播（不再吞成 generic "TTS failed"）', async () => {
    const apiErr = Object.assign(new Error('boom'), { code: 'SERVER_ERROR' })
    apiMock.mockRejectedValue(apiErr)
    await expect(textToSpeech({ text: 'x' })).rejects.toBe(apiErr)
  })
})
