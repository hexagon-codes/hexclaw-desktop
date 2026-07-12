/**
 * BUG-20260712-J（复现→修复→锁定）：会话里生成的视频显示纯黑矩形（播放/下载都正常）。
 *
 * 定性：**本应用组件问题，不是模型生成问题**——后端早已持久化封面图
 * （handleVideoGenerated 把 coverToSrc 写进 message.metadata.poster），但消息气泡的
 * <video> 元素**没有绑定 :poster**；且 WebKit 在 preload="metadata" 下不渲染首帧，
 * 无 poster 即纯黑。
 *
 * 根修契约（utils/chat-compose 纯函数，ChatView 模板消费）：
 *  ① metadata.poster 存在 → <video :poster> 显示封面；
 *  ② 无 poster 时 src 追加媒体片段 #t=0.1 —— 标准 WebKit 首帧兜底（强制 seek 到 0.1s
 *     使浏览器解码一帧作静态画面），data:/已带 fragment 的 src 不追加。
 */
import { describe, it, expect } from 'vitest'
import { videoPosterFromMetadata, videoDisplaySrc } from '../chat-compose'

describe('BUG-20260712-J：视频封面/首帧展示', () => {
  it('★metadata.poster 存在 → 取封面 URL（后端持久化 cover，本就有、只是没接线）', () => {
    expect(videoPosterFromMetadata({ poster: 'http://localhost:16060/api/v1/files/generated/c.jpg' }))
      .toBe('http://localhost:16060/api/v1/files/generated/c.jpg')
    expect(videoPosterFromMetadata({})).toBeUndefined()
    expect(videoPosterFromMetadata(undefined)).toBeUndefined()
    expect(videoPosterFromMetadata({ poster: '  ' })).toBeUndefined()
  })

  it('★无 poster → src 追加 #t=0.1 强制 WebKit 渲染首帧（黑矩形根因兜底）', () => {
    expect(videoDisplaySrc('http://localhost:16060/v.mp4', undefined))
      .toBe('http://localhost:16060/v.mp4#t=0.1')
  })

  it('有 poster → src 原样（封面已覆盖静态画面，不做多余 seek）', () => {
    expect(videoDisplaySrc('http://localhost:16060/v.mp4', 'http://x/c.jpg'))
      .toBe('http://localhost:16060/v.mp4')
  })

  it('边界：data: URL / 已带 fragment / 空 src 不追加', () => {
    expect(videoDisplaySrc('data:video/mp4;base64,xxx', undefined)).toBe('data:video/mp4;base64,xxx')
    expect(videoDisplaySrc('http://x/v.mp4#t=5', undefined)).toBe('http://x/v.mp4#t=5')
    expect(videoDisplaySrc('', undefined)).toBe('')
  })
})
