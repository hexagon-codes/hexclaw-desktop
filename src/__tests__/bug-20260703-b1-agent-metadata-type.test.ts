/**
 * BUG-20260703 B1 — AgentConfig.metadata 前端类型宽于后端契约（潜伏型契约错位）。
 *
 * 后端：router/agent_router.go:42 / api/handler_misc.go RegisterAgentRequest.Metadata
 * 均为 map[string]string。前端此前是 Record<string, unknown>——允许塞非字符串值，
 * 一旦有调用方真的写入（数字/对象），透传到后端即 JSON decode 400。
 *
 * 类型级回归锁：Equal 断言在 vue-tsc --build（CI 必跑门）下编译期锁死两端对齐；
 * 前端类型再被放宽回 unknown（或漂移成别的形状）即编译失败。
 */
import { describe, it, expect } from 'vitest'
import type { AgentConfig } from '@/types'

type Equal<A, B> = (<G>() => G extends A ? 1 : 2) extends (<G>() => G extends B ? 1 : 2) ? true : false

describe('BUG-20260703 B1 — AgentConfig.metadata 契约类型', () => {
  it('metadata 与后端 map[string]string 精确对齐（含 undefined 可选性）', () => {
    const lock: Equal<AgentConfig['metadata'], Record<string, string> | undefined> = true
    expect(lock).toBe(true)
  })

  it('运行时样例：字符串值可赋，类型不再吞非字符串', () => {
    const ok: AgentConfig = { name: 'a', display_name: 'A', model: '', provider: '', metadata: { grade: '初二' } }
    expect(ok.metadata?.grade).toBe('初二')
    // @ts-expect-error 非字符串 metadata 值必须被类型系统拒绝（后端 map[string]string）
    const bad: AgentConfig = { name: 'b', display_name: 'B', model: '', provider: '', metadata: { level: 2 } }
    expect(bad).toBeTruthy()
  })
})
