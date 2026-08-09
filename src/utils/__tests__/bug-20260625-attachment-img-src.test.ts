/**
 * BUG-20260625：附件图片 src 构造未按 ChatAttachment.data 契约 auto-detect 前缀。
 * 契约（types/chat.ts）：data 可能是 base64 / data URL / http(S) URL，渲染处须按
 * startsWith('http')/'data:' 自动判别。用户气泡 + 编辑缩略图原裸拼 `data:mime;base64,`+data，
 * 对 data-URL/http 图会拼成 `data:...;base64,data:...` / `...;base64,https://...` → 破图。
 */
import { describe, it, expect } from 'vitest'
import { imageSrc } from '@/utils/chat-compose'

describe('BUG-20260625 imageSrc 按 data 前缀 auto-detect', () => {
  it('裸 base64 → 加 data:mime;base64, 前缀', () => {
    expect(imageSrc({ data: 'AAAABBBB', mime: 'image/png' })).toBe('data:image/png;base64,AAAABBBB')
  })
  it('已是 data URL → 原样返回（不双前缀）', () => {
    expect(imageSrc({ data: 'data:image/jpeg;base64,XYZ', mime: 'image/png' })).toBe('data:image/jpeg;base64,XYZ')
  })
  it('http(s) URL → 原样返回', () => {
    expect(imageSrc({ data: 'https://cdn.example.com/a.png', mime: 'image/png' })).toBe('https://cdn.example.com/a.png')
    expect(imageSrc({ data: 'http://x/y.gif', mime: 'image/gif' })).toBe('http://x/y.gif')
  })
  it('当前会话 blob URL → 原样返回（不退化成 data URL）', () => {
    expect(imageSrc({ data: 'blob:chat-image-preview', mime: 'image/png' })).toBe('blob:chat-image-preview')
  })
})
