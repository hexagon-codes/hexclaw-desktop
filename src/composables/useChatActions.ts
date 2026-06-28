/**
 * Chat message actions composable
 *
 * Extracts retry, like, dislike, and in-place edit logic from ChatView.
 */

import { ref, nextTick } from 'vue'
import { removeMessage } from '@/services/messageService'
import { i18n } from '@/i18n'
import { logger } from '@/utils/logger'
import type { useChatStore } from '@/stores/chat'
import type { ChatAttachment, ChatMessage } from '@/types'
import type { useToast } from './useToast'

type ChatStore = ReturnType<typeof useChatStore>
type Toast = ReturnType<typeof useToast>

/** 编辑/重试重发时需保留的原消息载荷（图片等附件 + 挂载技能）。 */
type ResendCarry = { attachments?: ChatAttachment[]; skillNames?: string[] }

/**
 * 从原用户消息提取「重发需保留」的载荷：图片/附件（metadata.attachments）+ 挂载技能（metadata.skills）。
 * BUG-20260625 根因：编辑/重试只重发 text，丢掉这些 → 图片消失。无可带载荷时返回 undefined，
 * 让调用方退回单参 handleSend(text)（保持既有行为与测试）。
 */
function resendCarryFrom(msg: ChatMessage | undefined): ResendCarry | undefined {
  const meta = msg?.metadata
  if (!meta) return undefined
  const carry: ResendCarry = {}
  const atts = meta.attachments
  if (Array.isArray(atts) && atts.length > 0) carry.attachments = atts as ChatAttachment[]
  const skills = meta.skills
  if (Array.isArray(skills)) {
    const names = skills.filter((x): x is string => typeof x === 'string')
    if (names.length > 0) carry.skillNames = names
  }
  return carry.attachments || carry.skillNames ? carry : undefined
}

