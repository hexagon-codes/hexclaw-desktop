<!-- eslint-disable vue/multi-word-component-names -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  LayoutDashboard,
  MessageSquare,
  Bot,
  Clock,
  Puzzle,
  BookOpen,
  Brain,
  Server,
  Radio,
  ScrollText,
  Layout,

  Settings,
} from 'lucide-vue-next'
import { useAppStore } from '@/stores/app'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const collapsed = computed(() => appStore.sidebarCollapsed)

function handleKeydown(e: KeyboardEvent) {
  if (!e.metaKey && !e.ctrlKey) return
  const key = e.key
  const shortcuts: Record<string, string> = {
    '1': '/chat',
    '2': '/agents',
    '3': '/tasks',
  }
  if (shortcuts[key]) {
    e.preventDefault()
    router.push(shortcuts[key])
  }
}

onMounted(() => document.addEventListener('keydown', handleKeydown))
onUnmounted(() => document.removeEventListener('keydown', handleKeydown))

const navItems = computed(() => [
  { path: '/dashboard', label: t('nav.dashboard'), icon: LayoutDashboard },
  { path: '/chat', label: t('nav.chat'), icon: MessageSquare },
  { path: '/agents', label: t('nav.agents'), icon: Bot },
  { path: '/tasks', label: t('nav.tasks'), icon: Clock },
  { path: '/skills', label: t('nav.skills'), icon: Puzzle },
  { path: '/knowledge', label: t('nav.knowledge'), icon: BookOpen },
  { path: '/memory', label: t('nav.memory'), icon: Brain },
  { path: '/mcp', label: t('nav.mcp'), icon: Server },
  { path: '/im-channels', label: t('nav.imChannels'), icon: Radio },
  { path: '/logs', label: t('nav.logs'), icon: ScrollText },
  { path: '/canvas', label: t('nav.canvas'), icon: Layout },

])

function isActive(path: string): boolean {
  return route.path === path
}
</script>

<template>
  <aside
    class="hc-sidebar hc-vibrancy"
    :class="{ 'hc-sidebar--collapsed': collapsed }"
  >
    <!-- Navigation -->
    <nav class="hc-sidebar__nav" role="navigation">
      <router-link
        v-for="item in navItems"
        :key="item.path"
        :to="item.path"
        :aria-label="item.label"
        class="hc-sidebar__item"
        :class="{ 'hc-sidebar__item--active': isActive(item.path) }"
      >
        <component :is="item.icon" :size="17" class="hc-sidebar__icon" />
        <span v-if="!collapsed" class="hc-sidebar__label">{{ item.label }}</span>
      </router-link>
    </nav>

    <!-- Bottom: status + settings -->
    <div class="hc-sidebar__bottom">
      <div v-if="!collapsed" class="hc-sidebar__status">
        <span
          class="hc-sidebar__dot"
          :class="appStore.sidecarReady ? 'hc-sidebar__dot--ok' : 'hc-sidebar__dot--err'"
        />
        <span class="hc-sidebar__status-text">
          {{ appStore.sidecarReady ? t('nav.connected') : t('nav.disconnected') }}
        </span>
      </div>

      <router-link
        to="/settings"
        :aria-label="t('nav.settings')"
        class="hc-sidebar__item"
        :class="{ 'hc-sidebar__item--active': isActive('/settings') }"
      >
        <Settings :size="17" class="hc-sidebar__icon" />
        <span v-if="!collapsed" class="hc-sidebar__label">{{ t('nav.settings') }}</span>
      </router-link>
    </div>
  </aside>
</template>

<style scoped>
.hc-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 210px;
  background: var(--hc-bg-sidebar);
  border-right: 1px solid var(--hc-border-subtle);
  transition: width 0.25s cubic-bezier(0.25, 0.1, 0.25, 1);
  overflow: hidden;
}

.hc-sidebar--collapsed {
  width: 54px;
}

.hc-sidebar__nav {
  flex: 1;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  overflow-y: auto;
}

.hc-sidebar__item {
  display: flex;
  align-items: center;
  gap: var(--hc-space-2);
  padding: var(--hc-space-2) var(--hc-space-3);
  border-radius: var(--hc-radius-sm);
  font-size: 13px;
  color: var(--hc-text-secondary);
  text-decoration: none;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  white-space: nowrap;
  border: none;
  background: transparent;
  width: 100%;
  text-align: left;
}

.hc-sidebar__item:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}

.hc-sidebar__item--active {
  background: var(--hc-bg-active);
  color: var(--hc-text-primary);
  font-weight: 500;
}

.hc-sidebar__icon {
  flex-shrink: 0;
  opacity: 0.8;
}

.hc-sidebar__item--active .hc-sidebar__icon {
  opacity: 1;
  color: var(--hc-accent);
}

.hc-sidebar__label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---- Bottom ---- */
.hc-sidebar__bottom {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  border-top: 1px solid var(--hc-divider);
}

.hc-sidebar__status {
  display: flex;
  align-items: center;
  gap: var(--hc-space-2);
  padding: var(--hc-space-1) var(--hc-space-3) var(--hc-space-2);
}

.hc-sidebar__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.hc-sidebar__dot--ok {
  background: var(--hc-success);
  box-shadow: 0 0 6px var(--hc-success);
}

.hc-sidebar__dot--err {
  background: var(--hc-error);
  box-shadow: 0 0 6px var(--hc-error);
}

.hc-sidebar__status-text {
  font-size: 11px;
  color: var(--hc-text-muted);
}
</style>
