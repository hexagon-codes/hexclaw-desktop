/**
 * Comprehensive benchmarks for HexClaw Desktop utility modules.
 *
 * Covers: diff.ts, content-blocks.ts, errors.ts, chat-automation.ts
 */

import { bench as rawBench, describe } from 'vitest'

// 增加迭代次数以降低 RME（相对误差），默认太低导致噪声 >100%
const bench = (name: string, fn: () => void) => rawBench(name, fn, { iterations: 100, warmupIterations: 10 })
import { computeDiff, computeStructuredDiff } from '../diff'
import { toContentBlocks } from '../content-blocks'
import { fromNativeError, fromHttpStatus } from '../errors'
import { buildConversationAutomationActions } from '../chat-automation'
import type { ChatMessage } from '@/types/chat'

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function buildLines(count: number, prefix = 'line'): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i}: ${' '.repeat(i % 20)}content ${i}`)
}

function buildText(lines: string[]): string {
  return lines.join('\n')
}

function makeFewChanges(lines: string[], changeRate: number): string[] {
  return lines.map((line, i) => (i % changeRate === 0 ? `${line} [MODIFIED]` : line))
}

function makeManyChanges(lines: string[], changeRate: number): string[] {
  return lines.map((line, i) => {
    if (i % changeRate === 0) return `REPLACED: new content for line ${i}`
    if (i % changeRate === 1) return '' // deleted (empty)
    return line
  })
}

function buildToolCallMessage(count: number): ChatMessage {
  return {
    id: `msg-tc-${count}`,
    role: 'assistant',
    content: `Summary of ${count} tool calls`,
    reasoning: 'Analyzing tool results step by step with detailed reasoning',
    timestamp: new Date().toISOString(),
    metadata: { thinking_duration: 3.5 },
    tool_calls: Array.from({ length: count }, (_, idx) => ({
      id: `tool-${idx}`,
      name: idx % 3 === 0 ? 'web_search' : idx % 3 === 1 ? 'file_read' : 'code_execute',
      arguments: JSON.stringify({ query: `query-${idx}`, file: `path/to/file-${idx}.ts` }),
      result: `Result for tool call ${idx}: ${JSON.stringify({ status: 'ok', data: `response-${idx}` })}`,
    })),
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1. diff.ts — computeDiff with 500-line files (few changes)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('diff.ts: computeDiff 500 lines', () => {
  const base500 = buildLines(500)
  const fewChanges500 = makeFewChanges(base500, 50) // ~10 changes
  const manyChanges500 = makeManyChanges(base500, 3) // ~333 changes

  const oldText500 = buildText(base500)
  const fewChangesText500 = buildText(fewChanges500)
  const manyChangesText500 = buildText(manyChanges500)

  bench('computeDiff: 500 lines, few changes (~10 edits)', () => {
    computeDiff(oldText500, fewChangesText500)
  })

  bench('computeDiff: 500 lines, many changes (~333 edits)', () => {
    computeDiff(oldText500, manyChangesText500)
  })

  bench('computeDiff: 500 lines, identical (no changes)', () => {
    computeDiff(oldText500, oldText500)
  })

  bench('computeDiff: 500 lines, completely different', () => {
    const completelyDifferent = buildText(buildLines(500, 'different'))
    computeDiff(oldText500, completelyDifferent)
  })
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 2. diff.ts — computeStructuredDiff with 1000-line files
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('diff.ts: computeStructuredDiff 1000 lines', () => {
  const base1k = buildLines(1000)
  const sparse1k = makeFewChanges(base1k, 100) // ~10 changes
  const moderate1k = makeFewChanges(base1k, 20) // ~50 changes
  const dense1k = makeManyChanges(base1k, 5) // ~400 changes

  const oldText1k = buildText(base1k)
  const sparseText1k = buildText(sparse1k)
  const moderateText1k = buildText(moderate1k)
  const denseText1k = buildText(dense1k)

  bench('computeStructuredDiff: 1000 lines, sparse edits (~10)', () => {
    computeStructuredDiff(oldText1k, sparseText1k)
  })

  bench('computeStructuredDiff: 1000 lines, moderate edits (~50)', () => {
    computeStructuredDiff(oldText1k, moderateText1k)
  })

  bench('computeStructuredDiff: 1000 lines, dense edits (~400)', () => {
    computeStructuredDiff(oldText1k, denseText1k)
  })

  bench('computeStructuredDiff: 1000 lines, with custom context=5', () => {
    computeStructuredDiff(oldText1k, sparseText1k, 5)
  })
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 3. content-blocks.ts — toContentBlocks with 200 tool calls
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('content-blocks.ts: toContentBlocks', () => {
  const msg5 = buildToolCallMessage(5)
  const msg50 = buildToolCallMessage(50)
  const msg200 = buildToolCallMessage(200)

  const msgNoTools: ChatMessage = {
    id: 'msg-plain',
    role: 'assistant',
    content: 'Just a text response with no tools or reasoning.',
    timestamp: new Date().toISOString(),
  }

  const msgPrebuiltBlocks: ChatMessage = {
    id: 'msg-prebuilt',
    role: 'assistant',
    content: '',
    timestamp: new Date().toISOString(),
    blocks: Array.from({ length: 200 }, (_, i) => ({
      type: 'text' as const,
      text: `Pre-built block ${i}`,
    })),
  }

  bench('toContentBlocks: 5 tool calls', () => {
    toContentBlocks(msg5)
  })

  bench('toContentBlocks: 50 tool calls', () => {
    toContentBlocks(msg50)
  })

  bench('toContentBlocks: 200 tool calls', () => {
    toContentBlocks(msg200)
  })

  bench('toContentBlocks: plain text (no tools, no reasoning)', () => {
    toContentBlocks(msgNoTools)
  })

  bench('toContentBlocks: 200 prebuilt blocks (passthrough)', () => {
    toContentBlocks(msgPrebuiltBlocks)
  })
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 4. errors.ts — fromNativeError pipeline (100 different errors)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('errors.ts: fromNativeError pipeline', () => {
  // Pre-build a variety of error types
  const errors: unknown[] = [
    // Regular Error objects
    ...Array.from({ length: 20 }, (_, i) => new Error(`Generic error ${i}`)),
    // TypeError with fetch
    ...Array.from({ length: 10 }, (_, i) => new TypeError(`Failed to fetch resource ${i}`)),
    // DOMException AbortError
    ...Array.from({ length: 10 }, () => {
      const e = new DOMException('The operation was aborted', 'AbortError')
      return e
    }),
    // String errors
    ...Array.from({ length: 10 }, (_, i) => `String error message ${i}`),
    // ApiError-like objects
    ...Array.from({ length: 10 }, (_, i) => ({
      code: 'SERVER_ERROR',
      message: `Server error ${i}`,
      status: 500,
    })),
    // FetchError-like with status
    ...Array.from({ length: 10 }, (_, i) => {
      const e = new Error(`HTTP error ${i}`) as Error & { status: number; data?: { error?: string } }
      e.status = 400 + (i % 5)
      e.data = { error: `Validation error ${i}` }
      return e
    }),
    // null / undefined / numbers
    null,
    undefined,
    42,
    0,
    false,
    // Objects without code/message
    ...Array.from({ length: 5 }, (_, i) => ({ unexpected: `field ${i}` })),
    // Nested error
    ...Array.from({ length: 10 }, (_, i) => {
      const e = new Error(`Outer ${i}`)
      ;(e as Error & { status?: number }).status = 502
      return e
    }),
  ]

  bench('fromNativeError: process 100 mixed errors', () => {
    for (const err of errors) {
      fromNativeError(err)
    }
  })

  bench('fromNativeError: 100x same TypeError (fetch)', () => {
    const err = new TypeError('Failed to fetch')
    for (let i = 0; i < 100; i++) {
      fromNativeError(err)
    }
  })

  bench('fromNativeError: 100x string errors', () => {
    for (let i = 0; i < 100; i++) {
      fromNativeError(`Error string number ${i}`)
    }
  })

  bench('fromNativeError: 100x already-ApiError passthrough', () => {
    const apiErr = { code: 'NETWORK_ERROR', message: 'Network unreachable', status: undefined }
    for (let i = 0; i < 100; i++) {
      fromNativeError(apiErr)
    }
  })
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 5. errors.ts — fromHttpStatus for all status codes
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('errors.ts: fromHttpStatus', () => {
  // All HTTP error status codes in the 400-500 range
  const statusCodes = [
    400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414,
    415, 416, 417, 418, 421, 422, 423, 424, 425, 426, 428, 429, 431, 451,
    500, 501, 502, 503, 504, 505, 506, 507, 508, 510, 511,
  ]

  bench('fromHttpStatus: all codes 401-511 (~40 codes)', () => {
    for (const code of statusCodes) {
      fromHttpStatus(code)
    }
  })

  bench('fromHttpStatus: all codes with server messages', () => {
    for (const code of statusCodes) {
      fromHttpStatus(code, `Custom message for ${code}`)
    }
  })

  bench('fromHttpStatus: rapid 401 (auth check)', () => {
    for (let i = 0; i < 100; i++) {
      fromHttpStatus(401)
    }
  })

  bench('fromHttpStatus: rapid 429 (rate limit check)', () => {
    for (let i = 0; i < 100; i++) {
      fromHttpStatus(429)
    }
  })

  bench('fromHttpStatus: rapid 500 (server error)', () => {
    for (let i = 0; i < 100; i++) {
      fromHttpStatus(500, 'Internal Server Error')
    }
  })
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 6. chat-automation.ts — buildConversationAutomationActions
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('chat-automation.ts: buildConversationAutomationActions', () => {
  bench('simple task creation: Chinese schedule', () => {
    buildConversationAutomationActions({
      userText: '请帮我创建一个定时任务，每天下午3点执行，检查服务器状态',
      sourceMessageId: 'msg-1',
    })
  })

  bench('task creation with @every schedule', () => {
    buildConversationAutomationActions({
      userText: '创建一个定时任务 @every 30m 自动执行一次，检查所有API端点健康状况',
      sourceMessageId: 'msg-2',
    })
  })

  bench('task management: pause/resume/delete', () => {
    buildConversationAutomationActions({
      userText: '暂停任务"每日报告"',
      sourceMessageId: 'msg-3',
    })
    buildConversationAutomationActions({
      userText: '恢复任务"每日报告"',
      sourceMessageId: 'msg-4',
    })
    buildConversationAutomationActions({
      userText: '删除任务"过期数据清理"',
      sourceMessageId: 'msg-5',
    })
  })

  bench('knowledge base operations', () => {
    buildConversationAutomationActions({
      userText: '搜索知识库关于"RAG架构"的内容',
      sourceMessageId: 'msg-6',
    })
    buildConversationAutomationActions({
      userText: '请把上面的结果保存到知识库',
      assistantContent: 'RAG (Retrieval-Augmented Generation) is a technique that combines retrieval with generation...',
      sourceMessageId: 'msg-7',
    })
  })

  bench('document operations: reindex + delete', () => {
    buildConversationAutomationActions({
      userText: '重建索引知识库文档"API文档"',
      sourceMessageId: 'msg-8',
    })
    buildConversationAutomationActions({
      userText: '删除知识库文档"过时手册"',
      sourceMessageId: 'msg-9',
    })
  })

  bench('complex input: multiple intents (task + knowledge)', () => {
    buildConversationAutomationActions({
      userText: '请创建一个定时任务，每周一上午9点搜索知识库关于"周报模板"的内容并生成周报，任务名叫"自动周报"',
      assistantContent: '好的，我来帮你设置自动周报任务。',
      sourceMessageId: 'msg-10',
    })
  })

  bench('attachment knowledge action', () => {
    buildConversationAutomationActions({
      userText: '请把这个附件上传到知识库',
      sourceMessageId: 'msg-11',
      attachment: {
        fileName: 'architecture-overview.pdf',
        parsedText: 'This document describes the overall system architecture including microservices, message queues, and data pipelines.',
      },
    })
  })

  bench('no-match text (should return empty quickly)', () => {
    buildConversationAutomationActions({
      userText: '今天天气怎么样？',
      sourceMessageId: 'msg-12',
    })
  })

  bench('empty input', () => {
    buildConversationAutomationActions({
      userText: '',
      sourceMessageId: 'msg-13',
    })
  })

  bench('long text with multiple schedule formats', () => {
    buildConversationAutomationActions({
      userText: '帮我安排一个定时任务，名叫"全链路巡检"，使用 cron 表达式 */5 * * * * 每5分钟执行一次，检查所有微服务的健康状态，包括数据库连接、Redis缓存、消息队列、API网关的响应时间，如果发现异常就发送告警通知',
      sourceMessageId: 'msg-14',
    })
  })
})
