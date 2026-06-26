/**
 * BUG-20260625 / AP-027 同类：原位编辑卡 textarea 的回车未排除 IME 合成态。
 *
 * 现场：ChatView.vue 编辑卡 textarea 原为 `@keydown.enter.exact.prevent="confirmEdit(msg.id)"`，
 * 裸调 confirmEdit，未查 isComposing/229 → 中文/日文 IME 编辑时回车「确认候选词」被误当「提交编辑」。
 * 正例：ChatInput.vue 经 utils/chat-compose 的 shouldSendOnEnter(e,{composing,...}) 守卫。
 *
 * 本测试以源码契约钉死：编辑卡回车必须经 IME 守卫的 handler，禁止回退到裸 confirmEdit-on-enter。
 * 与 chat-compose 的 shouldSendOnEnter 行为单测（audit-chat-compose-20260623）共同构成回归闭环。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const view = readFileSync(resolve(__dirname, '../ChatView.vue'), 'utf-8')

describe('BUG-20260625 编辑卡回车 IME 守卫', () => {
  it('编辑卡 textarea 不再用裸 @keydown.enter...="confirmEdit(" 直接提交（无 IME 守卫）', () => {
    // 旧 bug 形式：Vue .enter 修饰符直接绑 confirmEdit，回车无条件提交。
    expect(view).not.toMatch(/@keydown\.enter[^"=]*=\s*"confirmEdit\(/)
  })

  it('ChatView 引入 shouldSendOnEnter 并用它守卫编辑卡回车', () => {
    expect(view).toContain('shouldSendOnEnter')
    // 编辑卡回车走专用 handler（含 IME 守卫），而非内联裸 confirmEdit。
    expect(view).toMatch(/@keydown\.enter[^"]*=\s*"onEditEnter\(/)
  })
})
