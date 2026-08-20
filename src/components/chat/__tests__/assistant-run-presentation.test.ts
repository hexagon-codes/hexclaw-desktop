import { describe, expect, it } from 'vitest'

import {
  deriveAssistantRunPresentation,
  type AssistantRunPresentationLabels,
} from '../assistant-run-presentation'

type ReasoningSupport = 'supported' | 'unsupported' | 'unknown'
type ReasoningRequest = 'on' | 'off'
type ReasoningExecution = 'applied' | 'ignored' | 'rejected' | 'unknown'

type PresentationInput = {
  reasoningSupport: ReasoningSupport
  reasoningRequest: ReasoningRequest
  reasoningExecution: ReasoningExecution
  hasVisibleAnswer: boolean
  elapsedSeconds: number
}

type ExpectedPresentation = {
  kind:
    | 'generating'
    | 'preparing'
    | 'unsupported'
    | 'thinking'
    | 'thought'
    | 'ignored'
    | 'rejected'
    | 'hidden'
  text: string | null
  animated: boolean
  timerActive: boolean
}

const baseInput: PresentationInput = {
  reasoningSupport: 'supported',
  reasoningRequest: 'on',
  reasoningExecution: 'unknown',
  hasVisibleAnswer: false,
  elapsedSeconds: 19,
}

const zhLabels: AssistantRunPresentationLabels = {
  generating: '正在生成回答…',
  preparing: '正在准备回答…',
  thinking: (duration) => `正在深度思考 · ${duration}`,
  thought: (duration) => `思考了 ${duration}`,
  ignored: '深度思考未生效，已按普通模式回答',
  rejected: '无法启用深度思考',
  unsupported: '该模型不支持深度思考',
}

function present(overrides: Partial<PresentationInput> = {}) {
  return deriveAssistantRunPresentation(
    {
      ...baseInput,
      ...overrides,
    },
    zhLabels,
  )
}

