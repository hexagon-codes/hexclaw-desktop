<!-- eslint-disable vue/multi-word-component-names -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { RotateCw } from 'lucide-vue-next'
import { useAppStore } from '@/stores/app'
import { useAboutWindow } from '@/composables/useAboutWindow'
import { getGroupedNavItems, isNavActive, NAV_GROUP_LABELS, type NavGroup } from '@/config/navigation'
import { env } from '@/config/env'
import logoUrl from '@/assets/logo.png'

const { t, locale } = useI18n()
const route = useRoute()
const appStore = useAppStore()
const openAbout = useAboutWindow()

// 角落展示的是 **HexClaw 产品版本**（= Tauri app 版本，随包发布、客服锚点、更新基准），
// 而非内部 Hexagon 引擎版本——后者已退到「关于」页展示（产品评审 2026-07-13）。
// 空串起步，取到 Tauri app 版本后再显，避免占位符闪烁。
const appVersion = ref('')

onMounted(() => {
  import('@tauri-apps/api/app')
    .then(({ getVersion }) => getVersion())
    .then((v) => { appVersion.value = 'v' + v })
    .catch(() => {})
})

const collapsed = computed(() => appStore.sidebarCollapsed)
const groups = computed(() => getGroupedNavItems())
const groupOrder: NavGroup[] = ['home', 'build', 'connections', 'system']

// Localized group header; empty for the home group (Chat stands alone).
function groupLabel(group: NavGroup): string {
  const label = NAV_GROUP_LABELS[group]
  return locale.value === 'zh-CN' ? label.zh : label.en
}

const dotClass = computed(() => {
  const s = appStore.sidecarStatus
  if (s === 'running') return 'hc-sidebar__dot--ok'
  if (s === 'starting') return 'hc-sidebar__dot--starting'
  return 'hc-sidebar__dot--err'
})

const productLabel = computed(() =>
  appVersion.value ? `HexClaw ${appVersion.value}` : 'HexClaw',
)

// 平台默认全功能，导航不按模式门控（K12 只是「作业辅导」智能体，非独立 UI 模式）。
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
      <span v-if="!collapsed" class="hc-sidebar__brand-name">{{ t('nav.brandName', 'HexClaw') }}</span>
    </div>

    <!-- Navigation -->
    <nav class="hc-sidebar__nav" role="navigation">
      <template v-for="(group, gi) in groupOrder">
        <div
          v-if="(collapsed ? gi > 0 : gi === 1) && getGroupItems(group).length"
          :key="`div-${group}`"
          class="hc-sidebar__divider"
        />
        <div
          v-if="!collapsed && groupLabel(group) && getGroupItems(group).length"
          :key="`lbl-${group}`"
          class="hc-sidebar__group-label"
        >
          {{ groupLabel(group) }}
        </div>

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

    <!-- Footer: engine status + version -->
    <div class="hc-sidebar__footer">
      <div class="hc-sidebar__engine-row" :title="env.apiBase">
        <span class="hc-sidebar__dot" :class="dotClass" />
        <template v-if="!collapsed">
          <span
            class="hc-sidebar__engine-label"
            role="button"
            :title="t('about.open', '关于河蟹')"
            @click="openAbout"
          >
            {{ productLabel }}
          </span>
          <button
            class="hc-sidebar__restart-btn"
            :class="{ 'hc-sidebar__restart-btn--spinning': appStore.isRestarting }"
            :title="t('nav.restartEngine', 'Restart engine')"
            :disabled="appStore.isRestarting"
            @click.stop="appStore.restartSidecar()"
          >
            <RotateCw :size="12" />
          </button>
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
  padding: 4px 10px 14px;
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
  gap: 3px;
  overflow-y: auto;
  overflow-x: hidden;
}

.hc-sidebar__divider {
  margin: 4px 12px;
  border-top: 1px solid var(--hc-divider);
}

.hc-sidebar__group-label {
  padding: 0 12px;
  margin: 16px 0 6px;
  font-size: 10.5px;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--hc-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hc-sidebar__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
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
  /* 常驻可见（对齐原型 .sb-foot .restart：始终显示，hover 高亮） */
  opacity: 1;
  transition: opacity 0.15s, color 0.15s, background 0.15s;
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

.hc-sidebar__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.hc-sidebar__dot--ok {
  background: var(--hc-success);
  transition: background 0.4s ease;
}

.hc-sidebar__dot--starting {
  background: var(--hc-warning, #eab308);
  animation: hc-dot-pulse 1s ease-in-out infinite;
  transition: background 0.4s ease;
}

.hc-sidebar__dot--err {
  background: var(--hc-error);
  transition: background 0.4s ease;
}

@keyframes hc-dot-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
</style>
