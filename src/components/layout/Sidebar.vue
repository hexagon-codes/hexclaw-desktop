<!-- eslint-disable vue/multi-word-component-names -->
<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { useAgentsStore } from '@/stores/agents'
import { useChatStore } from '@/stores/chat'
import { useLogsStore } from '@/stores/logs'
import { getGroupedNavItems, isNavActive, type NavGroup } from '@/config/navigation'
import { env } from '@/config/env'
import logoUrl from '@/assets/logo.png'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const agentsStore = useAgentsStore()
const chatStore = useChatStore()
const logsStore = useLogsStore()
defineEmits<{ openAbout: [] }>()

const collapsed = computed(() => appStore.sidebarCollapsed)

const groups = computed(() => getGroupedNavItems())

const logErrorCount = computed(() => {
  return (
    logsStore.entries.filter((e) => e.level === 'error' || e.level === 'warn').length || undefined
  )
})

const navBadges = computed<Record<string, number | undefined>>(() => ({
  chat: chatStore.sessions.length || undefined,
  logs: logErrorCount.value,
}))

const groupOrder: NavGroup[] = ['core', 'integration', 'system']

const groupLabelKeys: Record<NavGroup, string> = {
  core: 'nav.groupCore',
  integration: 'nav.groupIntegration',
  system: 'nav.groupSystem',
}

const quickAgents = computed(() => agentsStore.roles.slice(0, 3))

function getGroupItems(group: NavGroup) {
  return groups.value[group] ?? []
}

function handleWorkspaceSwitch() {
  window.$message?.info?.(t('nav.workspaceSwitchHint', '工作区切换功能即将推出'))
}

function openAgentChat(role: { name: string; title: string }) {
  chatStore.chatMode = 'agent'
  chatStore.agentRole = role.name
  if (!chatStore.currentSessionId && chatStore.messages.length === 0) {
    chatStore.newSession(role.title || role.name)
  }
  router.push('/chat')
}

function openAgentsPage() {
  router.push('/agents')
}

