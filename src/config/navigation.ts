import type { Component } from 'vue'
import {
  LayoutDashboard,
  MessageSquare,
  Radio,
  Bot,
  BookOpen,
  Zap,
  Blocks,
  ScrollText,
  Settings,
} from 'lucide-vue-next'

export interface NavItem {
  id: string
  path: string
  i18nKey: string        // nav.xxx key for i18n
  icon: Component
  keywords?: string      // search keywords for command palette
  group: NavGroup
  children?: NavChild[]  // sub-tabs within the merged page
}

export interface NavChild {
  id: string
  path: string           // full route path (for redirect)
  i18nKey: string
}

export type NavGroup = 'core' | 'integration' | 'system'

export const NAV_GROUP_LABELS: Record<NavGroup, { zh: string; en: string }> = {
  core: { zh: '核心工作区', en: 'Workspace' },
  integration: { zh: '集成与运维', en: 'Integration' },
  system: { zh: '系统', en: 'System' },
}

/**
 * 导航注册表 — 唯一数据源
 *
 * Sidebar、CommandPalette、路由都从这里派生。
 * 设计原则：
 *   - 一级导航 8 项（方案要求 6-8）
 *   - 三层分组：核心工作区 / 集成与运维 / 系统
 *   - 合并后的页面用 children 定义页内 Tab
 */
export const navigationItems: NavItem[] = [
  // ─── 核心工作区 ───
  {
    id: 'dashboard',
    path: '/dashboard',
    i18nKey: 'nav.dashboard',
    icon: LayoutDashboard,
    keywords: 'dashboard 概览 首页 overview',
    group: 'core',
  },
  {
    id: 'chat',
    path: '/chat',
    i18nKey: 'nav.chat',
    icon: MessageSquare,
    keywords: 'chat 聊天 对话 conversation',
    group: 'core',
  },
  {
    id: 'channels',
    path: '/channels',
    i18nKey: 'nav.channels',
    icon: Radio,
    keywords: 'channels 通道 IM 飞书 钉钉 discord telegram feishu dingtalk',
    group: 'core',
  },
  {
    id: 'agents',
    path: '/agents',
    i18nKey: 'nav.agents',
    icon: Bot,
    keywords: 'agents 智能体 角色 role agent',
    group: 'core',
  },
  {
    id: 'knowledge',
    path: '/knowledge',
    i18nKey: 'nav.knowledge',
    icon: BookOpen,
    keywords: 'knowledge 知识库 文档 记忆 memory',
    group: 'core',
    children: [
      { id: 'knowledge-docs', path: '/knowledge', i18nKey: 'nav.knowledgeDocs' },
      { id: 'knowledge-memory', path: '/knowledge/memory', i18nKey: 'nav.knowledgeMemory' },
    ],
  },
  {
    id: 'automation',
    path: '/automation',
    i18nKey: 'nav.automation',
    icon: Zap,
    keywords: 'automation 自动化 任务 定时 cron 工作流 canvas 画布 workflow',
    group: 'core',
    children: [
      { id: 'automation-tasks', path: '/automation', i18nKey: 'nav.automationTasks' },
      { id: 'automation-canvas', path: '/automation/canvas', i18nKey: 'nav.automationCanvas' },
    ],
  },

  // ─── 集成与运维 ───
  {
    id: 'integration',
    path: '/integration',
    i18nKey: 'nav.integration',
    icon: Blocks,
    keywords: 'integration 集成 skill 技能 mcp 工具 im 通道 channel',
    group: 'integration',
    children: [
      { id: 'integration-skills', path: '/integration', i18nKey: 'nav.integrationSkills' },
      { id: 'integration-mcp', path: '/integration/mcp', i18nKey: 'nav.integrationMcp' },
      { id: 'integration-diagnostics', path: '/integration/diagnostics', i18nKey: 'nav.integrationDiagnostics' },
    ],
  },
  {
    id: 'logs',
    path: '/logs',
    i18nKey: 'nav.logs',
    icon: ScrollText,
    keywords: 'logs 日志 诊断 diagnosis',
    group: 'integration',
  },

  // ─── 系统 ───
  {
    id: 'settings',
    path: '/settings',
    i18nKey: 'nav.settings',
    icon: Settings,
    keywords: 'settings 设置 偏好 preference config',
    group: 'system',
  },
]

/**
 * 获取分组后的导航项
 */
export function getGroupedNavItems(): Record<NavGroup, NavItem[]> {
  const groups: Record<NavGroup, NavItem[]> = { core: [], integration: [], system: [] }
  for (const item of navigationItems) {
    groups[item.group].push(item)
  }
  return groups
}

/**
 * 按 id 获取导航项
 */
export function getNavigationItem(id: string): NavItem | undefined {
  return navigationItems.find((item) => item.id === id)
}

/**
 * 获取某个导航项的子页签定义
 */
export function getNavigationChildren(id: string): NavChild[] {
  return getNavigationItem(id)?.children ?? []
}

/**
 * 判断路由是否匹配某个导航项（支持子路由）
 */
export function isNavActive(itemPath: string, currentPath: string): boolean {
  if (itemPath === '/dashboard') return currentPath === '/dashboard'
  return currentPath === itemPath || currentPath.startsWith(itemPath + '/')
}