export function useChatActions(
  chatStore: ChatStore,
  toast: Toast,
  handleSend: (text: string, files?: File[], options?: ResendCarry) => Promise<boolean>,
) {
  // ─── 原位编辑（DeepSeek 风格） ──────────────────────
  const editingMsgId = ref<string | null>(null)
  const editingText = ref('')
  let editTextareaEl: HTMLTextAreaElement | null = null

  function setEditTextareaEl(el: HTMLTextAreaElement | null) {
    editTextareaEl = el
  }

  /**
   * 原子删除从 fromIdx 起的整段消息（重试/编辑即"替换整轮"）。
   *
   * AP-094 修正：旧实现 fire-and-forget 删除后**无条件重发**——若某条后端删除失败，旧消息残留
   * 库里、新消息又落库 → 重载后**重复**；且删除先于重发成功存在数据丢失窗口。
   *
   * 现在：快照 → 乐观移除 UI → **逆序逐条 await 后端删除**（尾部回复先删、用户消息最后删）。
   * 任一失败即**回滚尚未删除的消息、返回 false 让调用方中止重发**——
   * 逆序保证失败时用户输入大概率仍在库里，且只会"删少"绝不"删多"（杜绝重复）。
   *
   * @returns true=全部删除成功可重发；false=已回滚+提示，调用方应中止。
   */
  // 后端已不存在该消息（404/410/not-found）=删除目标已达成，视为成功。
  // AP-094 续：fast-path/slash cron 卡片等客户端独占消息从不落库，删它必 404；
  // 旧实现会因此整体失败、报"重试失败"。容忍 not-found 才不阻断这类重试。
  function isAlreadyGone(error: unknown): boolean {
    const status = (error as { status?: number; statusCode?: number })?.status
      ?? (error as { statusCode?: number })?.statusCode
    if (status === 404 || status === 410) return true
    const msg = error instanceof Error ? error.message : String(error)
    return /not found|不存在|404|410/i.test(msg)
  }

  async function removeRangeAtomic(fromIdx: number): Promise<boolean> {
    const snapshot = chatStore.messages.slice(fromIdx)
    chatStore.messages.splice(fromIdx)
    // BUG（2026-06-28 用户反馈）：编辑早期消息会删掉其后整条尾巴；旧实现**逐条串行 await** →
    // N 条 = N 个网络往返串起来 = 提交后"卡几秒"才出现"正在思考"。改**并行删除**（往返折叠为一批），
    // 再按结果精确回滚：删失败的（仍在后端）原序恢复、删成功的不恢复——仍满足 AP-094「只删少不删多」。
    const results = await Promise.allSettled(snapshot.map((m) => removeMessage(m!.id)))
    const failed: ChatMessage[] = []
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!
      if (r.status === 'rejected' && !isAlreadyGone(r.reason)) {
        failed.push(snapshot[i]!) // 删除失败 = 仍在后端，需恢复到 UI（避免"删一半仍重发→重载重复"）
      }
    }
    if (failed.length > 0) {
      chatStore.messages.splice(fromIdx, 0, ...failed)
      logger.error(`[useChatActions] removeMessage failed during retry/edit, rolled back ${failed.length} message(s)`)
      toast.error(i18n.global.t('chat.retryFailed'))
      return false
    }
    return true
  }

  async function handleRetry(msgIndex: number) {
    const targetMsg = chatStore.messages[msgIndex]
    if (!targetMsg || targetMsg.role !== 'assistant') return

    // 先检查模型是否可用，避免在删除消息前才发现没法重发
    // model=undefined means "let backend decide" (Agent mode) — valid
    const model = chatStore.chatParams.model
    if (model !== undefined && model.trim() === '') {
      // 不再静默 no-op（"点了没反应"），明确提示选模型
      toast.error(i18n.global.t('chat.selectModelFirst'))
      return
    }

    // 找到触发重试的 AI 消息之前的用户消息
    const msgs = chatStore.messages
    let userMsgIdx = -1
    for (let i = msgIndex - 1; i >= 0; i--) {
      if (msgs[i]?.role === 'user') {
        userMsgIdx = i
        break
      }
    }
    if (userMsgIdx < 0) return

    // AP-096 前置闸：流式/发送中不允许重试——否则删光整轮后 handleSend 被 shouldBlockChatSend
    // 拦截返回 false，整轮已删却发不出去 = 静默数据丢失。先拦在删除之前。
    if (chatStore.streaming) {
      toast.error(i18n.global.t('chat.retryWhileStreaming'))
      return
    }

    const userMsg = msgs[userMsgIdx]!
    const userText = userMsg.content
    // BUG-20260625：重试必须带回原用户消息的图片附件 + 挂载技能，否则重发丢图。
    const carry = resendCarryFrom(userMsg)

    // AP-096 兜底：删前快照，供"删成功但重发失败/被拒"时恢复 UI，绝不让整轮凭空消失。
    const snapshot = chatStore.messages.slice(userMsgIdx)
    // 原子删除整轮（用户消息 + AI 回复），失败则已回滚+提示、不重发。
    if (!(await removeRangeAtomic(userMsgIdx))) return

    const ok = carry ? await handleSend(userText, undefined, carry) : await handleSend(userText)
    if (!ok) {
      chatStore.messages.splice(userMsgIdx, 0, ...snapshot)
      toast.error(i18n.global.t('chat.retryFailed'))
    }
  }

  async function handleLike(msgId: string) {
    const message = chatStore.messages.find((item) => item.id === msgId)
    if (!message) return

    const nextFeedback = message.metadata?.user_feedback === 'like' ? null : 'like'
    try {
      await chatStore.setMessageFeedback(msgId, nextFeedback)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '同步点赞状态失败')
    }
  }

  async function handleDislike(msgId: string) {
    const message = chatStore.messages.find((item) => item.id === msgId)
    if (!message) return

    const nextFeedback = message.metadata?.user_feedback === 'dislike' ? null : 'dislike'
    try {
      await chatStore.setMessageFeedback(msgId, nextFeedback)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '同步点踩状态失败')
    }
  }

  function handleEdit(msgIndex: number) {
    const msg = chatStore.messages[msgIndex]
    if (!msg || msg.role !== 'user') return
    editingMsgId.value = msg.id
    editingText.value = msg.content
    nextTick(() => {
      if (editTextareaEl) {
        editTextareaEl.focus()
        editTextareaEl.style.height = 'auto'
        editTextareaEl.style.height = editTextareaEl.scrollHeight + 'px'
        editTextareaEl.setSelectionRange(editTextareaEl.value.length, editTextareaEl.value.length)
      }
    })
  }

  async function confirmEdit(msgId: string) {
    const text = editingText.value.trim()
    if (!text) {
      cancelEdit()
      return
    }

    // 模型不可用：不再静默 cancelEdit（丢编辑+无提示），改 toast 并保留编辑内容，与 handleRetry 一致。
    // model=undefined means "let backend decide" (Agent mode) — valid
    const model = chatStore.chatParams.model
    if (model !== undefined && model.trim() === '') {
      toast.error(i18n.global.t('chat.selectModelFirst'))
      return
    }
    // AP-096 前置闸：流式中不允许编辑重发（同 handleRetry）。
    if (chatStore.streaming) {
      toast.error(i18n.global.t('chat.retryWhileStreaming'))
      return
    }

    const idx = chatStore.messages.findIndex((m) => m.id === msgId)

    editingMsgId.value = null
    editingText.value = ''

    if (idx < 0) return

    // BUG-20260625：编辑重发须带回原消息的图片附件 + 挂载技能（捕获要在删除之前）。
    const carry = resendCarryFrom(chatStore.messages[idx])
    const snapshot = chatStore.messages.slice(idx) // AP-096 兜底快照

    // 删除原消息及其之后的所有回复（DeepSeek 风格：编辑即替换）——原子删除，失败则回滚+提示、不重发。
    if (!(await removeRangeAtomic(idx))) return

    // 重新发送（会创建新用户消息 + 获取 AI 回复），带回原附件/技能
    const ok = carry ? await handleSend(text, undefined, carry) : await handleSend(text)
    if (!ok) {
      chatStore.messages.splice(idx, 0, ...snapshot)
      toast.error(i18n.global.t('chat.retryFailed'))
    }
  }

  function cancelEdit() {
    editingMsgId.value = null
    editingText.value = ''
  }

  function autoResizeEditTextarea(e: Event) {
    const el = e.target as HTMLTextAreaElement
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }

  return {
    editingMsgId,
    editingText,
    setEditTextareaEl,
    handleRetry,
    handleLike,
    handleDislike,
    handleEdit,
    confirmEdit,
    cancelEdit,
    autoResizeEditTextarea,
  }
}