onMounted(() => {
  if (!agentsStore.roles.length && !agentsStore.loading) {
    agentsStore.loadRoles()
  }
})
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
      <template v-if="!collapsed">
        <div class="hc-sidebar__brand-text">
          <span class="hc-sidebar__brand-name">HexClaw</span>
          <span class="hc-sidebar__brand-sub">Local-first desktop workspace</span>
        </div>
      </template>
    </div>

    <div
      v-if="!collapsed"
      class="hc-sidebar__workspace-meta"
      role="button"
      tabindex="0"
      @click="handleWorkspaceSwitch"
    >
      <span class="hc-sidebar__workspace-label">{{
        t('nav.defaultWorkspace', 'Default Workspace')
      }}</span>
      <span class="hc-sidebar__workspace-value">{{ t('chat.desktopWorkspace') }}</span>
    </div>

    <!-- Navigation -->
    <nav class="hc-sidebar__nav" role="navigation">
      <template v-for="group in groupOrder">
        <div :key="`title-${group}`" class="hc-sidebar__section-title" v-if="!collapsed">
          {{ t(groupLabelKeys[group]) }}
        </div>
        <div v-else :key="`div-${group}`" class="hc-sidebar__divider" />

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
          <span v-if="!collapsed && navBadges[item.id]" class="hc-sidebar__badge">{{
            navBadges[item.id]
          }}</span>
        </router-link>
      </template>
    </nav>

    <section v-if="!collapsed" class="hc-sidebar__agents">
      <div class="hc-sidebar__section-title">{{ t('agents.quickAgents') }}</div>
      <div class="hc-sidebar__agent-list">
        <button
          v-for="role in quickAgents"
          :key="role.name"
          class="hc-sidebar__agent-item"
          :class="{
            'hc-sidebar__agent-item--active':
              chatStore.agentRole === role.name && route.path.startsWith('/chat'),
          }"
          :title="t('agents.openChat')"
          @click="openAgentChat(role)"
        >
          <span class="hc-sidebar__agent-dot" />
          <span class="hc-sidebar__agent-title">{{ role.title || role.name }}</span>
          <span class="hc-sidebar__agent-name">{{ role.name }}</span>
        </button>
        <button class="hc-sidebar__agent-create" @click="openAgentsPage">
          + {{ t('chat.newAgent') }}
        </button>
      </div>
    </section>

    <!-- Bottom: status card -->
    <div class="hc-sidebar__footer">
      <div v-if="!collapsed" class="hc-sidebar__status-card">
        <div class="hc-sidebar__status-row">
          <span class="hc-sidebar__status-title">HexClaw Engine</span>
          <span
            class="hc-sidebar__status-value"
            :class="
              appStore.sidecarReady
                ? 'hc-sidebar__status-value--ok'
                : 'hc-sidebar__status-value--err'
            "
          >
            {{ appStore.sidecarReady ? t('nav.connected') : t('nav.disconnected') }}
          </span>
        </div>
        <div class="hc-sidebar__status-desc">{{ env.apiBase.replace(/^https?:\/\//, '') }}</div>
        <div class="hc-sidebar__status-meta">{{ t('chat.localFirstHint') }}</div>
      </div>
      <div v-if="!collapsed" class="hc-sidebar__footer-actions">
        <button class="hc-sidebar__about-btn" @click="$emit('openAbout')">
          {{ t('nav.about', '关于') }}
        </button>
        <button class="hc-sidebar__collapse-btn" @click="appStore.toggleSidebar">
          {{ t('nav.collapse') }}
        </button>
      </div>
      <div v-if="!collapsed" class="hc-sidebar__version">v0.0.2</div>
      <div v-else class="hc-sidebar__status-dot-wrap">
        <button
          class="hc-sidebar__collapsed-toggle"
          :title="t('nav.collapse')"
          @click="appStore.toggleSidebar"
        >
          <span
            class="hc-sidebar__dot"
            :class="appStore.sidecarReady ? 'hc-sidebar__dot--ok' : 'hc-sidebar__dot--err'"
          />
        </button>
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
  padding: 6px 10px 4px;
  flex-shrink: 0;
}

.hc-sidebar--collapsed .hc-sidebar__brand {
  justify-content: center;
  padding: 8px 0;
}

.hc-sidebar__logo {
  width: 32px;
  height: 32px;
  border-radius: 10px;
  object-fit: cover;
  flex-shrink: 0;
  box-shadow: 0 10px 20px rgba(74, 144, 217, 0.26);
}

.hc-sidebar__brand-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.hc-sidebar__brand-name {
  font-size: 15px;
  font-weight: 800;
  color: var(--hc-text-primary);
}

.hc-sidebar__brand-sub {
  margin-top: 2px;
  font-size: 11px;
  color: var(--hc-text-muted);
}

/* ── Workspace Meta ── */
.hc-sidebar__workspace-meta {
  border: 1px solid var(--hc-border-subtle);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.02));
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 12px;
  cursor: pointer;
  flex-shrink: 0;
  transition:
    background 0.15s,
    border-color 0.15s,
    transform 0.15s;
}

.hc-sidebar__workspace-meta:hover {
  background: var(--hc-bg-hover);
  border-color: var(--hc-accent-subtle);
  transform: translateY(-1px);
}

.hc-sidebar__workspace-label {
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--hc-text-muted);
}

.hc-sidebar__workspace-value {
  font-size: 13px;
  font-weight: 700;
  color: var(--hc-text-primary);
}

/* ── Nav ── */
.hc-sidebar__nav {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  overflow: hidden;
}

.hc-sidebar__section-title {
  padding: 6px 10px 2px;
  font-size: 10px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.16em;
  color: var(--hc-accent);
}

.hc-sidebar__divider {
  margin: 6px 4px;
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

.hc-sidebar__item--active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: linear-gradient(180deg, var(--hc-accent), var(--hc-accent-hover));
}