describe('assistant run presentation', () => {
  it.each<{
    name: string
    input: Partial<PresentationInput>
    expected: ExpectedPresentation
  }>([
    {
      name: 'supported model with reasoning off',
      input: { reasoningSupport: 'supported', reasoningRequest: 'off' },
      expected: {
        kind: 'generating',
        text: '正在生成回答…',
        animated: true,
        timerActive: false,
      },
    },
    {
      name: 'unsupported model with reasoning off',
      input: { reasoningSupport: 'unsupported', reasoningRequest: 'off' },
      expected: {
        kind: 'generating',
        text: '正在生成回答…',
        animated: true,
        timerActive: false,
      },
    },
    {
      name: 'unknown model with reasoning off',
      input: { reasoningSupport: 'unknown', reasoningRequest: 'off' },
      expected: {
        kind: 'generating',
        text: '正在生成回答…',
        animated: true,
        timerActive: false,
      },
    },
    {
      name: 'supported model awaiting an execution receipt',
      input: { reasoningSupport: 'supported', reasoningRequest: 'on' },
      expected: {
        kind: 'preparing',
        text: '正在准备回答…',
        animated: true,
        timerActive: false,
      },
    },
    {
      name: 'unknown model awaiting an execution receipt',
      input: { reasoningSupport: 'unknown', reasoningRequest: 'on' },
      expected: {
        kind: 'preparing',
        text: '正在准备回答…',
        animated: true,
        timerActive: false,
      },
    },
    {
      name: 'unsupported model with reasoning requested',
      input: { reasoningSupport: 'unsupported', reasoningRequest: 'on' },
      expected: {
        kind: 'unsupported',
        text: '该模型不支持深度思考',
        animated: false,
        timerActive: false,
      },
    },
  ])('projects support and request: $name', ({ input, expected }) => {
    expect(present(input)).toEqual(expected)
  })

  it.each<{
    execution: ReasoningExecution
    expected: ExpectedPresentation
  }>([
    {
      execution: 'applied',
      expected: {
        kind: 'thinking',
        text: '正在深度思考 · 19s',
        animated: true,
        timerActive: true,
      },
    },
    {
      execution: 'ignored',
      expected: {
        kind: 'ignored',
        text: '深度思考未生效，已按普通模式回答',
        animated: false,
        timerActive: false,
      },
    },
    {
      execution: 'rejected',
      expected: {
        kind: 'rejected',
        text: '无法启用深度思考',
        animated: false,
        timerActive: false,
      },
    },
    {
      execution: 'unknown',
      expected: {
        kind: 'preparing',
        text: '正在准备回答…',
        animated: true,
        timerActive: false,
      },
    },
  ])(
    'projects execution receipt $execution before the first visible answer',
    ({ execution, expected }) => {
      expect(present({ reasoningExecution: execution })).toEqual(expected)
    },
  )

  it('lets an applied receipt override unknown capability without inventing support', () => {
    expect(
      present({
        reasoningSupport: 'unknown',
        reasoningExecution: 'applied',
      }),
    ).toEqual({
      kind: 'thinking',
      text: '正在深度思考 · 19s',
      animated: true,
      timerActive: true,
    })
  })

  it.each<{
    name: string
    input: Partial<PresentationInput>
    expected: ExpectedPresentation
  }>([
    {
      name: 'ordinary generation',
      input: { reasoningRequest: 'off', hasVisibleAnswer: true },
      expected: {
        kind: 'hidden',
        text: null,
        animated: false,
        timerActive: false,
      },
    },
    {
      name: 'reasoning request without a receipt',
      input: { reasoningExecution: 'unknown', hasVisibleAnswer: true },
      expected: {
        kind: 'hidden',
        text: null,
        animated: false,
        timerActive: false,
      },
    },
    {
      name: 'applied reasoning receipt',
      input: { reasoningExecution: 'applied', hasVisibleAnswer: true },
      expected: {
        kind: 'thought',
        text: '思考了 19s',
        animated: false,
        timerActive: false,
      },
    },
    {
      name: 'ignored reasoning receipt',
      input: { reasoningExecution: 'ignored', hasVisibleAnswer: true },
      expected: {
        kind: 'ignored',
        text: '深度思考未生效，已按普通模式回答',
        animated: false,
        timerActive: false,
      },
    },
  ])('stops active status after the first visible answer: $name', ({ input, expected }) => {
    expect(present(input)).toEqual(expected)
  })

  it('formats active and frozen elapsed time with the same exact duration', () => {
    expect(present({ reasoningExecution: 'applied', elapsedSeconds: 100 })).toEqual({
      kind: 'thinking',
      text: '正在深度思考 · 1m 40s',
      animated: true,
      timerActive: true,
    })

    expect(
      present({
        reasoningExecution: 'applied',
        hasVisibleAnswer: true,
        elapsedSeconds: 100,
      }),
    ).toEqual({
      kind: 'thought',
      text: '思考了 1m 40s',
      animated: false,
      timerActive: false,
    })
  })

  it.each<{
    execution: ReasoningExecution
    expected: ExpectedPresentation
  }>([
    {
      execution: 'applied',
      expected: {
        kind: 'thought',
        text: '思考了 19s',
        animated: false,
        timerActive: false,
      },
    },
    {
      execution: 'ignored',
      expected: {
        kind: 'ignored',
        text: '深度思考未生效，已按普通模式回答',
        animated: false,
        timerActive: false,
      },
    },
    {
      execution: 'rejected',
      expected: {
        kind: 'rejected',
        text: '无法启用深度思考',
        animated: false,
        timerActive: false,
      },
    },
    {
      execution: 'unknown',
      expected: {
        kind: 'hidden',
        text: null,
        animated: false,
        timerActive: false,
      },
    },
  ])(
    'does not regress to an active state when a $execution receipt arrives after answer start',
    ({ execution, expected }) => {
      expect(
        present({
          reasoningExecution: execution,
          hasVisibleAnswer: true,
        }),
      ).toEqual(expected)
    },
  )

  it.each([false, true])(
    'keeps the specific unsupported failure visible when hasVisibleAnswer=%s',
    (hasVisibleAnswer) => {
      expect(
        present({
          reasoningSupport: 'unsupported',
          reasoningExecution: 'rejected',
          hasVisibleAnswer,
        }),
      ).toEqual({
        kind: 'unsupported',
        text: '该模型不支持深度思考',
        animated: false,
        timerActive: false,
      })
    },
  )

  it('covers request, support, execution, and answer-phase combinations as one matrix', () => {
    const supports: ReasoningSupport[] = ['supported', 'unsupported', 'unknown']
    const executions: ReasoningExecution[] = ['applied', 'ignored', 'rejected', 'unknown']

    for (const reasoningSupport of supports) {
      for (const reasoningExecution of executions) {
        expect(
          present({
            reasoningSupport,
            reasoningRequest: 'off',
            reasoningExecution,
            hasVisibleAnswer: false,
          }),
        ).toEqual({
          kind: 'generating',
          text: '正在生成回答…',
          animated: true,
          timerActive: false,
        })
        expect(
          present({
            reasoningSupport,
            reasoningRequest: 'off',
            reasoningExecution,
            hasVisibleAnswer: true,
          }),
        ).toEqual({
          kind: 'hidden',
          text: null,
          animated: false,
          timerActive: false,
        })
      }
    }

    const beforeAnswer: Record<ReasoningExecution, ExpectedPresentation> = {
      applied: {
        kind: 'thinking',
        text: '正在深度思考 · 19s',
        animated: true,
        timerActive: true,
      },
      ignored: {
        kind: 'ignored',
        text: '深度思考未生效，已按普通模式回答',
        animated: false,
        timerActive: false,
      },
      rejected: {
        kind: 'rejected',
        text: '无法启用深度思考',
        animated: false,
        timerActive: false,
      },
      unknown: {
        kind: 'preparing',
        text: '正在准备回答…',
        animated: true,
        timerActive: false,
      },
    }
    const afterAnswer: Record<ReasoningExecution, ExpectedPresentation> = {
      applied: {
        kind: 'thought',
        text: '思考了 19s',
        animated: false,
        timerActive: false,
      },
      ignored: beforeAnswer.ignored,
      rejected: beforeAnswer.rejected,
      unknown: {
        kind: 'hidden',
        text: null,
        animated: false,
        timerActive: false,
      },
    }

    for (const reasoningSupport of ['supported', 'unknown'] satisfies ReasoningSupport[]) {
      for (const reasoningExecution of executions) {
        expect(present({ reasoningSupport, reasoningExecution, hasVisibleAnswer: false })).toEqual(
          beforeAnswer[reasoningExecution],
        )
        expect(present({ reasoningSupport, reasoningExecution, hasVisibleAnswer: true })).toEqual(
          afterAnswer[reasoningExecution],
        )
      }
    }

    for (const reasoningExecution of executions) {
      for (const hasVisibleAnswer of [false, true]) {
        expect(
          present({
            reasoningSupport: 'unsupported',
            reasoningExecution,
            hasVisibleAnswer,
          }),
        ).toEqual({
          kind: 'unsupported',
          text: '该模型不支持深度思考',
          animated: false,
          timerActive: false,
        })
      }
    }
  })
})
