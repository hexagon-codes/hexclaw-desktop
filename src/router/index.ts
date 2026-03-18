import { createRouter, createWebHistory } from 'vue-router'
import { useSettingsStore } from '@/stores/settings'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      redirect: '/dashboard',
    },
    {
      path: '/dashboard',
      name: 'dashboard',
      component: () => import('@/views/DashboardView.vue'),
    },
    {
      path: '/welcome',
      name: 'welcome',
      component: () => import('@/views/WelcomeView.vue'),
      meta: { layout: 'blank' },
    },
    {
      path: '/chat',
      name: 'chat',
      component: () => import('@/views/ChatView.vue'),
    },
    {
      path: '/agents',
      name: 'agents',
      component: () => import('@/views/AgentsView.vue'),
    },
    {
      path: '/tasks',
      name: 'tasks',
      component: () => import('@/views/TasksView.vue'),
    },
    {
      path: '/skills',
      name: 'skills',
      component: () => import('@/views/SkillsView.vue'),
    },
    {
      path: '/logs',
      name: 'logs',
      component: () => import('@/views/LogsView.vue'),
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue'),
    },
    {
      path: '/knowledge',
      name: 'knowledge',
      component: () => import('@/views/KnowledgeView.vue'),
    },
    {
      path: '/memory',
      name: 'memory',
      component: () => import('@/views/MemoryView.vue'),
    },
    {
      path: '/mcp',
      name: 'mcp',
      component: () => import('@/views/McpView.vue'),
    },
    {
      path: '/im-channels',
      name: 'im-channels',
      component: () => import('@/views/IMChannelsView.vue'),
    },
    {
      path: '/canvas',
      name: 'canvas',
      component: () => import('@/views/CanvasView.vue'),
    },
    {
      path: '/team',
      name: 'team',
      component: () => import('@/views/TeamView.vue'),
    },
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
let welcomeRedirectDone = false

router.beforeEach(async (to) => {
  // blank-layout 页面 & settings 页面直接放行，无需 config
  if (to.meta?.layout === 'blank' || to.path === '/settings') {
    return true
  }

  const settingsStore = useSettingsStore()

  // 确保 config 已加载（并发安全：内部有 loadConfigPromise 锁）
  if (!settingsStore.config) {
    await settingsStore.loadConfig()
  }

  // 首次启动检测：无 provider 时引导至 welcome
  if (!welcomeRedirectDone) {
    welcomeRedirectDone = true
    const hasProvider = (settingsStore.config?.llm.providers?.length ?? 0) > 0
    if (!hasProvider) {
      return '/welcome'
    }
  }

  return true
})

export default router
