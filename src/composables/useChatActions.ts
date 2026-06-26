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

  // Backend delete failures must be surfaced: the message stays in the DB and
  // reappears on the next session load, contradicting what the user just saw.
  function removeMessageWithFeedback(messageId: string) {
    removeMessage(messageId).catch((error) => {
      // logger (not console) — production code keeps the no-console invariant.
      logger.error(`[useChatActions] removeMessage(${messageId}) failed: ${error instanceof Error ? error.message : String(error)}`)
      toast.error(i18n.global.t('chat.deleteMessageFailed'))
    })
  }

  async function handleRetry(msgIndex: number) {
    const targetMsg = chatStore.messages[msgIndex]
    if (!targetMsg || targetMsg.role !== 'assistant') return

    // 先检查模型是否可用，避免在 handleSend 静默返回前删除消息
    // model=undefined means "let backend decide" (Agent mode) — valid
    const model = chatStore.chatParams.model
    if (model !== undefined && model.trim() === '') return

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

    const userMsg = msgs[userMsgIdx]!
    const userText = userMsg.content
    // BUG-20260625：重试必须带回原用户消息的图片附件 + 挂载技能，否则重发丢图。
    const carry = resendCarryFrom(userMsg)

    // 从用户消息开始全部删除（用户消息 + AI 回复），然后重新发送
    const toRemove = chatStore.messages.splice(userMsgIdx)
    for (const m of toRemove) {
      removeMessageWithFeedback(m.id)
    }

    if (carry) await handleSend(userText, undefined, carry)
    else await handleSend(userText)
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

    // 先检查模型是否可用，避免在 handleSend 静默返回前删除消息
    // model=undefined means "let backend decide" (Agent mode) — valid
    const model = chatStore.chatParams.model
    if (model !== undefined && model.trim() === '') {
      cancelEdit()
      return
    }

    const idx = chatStore.messages.findIndex((m) => m.id === msgId)

    editingMsgId.value = null
    editingText.value = ''

    if (idx < 0) return

    // BUG-20260625：编辑重发须带回原消息的图片附件 + 挂载技能（捕获要在 splice 之前）。
    const carry = resendCarryFrom(chatStore.messages[idx])

    // 删除原消息及其之后的所有回复（DeepSeek 风格：编辑即替换）
    const toRemove = chatStore.messages.splice(idx)
    for (const m of toRemove) {
      removeMessageWithFeedback(m.id)
    }

    // 重新发送（会创建新用户消息 + 获取 AI 回复），带回原附件/技能
    if (carry) await handleSend(text, undefined, carry)
    else await handleSend(text)
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
