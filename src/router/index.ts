import { createRouter, createWebHistory } from 'vue-router'
import { useSettingsStore } from '@/stores/settings'
import { logger } from '@/utils/logger'
import { navigationItems } from '@/config/navigation'

const navRouteComponents = {
  dashboard: () => import('@/views/DashboardView.vue'),
  chat: () => import('@/views/ChatView.vue'),
  channels: () => import('@/views/ChannelsView.vue'),
  agents: () => import('@/views/AgentsView.vue'),
  knowledge: () => import('@/views/KnowledgeCenterView.vue'),
  automation: () => import('@/views/AutomationView.vue'),
  integration: () => import('@/views/IntegrationView.vue'),
  logs: () => import('@/views/LogsView.vue'),
  settings: () => import('@/views/SettingsView.vue'),
} as const

function buildNavigationRoutes() {
  return navigationItems.flatMap((item) => {
    const component = navRouteComponents[item.id as keyof typeof navRouteComponents]
    if (!component) return []

    const routes = [{
      path: item.path,
      name: item.id,
      component,
    }]

    if (item.children) {
      for (const child of item.children) {
        if (child.path === item.path) continue
        routes.push({
          path: child.path,
          name: child.id,
          component,
        })
      }
    }

    return routes
  })
}

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      redirect: '/dashboard',
    },
    {
      path: '/welcome',
      name: 'welcome',
      component: () => import('@/views/WelcomeView.vue'),
      meta: { layout: 'blank' },
    },
    ...buildNavigationRoutes(),
    // 旧路由重定向（兼容书签/收藏）
    { path: '/memory', redirect: '/knowledge/memory' },
    { path: '/tasks', redirect: '/automation' },
    { path: '/canvas', redirect: '/automation/canvas' },
    { path: '/skills', redirect: '/integration' },
    { path: '/mcp', redirect: '/integration/mcp' },
    { path: '/im-channels', redirect: '/channels' },
    { path: '/integration/im', redirect: '/channels' },
    {
      path: '/team',
      name: 'team',
      component: () => import('@/views/TeamView.vue'),
    },
    // 独立窗口页面
    {
      path: '/quick-chat',
      name: 'quick-chat',
      component: () => import('@/views/QuickChatView.vue'),
      meta: { layout: 'blank' },
    },
    {
      path: '/about',
      name: 'about',
      component: () => import('@/views/AboutView.vue'),
      meta: { layout: 'blank' },
    },
    { path: '/:pathMatch(.*)*', redirect: '/dashboard' },
  ],
})

/**
 * 全局导航守卫：确保进入任何"真实页面"前 config 已加载完毕。
 *
 * 设计原则：
 * - blank-layout 页面（welcome / quick-chat / about）不依赖 config，直接放行
 * - settings 页面始终可访问（用户可能就是为了修 config 而来）
 * - 其余所有页面：等待 config 加载完毕，首次检测若无 provider 则引导至 welcome
 * - welcomeRedirectDone 仅控制"是否还需要做首次引导检测"，与导航放行无关
 */
const WELCOME_DONE_KEY = 'hexclaw:welcomeRedirectDone'

function isWelcomeDone(): boolean {
  try {
    return sessionStorage.getItem(WELCOME_DONE_KEY) === '1'
  } catch {
    return false
  }
}

function markWelcomeDone(): void {
  try {
    sessionStorage.setItem(WELCOME_DONE_KEY, '1')
  } catch {
    // sessionStorage unavailable (SSR)
  }
}

router.beforeEach(async (to, from) => {
  if (to.meta?.layout === 'blank' || to.path === '/settings') {
    return true
  }

  try {
    const settingsStore = useSettingsStore()

    if (!settingsStore.config) {
      await settingsStore.loadConfig()
    }

    if (!isWelcomeDone()) {
      const hasProvider = (settingsStore.config?.llm.providers?.length ?? 0) > 0
      if (!hasProvider) {
        return '/welcome'
      }
      markWelcomeDone()
    }
  } catch (e) {
    logger.error('导航守卫异常，放行以避免页面卡死:', e)
  }

  return true
})

router.onError((error, to, from) => {
  logger.error(`导航错误 ${from.path} → ${to.path}:`, error)
})

export default router
