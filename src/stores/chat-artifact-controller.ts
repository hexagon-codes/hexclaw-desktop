import type { Ref } from 'vue'
import type { Artifact } from '@/types'

type MessageServiceModule = typeof import('@/services/messageService')
type LoggerModule = typeof import('@/utils/logger').logger

export function createChatArtifactController(params: {
  artifacts: Ref<Artifact[]>
  selectedArtifactId: Ref<string | null>
  showArtifacts: Ref<boolean>
  currentSessionId: Ref<string | null>
  msgSvc: MessageServiceModule
  logger: LoggerModule
  createId: () => string
}) {
  const {
    artifacts,
    selectedArtifactId,
    showArtifacts,
    currentSessionId,
    msgSvc,
    logger,
    createId,
  } = params

  function extractArtifacts(content: string, messageId: string) {
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g
    let match: RegExpExecArray | null
    artifacts.value = artifacts.value.filter((artifact) => artifact.messageId !== messageId)
    let blockIndex = 0
    while ((match = codeBlockRegex.exec(content)) !== null) {
      const language = match[1] || 'text'
      const code = match[2]!.trim()
      if (code.length < 5) continue
      const artifact: Artifact = {
        id: createId(),
        type: language === 'html' ? 'html' : 'code',
        title: `${language} snippet`,
        language,
        content: code,
        messageId,
        blockIndex,
        createdAt: new Date().toISOString(),
      }
      blockIndex++
      artifacts.value.push(artifact)
      if (currentSessionId.value) {
        msgSvc.saveArtifact(currentSessionId.value, artifact).catch((error) => logger.warn('持久化 artifact 失败', error))
      }
    }
  }

  function addArtifact(artifact: Omit<Artifact, 'id' | 'createdAt'>) {
    const nextArtifact: Artifact = {
      ...artifact,
      id: createId(),
      createdAt: new Date().toISOString(),
    }
    artifacts.value.push(nextArtifact)
    if (currentSessionId.value) {
      msgSvc.saveArtifact(currentSessionId.value, nextArtifact).catch((error) => logger.warn('持久化 artifact 失败', error))
    }
  }

  function selectArtifact(id: string) {
    selectedArtifactId.value = id
    showArtifacts.value = true
  }

  return {
    extractArtifacts,
    addArtifact,
    selectArtifact,
  }
}

