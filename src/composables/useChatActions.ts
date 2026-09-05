/**
 * Chat message actions composable
 *
 * Extracts retry, like, dislike, and in-place edit logic from ChatView.
 */

import { ref } from 'vue'
import { removeMessage } from '@/services/messageService'
import { appendSessionMessage, forkSession } from '@/api/chat'
import { i18n } from '@/i18n'
import { logger } from '@/utils/logger'
import { backendDeletableMessageId } from '@/utils/chat-message-id'
import type { useChatStore } from '@/stores/chat'
import type { ChatRouteSnapshot } from '@/stores/chat-route-snapshot'
import type { ChatAttachment, ChatMessage } from '@/types'
import type { useToast } from './useToast'

type ChatStore = ReturnType<typeof useChatStore>
type Toast = ReturnType<typeof useToast>

/** 编辑/重试重发时需保留的原消息载荷（图片等附件 + 挂载技能）。 */
type ResendCarry = { attachments?: ChatAttachment[]; skillNames?: string[] }
type DirectedResend = ResendCarry & {
  targetSessionId: string
  routeSnapshot?: ChatRouteSnapshot
}
export interface EditedMessageSubmission {
  /** 被编辑的历史消息只读保留；调用方可据其来源选择正确的提交管道。 */
  sourceMessage: ChatMessage
  /** 本次新版本唯一允许写入的会话；提交器不得再读取全局 currentSessionId 猜目标。 */
  targetSessionId: string
  /** 新版本正文。仅用于判空时 trim，提交时保持 canonical 字节不变。 */
  content: string
  carry?: ResendCarry
  /** 用户确认时冻结的源会话路由；不得由可变全局状态重建。 */
  routeSnapshot?: ChatRouteSnapshot
}
export type SubmitEditedMessage = (submission: EditedMessageSubmission) => Promise<boolean>
export type CaptureEditRouteSnapshot = (sourceSessionId: string) => ChatRouteSnapshot

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
  handleSend: (text: string, files?: File[], options?: ResendCarry | DirectedResend) => Promise<boolean>,
  submitEditedMessage?: SubmitEditedMessage,
  captureEditRouteSnapshot?: CaptureEditRouteSnapshot,
) {
  // ─── 原位编辑（DeepSeek 风格） ──────────────────────
  const editingMsgId = ref<string | null>(null)
  const editingText = ref('')
  // 编辑提交会跨越 fork/load/select/send 多个异步边界。单一运行令牌同时解决：
  // 1) 双击发送创建两个分支；2) 等待期间切换会话后把分支/消息写进错误会话；
  // 3) 用户取消后，迟到的 fork 响应仍继续提交。
  // 这是内部并发闸，不改变任何可见按钮或交互布局。
  let editGeneration = 0
  let activeEditSubmission: number | null = null

  function editSubmissionIsCurrent(
    token: number,
    messageID: string,
    expectedSessionID: string,
  ): boolean {
    return activeEditSubmission === token
      && editGeneration === token
      && editingMsgId.value === messageID
      && chatStore.currentSessionId === expectedSessionID
  }

  function editSubmissionIdentityIsCurrent(token: number, messageID: string): boolean {
    return activeEditSubmission === token
      && editGeneration === token
      && editingMsgId.value === messageID
  }

  /**
   * 恢复被替换删除的尾部：仅当仍在原会话且消息数组未被其他写入改动时原样 splice 回去，
   * 避免把快照写进用户已切换的其他会话或已开始流式的新数组。
   */
  function restoreEditedTail(chatStore: ChatStore, idx: number, tail: ChatMessage[], sourceSessionID: string): void {
    if (chatStore.currentSessionId !== sourceSessionID) return
    if (chatStore.messages.length !== idx) return
    chatStore.messages.splice(idx, 0, ...tail)
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
    const results = await Promise.allSettled(snapshot.map((m) => removeMessage(backendDeletableMessageId(m!))))
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

  /**
   * 由此分叉（BUG-20260703 P2-1）：以该消息为分支点复制会话（后端 ForkSession 按
   * rowid 截到该消息含自身），切到新分支继续聊——原会话原样保留。
   * 消息 id 解析同删除：live 消息用 metadata.backend_message_id，重载消息本身就是后端 id。
   */
  async function handleFork(msgIndex: number, taskResultContent?: string) {
    const targetMsg = chatStore.messages[msgIndex]
    const sessionId = chatStore.currentSessionId
    if (!targetMsg || !sessionId) return
    // 流式中分叉：正在生成的回复尚未落库，分支会缺尾巴且易与写入竞争——先拦。
    if (chatStore.streaming) {
      toast.error(i18n.global.t('chat.forkWhileStreaming'))
      return
    }
    try {
      const res = await forkSession(sessionId, backendDeletableMessageId(targetMsg))
      // 任务卡结果不在原消息序列中，分支只携带已展示正文，不重建活动任务。
      if (taskResultContent?.trim()) {
        await appendSessionMessage(res.session.id, {
          role: 'assistant',
          content: taskResultContent,
        })
      }
      await chatStore.loadSessions()
      await chatStore.selectSession(res.session.id)
      toast.success(i18n.global.t('chat.forkCreated'))
    } catch (error) {
      logger.error('[useChatActions] fork session failed', error)
      toast.error(error instanceof Error ? error.message : i18n.global.t('chat.forkFailed'))
    }
  }

  async function handleLike(msgId: string, taskResult = false) {
    const message = chatStore.messages.find((item) => item.id === msgId)
    if (!message) return

    const nextFeedback = message.metadata?.user_feedback === 'like' ? null : 'like'
    try {
      await (taskResult
        ? chatStore.setMessageFeedback(msgId, nextFeedback, true)
        : chatStore.setMessageFeedback(msgId, nextFeedback))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '同步点赞状态失败')
    }
  }

  async function handleDislike(msgId: string, taskResult = false) {
    const message = chatStore.messages.find((item) => item.id === msgId)
    if (!message) return

    const nextFeedback = message.metadata?.user_feedback === 'dislike' ? null : 'dislike'
    try {
      await (taskResult
        ? chatStore.setMessageFeedback(msgId, nextFeedback, true)
        : chatStore.setMessageFeedback(msgId, nextFeedback))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '同步点踩状态失败')
    }
  }

  function handleEdit(msgIndex: number) {
    if (activeEditSubmission !== null) return
    const msg = chatStore.messages[msgIndex]
    if (!msg || msg.role !== 'user') return
    editGeneration += 1
    editingMsgId.value = msg.id
    editingText.value = msg.content
    // The editable MessageText projection owns focus/caret after it mounts.
    // Keeping a detached textarea ref here would create a second editor model.
  }

  async function confirmEdit(msgId: string) {
    // The first call owns the entire delete→submit transaction. Later clicks are harmless.
    if (activeEditSubmission !== null) return
    const text = editingText.value
    const idx = chatStore.messages.findIndex((m) => m.id === msgId)
    if (idx < 0) {
      cancelEdit()
      return
    }
    const sourceMessage = chatStore.messages[idx]!
    // 附件本身就是有效内容：纯图片消息编辑不能被空文本校验吞掉。
    const carry = resendCarryFrom(sourceMessage)
    if (!text.trim() && !carry?.attachments?.length) {
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
    // 流式中不允许编辑重发（同 handleRetry）。
    if (chatStore.streaming) {
      toast.error(i18n.global.t('chat.retryWhileStreaming'))
      return
    }

    const sourceSessionID = chatStore.currentSessionId
    if (!sourceSessionID) {
      // 编辑已有历史消息却没有会话归属，不能安全地退化成追加发送；草稿必须保留。
      toast.error(i18n.global.t('chat.retryFailed'))
      return
    }

    const token = editGeneration
    activeEditSubmission = token
    const routeSnapshot = captureEditRouteSnapshot?.(sourceSessionID)
    const tail = chatStore.messages.slice(idx)
    try {
      // 替换语义：确认即在本会话内原子删除目标消息及其后的全部消息。
      // 删除失败时 removeRangeAtomic 已回滚并提示，直接中止，不得重发。
      if (!(await removeRangeAtomic(idx))) return

      // 删除跨越异步边界：期间用户可能切换会话或取消，此时不得把新版本写进别的会话。
      // 仍在原会话则原样恢复尾部（后端可能已删除，恢复让用户看到“替换未完成”的实情并可重试）。
      if (!editSubmissionIsCurrent(token, msgId, sourceSessionID)) {
        restoreEditedTail(chatStore, idx, tail, sourceSessionID)
        return
      }

      // ChatView 可注入场景提交器，让纯图片重新进入原场景管道；普通发送同样显式携带
      // targetSessionId。任何提交器都不能把 global currentSessionId 当作隐式写入目标。
      const ok = submitEditedMessage
        ? await submitEditedMessage({
            sourceMessage,
            targetSessionId: sourceSessionID,
            content: text,
            carry,
            ...(routeSnapshot ? { routeSnapshot } : {}),
          })
        : await handleSend(text, undefined, {
            ...carry,
            targetSessionId: sourceSessionID,
            ...(routeSnapshot ? { routeSnapshot } : {}),
          })
      if (!ok) {
        // 发送失败：尾部已在后端删除，原样恢复 UI，编辑框与草稿保留供重试。
        restoreEditedTail(chatStore, idx, tail, sourceSessionID)
        toast.error(i18n.global.t('chat.retryFailed'))
        return
      }

      // 编辑提交成功后编辑框必须关闭；会话切换/取消不得让编辑框残留，也不得偷走焦点。
      if (editSubmissionIdentityIsCurrent(token, msgId)) cancelEdit()
    } catch (error) {
      logger.error('[useChatActions] edited submission failed', error)
      restoreEditedTail(chatStore, idx, tail, sourceSessionID)
      toast.error(i18n.global.t('chat.retryFailed'))
    } finally {
      if (activeEditSubmission === token) activeEditSubmission = null
    }
  }

  function cancelEdit() {
    editGeneration += 1
    editingMsgId.value = null
    editingText.value = ''
  }

  return {
    editingMsgId,
    editingText,
    handleRetry,
    handleFork,
    handleLike,
    handleDislike,
    handleEdit,
    confirmEdit,
    cancelEdit,
  }
}
