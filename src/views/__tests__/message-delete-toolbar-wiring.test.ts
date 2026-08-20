/**
 * 单条消息删除入口接线校验。
 *
 * 删除以会话级为主，消息操作区（MessageActions 工具条）不再暴露删除入口；
 * 单条删除保留右键菜单低频入口，仍走 requestDeleteMessage
 * 同一删除链路并加二次确认。
 */
import { describe, it, expect } from 'vitest'
import chatViewSrc from '@/views/ChatView.vue?raw'
import { DESTRUCTIVE_CONFIRM_COOLDOWN_MS } from '@/config/destructive-actions'

describe('ChatView — 消息删除接线', () => {
  it('MessageActions 工具条不再接 @delete（删除仅保留右键菜单入口）', () => {
    const hits = chatViewSrc.match(/@delete="requestDeleteMessage\(msg\.id\)"/g) ?? []
    expect(hits.length).toBe(0)
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