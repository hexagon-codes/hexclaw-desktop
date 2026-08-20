import type { ModelReasoningSupport } from '@/types/settings'
import type { ReasoningExecution, ReasoningRequest } from '@/types/chat'

export type AssistantReasoningRequest = ReasoningRequest
export type AssistantReasoningSupport = ModelReasoningSupport
export type AssistantReasoningExecution = ReasoningExecution

export type AssistantRunPresentationKind =
  | 'generating'
  | 'preparing'
  | 'unsupported'
  | 'thinking'
  | 'thought'
  | 'ignored'
  | 'rejected'
  | 'hidden'

export interface AssistantRunPresentationInput {
  reasoningRequest: AssistantReasoningRequest
  reasoningSupport: AssistantReasoningSupport
  reasoningExecution: AssistantReasoningExecution
  hasVisibleAnswer: boolean
  elapsedSeconds: number
}

export interface AssistantRunPresentation {
  kind: AssistantRunPresentationKind
  text: string | null
  animated: boolean
  timerActive: boolean
}

export interface AssistantRunPresentationLabels {
  generating: string
  preparing: string
  thinking: (duration: string) => string
  thought: (duration: string) => string
  ignored: string
  rejected: string
  unsupported: string
}

const HIDDEN_PRESENTATION: AssistantRunPresentation = {
  kind: 'hidden',
  text: null,
  animated: false,
  timerActive: false,
}

export function formatAssistantRunDuration(elapsedSeconds: number): string {
  const numericSeconds = Number(elapsedSeconds)
  const seconds = Number.isFinite(numericSeconds) ? Math.max(0, Math.round(numericSeconds)) : 0
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`
}

export function deriveAssistantRunPresentation(
  input: AssistantRunPresentationInput,
  labels: AssistantRunPresentationLabels,
): AssistantRunPresentation {
  if (input.reasoningRequest === 'off') {
    return input.hasVisibleAnswer
      ? HIDDEN_PRESENTATION
      : {
          kind: 'generating',
          text: labels.generating,
          animated: true,
          timerActive: false,
        }
  }

  if (input.reasoningSupport === 'unsupported') {
    return {
      kind: 'unsupported',
      text: labels.unsupported,
      animated: false,
      timerActive: false,
    }
  }

  if (input.hasVisibleAnswer) {
    if (input.reasoningExecution === 'applied') {
      return {
        kind: 'thought',
        text: labels.thought(formatAssistantRunDuration(input.elapsedSeconds)),
        animated: false,
        timerActive: false,
      }
    }
    if (input.reasoningExecution === 'ignored') {
      return {
        kind: 'ignored',
        text: labels.ignored,
        animated: false,
        timerActive: false,
      }
    }
    if (input.reasoningExecution === 'rejected') {
      return {
        kind: 'rejected',
        text: labels.rejected,
        animated: false,
        timerActive: false,
      }
    }
    return HIDDEN_PRESENTATION
  }

  if (input.reasoningExecution === 'applied') {
    return {
      kind: 'thinking',
      text: labels.thinking(formatAssistantRunDuration(input.elapsedSeconds)),
      animated: true,
      timerActive: true,
    }
  }
  if (input.reasoningExecution === 'ignored') {
    return {
      kind: 'ignored',
      text: labels.ignored,
      animated: false,
      timerActive: false,
    }
  }
  if (input.reasoningExecution === 'rejected') {
    return {
      kind: 'rejected',
      text: labels.rejected,
      animated: false,
      timerActive: false,
    }
  }
  return {
    kind: 'preparing',
    text: labels.preparing,
    animated: true,
    timerActive: false,
  }
}
