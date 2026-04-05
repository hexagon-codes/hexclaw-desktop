/**
 * Chat message actions composable
 *
 * Extracts retry, like, dislike, and in-place edit logic from ChatView.
 */

import { ref, nextTick } from 'vue'
import { removeMessage } from '@/services/messageService'
import type { useChatStore } from '@/stores/chat'
import type { useToast } from './useToast'

type ChatStore = ReturnType<typeof useChatStore>
type Toast = ReturnType<typeof useToast>

export function useChatActions(
  chatStore: ChatStore,
  toast: Toast,
  handleSend: (text: string, files?: File[]) => Promise<void>,
) {
  // ─── 原位编辑（DeepSeek 风格） ──────────────────────
  const editingMsgId = ref<string | null>(null)
  const editingText = ref('')
  let editTextareaEl: HTMLTextAreaElement | null = null

  function setEditTextareaEl(el: HTMLTextAreaElement | null) {
    editTextareaEl = el
  }

  async function handleRetry(msgIndex: number) {
    const targetMsg = chatStore.messages[msgIndex]
    if (!targetMsg || targetMsg.role !== 'assistant') return

    // 先检查模型是否可用，避免在 handleSend 静默返回前删除消息
    const model = chatStore.chatParams.model
    if (!model || (model !== 'auto' && model.trim() === '')) return

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

    const userText = msgs[userMsgIdx]!.content

    // 从用户消息开始全部删除（用户消息 + AI 回复），然后重新发送
    const toRemove = chatStore.messages.splice(userMsgIdx)
    for (const m of toRemove) {
      removeMessage(m.id).catch(() => {})
    }

    await handleSend(userText)
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
    const model = chatStore.chatParams.model
    if (!model || (model !== 'auto' && model.trim() === '')) {
      cancelEdit()
      return
    }

    const idx = chatStore.messages.findIndex((m) => m.id === msgId)

    editingMsgId.value = null
    editingText.value = ''

    if (idx < 0) return

    // 删除原消息及其之后的所有回复（DeepSeek 风格：编辑即替换）
    const toRemove = chatStore.messages.splice(idx)
    for (const m of toRemove) {
      removeMessage(m.id).catch(() => {})
    }

    // 重新发送（会创建新用户消息 + 获取 AI 回复）
    await handleSend(text)
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
