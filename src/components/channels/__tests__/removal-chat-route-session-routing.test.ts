/**
 * 防漂移回归锁 —「会话路由 · chat_id → 实例 / 绑定会话」功能【已彻底移除，禁止复活】。
 *
 * ⚠️ 此功能经产品评审（方案 A）**故意移除**：连接卡的智能体绑定只保留「频道级默认接待
 * 智能体 + 派生模型（只读）」这一主控件；per-chat（chat_id 私聊/群）会话路由绑定 UI 及其
 * 全部逻辑（chat_id 输入框、per-chat 绑定/解绑按钮、addChatRoute/removeChatRoute 等）一律删除。
 *
 * 本测试是**防 AI 漂移复活的回归锁**：历史上此功能被「删不彻底 → AI 把残留当未完成又改回来」
 * 坑过。任何「重新加回会话路由 / per-chat 绑定」的改动都会让本测试**立即变红**。
 *
 * 若产品未来真要恢复该能力，必须先删除本测试并留下书面评审结论 —— 不得绕过。
 *
 * 保留（不在移除范围、勿误删）：频道级默认智能体下拉 + 编辑 + 模型只读徽标 + 来源，以及
 * 频道卡的 test-route / 测试 / 编辑 / 停用 / 删除 按钮；后端 router 平台级/频道默认路由。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as agentsApi from '@/api/agents'

const SRC = readFileSync(resolve(__dirname, '../ChannelAgentBinding.vue'), 'utf8')

describe('回归锁 · 会话路由 chat_id→实例 已移除（禁止复活）', () => {
  // 穷举被删功能的标志串（模板 data-testid / i18n key / 方法名 / ref / CSS 类 / 提示文案）。
  const BANNED_MARKERS: Array<[string, string]> = [
    // 模板锚点（原 per-chat 绑定 UI 的 data-testid）
    ['data-testid="chat-route-add-open"', 'per-chat「+ 绑定会话」开关'],
    ['data-testid="chat-route-row"', 'per-chat 会话路由行'],
    ['data-testid="chat-route-unbind"', 'per-chat 解绑按钮'],
    ['data-testid="chat-route-chatid"', 'chat_id 输入框'],
    ['data-testid="chat-route-agent"', 'per-chat agent 选择器'],
    ['data-testid="chat-route-add"', 'per-chat「绑定」按钮'],
    // 脚本符号（state / 方法）
    ['chatRoutes', 'chatRoutes computed'],
    ['chatRouteAddOpen', 'chatRouteAddOpen ref'],
    ['chatRouteChatId', 'chatRouteChatId ref'],
    ['chatRouteAgent', 'chatRouteAgent ref / options'],
    ['chatRouteAgentLabel', 'chatRouteAgentLabel'],
    ['addChatRoute', 'addChatRoute 方法'],
    ['removeChatRoute', 'removeChatRoute 方法'],
    // i18n key 前缀
    ['chatRoute', 'imChannels.chatRoute.* i18n key'],
    // CSS 类
    ['hc-cab__routes', '会话路由块 CSS'],
    ['hc-cab__route-', 'per-chat 路由行 CSS'],
    // 文案 / 组件（该 UI 唯一用到 HcSelect 的地方）
    ['会话路由', '「会话路由」标题文案'],
    ['绑定会话', '「+ 绑定会话」文案'],
    // 注：`chat_id` 字段名被「频道级默认绑定」正常复用（过滤 !chat_id / 写 chat_id:''），
    // 不能整串禁；per-chat 的 chat_id 输入框由 data-testid="chat-route-chatid" 与
    // chatRouteChatId ref 精确锁定（见上）。
    ['chatIdPlaceholder', 'chat_id 输入框 i18n 占位符'],
    ['HcSelect', 'per-chat agent 选择用的 HcSelect（该组件已无其它用途）'],
  ]

  it.each(BANNED_MARKERS)(
    'ChannelAgentBinding.vue 源码不得含被删标识串: %s',
    (marker) => {
      expect(SRC, `会话路由功能已移除（方案 A），禁止复活：残留标识 [${marker}]`).not.toContain(marker)
    },
  )

  it('注释掉也不算删 —— 源码不得留任何「chatRoute」注释残骸（AI 会当 TODO 改回）', () => {
    // 逐行检查，连注释行都不允许出现 per-chat 路由的旧标识，避免被当作「未完成」复活。
    const offending = SRC.split('\n').filter((l) => /chatRoute|会话路由|绑定会话/.test(l))
    expect(offending, `残留行:\n${offending.join('\n')}`).toEqual([])
  })

  it('agents API 不得新增 per-chat 会话路由专用方法（bindSessionRoute / addChatRoute 等）', () => {
    // addRule/deleteRule 是频道级默认绑定共用的通用规则 API（保留）；但不得出现 per-chat 专用封装。
    const banned = ['bindSessionRoute', 'addChatRoute', 'removeChatRoute', 'routeChatRules', 'bindChatRoute']
    for (const name of banned) {
      expect(agentsApi, `api/agents 不得导出 per-chat 会话路由专用方法: ${name}`).not.toHaveProperty(name)
    }
  })

  it('保留主功能锚点：频道级默认接待智能体下拉 + 派生模型只读徽标仍在（未误伤）', () => {
    expect(SRC).toContain('hc-agent-combo__trigger') // 频道级默认智能体下拉
    expect(SRC).toContain('hc-cab__effmodel-badge') // 派生模型只读徽标
    expect(SRC).toContain("t('imChannels.bindAgentLabel'") // 「智能体」标签
  })
})
