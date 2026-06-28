import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * BUG-20260628：上一个会话显示「下翻箭头」时，点击「创建新会话」箭头仍残留，而新会话上面是空的。
 *
 * 根因：ChatView 里 currentSessionId 的 watch 在会话切换时只重置 `userScrolledUp`，**漏置
 * `showScrollToBottom`**。新空会话不产生 scroll 事件 → `handleMessagesScroll` 不触发 →
 * `scrollNavFlags` 不重新判定 → 上个会话遗留的 `showScrollToBottom=true` 一直残留 → 箭头不消失。
 * （pure `scrollNavFlags` 本身对空会话已返回 false，见 bug-20260626-scroll-nav-new-session；
 * 本 bug 是「会话切换时 ref 未被重置」，不是几何判定错。）
 *
 * 修复：currentSessionId 的 watch 在任何会话切换/新建时，连同 `showScrollToBottom` 一并重置为 false。
 */
describe('BUG-20260628: 切换/新建会话重置下翻箭头', () => {
  it('currentSessionId 的 watch 必须同时重置 showScrollToBottom（否则新会话残留上个会话的箭头）', () => {
    const src = readFileSync(resolve(__dirname, '../views/ChatView.vue'), 'utf-8')
    const anchor = src.indexOf('() => chatStore.currentSessionId')
    expect(anchor).toBeGreaterThan(-1)
    // 截取该 watch 的回调体（足以覆盖 reset 语句）
    const watchBody = src.slice(anchor, anchor + 420)
    // 既有：重置 userScrolledUp（防上滚态残留 → 自动跟随被卡）
    expect(watchBody).toMatch(/userScrolledUp\.value\s*=\s*false/)
    // ★修复点：必须也重置 showScrollToBottom（防下翻箭头残留到新空会话）
    expect(watchBody).toMatch(/showScrollToBottom\.value\s*=\s*false/)
  })
})