.hc-sidebar--collapsed .hc-sidebar__item--active::before {
  left: 0;
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

/* ── Badge ── */
.hc-sidebar__badge {
  margin-left: auto;
  font-size: 10px;
  font-weight: 600;
  min-width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.hc-sidebar__item--active .hc-sidebar__badge {
  background: var(--hc-accent);
  color: #fff;
}

.hc-sidebar__agents {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex-shrink: 0;
}

.hc-sidebar__agent-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.hc-sidebar__agent-item {
  width: 100%;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--hc-text-secondary);
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  text-align: left;
  cursor: pointer;
  transition:
    background 0.15s,
    border-color 0.15s,
    color 0.15s;
}

.hc-sidebar__agent-item:hover {
  background: var(--hc-bg-hover);
  border-color: var(--hc-border);
  color: var(--hc-text-primary);
}

.hc-sidebar__agent-item--active {
  background: var(--hc-accent-subtle);
  border-color: rgba(74, 144, 217, 0.28);
  color: var(--hc-text-primary);
}

.hc-sidebar__agent-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--hc-success);
  box-shadow: 0 0 0 2px rgba(50, 213, 131, 0.12);
}

.hc-sidebar__agent-title {
  font-size: 13px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hc-sidebar__agent-name {
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--hc-text-muted);
}

.hc-sidebar__agent-create {
  width: 100%;
  border: 1px dashed var(--hc-border);
  border-radius: 10px;
  background: transparent;
  color: var(--hc-text-secondary);
  padding: 6px 12px;
  text-align: left;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition:
    background 0.15s,
    border-color 0.15s,
    color 0.15s;
}

.hc-sidebar__agent-create:hover {
  background: var(--hc-bg-hover);
  border-color: var(--hc-accent-subtle);
  color: var(--hc-text-primary);
}

/* ── About Button ── */
.hc-sidebar__about-btn {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--hc-border);
  border-radius: 10px;
  background: transparent;
  color: var(--hc-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.15s;
  text-align: center;
}

.hc-sidebar__about-btn:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}

/* ── Footer / Status Card ── */
.hc-sidebar__footer {
  margin-top: auto;
  padding-top: 6px;
  border-top: 1px solid var(--hc-divider);
  flex-shrink: 0;
}

.hc-sidebar__status-card {
  border-radius: 10px;
  padding: 8px 10px;
  background: var(--hc-bg-card);
  border: 1px solid var(--hc-border);
  box-shadow: var(--hc-shadow-sm);
}

.hc-sidebar__status-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.hc-sidebar__status-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--hc-text-primary);
}

.hc-sidebar__status-value {
  font-size: 11px;
  font-weight: 800;
}

.hc-sidebar__status-value--ok {
  color: var(--hc-success);
}

.hc-sidebar__status-value--err {
  color: var(--hc-error);
}

.hc-sidebar__status-desc {
  margin-top: 4px;
  font-size: 10px;
  color: var(--hc-text-muted);
  font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hc-sidebar__status-meta {
  margin-top: 4px;
  font-size: 10px;
  line-height: 1.4;
  color: var(--hc-text-secondary);
}

.hc-sidebar__footer-actions {
  margin-top: 6px;
  display: flex;
  gap: 6px;
}

.hc-sidebar__collapse-btn {
  border: 1px solid var(--hc-border);
  border-radius: 10px;
  background: transparent;
  color: var(--hc-text-secondary);
  font-size: 12px;
  font-weight: 600;
  padding: 8px 12px;
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.15s;
}

.hc-sidebar__collapse-btn:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}

.hc-sidebar__version {
  margin-top: 4px;
  font-size: 10px;
  color: var(--hc-text-muted);
  text-align: center;
}

/* ── Collapsed status dot ── */
.hc-sidebar__status-dot-wrap {
  display: flex;
  justify-content: center;
  padding: 4px 0;
}

.hc-sidebar__collapsed-toggle {
  border: none;
  background: transparent;
  padding: 6px;
  border-radius: 999px;
  cursor: pointer;
}

.hc-sidebar__collapsed-toggle:hover {
  background: var(--hc-bg-hover);
}

.hc-sidebar__dot {
  width: 8px;
  height: 8px;
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
</style>
