import type { ContentBlock, RuntimeWireFrame, ToolCall } from '@/types/chat'
import { trimDegenerateTail, DEGENERATION_NOTICE } from '@/utils/degeneration'

/** 复读终止只收口最终回答；此前解释、工具与召回保持原顺序。 */
export function freezeProcessAnswer(blocks: ContentBlock[] = []): ContentBlock[] {
  const { answer } = splitProcessBlocks(blocks)
  if (!answer.length) return blocks
  const text = answer.map(block => block.type === 'text' ? block.text : '').join('')
  const frozen = trimDegenerateTail(text) + DEGENERATION_NOTICE
  const answerSet = new Set(answer)
  let emitted = false
  return blocks.flatMap((block): ContentBlock[] => {
    if (!answerSet.has(block)) return [block]
    if (emitted) return []
    emitted = true
    return [{ type: 'text', text: frozen }]
  })
}

/** 仅在调用者接受请求身份与序号后归并，调用 ID 保持开始顺序。 */
export function mergeProcessCalls(current: ToolCall[] = [], incoming: ToolCall[] = []): ToolCall[] {
  const calls = current.map((call) => ({ ...call }))
  for (const next of incoming) {
    const index = calls.findIndex((call) => call.id === next.id)
    if (index < 0) calls.push(next)
    else calls[index] = { ...calls[index], ...next }
  }
  return calls
}

/** 服务端有序快照优先；公开增量只补充尚未取得快照的帧。 */
export function appendProcessBlocks(
  current: ContentBlock[] = [],
  frame: RuntimeWireFrame | undefined,
  text: string,
  reasoning?: string,
  clearReasoning = false,
): ContentBlock[] {
  let blocks = frame?.blocks ? [...frame.blocks] : current.map((block) => ({ ...block }))
  if (!frame?.blocks) {
    if (reasoning) {
      const last = blocks[blocks.length - 1]
      if (last?.type === 'thinking') last.thinking += reasoning
      else blocks.push({ type: 'thinking', thinking: reasoning })
    }
    if (text) {
      const last = blocks[blocks.length - 1]
      if (last?.type === 'text') {
        last.text += text
        delete last.message_content
      } else blocks.push({ type: 'text', text })
    }
    const event = frame?.runtimeEvent
    if (
      event?.kind === 'tool_started' &&
      event.tool_call_id &&
      event.tool_name &&
      !blocks.some((block) => block.type === 'tool_use' && block.id === event.tool_call_id)
    ) {
      blocks.push({
        type: 'tool_use',
        id: event.tool_call_id,
        name: event.tool_name,
        input: frame?.toolCalls?.find((call) => call.id === event.tool_call_id)?.arguments ?? '',
      })
    }
  }
  if (clearReasoning || (frame?.blocks && frame.reasoningDisclosure.visibility !== 'visible'))
    blocks = blocks.filter((block) => block.type !== 'thinking')
  return blocks
}

/** 最后一次工具调用后的正文独立交付；此前的公开解释保留在处理过程。 */
export function splitProcessBlocks(blocks: ContentBlock[] = []) {
  let lastTool = -1
  blocks.forEach((block, index) => {
    if (block.type === 'tool_use') lastTool = index
  })
  return {
    process: blocks.filter(
      (block, index) =>
        block.type === 'retrieval' ||
        block.type === 'thinking' ||
        block.type === 'tool_use' ||
        (block.type === 'text' && index < lastTool),
    ),
    answer: blocks.filter((block, index) => block.type === 'text' && index > lastTool),
  }
}
