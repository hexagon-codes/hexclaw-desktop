/**
 * BUG-20260708 F3 · 慢 Agent 首 chunk 时延 > 客户端空闲超时 → 空回复被误判卡死。
 *
 * 症状（真机 qwen3.5:9b 取证）：role=k12-tutor（10-skill ReAct，本地 9B 跑 CPU）首个内容 chunk
 * 约 214s 才来（思考期无输出）；Rust `backend_chat` 的 `CHUNK_IDLE_TIMEOUT_SECS=60` 对**每个** chunk
 * 都套 60s 超时（含首 chunk）→ 60s 无 chunk 即判卡死中断 → 用户见空回复。
 *
 * 修复：区分「首 chunk 超时」（长，容忍慢本地模型/多步 ReAct 思考期）vs「chunk 间空闲超时」（短，
 * 防中途真卡死）。首 chunk 前用 FIRST_CHUNK_TIMEOUT_SECS（≥240），收到首 chunk 后才用 60s。
 * 回归锁：源码扫描 commands.rs 存在 FIRST_CHUNK_TIMEOUT_SECS ≥ 240 且据 chunk_count==0 选用。
 *
 * 注：Rust 流式超时行为难在单测直接驱动，故沿用本仓既有源码扫描锁风格（见 scroll-arrow 测试）。
 * 真机行为验证在 hex-test env-gated 门（role-pinned tutor 请求在超时内出首 chunk）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('BUG-20260708 F3: 首 chunk 超时区别于 chunk 间空闲超时', () => {
  const src = readFileSync(resolve(__dirname, '../../src-tauri/src/commands.rs'), 'utf-8')

  it('存在独立的 FIRST_CHUNK_TIMEOUT_SECS 且 ≥ 240（容忍慢本地 ReAct 思考期）', () => {
    const m = src.match(/FIRST_CHUNK_TIMEOUT_SECS\s*:\s*u64\s*=\s*(\d+)/)
    expect(m, '必须有独立的首 chunk 超时常量').not.toBeNull()
    expect(Number(m![1])).toBeGreaterThanOrEqual(240)
  })

  it('chunk 间空闲超时仍短（60s 量级，防中途真卡死）', () => {
    const m = src.match(/CHUNK_IDLE_TIMEOUT_SECS\s*:\s*u64\s*=\s*(\d+)/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBeLessThanOrEqual(90)
  })

  it('首 chunk 超时据 chunk_count==0 选用（收到首 chunk 后切回短空闲超时）', () => {
    // 循环里必须按「是否已收到首 chunk」在两个超时间切换
    expect(src).toMatch(/chunk_count\s*==\s*0/)
  })
})
