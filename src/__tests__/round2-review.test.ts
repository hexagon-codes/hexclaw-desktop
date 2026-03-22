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

describe('SettingsSecurity — 持久化验证', () => {
  const src = readSrc('components/settings/SettingsSecurity.vue')

  it('不再使用本地 ref 存储安全开关', () => {
    expect(src).not.toMatch(/const conversationEncrypt = ref\(/)
    expect(src).not.toMatch(/const secureStorage = ref\(/)
    expect(src).not.toMatch(/const keyRotation = ref\(/)
  })

  it('所有 toggle 均通过 emit("patch") 持久化', () => {
    expect(src).toContain("emit('patch', { conversation_encrypt:")
    expect(src).toContain("emit('patch', { secure_storage:")
    expect(src).toContain("emit('patch', { key_rotation:")
  })

  it('toggle 组件有 role="switch" 和 aria-checked', () => {
    const switchCount = (src.match(/role="switch"/g) || []).length
    expect(switchCount).toBeGreaterThanOrEqual(5)
    const ariaCount = (src.match(/:aria-checked=/g) || []).length
    expect(ariaCount).toBeGreaterThanOrEqual(5)
  })
})

describe('SettingsNotification — 拆分验证', () => {
  const src = readSrc('components/settings/SettingsNotification.vue')

  it('不再使用本地 dndEnabled ref', () => {
    expect(src).not.toMatch(/const dndEnabled = ref\(/)
  })

  it('cron 和 agent_complete 使用不同字段', () => {
    expect(src).toContain('cron_notify')
    expect(src).toContain('agent_complete')
    const cronToggle = src.includes("emit('patch', { cron_notify:")
    const agentToggle = src.includes("emit('patch', { agent_complete:")
    expect(cronToggle).toBe(true)
    expect(agentToggle).toBe(true)
  })

  it('dnd 通过 emit("patch") 持久化', () => {
    expect(src).toContain("emit('patch', { dnd_enabled:")
  })
})

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
  const chatStoreSrc = readSrc('stores/chat.ts')
  const chatApiSrc = readSrc('api/chat.ts')

  it('sendMessageViaBackend 映射 attachment 使用 data 而非 url', () => {
    expect(chatStoreSrc).toContain('a.data')
    expect(chatStoreSrc).not.toContain('a.url')
  })

  it('sendMessageViaBackend 映射包含 mime 字段', () => {
    expect(chatStoreSrc).toContain('a.mime')
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

describe('IntegrationView — 诊断数据来源', () => {
  const src = readSrc('views/IntegrationView.vue')

  it('使用 logsStore 而非硬编码数据', () => {
    expect(src).toContain('logsStore.entries')
    expect(src).toContain('diagnosticEntries')
    expect(src).not.toContain('MCP refresh')
    expect(src).not.toContain('telegram timeout')
  })

  it('调用 loadHistory 而非不存在的 fetchLogs', () => {
    expect(src).toContain('loadHistory')
    expect(src).not.toContain('fetchLogs')
  })

  it('不包含冗余的动态 import logs store', () => {
    expect(src).not.toContain("import('@/stores/logs')")
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
    expect(src).toContain('restartEngine')
    expect(src).toContain("router.push('/settings')")
  })
})
