import { describe, it, expect } from 'vitest'
import { shouldSendOnEnter, normalizePastedText, shouldAutoScroll, COMPOSE_GUARD_MS } from '@/utils/chat-compose'

const LS = String.fromCharCode(0x2028) // U+2028 行分隔
const PS = String.fromCharCode(0x2029) // U+2029 段分隔

// AUDIT 2026-06-23 三处会话 UX bug 的纯逻辑钉死：
describe('AUDIT #3 IME Enter 不误发送', () => {
  it('普通 Enter 发送', () => {
    expect(shouldSendOnEnter({ key: 'Enter' })).toBe(true)
  })
  it('IME 合成中(isComposing) 的 Enter 不发送（确认候选词）', () => {
    expect(shouldSendOnEnter({ key: 'Enter', isComposing: true })).toBe(false)
  })
  it('IME keyCode 229 的 Enter 不发送（旧浏览器）', () => {
    expect(shouldSendOnEnter({ key: 'Enter', keyCode: 229 })).toBe(false)
  })
  it('Shift/Alt/Cmd+Enter = 换行不发送', () => {
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: true })).toBe(false)
    expect(shouldSendOnEnter({ key: 'Enter', altKey: true })).toBe(false)
    expect(shouldSendOnEnter({ key: 'Enter', metaKey: true })).toBe(false)
  })
  it('手动合成标志 composing=true 的 Enter 不发送', () => {
    expect(shouldSendOnEnter({ key: 'Enter' }, { composing: true })).toBe(false)
  })
  it('WKWebView 兜底：刚结束合成(<窗口) 的确认 Enter 不发送', () => {
    expect(shouldSendOnEnter({ key: 'Enter' }, { msSinceCompositionEnd: 0 })).toBe(false)
    expect(shouldSendOnEnter({ key: 'Enter' }, { msSinceCompositionEnd: COMPOSE_GUARD_MS - 1 })).toBe(false)
  })
  it('合成结束后再按 Enter 发送（超过窗口，真实发送不被误拦）', () => {
    expect(shouldSendOnEnter({ key: 'Enter' }, { composing: false, msSinceCompositionEnd: COMPOSE_GUARD_MS + 50 })).toBe(true)
    expect(shouldSendOnEnter({ key: 'Enter' }, { msSinceCompositionEnd: 5000 })).toBe(true)
  })
})

describe('AUDIT #1 粘贴换行不被吞', () => {
  it('CRLF / CR / U+2028 / U+2029 都规范化为 \\n（保留换行）', () => {
    expect(normalizePastedText('a\r\nb')).toBe('a\nb')
    expect(normalizePastedText('a\rb')).toBe('a\nb')
    expect(normalizePastedText('a' + LS + 'b')).toBe('a\nb')
    expect(normalizePastedText('a' + PS + 'b')).toBe('a\nb')
    // 三行编号项（用 U+2028 分隔）不再连成一行
    expect(normalizePastedText('1.甲' + LS + '2.乙' + LS + '3.丙')).toBe('1.甲\n2.乙\n3.丙')
  })
  it('普通 \\n 原样保留', () => {
    expect(normalizePastedText('a\nb\nc')).toBe('a\nb\nc')
  })
})

describe('AUDIT #2 流式上滚不被拉回底部', () => {
  it('用户已上滚(userScrolledUp) 且非强制 → 不自动滚（节流定时器到点也要据此再判断）', () => {
    expect(shouldAutoScroll(false, true)).toBe(false)
  })
  it('未上滚 → 自动跟随；强制 → 总滚', () => {
    expect(shouldAutoScroll(false, false)).toBe(true)
    expect(shouldAutoScroll(true, true)).toBe(true)
  })
})
