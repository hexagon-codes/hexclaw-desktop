<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { usePlatform } from '@/composables/usePlatform'
import { useAppStore } from '@/stores/app'
import { useNotificationsStore } from '@/stores/notifications'
import { useTheme } from '@/composables/useTheme'
import { useI18n } from 'vue-i18n'
import { PanelLeft, Sun, Moon, Command, Bell } from 'lucide-vue-next'
import { navigationItems } from '@/config/navigation'
import NotificationPanel from './NotificationPanel.vue'

const { isMac } = usePlatform()
const route = useRoute()
const appStore = useAppStore()
const notifications = useNotificationsStore()
const { resolvedTheme, setTheme } = useTheme()
const { t } = useI18n()

const notifOpen = ref(false)
const unreadLabel = computed(() =>
  notifications.unreadCount > 99 ? '99+' : String(notifications.unreadCount),
)

const currentSection = computed(() => {
  const match = navigationItems.find(
    (item) => route.path === item.path || route.path.startsWith(item.path + '/'),
  )
  return match ? t(match.i18nKey) : 'HexClaw'
})

function toggleTheme() {
  setTheme(resolvedTheme.value === 'dark' ? 'light' : 'dark')
}

function openCommandPalette() {
  window.dispatchEvent(new CustomEvent('hc:toggle-command-palette'))
}
</script>

<template>
  <div
    data-tauri-drag-region
    class="hc-titlebar hc-vibrancy"
    :class="{ 'hc-titlebar--mac': isMac }"
  >
    <div class="hc-titlebar__left">
      <button
        class="hc-titlebar__btn"
        :aria-label="appStore.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
        @click="appStore.toggleSidebar"
      >
        <PanelLeft :size="15" />
      </button>
      <span class="hc-titlebar__section">{{ currentSection }}</span>
    </div>

    <div class="hc-titlebar__spacer" />

    <div class="hc-titlebar__right">
      <button
        class="hc-titlebar__btn hc-titlebar__notif"
        :aria-label="t('notifications.title')"
        :title="t('notifications.title')"
        data-testid="notif-bell"
        @click="notifOpen = !notifOpen"
      >
        <Bell :size="15" />
        <span
          v-if="notifications.unreadCount > 0"
          class="hc-titlebar__badge"
          :class="{ 'hc-titlebar__badge--urgent': notifications.hasUrgentUnread }"
          data-testid="notif-badge"
        >{{ unreadLabel }}</span>
      </button>
      <button class="hc-titlebar__btn hc-titlebar__btn--kbd" @click="openCommandPalette">
        <Command :size="12" />
        <span>K</span>
      </button>
      <button class="hc-titlebar__btn" @click="toggleTheme">
        <Sun v-if="resolvedTheme === 'dark'" :size="15" />
        <Moon v-else :size="15" />
      </button>
    </div>

    <NotificationPanel v-if="notifOpen" @close="notifOpen = false" />
  </div>
</template>

<style scoped>
.hc-titlebar {
  height: var(--hc-titlebar-height);
  flex-shrink: 0;
  user-select: none;
  -webkit-app-region: drag;
  cursor: default;
  display: flex;
  align-items: center;
  padding: 0 12px;
  position: relative;
  z-index: var(--hc-z-toast);
  border-bottom: 1px solid var(--hc-border-subtle);
}

.hc-titlebar--mac {
  padding-left: 78px;
}

.hc-titlebar__left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.hc-titlebar__spacer {
  flex: 1;
}

.hc-titlebar__section {
  font-size: 13px;
  font-weight: 600;
  color: var(--hc-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hc-titlebar__right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.hc-titlebar__btn {
  padding: 5px 7px;
  border-radius: var(--hc-radius-sm);
  border: none;
  background: transparent;
  color: var(--hc-text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  transition:
    background 0.15s,
    color 0.15s;
  -webkit-app-region: no-drag;
}

.hc-titlebar__btn:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}

.hc-titlebar__btn:active {
  background: var(--hc-bg-active);
  transform: scale(0.95);
}

.hc-titlebar__btn--kbd {
  font-family: var(--hc-font-mono, 'SF Mono', 'Menlo', monospace);
  font-size: 11px;
  gap: 1px;
  padding: 4px 6px;
  border: 1px solid var(--hc-border);
  border-radius: 5px;
}

.hc-titlebar__notif {
  position: relative;
}

.hc-titlebar__badge {
  position: absolute;
  top: -1px;
  right: -2px;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 999px;
  /* 默认：中性强调色（纯 info 未读，不报警） */
  background: var(--hc-accent);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  line-height: 15px;
  text-align: center;
  box-shadow: 0 0 0 1.5px var(--hc-bg-base, var(--hc-bg-elevated));
  pointer-events: none;
}

/* 有审批/警告/错误未读时才转红 —— 红色重新代表「需你处理」 */
.hc-titlebar__badge--urgent {
  background: var(--hc-error);
}
</style>
