/**
 * 静默失败闭环审计 + 修复回归锁（2026-06-22，接续 audit-v2-ui-closure 的 UI-5~UI-8）。
 *
 * 这些 catch 块此前只 console.error / logger.error / 空吞，用户操作失败后无任何反馈。
 * 修复方式：用户主动触发的失败 → surface 到 toast / errorMsg；自动后台失败保持静默。
 *
 *   SF-1 SettingsView onToolbarReset（重置按钮）失败 → toast.error
 *   SF-2 SettingsView refreshCapability（能力探测按钮）失败 → toast.error
 *   SF-3 SettingsView handleDeleteProvider（删除 Provider 确认）失败 → toast.error（已恢复快照）
 *   SF-4 模型管理器手动重同步失败 → toast.error
 *   SF-7 TasksView loadJobs（加载列表）失败 → toast.error（非仅 console.error）
 *   SF-8 TasksView handlePauseResume（暂停/恢复）失败 → toast.error
 *   SF-9 TasksView handleDelete（删除任务）失败 → toast.error
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(__dirname, '..')
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8')

/** 截取某个函数体（从声明到下一个顶层 function 声明之前，精确边界）。 */
function fnBody(src: string, decl: string): string {
  const start = src.indexOf(decl)
  if (start < 0) throw new Error(`未找到函数声明：${decl}`)
  const after = src.slice(start + decl.length)
  const nextRel = after.search(/\n(?:async function|function) /)
  return decl + (nextRel < 0 ? after : after.slice(0, nextRel))
}
function catchOf(fn: string): string {
  return fn.slice(fn.indexOf('} catch'))
}

describe('SF SettingsView — 用户主动操作失败已 surface 到 toast', () => {
  const src = read('views/SettingsView.vue')

  it('SettingsView 引入 useToast', () => {
    expect(src).toMatch(/useToast/)
  })
  it('SF-1 onToolbarReset 失败 → toast.error', () => {
    expect(catchOf(fnBody(src, 'async function onToolbarReset'))).toContain('toast.error')
  })
  it('SF-2 refreshCapability 失败 → toast.error', () => {
    expect(catchOf(fnBody(src, 'async function refreshCapability'))).toContain('toast.error')
  })
  it('SF-3 handleDeleteProvider 失败 → toast.error（保留快照恢复）', () => {
    const fn = fnBody(src, 'async function handleDeleteProvider')
    const c = catchOf(fn)
    expect(c).toContain('toast.error')
    expect(c, '不能丢掉原有快照恢复').toContain('snapshot')
  })
  it('SF-4 模型管理器手动重同步失败 → toast.error', () => {
    expect(src).toContain('ModelManagerModal')
    const fn = fnBody(src, 'async function handleManagerResync')
    expect(fn).toContain('syncRemoteModels')
    expect(fn).toContain('toast.error')
  })
})

describe('SF TasksView — 加载/暂停/删除失败已 surface 到 toast', () => {
  const src = read('views/TasksView.vue')

  it('SF-7 loadJobs 失败 → toast.error', () => {
    expect(catchOf(fnBody(src, 'async function loadJobs'))).toContain('toast.error')
  })
  it('SF-8 handlePauseResume 失败 → toast.error', () => {
    expect(catchOf(fnBody(src, 'async function handlePauseResume'))).toContain('toast.error')
  })
  it('SF-9 confirmDeleteJob 失败 → toast.error', () => {
    expect(catchOf(fnBody(src, 'async function confirmDeleteJob'))).toContain('toast.error')
  })
})
