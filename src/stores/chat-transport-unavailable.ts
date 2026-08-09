import type { Ref } from 'vue'
import type { ChatAttachment, ChatMessage } from '@/types'
import type { ChatSendErrorHandler, SessionStreamState } from './chat-stream-helpers'

/** A failed WebSocket is terminal; retry resumes the same protocol/request id. */
export function createChatTransportUnavailableController(params: {
  activeStreams: Ref<Record<string, SessionStreamState>>
  isSessionCancelled: (sessionId: string) => boolean
  resetSessionStream: (
    sessionId?: string | null,
    sending?: Ref<boolean>,
    draftSending?: Ref<boolean>,
  ) => void
  handleSendError: ChatSendErrorHandler
}) {
  async function rejectUnavailableTransport(args: {
    backendText: string
    sessionId: string
    attachments?: ChatAttachment[]
    requestId: string
    requestMetadata?: Record<string, string>
    samplingSnapshot?: unknown
    sending: Ref<boolean>
    draftSending: Ref<boolean>
  }): Promise<ChatMessage | null> {
    if (params.isSessionCancelled(args.sessionId)) {
      params.resetSessionStream(args.sessionId, args.sending, args.draftSending)
      return null
    }
    params.handleSendError(
      new Error('WebSocket transport unavailable; retry will resume with the same request id'),
      args.sessionId,
      params.activeStreams.value[args.sessionId],
    )
    return null
  }
  return { rejectUnavailableTransport }
}
