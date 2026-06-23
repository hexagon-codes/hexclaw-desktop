import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import zhCN from '@/i18n/locales/zh-CN'
import enUS from '@/i18n/locales/en'
import ugCN from '@/i18n/locales/ug-CN'

// AUDIT 2026-06-23（AP-030）：日志详情抽屉里 trace_id 行的「复制」按钮原本只复制裸 trace_id
// （copy(selected.trace_id)）。在纯本地桌面 app 里没有分布式链路追踪系统可粘贴，裸 trace_id 无用武之地。
// 改为复制人类可读的整条日志（reuse logLine(selected)），与「复制 JSON」(完整结构化) 形成互补：
//   复制 JSON  → 机器可读完整对象（含 trace_id + 全字段）
//   复制整条   → 人类可读单行 [time] [LEVEL] [source] message
//   按此 trace 检索 → 过滤
const src = readFileSync(resolve(process.cwd(), 'src/views/LogsView.vue'), 'utf8')

type Dict = { logs: Record<string, unknown> }
const locales: Array<[string, Dict]> = [
  ['zh-CN', zhCN as unknown as Dict],
  ['en', enUS as unknown as Dict],
  ['ug-CN', ugCN as unknown as Dict],
]

describe('AUDIT 日志 trace 行复制改为「复制整条」(reuse logLine)', () => {
  it('trace 行复制按钮复用 logLine(selected)，不再复制裸 trace_id', () => {
    // 旧实现已移除
    expect(src).not.toContain('copy(selected.trace_id)')
    // 新实现复用 logLine
    expect(src).toContain('copy(logLine(selected))')
  })

  it('按钮文案使用 logs.copyWholeLine（复制整条）', () => {
    expect(src).toContain("t('logs.copyWholeLine', '复制整条')")
  })

  it('「按此 trace 检索」仍保留（trace_id 仍可读、可检索）', () => {
    expect(src).toContain('searchByTrace(selected.trace_id)')
    expect(src).toContain("t('logs.filterByTrace'")
  })

  it('logLine 仍产出可读单行：[time] [LEVEL] [source] message', () => {
    expect(src).toMatch(/function logLine\(e: LogEntry\): string/)
    expect(src).toContain('e.level.toUpperCase()')
    expect(src).toContain('e.message')
  })

  it('三语均有 copyWholeLine，且废弃的 copyTrace 已删除（无死键）', () => {
    for (const [name, dict] of locales) {
      const logs = dict.logs as Record<string, unknown>
      expect(logs.copyWholeLine, `${name} 缺 copyWholeLine`).toBeTruthy()
      expect(logs.copyTrace, `${name} 仍残留废弃 copyTrace`).toBeUndefined()
    }
  })
})
