<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { usePlatform } from '@/composables/usePlatform'
import { useAppStore } from '@/stores/app'
import { useTheme } from '@/composables/useTheme'
import { useI18n } from 'vue-i18n'
import { PanelLeft, PanelRightOpen, Sun, Moon, Command } from 'lucide-vue-next'
import { navigationItems } from '@/config/navigation'

const { isMac } = usePlatform()
const route = useRoute()
const appStore = useAppStore()
const { resolvedTheme, setTheme } = useTheme()
const { locale, t } = useI18n()

const currentSection = computed(() => {
  const match = navigationItems.find(
    (item) => route.path === item.path || route.path.startsWith(item.path + '/'),
  )
  return match ? t(match.i18nKey) : 'HexClaw'
})

const engineLabel = computed(() =>
  appStore.sidecarReady ? t('nav.connected') : t('nav.disconnected'),
)

function toggleTheme() {
  setTheme(resolvedTheme.value === 'dark' ? 'light' : 'dark')
}

function toggleLang() {
  locale.value = locale.value === 'zh-CN' ? 'en' : 'zh-CN'
  localStorage.setItem('hc-locale', locale.value)
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

    <span class="hc-titlebar__title">HexClaw Desktop Workspace</span>

    <div class="hc-titlebar__right">
      <span class="hc-titlebar__status">
        <span
          class="hc-titlebar__status-dot"
          :class="
            appStore.sidecarReady ? 'hc-titlebar__status-dot--ok' : 'hc-titlebar__status-dot--err'
          "
        />
        {{ engineLabel }}
      </span>
      <button
        class="hc-titlebar__btn"
        :title="t('chat.toggleInspector')"
        @click="appStore.toggleDetailPanel"
      >
        <PanelRightOpen :size="15" />
      </button>
      <button class="hc-titlebar__btn hc-titlebar__btn--kbd" @click="openCommandPalette">
        <Command :size="12" />
        <span>K</span>
      </button>
      <button class="hc-titlebar__btn" @click="toggleLang">
        {{ locale === 'zh-CN' ? 'EN' : '中' }}
      </button>
      <button class="hc-titlebar__btn" @click="toggleTheme">
        <Sun v-if="resolvedTheme === 'dark'" :size="15" />
        <Moon v-else :size="15" />
      </button>
    </div>
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

.hc-titlebar__title {
  flex: 1;
  text-align: center;
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-secondary);
  cursor: default;
  pointer-events: none;
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

.hc-titlebar__status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--hc-border);
  border-radius: 999px;
  font-size: 11px;
  color: var(--hc-text-secondary);
  background: rgba(255, 255, 255, 0.03);
  -webkit-app-region: no-drag;
}

.hc-titlebar__status-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
}

.hc-titlebar__status-dot--ok {
  background: var(--hc-success);
}

.hc-titlebar__status-dot--err {
  background: var(--hc-error);
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
</style>
