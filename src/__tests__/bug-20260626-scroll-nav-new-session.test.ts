import { describe, it, expect } from 'vitest'
import { scrollNavFlags } from '@/utils/chat-compose'

/**
 * BUG-20260626：新开会话里输入框内容输入很多时，误显"下翻箭头"。
 *
 * 根因：ChatView.handleMessagesScroll 旧逻辑只看几何
 *   showScrollToBottom = (scrollHeight - scrollTop - clientHeight) > 200
 * 输入框变高 → 消息滚动容器（flex:1）clientHeight 被压缩 → 即便没有"长会话"，
 * 空状态/单条短消息也会相对压缩后的视口"溢出" → distanceFromBottom>200 → 误显下翻箭头。
 * 箭头本应只在"会话太长（真实可滚动距离够大）"时出现。
 *
 * 修复：scrollNavFlags 两道闸——① 无消息（空会话）一律不显示导航键；
 * ② 真实可滚动距离(overflow=scrollHeight-clientHeight) ≤ 阈值时不显示、也不误判为"已上滚"。
 */
describe('BUG-20260626: 新会话/短会话不因高输入框误显下翻箭头', () => {
  it('空会话（无消息）即便视口被压缩到溢出也不显示导航箭头', () => {
    // 高输入框把消息视口压到 300；空状态高 600 → distanceFromBottom=300>200（旧逻辑会显示）
    const f = scrollNavFlags({ scrollHeight: 600, scrollTop: 0, clientHeight: 300, hasMessages: false })
    expect(f.showScrollToBottom).toBe(false)
    expect(f.showScrollToTop).toBe(false)
    expect(f.userScrolledUp).toBe(false)
  })

  it('短会话（真实可滚动距离 < 200）不显示下翻箭头、也不误判为已上滚', () => {
    // overflow = 380-200 = 180 < 200。旧逻辑 userScrolledUp=180>100=true 会停掉自动跟随。
    const f = scrollNavFlags({ scrollHeight: 380, scrollTop: 0, clientHeight: 200, hasMessages: true })
    expect(f.showScrollToBottom).toBe(false)
    expect(f.userScrolledUp).toBe(false)
  })

  it('长会话真上滚到顶 → 显示下翻箭头、标记已上滚', () => {
    const f = scrollNavFlags({ scrollHeight: 2000, scrollTop: 0, clientHeight: 500, hasMessages: true })
    expect(f.showScrollToBottom).toBe(true)
    expect(f.userScrolledUp).toBe(true)
  })

  it('长会话停在底部 → 不显示下翻箭头', () => {
    const f = scrollNavFlags({ scrollHeight: 2000, scrollTop: 1500, clientHeight: 500, hasMessages: true })
    expect(f.showScrollToBottom).toBe(false)
  })

  it('长会话接近底部 → 显示上翻箭头', () => {
    const f = scrollNavFlags({ scrollHeight: 2000, scrollTop: 1450, clientHeight: 500, hasMessages: true })
    expect(f.showScrollToTop).toBe(true)
  })
})
