<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Bot, Cpu } from 'lucide-vue-next'
import { useSettingsStore } from '@/stores/settings'
import { useAppStore } from '@/stores/app'
import { useChatStore } from '@/stores/chat'

const { t } = useI18n()
const settingsStore = useSettingsStore()
const appStore = useAppStore()
const chatStore = useChatStore()

const defaultProvider = computed(() => {
  const providers = settingsStore.enabledProviders
  const defaultModelId = settingsStore.config?.llm?.defaultModel
  const defaultProviderId = settingsStore.config?.llm?.defaultProviderId
  if (defaultModelId) {
    const p =
      providers.find(
        (pp) =>
          (!defaultProviderId || pp.id === defaultProviderId) &&
          pp.models.some((m) => m.id === defaultModelId),
      ) ?? providers.find((pp) => pp.models.some((m) => m.id === defaultModelId))
    if (p) return p.name || p.id
  }
  return providers[0]?.name || providers[0]?.id || null
})

const defaultModel = computed(() => {
  const providers = settingsStore.enabledProviders
  const defaultModelId = settingsStore.config?.llm?.defaultModel
  const defaultProviderId = settingsStore.config?.llm?.defaultProviderId
  if (defaultModelId) {
    for (const provider of providers) {
      if (defaultProviderId && provider.id !== defaultProviderId) continue
      const model = provider.models.find((m) => m.id === defaultModelId)
      if (model) return model.name || model.id
    }
    for (const provider of providers) {
      const model = provider.models.find((m) => m.id === defaultModelId)
      if (model) return model.name || model.id
    }
  }
  return providers[0]?.models[0]?.name || providers[0]?.models[0]?.id || null
})

const currentAgent = computed(() => chatStore.agentRole || null)
const engineReady = computed(() => appStore.sidecarReady)
</script>

<template>
  <div class="hc-context-bar">
    <!-- Engine status -->
    <div class="hc-context-bar__item">
      <span
        class="hc-context-bar__dot"
        :class="engineReady ? 'hc-context-bar__dot--ok' : 'hc-context-bar__dot--err'"
      />
    </div>

    <!-- Provider / Model -->
    <div v-if="defaultProvider" class="hc-context-bar__item" :title="t('settings.llm.provider')">
      <Cpu :size="11" />
      <span>{{ defaultModel || defaultProvider }}</span>
    </div>

    <!-- Agent -->
    <div
      v-if="currentAgent"
      class="hc-context-bar__item hc-context-bar__item--accent"
      :title="t('nav.agents')"
    >
      <Bot :size="11" />
      <span>{{ currentAgent }}</span>
    </div>
  </div>
</template>

<style scoped>
.hc-context-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  height: 24px;
  background: var(--hc-bg-sidebar);
  border-top: 1px solid var(--hc-divider);
  font-size: 11px;
  color: var(--hc-text-muted);
  flex-shrink: 0;
}

.hc-context-bar__item {
  display: flex;
  align-items: center;
  gap: 4px;
}

.hc-context-bar__item--accent {
  color: var(--hc-accent);
}

.hc-context-bar__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
}

.hc-context-bar__dot--ok {
  background: var(--hc-success);
}

.hc-context-bar__dot--err {
  background: var(--hc-error);
}
</style>
