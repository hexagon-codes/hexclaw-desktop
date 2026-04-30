<!--
  ContextBar — 底部上下文栏（PLAN-D4 #21）

  常驻在 AppLayout 底部，显示当前作用上下文：
    [● 引擎状态]   Provider/Model   Agent · Mode

  设计目标：
    - 让用户在任意页面都能 1 秒内看到"我现在用的是哪个模型 / 哪个 Agent"
    - 点击各 chip 跳转对应设置页（Provider/Model → /settings, Agent → /agents）
    - 不替代 Sidebar footer 的引擎状态，而是补充更细的当前会话上下文
-->
<template>
  <footer class="hc-contextbar" role="contentinfo">
    <button
      type="button"
      class="hc-contextbar__chip hc-contextbar__chip--engine"
      :class="dotClass"
      :title="engineTooltip"
      @click="router.push('/settings')"
    >
      <span class="hc-contextbar__dot" />
      <span class="hc-contextbar__chip-label">{{ engineLabel }}</span>
    </button>

    <span class="hc-contextbar__sep" />

    <button
      type="button"
      class="hc-contextbar__chip"
      :title="t('contextbar.providerModelTip', 'Provider · Model（点击切换）')"
      @click="router.push('/settings')"
    >
      <span class="hc-contextbar__chip-key">{{ providerName || '—' }}</span>
      <span class="hc-contextbar__chip-sep">/</span>
      <span class="hc-contextbar__chip-val">{{ modelName || t('contextbar.noModel', '未选模型') }}</span>
    </button>

    <span class="hc-contextbar__sep" />

    <button
      type="button"
      class="hc-contextbar__chip"
      :title="t('contextbar.agentTip', 'Agent · 模式（点击切换）')"
      @click="router.push('/agents')"
    >
      <span class="hc-contextbar__chip-key">{{ agentName }}</span>
      <span class="hc-contextbar__chip-sep">·</span>
      <span class="hc-contextbar__chip-val">{{ modeLabel }}</span>
    </button>

    <span class="hc-contextbar__spacer" />

    <span v-if="appStore.isRestarting" class="hc-contextbar__hint">
      {{ t('contextbar.restarting', '引擎重启中…') }}
    </span>
  </footer>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { useSettingsStore } from '@/stores/settings'
import { useChatStore } from '@/stores/chat'
import { useAgentsStore } from '@/stores/agents'

const router = useRouter()
const { t } = useI18n()
const appStore = useAppStore()
const settingsStore = useSettingsStore()
const chatStore = useChatStore()
const agentsStore = useAgentsStore()

const dotClass = computed(() => {
  if (appStore.isRestarting) return 'is-warn'
  return appStore.sidecarReady ? 'is-ok' : 'is-bad'
})

const engineLabel = computed(() => {
  if (appStore.isRestarting) return t('contextbar.engineRestarting', '重启中')
  return appStore.sidecarReady
    ? t('contextbar.engineOnline', '引擎已连接')
    : t('contextbar.engineOffline', '引擎离线')
})
const engineTooltip = computed(() => engineLabel.value)

/** 当前 provider 名（从 settings.llm.defaultProviderId 解析） */
const providerName = computed(() => {
  const cfg = settingsStore.config?.llm
  if (!cfg) return ''
  const id = cfg.defaultProviderId
  if (!id) return ''
  const p = (cfg.providers ?? []).find(x => x.id === id)
  return p?.name ?? ''
})

/** 当前 model 名 */
const modelName = computed(() => {
  return settingsStore.config?.llm?.defaultModel ?? ''
})

/** 当前 Agent 名 */
const agentName = computed(() => {
  if (chatStore.chatMode === 'agent' && chatStore.agentRole) {
    return agentsStore.findAgent(chatStore.agentRole)?.name ?? chatStore.agentRole
  }
  return t('contextbar.noAgent', '无 Agent')
})

/** Agent 模式中文/英文 label */
const modeLabel = computed(() => {
  const mode = settingsStore.config?.llm?.agentMode ?? 'auto'
  const labels: Record<string, string> = {
    auto: 'Auto',
    react: 'ReAct',
    'plan-execute': 'Plan-Exec',
    reflection: 'Reflect',
    tot: 'ToT',
    'self-reflect': 'Self-Reflect',
    'mem-augmented': 'Mem-Aug',
    debate: 'Debate',
  }
  return labels[mode] ?? mode
})
</script>

<style scoped>
/* HIG：底部上下文栏使用项目级 token + 毛玻璃，0.5px 细边框，
   chip 圆角 var(--hc-radius-md)，hover 背景柔和 + 微 scale；
   transition 显式列出属性（禁止 transition: all）。 */
.hc-contextbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 14px;
  font-size: 12px;
  letter-spacing: -0.005em;
  color: var(--hc-text-secondary);
  background: var(--hc-bg-panel);
  backdrop-filter: saturate(180%) blur(var(--hc-blur));
  -webkit-backdrop-filter: saturate(180%) blur(var(--hc-blur));
  border-top: 0.5px solid var(--hc-border);
  user-select: none;
}
.hc-contextbar__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 0;
  border-radius: var(--hc-radius-md);
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  letter-spacing: inherit;
  transition:
    background 140ms cubic-bezier(0.25, 0.1, 0.25, 1),
    color 140ms cubic-bezier(0.25, 0.1, 0.25, 1),
    transform 140ms cubic-bezier(0.25, 0.1, 0.25, 1);
}
.hc-contextbar__chip:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
  transform: scale(1.02);
}
.hc-contextbar__chip:active {
  transform: scale(0.98);
}
.hc-contextbar__chip-key {
  color: var(--hc-text-primary);
  font-weight: 500;
}
.hc-contextbar__chip-sep {
  color: var(--hc-text-muted);
  opacity: 0.6;
}
.hc-contextbar__chip-val {
  color: var(--hc-text-secondary);
}
.hc-contextbar__sep {
  width: 1px;
  height: 14px;
  background: var(--hc-divider);
}
.hc-contextbar__spacer {
  flex: 1;
}
.hc-contextbar__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--hc-text-muted);
  transition: background 140ms cubic-bezier(0.25, 0.1, 0.25, 1);
}
.hc-contextbar__chip--engine.is-ok .hc-contextbar__dot {
  background: var(--hc-success);
}
.hc-contextbar__chip--engine.is-warn .hc-contextbar__dot {
  background: var(--hc-warning);
}
.hc-contextbar__chip--engine.is-bad .hc-contextbar__dot {
  background: var(--hc-error);
}
.hc-contextbar__hint {
  color: var(--hc-text-muted);
  font-style: italic;
}
</style>
