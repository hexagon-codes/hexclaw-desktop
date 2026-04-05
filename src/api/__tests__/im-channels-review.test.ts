/**
 * im-channels.ts Code Review — 验证动态导入 Tauri API（修复后）
 */
import { describe, it, expect } from 'vitest'

describe('im-channels.ts — 动态导入 Tauri API（修复后）', () => {
  it('im-channels.ts 不再使用静态 import Tauri API', async () => {
    const sourceCode = await import('../im-channels?raw')
    const raw = typeof sourceCode === 'string' ? sourceCode : sourceCode.default

    expect(raw).not.toContain("import { invoke } from '@tauri-apps/api/core'")
    expect(raw).not.toContain("import { load } from '@tauri-apps/plugin-store'")
  })

  it('im-channels.ts 使用动态导入方式（与代码库惯例一致）', async () => {
    const sourceCode = await import('../im-channels?raw')
    const raw = typeof sourceCode === 'string' ? sourceCode : sourceCode.default

    expect(raw).toContain("await import('@tauri-apps/plugin-store')")
    expect(raw).toContain("await import('@tauri-apps/api/core')")
  })

  it('im-channels.ts 不再内嵌平台元数据与文案配置', async () => {
    const sourceCode = await import('../im-channels?raw')
    const raw = typeof sourceCode === 'string' ? sourceCode : sourceCode.default

    expect(raw).toContain("from '@/config/im-channels'")
    expect(raw).not.toContain('export const CHANNEL_CONFIG_FIELDS')
    expect(raw).not.toContain('export const CHANNEL_TYPES')
    expect(raw).not.toContain('export const CHANNEL_HELP_TEXT')
  })

  it('im-channels.ts 不再内嵌重复名称错误文案', async () => {
    const sourceCode = await import('../im-channels?raw')
    const raw = typeof sourceCode === 'string' ? sourceCode : sourceCode.default

    expect(raw).toContain("from '@/config/im-channel-errors'")
    expect(raw).not.toContain('实例名称重复：')
  })
})
