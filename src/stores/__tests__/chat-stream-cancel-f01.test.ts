/**
 * 回归测试 — F-01（2026-06-22 hex-test 审计）：
 * stopStreaming 在目标会话无活跃流时，曾无条件走 legacy 兜底块，按镜像
 * streamingSessionId 强制 sendCancel + 清流状态 —— 会停掉「另一个正在并发流式」
 * 的会话。修复后：仅当确为 legacy/当前镜像流时才走兜底，否则不动镜像。
 */
import { describe, expect, it } from 'vitest'
import { ref as vueRef } from 'vue'
import { createChatStreamCancelController } from '../chat-stream-cancel'

describe('F-01 stopStreaming 不得停掉另一并发会话', () => {
  it('当前会话 A 未流式、后台会话 B 正在流式时，stop 不应取消 B', () => {
    const sendCancel = (() => {
      const fn = (...args: unknown[]) => {
        ;(fn as any).calls.push(args)
      }
      ;(fn as any).calls = [] as unknown[][]
      return fn
    })()
    const triggerSocketError = (() => {
      const fn = () => {
        ;(fn as any).called = true
      }
      ;(fn as any).called = false
      return fn
    })()

    const streaming = vueRef(true) // B 正在流式
    const streamingSessionId = vueRef<string | null>('B') // 镜像指向 B

    const controller = createChatStreamCancelController({
      activeStreams: vueRef({
        B: {
          sessionId: 'B',
          requestId: 'req-B',
          rawContent: '',
          content: 'B 的半截回答',
          explicitReasoning: '',
          reasoning: '',
          reasoningStartTime: 0,
          reasoningEndTime: 0,
        },
      }),
      currentSessionId: vueRef('A'), // 用户正看 A（A 无流）
      messages: vueRef([]),
      streaming,
      streamingSessionId,
      streamingContent: vueRef(''),
      streamingReasoning: vueRef(''),
      streamingReasoningStartTime: vueRef(0),
      streamingReasoningEndTime: vueRef(0),
      streamHandles: new Map(),
      msgSvc: { persistMessage: () => {} } as any,
      createId: () => 'x',
      appendMessageToSession: () => {},
      resetSessionStream: () => {},
      sendCancel: sendCancel as any,
      clearSocketCallbacks: () => {},
      triggerSocketError: triggerSocketError as any,
    })

    // 停「当前会话 A」（A 无活跃流）
    controller.stopStreaming(undefined, vueRef(false), vueRef(false))

    // B 不应被取消
    const cancelledB = (sendCancel as any).calls.some((c: unknown[]) => c[0] === 'B')
    expect(cancelledB, 'sendCancel 不应以 B 调用（B 是另一并发会话）').toBe(false)
    expect(streaming.value, 'B 仍在流式，streaming 不应被清为 false').toBe(true)
    expect((triggerSocketError as any).called, '不应对 B 触发 socket 错误').toBe(false)
  })
})
