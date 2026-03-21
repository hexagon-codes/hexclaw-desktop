<!-- eslint-disable vue/multi-word-component-names -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { invoke } from '@tauri-apps/api/core'
import { RotateCw } from 'lucide-vue-next'
import { useAppStore } from '@/stores/app'
import { getGroupedNavItems, isNavActive, type NavGroup } from '@/config/navigation'
import { env } from '@/config/env'
import logoUrl from '@/assets/logo.png'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()

const restarting = ref(false)

async function restartEngine() {
  if (restarting.value) return
  restarting.value = true
  try {
    await invoke<string>('restart_sidecar')
    await appStore.checkConnection()
  } catch (e) {
    console.error('[Sidebar] restart sidecar failed:', e)
  } finally {
    restarting.value = false
  }
}

const collapsed = computed(() => appStore.sidebarCollapsed)
const groups = computed(() => getGroupedNavItems())
const groupOrder: NavGroup[] = ['core', 'integration', 'system']

function getGroupItems(group: NavGroup) {
  return groups.value[group] ?? []
}
</script>

<template>
  <aside
    class="hc-sidebar hc-vibrancy"
    :class="{ 'hc-sidebar--collapsed': collapsed }"
    role="complementary"
    :aria-label="t('nav.sidebarLabel', 'Navigation Sidebar')"
  >
    <!-- Brand -->
    <div class="hc-sidebar__brand">
      <img :src="logoUrl" alt="HexClaw" class="hc-sidebar__logo" />
      <span v-if="!collapsed" class="hc-sidebar__brand-name">HexClaw</span>
    </div>

    <!-- Navigation -->
    <nav class="hc-sidebar__nav" role="navigation">
      <template v-for="(group, gi) in groupOrder">
        <div v-if="gi > 0" :key="`div-${group}`" class="hc-sidebar__divider" />

        <router-link
          v-for="item in getGroupItems(group)"
          :key="item.id"
          :to="item.path"
          :aria-label="t(item.i18nKey)"
          class="hc-sidebar__item"
          :class="{ 'hc-sidebar__item--active': isNavActive(item.path, route.path) }"
        >
          <component :is="item.icon" :size="17" class="hc-sidebar__icon" />
          <span v-if="!collapsed" class="hc-sidebar__label">{{ t(item.i18nKey) }}</span>
        </router-link>
      </template>
    </nav>

    <!-- Footer: engine status -->
    <div class="hc-sidebar__footer">
      <div class="hc-sidebar__engine-row" :title="env.apiBase">
        <span
          class="hc-sidebar__dot"
          :class="appStore.sidecarReady ? 'hc-sidebar__dot--ok' : 'hc-sidebar__dot--err'"
        />
        <template v-if="!collapsed">
          <span class="hc-sidebar__engine-label" role="button" @click="router.push('/settings')">
            {{ appStore.sidecarReady ? t('nav.engineRunning', 'Engine running') : t('nav.engineStopped', 'Engine stopped') }}
          </span>
          <button
            class="hc-sidebar__restart-btn"
            :class="{ 'hc-sidebar__restart-btn--spinning': restarting }"
            :title="t('nav.restartEngine', 'Restart engine')"
            :disabled="restarting"
            @click.stop="restartEngine"
          >
            <RotateCw :size="12" />
          </button>
          <span class="hc-sidebar__version">v0.0.2</span>
        </template>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.hc-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 226px;
  background: var(--hc-bg-sidebar);
  border-right: 1px solid var(--hc-border-subtle);
  transition: width 0.25s cubic-bezier(0.25, 0.1, 0.25, 1);
  overflow: hidden;
  padding: 12px 12px 8px;
  gap: 6px;
}

.hc-sidebar--collapsed {
  width: 54px;
  align-items: center;
}

/* ── Brand ── */
.hc-sidebar__brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 10px;
  flex-shrink: 0;
}

.hc-sidebar--collapsed .hc-sidebar__brand {
  justify-content: center;
  padding: 6px 0;
}

.hc-sidebar__logo {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  object-fit: cover;
  flex-shrink: 0;
}

.hc-sidebar__brand-name {
  font-size: 14px;
  font-weight: 700;
  color: var(--hc-text-primary);
  letter-spacing: -0.01em;
}

/* ── Nav ── */
.hc-sidebar__nav {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  overflow-y: auto;
  overflow-x: hidden;
}

.hc-sidebar__divider {
  margin: 4px 12px;
  border-top: 1px solid var(--hc-divider);
}

.hc-sidebar__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  border-radius: 10px;
  font-size: 13px;
  color: var(--hc-text-secondary);
  text-decoration: none;
  cursor: pointer;
  position: relative;
  transition:
    background 0.15s,
    color 0.15s;
  white-space: nowrap;
  border: none;
  background: transparent;
  width: 100%;
  text-align: left;
  flex-shrink: 0;
}

.hc-sidebar--collapsed .hc-sidebar__item {
  justify-content: center;
  padding: 10px 0;
}

.hc-sidebar__item:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}

.hc-sidebar__item--active {
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  font-weight: 600;
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

/* ── Footer ── */
.hc-sidebar__footer {
  flex-shrink: 0;
  padding: 0 4px 2px;
}

.hc-sidebar__engine-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  cursor: default;
}

.hc-sidebar--collapsed .hc-sidebar__engine-row {
  justify-content: center;
  padding: 8px 0;
}

.hc-sidebar__engine-label {
  font-size: 11px;
  color: var(--hc-text-muted);
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}

.hc-sidebar__engine-label:hover {
  color: var(--hc-text-secondary);
}

.hc-sidebar__restart-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  border-radius: 4px;
  cursor: pointer;
  flex-shrink: 0;
  padding: 0;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s, background 0.15s;
}

.hc-sidebar__engine-row:hover .hc-sidebar__restart-btn {
  opacity: 1;
}

.hc-sidebar__restart-btn:hover {
  color: var(--hc-accent);
  background: var(--hc-bg-hover);
}

.hc-sidebar__restart-btn--spinning {
  opacity: 1;
  color: var(--hc-accent);
}

.hc-sidebar__restart-btn--spinning svg {
  animation: hc-sidebar-spin 0.8s linear infinite;
}

@keyframes hc-sidebar-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.hc-sidebar__version {
  font-size: 10px;
  color: var(--hc-text-muted);
  font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
  opacity: 0.6;
}

.hc-sidebar__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.hc-sidebar__dot--ok {
  background: var(--hc-success);
}

.hc-sidebar__dot--err {
  background: var(--hc-error);
}
</style>
