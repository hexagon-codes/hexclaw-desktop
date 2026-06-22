/**
 * useAboutWindow —— 所有版本号入口共用的「打开关于窗口」组合式。
 * Tauri 下调 open_about 命令；非 Tauri / 命令缺失回退应用内 /about 路由。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
const push = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))

import { useAboutWindow } from '../useAboutWindow'

describe('useAboutWindow', () => {
  beforeEach(() => {
    invoke.mockReset()
    push.mockReset()
  })

  it('Tauri 环境：调用 open_about 命令，不回退路由', async () => {
    invoke.mockResolvedValue(undefined)
    const openAbout = useAboutWindow()
    await openAbout()
    expect(invoke).toHaveBeenCalledWith('open_about')
    expect(push).not.toHaveBeenCalled()
  })

  it('命令不可用（非 Tauri / 拒绝）：回退到 /about 路由', async () => {
    invoke.mockRejectedValue(new Error('not in tauri'))
    const openAbout = useAboutWindow()
    await openAbout()
    expect(invoke).toHaveBeenCalledWith('open_about')
    expect(push).toHaveBeenCalledWith('/about')
  })
})
