/**
 * Round 2 Code Review — 针对上一轮修复引入的代码进行测试
 *
 * 验证：
 * 1. SettingsSecurity 持久化逻辑
 * 2. SettingsNotification 拆分字段逻辑
 * 3. useShortcuts 动态映射正确性
 * 4. ChatAttachment 数据完整性
 * 5. InspectorContext 主题检测
 * 6. CommandPalette 主题 key 一致性
 * 7. SegmentedControl ARIA 合规
 * 8. IntegrationView 诊断数据来源
 * 9. sendChatViaBackend attachments 参数
 * 10. env.d.ts $message 类型声明
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function readSrc(relPath: string): string {
  return readFileSync(resolve(__dirname, '..', relPath), 'utf-8')
}

// SettingsSecurity / SettingsNotification 组件已于 2026-06-22 作为孤儿死代码删除
// （emit('patch') 但无父组件挂载，10 个 toggle UI 不可达）；对应扫描测试随之移除。
// 回归锁见 audit-v2-ui-closure-20260622.test.ts（UI-1/2）。

describe('useShortcuts — 动态映射', () => {
  const src = readSrc('composables/useShortcuts.ts')

  it('从 navigationItems 动态生成快捷键映射', () => {
    expect(src).toContain('navigationItems')
    expect(src).toContain('numKeyRoutes')
    expect(src).not.toContain("case '1':")
  })

  it('⌘N 仍然新建对话', () => {
    expect(src).toContain("case 'n':")
    expect(src).toContain('newSession')
  })

  it('⌘, 仍然打开设置', () => {
    expect(src).toContain("case ',':")
    expect(src).toContain("router.push('/settings')")
  })
})

describe('ChatAttachment 数据完整性', () => {
  // 附件映射逻辑已迁移到 services/chatService.ts
  const chatServiceSrc = readSrc('services/chatService.ts')
  const chatApiSrc = readSrc('api/chat.ts')

  it('sendMessageViaBackend 映射 attachment 使用 data 而非 url', () => {
    expect(chatServiceSrc).toContain('a.data')
  })

  it('sendMessageViaBackend 映射包含 mime 字段', () => {
    expect(chatServiceSrc).toContain('a.mime')
  })

  it('sendChatViaBackend 签名接受 attachments 参数', () => {
    expect(chatApiSrc).toContain('attachments?:')
    expect(chatApiSrc).toContain('attachments: options?.attachments || null')
  })
})

describe('InspectorContext — 主题检测', () => {
  const src = readSrc('components/inspector/InspectorContext.vue')

  it("使用 getAttribute('data-theme') 而非 classList.contains", () => {
    expect(src).toContain("getAttribute('data-theme')")
    expect(src).not.toContain("classList.contains('dark')")
  })
})

describe('CommandPalette — 主题 key 一致性', () => {
  const paletteSrc = readSrc('components/common/CommandPalette.vue')
  const themeSrc = readSrc('composables/useTheme.ts')

  it("CommandPalette 和 useTheme 使用相同的 localStorage key 'hc-theme'", () => {
    expect(paletteSrc).toContain("'hc-theme'")
    expect(paletteSrc).not.toContain("'hexclaw-theme'")
    expect(themeSrc).toContain("'hc-theme'")
  })
})

describe('SegmentedControl — ARIA', () => {
  const src = readSrc('components/common/SegmentedControl.vue')

  it('容器有 role="tablist"', () => {
    expect(src).toContain('role="tablist"')
  })

  it('按钮有 role="tab" 和 :aria-selected', () => {
    expect(src).toContain('role="tab"')
    expect(src).toContain(':aria-selected=')
  })
})

describe('logsStore — loadHistory 已导出', () => {
  const src = readSrc('stores/logs.ts')

  it('return 对象包含 loadHistory', () => {
    expect(src).toContain('loadHistory,')
  })
})

describe('env.d.ts — $message 类型声明', () => {
  const src = readFileSync(resolve(__dirname, '../../env.d.ts'), 'utf-8')

  it('声明了 window.$message 接口', () => {
    expect(src).toContain('$message')
    expect(src).toContain('success')
    expect(src).toContain('error')
  })
})

describe('types/settings — 新增字段', () => {
  const src = readSrc('types/settings.ts')

  it('SecurityConfig 包含 conversation_encrypt/secure_storage/key_rotation', () => {
    expect(src).toContain('conversation_encrypt')
    expect(src).toContain('secure_storage')
    expect(src).toContain('key_rotation')
  })

  it('NotificationConfig 包含 cron_notify/dnd_enabled', () => {
    expect(src).toContain('cron_notify')
    expect(src).toContain('dnd_enabled')
  })

  it('MCPConfig 包含 auto_reconnect', () => {
    expect(src).toContain('auto_reconnect')
  })
})

describe('Sidebar — 动态地址和工作区切换', () => {
  const src = readSrc('components/layout/Sidebar.vue')

  it('使用 env.apiBase 而非硬编码 IP', () => {
    expect(src).toContain('env.apiBase')
    expect(src).not.toContain('127.0.0.1:16060')
  })

  it('侧边栏包含引擎与会话相关的点击处理', () => {
    // 重启引擎按钮 + 点击引擎名打开「关于」窗口（openAbout）
    expect(src).toContain('restartEngine')
    expect(src).toContain('openAbout')
  })
})
