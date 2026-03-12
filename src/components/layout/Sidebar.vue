<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  MessageSquare,
  Bot,
  Clock,
  Puzzle,
  BookOpen,
  Brain,
  Server,
  ScrollText,
  Layout,
  Settings,
  PanelLeftClose,
  PanelLeft,
} from 'lucide-vue-next'
import { useAppStore } from '@/stores/app'

const { t } = useI18n()
const route = useRoute()
const appStore = useAppStore()

const navItems = computed(() => [
  { path: '/chat', label: t('nav.chat'), icon: MessageSquare },
  { path: '/agents', label: t('nav.agents'), icon: Bot },
  { path: '/tasks', label: t('nav.tasks'), icon: Clock },
  { path: '/skills', label: t('nav.skills'), icon: Puzzle },
  { path: '/knowledge', label: t('nav.knowledge'), icon: BookOpen },
  { path: '/memory', label: t('nav.memory'), icon: Brain },
  { path: '/mcp', label: t('nav.mcp'), icon: Server },
  { path: '/logs', label: t('nav.logs'), icon: ScrollText },
  { path: '/canvas', label: t('nav.canvas'), icon: Layout },
])

const bottomItems = computed(() => [
  { path: '/settings', label: t('nav.settings'), icon: Settings },
])

function isActive(path: string): boolean {
  return route.path === path
}
</script>

<template>
  <div
    class="flex flex-col h-full transition-all duration-200"
    :class="appStore.sidebarCollapsed ? 'w-[56px]' : 'w-[220px]'"
    :style="{ background: 'var(--hc-bg-sidebar)', borderRight: '1px solid var(--hc-border)' }"
  >
    <!-- 导航列表 -->
    <nav class="flex-1 py-2 px-2 space-y-0.5 overflow-y-auto">
      <router-link
        v-for="item in navItems"
        :key="item.path"
        :to="item.path"
        class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors"
        :style="{
          background: isActive(item.path) ? 'var(--hc-bg-hover)' : 'transparent',
          color: isActive(item.path) ? 'var(--hc-text-primary)' : 'var(--hc-text-secondary)',
        }"
      >
        <component :is="item.icon" :size="18" class="flex-shrink-0" />
        <span v-if="!appStore.sidebarCollapsed" class="truncate">{{ item.label }}</span>
      </router-link>
    </nav>

    <!-- 底部 -->
    <div class="py-2 px-2 space-y-0.5 border-t" :style="{ borderColor: 'var(--hc-border)' }">
      <!-- 连接状态 -->
      <div
        v-if="!appStore.sidebarCollapsed"
        class="flex items-center gap-2 px-3 py-1.5 text-xs"
        :style="{ color: 'var(--hc-text-muted)' }"
      >
        <span
          class="w-2 h-2 rounded-full"
          :style="{ background: appStore.sidecarReady ? 'var(--hc-success)' : 'var(--hc-error)' }"
        />
        {{ appStore.sidecarReady ? t('nav.connected') : t('nav.disconnected') }}
      </div>

      <router-link
        v-for="item in bottomItems"
        :key="item.path"
        :to="item.path"
        class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors"
        :style="{
          background: isActive(item.path) ? 'var(--hc-bg-hover)' : 'transparent',
          color: isActive(item.path) ? 'var(--hc-text-primary)' : 'var(--hc-text-secondary)',
        }"
      >
        <component :is="item.icon" :size="18" class="flex-shrink-0" />
        <span v-if="!appStore.sidebarCollapsed" class="truncate">{{ item.label }}</span>
      </router-link>

      <!-- 折叠按钮 -->
      <button
        class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors w-full"
        :style="{ color: 'var(--hc-text-muted)' }"
        @click="appStore.toggleSidebar"
      >
        <PanelLeftClose v-if="!appStore.sidebarCollapsed" :size="18" class="flex-shrink-0" />
        <PanelLeft v-else :size="18" class="flex-shrink-0" />
        <span v-if="!appStore.sidebarCollapsed" class="truncate">{{ t('nav.collapse') }}</span>
      </button>
    </div>
  </div>
</template>
