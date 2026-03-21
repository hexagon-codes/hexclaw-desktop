<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useChatStore } from '@/stores/chat'
import { useSettingsStore } from '@/stores/settings'
import { useAgentsStore } from '@/stores/agents'
import { useAppStore } from '@/stores/app'
import ContextCard from './ContextCard.vue'
import KeyValueRow from './KeyValueRow.vue'
import TimelineItem from './TimelineItem.vue'

const route = useRoute()
const { t } = useI18n()
const chatStore = useChatStore()
const settingsStore = useSettingsStore()
const agentsStore = useAgentsStore()
const appStore = useAppStore()

type InspectorSection =
  | 'dashboard'
  | 'chat'
  | 'agents'
  | 'knowledge'
  | 'automation'
  | 'integration'
  | 'logs'
  | 'settings'
  | 'generic'

const section = computed<InspectorSection>(() => {
  const p = route.path
  if (p === '/' || p === '/dashboard') return 'dashboard'
  if (p.startsWith('/chat')) return 'chat'
  if (p.startsWith('/agents')) return 'agents'
  if (p.startsWith('/knowledge')) return 'knowledge'
  if (p.startsWith('/automation')) return 'automation'
  if (p.startsWith('/integration')) return 'integration'
  if (p.startsWith('/logs')) return 'logs'
  if (p.startsWith('/settings')) return 'settings'
  return 'generic'
})

const activeProvider = computed(() => {
  const providers = settingsStore.enabledProviders
  return providers[0]?.name ?? '—'
})

const activeModel = computed(() => {
  return settingsStore.config?.llm.defaultModel || 'auto'
})

const activeAgent = computed(() => {
  const role = chatStore.agentRole
  if (role) return role
  const roles = agentsStore.roles
  return roles[0]?.name ?? '—'
})

const sessionCount = computed(() => chatStore.sessions.length)
const messageCount = computed(() => chatStore.messages.length)
const artifactCount = computed(() => chatStore.artifacts.length)
const agentCount = computed(() => agentsStore.roles.length)

const engineStatus = computed(() =>
  appStore.sidecarReady ? t('nav.connected') : t('nav.disconnected'),
)

const currentTheme = computed(() =>
  document.documentElement.getAttribute('data-theme') === 'dark' ? 'Dark' : 'Light',
)

const currentLocale = computed(() =>
  settingsStore.config?.general.language === 'zh-CN' ? '简体中文' : 'English',
)

function nowTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <div class="hc-inspector-context">
    <!-- Dashboard -->
    <template v-if="section === 'dashboard'">
      <ContextCard
        :eyebrow="t('inspector.eyebrow.currentContext')"
        :title="t('inspector.demo.contextHeadline')"
      >
        <KeyValueRow :label="t('inspector.kv.provider')" :value="activeProvider" />
        <KeyValueRow :label="t('inspector.kv.model')" :value="activeModel" />
        <KeyValueRow :label="t('inspector.kv.agent')" :value="activeAgent" />
        <KeyValueRow :label="t('inspector.kv.sessions')" :value="String(sessionCount)" />
      </ContextCard>
      <ContextCard :eyebrow="t('inspector.eyebrow.systemStatus')" :title="t('inspector.demo.activityTitle')">
        <KeyValueRow label="HexClaw Engine" :value="engineStatus" />
        <KeyValueRow :label="t('inspector.kv.agentCount')" :value="String(agentCount)" />
      </ContextCard>
    </template>

    <!-- Chat -->
    <template v-else-if="section === 'chat'">
      <ContextCard
        :eyebrow="t('inspector.eyebrow.answerSource')"
        :title="t('inspector.demo.chatAnswerHeadline')"
      >
        <KeyValueRow :label="t('inspector.kv.provider')" :value="activeProvider" />
        <KeyValueRow :label="t('inspector.kv.model')" :value="activeModel" />
        <KeyValueRow :label="t('inspector.kv.agent')" :value="activeAgent" />
        <KeyValueRow :label="t('inspector.kv.messages')" :value="String(messageCount)" />
        <KeyValueRow :label="t('inspector.kv.artifacts')" :value="String(artifactCount)" />
      </ContextCard>
      <ContextCard :eyebrow="t('inspector.eyebrow.recentActivity')" :title="t('inspector.demo.activityTitle')">
        <div class="hc-inspector-context__timeline">
          <TimelineItem
            v-if="chatStore.isCurrentStreaming"
            :time="nowTime()"
            :text="t('inspector.live.streaming', '正在流式回复…')"
            dot-color="var(--hc-accent)"
          />
          <TimelineItem
            v-for="(session, idx) in chatStore.sessions.slice(0, 3)"
            :key="session.id"
            :time="new Date(session.updated_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })"
            :text="session.title || t('chat.newSession')"
            :dot-color="idx === 0 ? 'var(--hc-accent)' : '#22c55e'"
          />
        </div>
      </ContextCard>
    </template>

    <!-- Agents -->
    <template v-else-if="section === 'agents'">
      <ContextCard
        :eyebrow="t('inspector.eyebrow.selectedAgent')"
        :title="t('inspector.demo.agentsHeadline')"
      >
        <KeyValueRow :label="t('inspector.kv.agentCount')" :value="String(agentCount)" />
        <KeyValueRow :label="t('inspector.kv.model')" :value="activeModel" />
        <template v-if="agentsStore.roles.length > 0">
          <KeyValueRow
            v-for="role in agentsStore.roles.slice(0, 3)"
            :key="role.name"
            :label="role.name"
            :value="role.goal?.slice(0, 20) || '—'"
          />
        </template>
      </ContextCard>
    </template>

    <!-- Knowledge -->
    <template v-else-if="section === 'knowledge'">
      <ContextCard
        :eyebrow="t('inspector.eyebrow.selectedDoc')"
        :title="t('inspector.demo.knowledgeHeadline')"
        :description="t('inspector.demo.knowledgeDesc')"
      >
        <KeyValueRow :label="t('inspector.kv.provider')" :value="activeProvider" />
        <KeyValueRow :label="t('inspector.kv.model')" :value="activeModel" />
      </ContextCard>
    </template>

    <!-- Automation -->
    <template v-else-if="section === 'automation'">
      <ContextCard
        :eyebrow="t('inspector.eyebrow.automationContext')"
        :title="t('inspector.demo.automationHeadline')"
        :description="t('inspector.demo.automationDesc')"
      >
        <KeyValueRow :label="t('inspector.kv.agent')" :value="activeAgent" />
        <KeyValueRow :label="t('inspector.kv.model')" :value="activeModel" />
      </ContextCard>
    </template>

    <!-- Integration -->
    <template v-else-if="section === 'integration'">
      <ContextCard
        :eyebrow="t('inspector.eyebrow.integrationHealth')"
        :title="t('inspector.demo.integrationHeadline')"
      >
        <KeyValueRow :label="t('inspector.kv.provider')" :value="activeProvider" />
        <KeyValueRow label="HexClaw Engine" :value="engineStatus" />
        <KeyValueRow :label="t('inspector.kv.agentCount')" :value="String(agentCount)" />
      </ContextCard>
    </template>

    <!-- Logs -->
    <template v-else-if="section === 'logs'">
      <ContextCard
        :eyebrow="t('inspector.eyebrow.logView')"
        :title="t('inspector.demo.logsHeadline')"
        :description="t('inspector.demo.logsDesc')"
      >
        <KeyValueRow :label="t('inspector.kv.level')" :value="settingsStore.config?.general.log_level ?? 'info'" />
        <KeyValueRow label="HexClaw Engine" :value="engineStatus" />
      </ContextCard>
    </template>

    <!-- Settings -->
    <template v-else-if="section === 'settings'">
      <ContextCard
        :eyebrow="t('inspector.eyebrow.settingsContext')"
        :title="t('inspector.demo.settingsHeadline')"
      >
        <KeyValueRow :label="t('inspector.kv.theme')" :value="currentTheme" />
        <KeyValueRow :label="t('inspector.kv.locale')" :value="currentLocale" />
        <KeyValueRow :label="t('inspector.kv.provider')" :value="activeProvider" />
        <KeyValueRow :label="t('inspector.kv.model')" :value="activeModel" />
      </ContextCard>
    </template>

    <!-- Generic fallback -->
    <template v-else>
      <ContextCard
        :eyebrow="t('inspector.eyebrow.genericHint')"
        :title="t('inspector.demo.genericHeadline')"
        :description="t('inspector.demo.genericDesc')"
      >
        <KeyValueRow :label="t('inspector.kv.path')" :value="route.path" />
      </ContextCard>
    </template>
  </div>
</template>

<style scoped>
.hc-inspector-context {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.hc-inspector-context__timeline {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
