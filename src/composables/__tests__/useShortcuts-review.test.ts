/**
 * useShortcuts vs Sidebar — 快捷键冲突验证（修复后）
 */
import { describe, it, expect } from 'vitest'

describe('快捷键冲突修复验证', () => {
  it('useShortcuts 使用 navigationItems 动态映射数字快捷键', async () => {
    const sourceCode = await import('../useShortcuts?raw')
    const raw = typeof sourceCode === 'string' ? sourceCode : sourceCode.default

    expect(raw).toContain("import { navigationItems } from '@/config/navigation'")
    expect(raw).toContain('numKeyRoutes')
    expect(raw).toContain('navigationItems.forEach')
    expect(raw).toContain('numKeyRoutes[e.key]')
    expect(raw).not.toContain("case '1':")
    expect(raw).not.toContain("case '2':")
    expect(raw).not.toContain("case '3':")
  })

  it('Sidebar 不再注册快捷键（冗余代码已删除）', async () => {
    const sourceCode = await import('../../components/layout/Sidebar.vue?raw')
    const raw = typeof sourceCode === 'string' ? sourceCode : sourceCode.default

    expect(raw).not.toContain("'3': '/automation'")
    expect(raw).not.toContain('handleKeydown')
    expect(raw).not.toContain('document.addEventListener')
  })
})
