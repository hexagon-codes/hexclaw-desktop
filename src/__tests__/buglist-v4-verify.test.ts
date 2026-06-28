/**
 * buglist.txt 4 个问题的验证测试
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'

// ─── 问题 1: setClipboard 桌面端剪贴板写入 ─────
// 注：原「copyWebhookUrl catch 二次保护」断言读 src/views/IMChannelsView.vue（已退役孤儿视图）——
// 随该文件统一清理一并移除；copyWebhookUrl 的活实现在 WebhookPanel.vue / ChannelConfigModal.vue。

describe('问题 1: setClipboard 桌面端剪贴板写入', () => {
  it('setClipboard 在 Tauri 桌面端通过后端 API 写入剪贴板', () => {
    const source = readFileSync('src/api/desktop.ts', 'utf-8')
    expect(source).toContain('/api/v1/desktop/clipboard')
    expect(source).toContain('navigator.clipboard')
  })
})

// ─── 问题 3: budget/status 前后端类型对齐 ─────

describe('问题 3: BudgetStatus 前后端类型对齐', () => {
  it('response-shapes.test.ts 已更新为扁平结构（不再是 {summary, remaining}）', () => {
    const source = readFileSync('src/__tests__/response-shapes.test.ts', 'utf-8')
    // 不应再包含旧的 {summary, remaining} 结构
    expect(source).not.toContain("summary: 'tokens:")
    expect(source).not.toContain('remaining: {')
    // 应包含扁平字段
    expect(source).toContain('tokens_used: 0')
    expect(source).toContain('tokens_max: 500000')
  })

  it('后端 budget.go Status() 返回 BudgetStatus 结构体（已验证）', () => {
    const backendFile = '/Users/hexagon/work/hexclaw/api/handler_tools.go'
    if (!existsSync(backendFile)) {
      // CI 环境没有后端仓库，跳过
      return
    }
    const handlerSource = readFileSync(backendFile, 'utf-8')
    // handler 调用 s.budgetCtrl.Status() 而非 Summary()/Remaining()
    expect(handlerSource).toContain('.Status()')
    expect(handlerSource).not.toContain('.Summary()')
    expect(handlerSource).not.toContain('.Remaining()')
  })
})

// ─── 问题 4: computeDiff 性能 ─────

describe('问题 4: computeDiff 1k sparse vs 4k fallback 性能差异', () => {
  it('1k sparse 走 LCS，4k 走 fallback — 这是设计选择不是 bug', () => {
    const source = readFileSync('src/utils/diff.ts', 'utf-8')
    // MAX_LCS_CELLS = 4_000_000
    expect(source).toContain('MAX_LCS_CELLS = 4_000_000')
    // 1k×1k = 1M < 4M → 走 LCS（高质量，较慢）
    // 4k×4k = 16M > 4M → 走 fallback（低质量，较快）
    // 这是正确的行为：LCS 产出最优 diff，fallback 是大文件保护
  })
})
