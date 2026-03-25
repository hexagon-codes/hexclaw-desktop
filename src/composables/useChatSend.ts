/**
 * Chat send composable
 *
 * Extracts the main send handler (with Auto-RAG) and file-to-base64 conversion
 * from ChatView.
 */

import { nextTick, type Ref } from 'vue'
import { searchKnowledge } from '@/api/knowledge'
import { parseDocument } from '@/utils/file-parser'
import type { ChatAttachment, ChatMessage } from '@/types'
import type { useChatStore } from '@/stores/chat'

type ChatStore = ReturnType<typeof useChatStore>

export interface ChatSendDeps {
  chatStore: ChatStore
  parsedDocument: Ref<{ text: string; fileName: string; pageCount?: number } | null>
  attachmentPreview: Ref<{
    url: string
    name: string
    type: 'image' | 'video' | 'file'
    file: File
  } | null>
  clearAttachmentPreview: () => void
  scrollToBottom: () => void
  attachConversationAutomationActions: (params: {
    userText: string
    assistantMessage: ChatMessage | null
    attachment?: { fileName: string; parsedText?: string } | null
  }) => Promise<void>
}

export function useChatSend(deps: ChatSendDeps) {
  const {
    chatStore,
    parsedDocument,
    attachmentPreview,
    clearAttachmentPreview,
    scrollToBottom,
    attachConversationAutomationActions,
  } = deps

  /** File -> Base64 */
  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = reader.result as string
        // 去掉 data:xxx;base64, 前缀
        resolve(result.split(',')[1] || result)
      }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  async function handleSend(text: string, files?: File[]) {
    const attachmentAutomation =
      attachmentPreview.value?.type === 'file' && parsedDocument.value
        ? {
            fileName: attachmentPreview.value.name,
            parsedText: parsedDocument.value.text,
          }
        : null

    // 将附件转为 base64（支持多文件）
    const attachments: ChatAttachment[] = []

    // 从旧的 attachmentPreview（兼容拖拽等路径）
    if (attachmentPreview.value) {
      const { file, type } = attachmentPreview.value
      const data = await fileToBase64(file)
      attachments.push({ type, name: file.name, mime: file.type, data })
      clearAttachmentPreview()
    }

    // 从新的多文件参数：图片作为 attachment，文档解析为文本
    const docTexts: string[] = []
    if (files?.length) {
      for (const file of files) {
        const isImage = file.type.startsWith('image/')
        if (isImage) {
          // 图片：作为 attachment 发送给支持 vision 的模型
          const data = await fileToBase64(file)
          attachments.push({ type: 'image', name: file.name, mime: file.type, data })
        } else {
          // 文档（PDF/TXT/DOCX 等）：解析提取文本，拼入消息内容
          try {
            const parsed = await parseDocument(file)
            if (parsed.text.trim()) {
              const pageInfo = parsed.pageCount ? ` (${parsed.pageCount}页)` : ''
              docTexts.push(`[文件: ${parsed.fileName}${pageInfo}]\n\n${parsed.text}`)
            }
          } catch {
            // 解析失败时作为普通附件发送
            const data = await fileToBase64(file)
            attachments.push({ type: 'file', name: file.name, mime: file.type, data })
          }
        }
      }
    }

    // 拼接文档文本到消息内容
    let finalText = text
    if (parsedDocument.value) {
      const doc = parsedDocument.value
      const pageInfo = doc.pageCount ? ` (${doc.pageCount}页)` : ''
      docTexts.unshift(`[文件: ${doc.fileName}${pageInfo}]\n\n${doc.text}`)
      parsedDocument.value = null
    }
    if (docTexts.length > 0) {
      finalText = docTexts.join('\n\n---\n\n') + '\n\n---\n' + text
    }

    // Auto-RAG: 自动检索知识库，将相关内容注入后端上下文
    let backendText: string | undefined
    try {
      const { result: knowledgeHits } = await searchKnowledge(text, 3)
      const relevant = knowledgeHits.filter((hit) => hit.score >= 0.35 && hit.content)
      if (relevant.length > 0) {
        const contextBlock = relevant
          .map((hit, i) => {
            const source = hit.doc_title || hit.source || `片段${i + 1}`
            return `[来源: ${source}]\n${hit.content}`
          })
          .join('\n\n')
        backendText = `[知识库参考信息 - 请优先参考以下内容回答用户问题]\n${contextBlock}\n\n[用户问题]\n${finalText}`
      }
    } catch {
      // 知识库搜索失败不阻塞聊天
    }

    // Set agent role for research mode
    if (chatStore.chatMode === 'research') {
      chatStore.agentRole = 'researcher'
    }

    const assistantMessage = await chatStore.sendMessage(
      finalText,
      attachments.length > 0 ? attachments : undefined,
      backendText ? { backendText } : undefined,
    )
    await attachConversationAutomationActions({
      userText: text,
      assistantMessage,
      attachment: attachmentAutomation,
    })
    await nextTick()
    scrollToBottom()
  }

  return {
    handleSend,
    fileToBase64,
  }
}
