/**
 * BUG-20260703 P2-7 — 审计证伪 + 可达性锁：会话对话级导出【已存在且可达】。
 *
 * 未覆盖模块面审计曾记「会话导出仅制品级无对话级」——取证推翻：ChatExportMenu
 * （Markdown + JSON，全量消息）由 ChatToolbar 下载按钮挂载，ChatToolbar 由
 * ChatView 挂载，链路完整可达。审计漏判的根因是「功能测试齐、可达链无锁」——
 * 组件测试全绿也可能是孤儿死码（同 AgentRoutingRules）。本锁钉死挂载链：
 * 任何一环断开（按钮删除/组件解挂）即 FAIL，不再靠审计肉眼。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const toolbarSrc = readFileSync(resolve(__dirname, '../ChatToolbar.vue'), 'utf8')
const chatViewSrc = readFileSync(resolve(__dirname, '../../../views/ChatView.vue'), 'utf8')

describe('BUG-20260703 P2-7 — 会话导出可达链', () => {
  it('ChatToolbar 挂载 ChatExportMenu 并喂入全量会话消息', () => {
    expect(toolbarSrc).toContain("import ChatExportMenu from '@/components/chat/ChatExportMenu.vue'")
    expect(toolbarSrc).toMatch(/<ChatExportMenu[\s\S]*?:messages="chatStore\.messages"/)
    // 下载按钮开关菜单（入口按钮存在且接 showExport）
    expect(toolbarSrc).toMatch(/@click="showExport = !showExport"/)
  })

  it('ChatView 挂载 ChatToolbar（导出入口进主聊天页）', () => {
    expect(chatViewSrc).toContain("import ChatToolbar from '@/components/chat/ChatToolbar.vue'")
    expect(chatViewSrc).toContain('<ChatToolbar')
  })
})
