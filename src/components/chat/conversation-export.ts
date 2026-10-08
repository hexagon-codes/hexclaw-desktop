import { saveBlobInApp } from '@/utils/download'
import { isTauri } from '@/utils/platform'

/** 普通会话与场景头共用同一正文快照；导出不追加摘要、PDF 或当前资料的新版本。 */
export async function exportConversationSnapshot(input: {
  format: 'markdown' | 'json'
  title: string
  messages: Array<{ role: string; content: string; timestamp: string; agent_name?: string }>
  exportedAtLabel: string
  userLabel: string
  assistantLabel: string
}): Promise<void> {
  const exportedAt = new Date()
  const body =
    input.format === 'json'
      ? JSON.stringify(
          {
            title: input.title,
            exported_at: exportedAt.toISOString(),
            message_count: input.messages.length,
            messages: input.messages.map(({ role, content, timestamp, agent_name }) => ({
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
        input.messages
          .map(
            (message) =>
              `### **${message.role === 'user' ? input.userLabel : message.agent_name || input.assistantLabel}** · ${new Date(message.timestamp).toLocaleString()}\n\n${message.content}\n\n---\n\n`,
          )
          .join('')
  const extension = input.format === 'json' ? 'json' : 'md'
  const blob = new Blob([body], {
    type: input.format === 'json' ? 'application/json' : 'text/markdown',
  })
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
