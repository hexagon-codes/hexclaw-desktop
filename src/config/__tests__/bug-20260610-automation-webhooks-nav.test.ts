/**
 * BUG-20260610 回归测试：navigation.ts 的 automation children 漏注册 webhooks tab
 *
 * 症状：
 * - AutomationView 的 segments 从 getNavigationChildren('automation') 派生，
 *   漏注册导致 Webhooks tab 在分段控件中根本不渲染（功能不可达）；
 * - router.buildNavigationRoutes 只为 children 建路由，/automation/webhooks
 *   无路由命中 /:pathMatch(.*)* 兜底，被重定向回 /dashboard。
 *
 * 本文件为永久回归锁定，不可删除。
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('lucide-vue-next', () => ({
  LayoutDashboard: 'LayoutDashboard',
  MessageSquare: 'MessageSquare',
  Radio: 'Radio',
  Plug: 'Plug',
  Bot: 'Bot',
  BookOpen: 'BookOpen',
  Zap: 'Zap',
  Blocks: 'Blocks',
  ScrollText: 'ScrollText',
  Settings: 'Settings',
}))

import { getNavigationChildren } from '../navigation'

describe('BUG-20260610: automation 导航 children 必须注册 webhooks tab', () => {
  it('automation children 包含 automation-webhooks，路径为 /automation/webhooks', () => {
    const children = getNavigationChildren('automation')
    const webhooks = children.find((c) => c.id === 'automation-webhooks')
    expect(webhooks, 'webhooks tab 未在 navigation children 注册 — UI 不渲染该 tab 且路由 404').toBeDefined()
    expect(webhooks!.path).toBe('/automation/webhooks')
    expect(webhooks!.i18nKey).toBeTruthy()
  })
})
