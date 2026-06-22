/**
 * Image Generation API — 全场景覆盖
 *
 * 覆盖每个导出：getImageGenStatus / generateImage / imageToSrc
 *  - getImageGenStatus / generateImage：endpoint + 方法 + body 透传；reject 传播；边界
 *  - imageToSrc（纯函数）：file_path / url / b64_json / 兜底 逐分支精确断言
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { apiGet, apiPost } = vi.hoisted(() => ({
  apiGet: vi.fn().mockResolvedValue({}),
  apiPost: vi.fn().mockResolvedValue({}),
}))

vi.mock('../client', () => ({ apiGet, apiPost }))
// env.apiBase 固定为已知值，便于 imageToSrc(file_path) 分支精确断言
vi.mock('@/config/env', () => ({ env: { apiBase: 'http://localhost:16060' } }))

import { getImageGenStatus, generateImage, imageToSrc } from '../imagegen'
import type { ImageGenRequest, GeneratedImage } from '../imagegen'

const API_BASE = 'http://localhost:16060'

describe('imagegen API', () => {
  beforeEach(() => vi.clearAllMocks())

  // ─── getImageGenStatus ───────────────────────────
  describe('getImageGenStatus', () => {
    it('calls GET /api/v1/images/status', async () => {
      apiGet.mockResolvedValueOnce({ enabled: true, providers: ['openai-dalle'], models: ['dall-e-3'] })
      const result = await getImageGenStatus()
      expect(apiGet).toHaveBeenCalledTimes(1)
      expect(apiGet).toHaveBeenCalledWith('/api/v1/images/status')
      expect(result.enabled).toBe(true)
      expect(result.providers).toEqual(['openai-dalle'])
      expect(result.models).toEqual(['dall-e-3'])
    })

    it('passes through disabled status (empty providers/models)', async () => {
      apiGet.mockResolvedValueOnce({ enabled: false, providers: [], models: [] })
      const result = await getImageGenStatus()
      expect(result.enabled).toBe(false)
      expect(result.providers).toEqual([])
    })

    it('propagates rejection from client (error path)', async () => {
      apiGet.mockRejectedValueOnce(new Error('Connection refused'))
      await expect(getImageGenStatus()).rejects.toThrow('Connection refused')
    })
  })

  // ─── generateImage ───────────────────────────────
  describe('generateImage', () => {
    it('calls POST /api/v1/images/generate with full body (model/prompt/size/n)', async () => {
      apiPost.mockResolvedValueOnce({ provider: 'openai-dalle', model: 'dall-e-3', created: 1, images: [] })
      const req: ImageGenRequest = { model: 'dall-e-3', prompt: 'a cat', size: '1024x1024', n: 2 }
      await generateImage(req)
      expect(apiPost).toHaveBeenCalledTimes(1)
      expect(apiPost).toHaveBeenCalledWith('/api/v1/images/generate', req)
    })

    it('forwards the request object verbatim (no mutation / no defaults injected)', async () => {
      apiPost.mockResolvedValueOnce({ provider: 'p', model: 'm', created: 0, images: [] })
      const req: ImageGenRequest = {
        provider: 'zhipu-cogview',
        model: 'cogview-4',
        prompt: 'mountain',
        negative: 'blurry',
        size: '1792x1024',
        n: 1,
        style: 'vivid',
        quality: 'hd',
      }
      await generateImage(req)
      const [url, body] = apiPost.mock.calls[0]!
      expect(url).toBe('/api/v1/images/generate')
      // 完整透传，未丢字段、未注入默认值
      expect(body).toEqual(req)
      expect(body).toBe(req) // 同一引用，证明没有拷贝/改写
    })

    it('returns the parsed result (provider/model/images)', async () => {
      const payload = {
        provider: 'openai-dalle',
        model: 'dall-e-3',
        created: 123,
        images: [{ url: 'https://x/img.png', revised_prompt: 'a fluffy cat' }],
        usage_ms: 4200,
      }
      apiPost.mockResolvedValueOnce(payload)
      const result = await generateImage({ model: 'dall-e-3', prompt: 'a cat' })
      expect(result.provider).toBe('openai-dalle')
      expect(result.images).toHaveLength(1)
      expect(result.images[0]!.url).toBe('https://x/img.png')
      expect(result.usage_ms).toBe(4200)
    })

    it('propagates rejection from client (error path)', async () => {
      apiPost.mockRejectedValueOnce(new Error('HTTP 500'))
      await expect(generateImage({ model: 'dall-e-3', prompt: 'x' })).rejects.toThrow('HTTP 500')
    })

    // ── 边界：空 prompt（前端不校验，原样透传由后端判定）
    it('boundary: empty prompt is forwarded as-is (no client-side validation)', async () => {
      apiPost.mockResolvedValueOnce({ provider: 'p', model: 'm', created: 0, images: [] })
      await generateImage({ model: 'dall-e-3', prompt: '' })
      expect(apiPost).toHaveBeenCalledWith(
        '/api/v1/images/generate',
        expect.objectContaining({ prompt: '' }),
      )
    })

    // ── 边界：n=0 原样透传
    it('boundary: n=0 is forwarded as-is', async () => {
      apiPost.mockResolvedValueOnce({ provider: 'p', model: 'm', created: 0, images: [] })
      await generateImage({ model: 'dall-e-3', prompt: 'x', n: 0 })
      const body = apiPost.mock.calls[0]![1] as ImageGenRequest
      expect(body.n).toBe(0)
    })

    // ── 边界：超大 n 原样透传（不被前端截断）
    it('boundary: very large n is forwarded without clamping', async () => {
      apiPost.mockResolvedValueOnce({ provider: 'p', model: 'm', created: 0, images: [] })
      await generateImage({ model: 'dall-e-3', prompt: 'x', n: 999999 })
      const body = apiPost.mock.calls[0]![1] as ImageGenRequest
      expect(body.n).toBe(999999)
    })

    // ── 边界：size 缺省 —— 不会在 body 中出现 size 字段（交由后端默认）
    it('boundary: omitted size is not injected into body', async () => {
      apiPost.mockResolvedValueOnce({ provider: 'p', model: 'm', created: 0, images: [] })
      await generateImage({ model: 'dall-e-3', prompt: 'x' })
      const body = apiPost.mock.calls[0]![1] as ImageGenRequest
      expect(body).not.toHaveProperty('size')
      expect(body.size).toBeUndefined()
    })
  })

  // ─── imageToSrc（纯函数，逐分支） ─────────────────
  describe('imageToSrc (pure)', () => {
    // 优先级 1：file_path 拼后端持久化路径
    it('file_path branch: builds backend generated-files URL', () => {
      const img: GeneratedImage = { file_path: '202604/abc.png' }
      expect(imageToSrc(img)).toBe(`${API_BASE}/api/v1/files/generated/202604/abc.png`)
    })

    it('file_path wins over url and b64_json (priority order)', () => {
      const img: GeneratedImage = {
        file_path: '202604/abc.png',
        url: 'https://provider/temp.png',
        b64_json: 'QUJD',
      }
      expect(imageToSrc(img)).toBe(`${API_BASE}/api/v1/files/generated/202604/abc.png`)
    })

    // 优先级 2：url 直接返回
    it('url branch: returns the url verbatim when no file_path', () => {
      const img: GeneratedImage = { url: 'https://provider/temp.png' }
      expect(imageToSrc(img)).toBe('https://provider/temp.png')
    })

    it('url wins over b64_json when no file_path', () => {
      const img: GeneratedImage = { url: 'https://provider/temp.png', b64_json: 'QUJD' }
      expect(imageToSrc(img)).toBe('https://provider/temp.png')
    })

    it('url branch: data: URLs are returned untouched', () => {
      const img: GeneratedImage = { url: 'data:image/jpeg;base64,/9j/4AAQ' }
      expect(imageToSrc(img)).toBe('data:image/jpeg;base64,/9j/4AAQ')
    })

    // 优先级 3：b64_json 拼 data URL
    it('b64_json branch: builds a data:image/png;base64 URL', () => {
      const img: GeneratedImage = { b64_json: 'QUJDREVG' }
      expect(imageToSrc(img)).toBe('data:image/png;base64,QUJDREVG')
    })

    it('b64_json branch: MIME 按 magic bytes 推断（BUG-20260622-A1 修复后，jpeg 不再标 png）', () => {
      // JPEG magic（/9j/）→ image/jpeg；png/未知才兜底 image/png
      const img: GeneratedImage = { b64_json: '/9j/4AAQSkZJRg' }
      const src = imageToSrc(img)
      expect(src).toBe('data:image/jpeg;base64,/9j/4AAQSkZJRg')
    })

    // 兜底：什么都没有 → 空串
    it('fallback branch: returns empty string when no field present', () => {
      expect(imageToSrc({})).toBe('')
    })

    it('fallback: revised_prompt alone (no src field) → empty string', () => {
      const img: GeneratedImage = { revised_prompt: 'a cat sitting' }
      expect(imageToSrc(img)).toBe('')
    })

    // 边界：空串字段视为 falsy，跳到下一优先级 / 兜底
    it('empty-string file_path falls through to url', () => {
      const img: GeneratedImage = { file_path: '', url: 'https://provider/temp.png' }
      expect(imageToSrc(img)).toBe('https://provider/temp.png')
    })

    it('empty-string url falls through to b64_json', () => {
      const img: GeneratedImage = { url: '', b64_json: 'QUJD' }
      expect(imageToSrc(img)).toBe('data:image/png;base64,QUJD')
    })

    it('all empty-string fields → fallback empty string', () => {
      const img: GeneratedImage = { file_path: '', url: '', b64_json: '' }
      expect(imageToSrc(img)).toBe('')
    })

    // 边界：file_path 带前导斜杠会产生双斜杠（原样拼接，不做规范化）
    it('file_path with leading slash is concatenated verbatim (double slash, no normalization)', () => {
      const img: GeneratedImage = { file_path: '/202604/abc.png' }
      // BUG-20260622-A2 修复后：前导斜杠被规范化，不再产生双斜杠
      expect(imageToSrc(img)).toBe(`${API_BASE}/api/v1/files/generated/202604/abc.png`)
    })

    // 纯函数：不触碰 client（无副作用）
    it('is side-effect free: does not call apiGet/apiPost', () => {
      imageToSrc({ url: 'https://x/y.png' })
      expect(apiGet).not.toHaveBeenCalled()
      expect(apiPost).not.toHaveBeenCalled()
    })
  })
})
