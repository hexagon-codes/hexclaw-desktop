import { saveBlobInApp } from '@/utils/download'
import { isTauri } from '@/utils/platform'
import { renderDocument } from '@/api/k12'
import { api } from '@/api/client'
import { k12AssetURL } from '@/api/k12-asset-url'
import { backendMediaURL } from '@/composables/useBackendMedia'
import { assertBackendActive, backendRelativePath, backendScopeKey } from '@/services/backend-context'
import { imageSrc } from '@/utils/chat-compose'
import type { ChatAttachment } from '@/types'

export type ConversationExportFormat = 'markdown' | 'json' | 'pdf'

/** 受保护的会话图片先经当前连接认证读取，渲染器只接收图片字节，不承担应用资产寻址。 */
async function inlineConversationImages(content: string, scope: string): Promise<string> {
  const images = new Map<string, string>()
  const replacements: Array<{ start: number; end: number; value: string }> = []
  // 代码中的图片示例保持原文；图片标题和替代文字不参与地址替换。
  const references = content.matchAll(/(`+)(?!`)[\s\S]*?\1(?!`)|(!\[[^\]]*\]\()([^)\s]+)(?:\s+"[^"]*")?\)/g)
  for (const match of references) {
    const source = match[3]
    if (!source) continue
    const assetOwner = source.startsWith('asset://')
      ? source.slice('asset://'.length, source.lastIndexOf('/'))
      : ''
    const normalized = assetOwner ? k12AssetURL(assetOwner, source) : backendMediaURL(source)
    const path = normalized.startsWith('/api/') ? normalized : backendRelativePath(normalized)
    if (!path?.startsWith('/api/')) continue
    assertBackendActive(scope)
    let dataURL = images.get(path)
    if (!dataURL) {
      const blob = await api<Blob, 'blob'>(path, {
        method: 'GET',
        responseType: 'blob',
        timeout: 120_000,
        headers: { 'x-hexclaw-connection-scope': scope },
      })
      assertBackendActive(scope)
      if (!blob.type.toLowerCase().startsWith('image/')) {
        throw new Error('Conversation image returned an invalid content type')
      }
      dataURL = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error ?? new Error('Unable to read conversation image'))
        reader.readAsDataURL(blob)
      })
      images.set(path, dataURL)
    }
    const start = match.index + match[2]!.length
    replacements.push({ start, end: start + source.length, value: dataURL })
  }
  for (const replacement of replacements.reverse()) {
    content = content.slice(0, replacement.start) + replacement.value + content.slice(replacement.end)
  }
  assertBackendActive(scope)
  return content
}

/** 普通会话与场景头共用同一正文快照；PDF复用应用标准版式，不合并附件或重新生成摘要。 */
export async function exportConversationSnapshot(input: {
  format: ConversationExportFormat
  title: string
  messages: Array<{ role: string; content: string; timestamp: string; agent_name?: string; metadata?: Record<string, unknown> }>
  exportedAtLabel: string
  userLabel: string
  assistantLabel: string
}): Promise<void> {
  const scope = backendScopeKey()
  const exportedAt = new Date()
  // 附件属于原消息快照，普通会话和场景调用者共用同一展开规则。
  const messages = input.messages.map((message) => {
    const attachments = message.metadata?.attachments
    const sources = Array.isArray(attachments)
      ? (attachments as ChatAttachment[])
          .filter((attachment) => attachment?.type === 'image')
          .map(imageSrc)
          .filter((source) => source && !message.content.includes(source))
      : []
    const images = [...new Set(sources)].map((source) => `![](${source})`)
    return { ...message, content: [message.content, ...images].filter(Boolean).join('\n\n') }
  })
  const body =
    input.format === 'json'
      ? JSON.stringify(
          {
            title: input.title,
            exported_at: exportedAt.toISOString(),
            message_count: messages.length,
            messages: messages.map(({ role, content, timestamp, agent_name }) => ({
              role,
              content,
              timestamp,
              agent_name,
            })),
          },
          null,
          2,
        )
      : `# ${input.title}\n\n> ${input.exportedAtLabel}: ${exportedAt.toLocaleString()}\n\n---\n\n` +
        messages
          .map(
            (message) =>
              `### **${message.role === 'user' ? input.userLabel : message.agent_name || input.assistantLabel}** · ${new Date(message.timestamp).toLocaleString()}\n\n${message.content}\n\n---\n\n`,
          )
          .join('')
  const extension = input.format === 'markdown' ? 'md' : input.format
  const blob =
    input.format === 'pdf'
      ? await renderDocument(
          {
            content: await inlineConversationImages(body, scope),
            format: 'pdf',
            title: input.title,
          },
          scope,
        )
      : new Blob([body], {
          type: input.format === 'json' ? 'application/json' : 'text/markdown',
        })
  assertBackendActive(scope)
  if (isTauri()) {
    await saveBlobInApp(blob, `${input.title}.${extension}`)
    return
  }
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${input.title}.${extension}`
    anchor.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}
