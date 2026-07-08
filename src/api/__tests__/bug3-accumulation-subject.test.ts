/**
 * BUG-3 (Low)：后端 GET /accumulation 支持 ?subject= 过滤（handler.go listAccumulation
 * → Deps.ListAccumulation(agent, subject)），但前端 k12ListAccumulation 只传 agent，
 * subject 过滤能力从不被前端触达（未用能力）。本测试钉死 api client 契约：给了 subject
 * 就必须进 query；没给则不带 subject 键（保持全量列表语义）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.hoisted(() => vi.fn())
vi.mock('ofetch', () => ({
  ofetch: { create: () => mockFetch },
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import { k12ListAccumulation } from '../k12'

function lastCall() {
  const calls = mockFetch.mock.calls
  return calls[calls.length - 1] as [string, Record<string, unknown>]
}

describe('BUG-3 k12ListAccumulation subject 过滤透传', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockResolvedValue({ items: [] })
  })

  it('给了 subject → 进 query', async () => {
    await k12ListAccumulation('mingming', '语文')
    const [, opts] = lastCall()
    const query = (opts?.query ?? {}) as Record<string, unknown>
    expect(query.agent).toBe('mingming')
    expect(query.subject).toBe('语文')
  })

  it('没给 subject → 不带 subject 键（全量列表）', async () => {
    await k12ListAccumulation('mingming')
    const [, opts] = lastCall()
    const query = (opts?.query ?? {}) as Record<string, unknown>
    expect(query.agent).toBe('mingming')
    expect('subject' in query).toBe(false)
  })
})
