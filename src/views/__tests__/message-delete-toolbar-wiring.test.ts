/**
 * 单条消息删除「发现性」治本 — 悬浮工具条删除入口接线校验。
 *
 * 现状：删除逻辑已完整实现（右键菜单 → handleMsgCtxAction('delete')），但入口只藏在右键，
 * 用户发现不了 → 以为不支持删除。治本：MessageActions 悬浮工具条加显式删除按钮，
 * ChatView 把 assistant/user 两处 MessageActions 的 @delete 接到同一条已有删除链路，
 * 并加二次确认（对齐 deleteSession 的 ConfirmDialog 惯例）。
 *
 * 这里用源码级断言核验 ChatView 的接线，避免 mount 整个重型视图。
 * RED（修前）：ChatView 无 @delete 接线 / 无 ConfirmDialog → 下列断言失败。
 */
import { describe, it, expect } from 'vitest'
import chatViewSrc from '@/views/ChatView.vue?raw'
import { DESTRUCTIVE_CONFIRM_COOLDOWN_MS } from '@/config/destructive-actions'

describe('ChatView — 消息删除工具条接线', () => {
  it('assistant 与 user 两处 MessageActions 都接了 @delete → requestDeleteMessage', () => {
    const hits = chatViewSrc.match(/@delete="requestDeleteMessage\(msg\.id\)"/g) ?? []
    expect(hits.length).toBe(2)
  })

  it('复用单一真相源：右键菜单 delete 分支也走 requestDeleteMessage', () => {
    expect(chatViewSrc).toContain("case 'delete': {\n      requestDeleteMessage(msg.id)")
  })

  it('保留原乐观删除+回滚链路（提取为 deleteMessageAt，含 404/410 视为已删）', () => {
    expect(chatViewSrc).toContain('function deleteMessageAt(idx: number)')
    expect(chatViewSrc).toContain('backendDeletableMessageId(m)')
    expect(chatViewSrc).toContain('status === 404 || status === 410')
    expect(chatViewSrc).toContain("toast.error(t('chat.deleteMessageFailed'))")
  })

  it('删除不可逆 → 走二次确认（ConfirmDialog + pendingDeleteMsgId）', () => {
    expect(chatViewSrc).toContain('ConfirmDialog')
      expect(chatViewSrc).toContain('pendingDeleteMsgId')
      expect(chatViewSrc).toContain('@confirm="confirmDeleteMessage"')
      expect(chatViewSrc).toContain("t('chat.deleteMessageConfirmTitle')")
      expect(DESTRUCTIVE_CONFIRM_COOLDOWN_MS).toBe(1_500)
      expect(chatViewSrc).not.toContain(':confirm-delay-ms=')
      expect(chatViewSrc).toContain(':confirmation-key="pendingDeleteMsgId"')
    })
  })
