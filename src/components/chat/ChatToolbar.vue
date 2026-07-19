<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Download, PanelLeft, PanelRight, Boxes } from 'lucide-vue-next'
import ChatExportMenu from '@/components/chat/ChatExportMenu.vue'
import { useChatStore } from '@/stores/chat'
import { useAppStore } from '@/stores/app'
import { ref } from 'vue'

const { t } = useI18n()
const chatStore = useChatStore()
const appStore = useAppStore()

const showSessions = defineModel<boolean>('showSessions', { required: true })

const showExport = ref(false)
const exportBtn = ref<HTMLButtonElement>()

defineProps<{
  messageCount: number
  tokenBadge: string
}>()
</script>

<template>
  <div class="hc-chat__toolbar">
    <div class="hc-chat__toolbar-row">
      <!-- 左：控「左侧」会话列表（空间映射 — 控左栏的钮在左） -->
      <button
        class="hc-chat__toolbar-btn"
        :class="{ 'hc-chat__toolbar-btn--active': showSessions }"
        :title="t('chat.toggleSessions')"
        @click="showSessions = !showSessions"
      >
        <PanelLeft :size="14" />
      </button>

      <div class="hc-chat__stat-strip">
        <span v-if="messageCount > 0" class="hc-token-badge" :title="tokenBadge">
          {{ messageCount }} {{ t('chat.messagesStat') }} · {{ tokenBadge }}
        </span>
      </div>

      <div style="flex: 1" />

      <!-- 右：会话操作 -->
      <button v-if="messageCount > 0" ref="exportBtn" class="hc-chat__toolbar-btn" :title="t('common.download')" @click="showExport = !showExport">
        <Download :size="14" />
      </button>
      <ChatExportMenu v-if="showExport" :messages="chatStore.messages" :trigger-el="exportBtn" @close="showExport = false" />

      <span class="hc-chat__toolbar-sep" />

      <!-- 右：控「右侧」产物面板（唯一图标 Boxes + 计数） -->
      <button
        class="hc-chat__toolbar-btn"
        :class="{ 'hc-chat__toolbar-btn--active': chatStore.showArtifacts }"
        :title="t('chat.artifacts')"
        @click="chatStore.showArtifacts = !chatStore.showArtifacts"
      >
        <Boxes :size="14" />
        <span v-if="chatStore.artifacts.length > 0" class="hc-chat__artifact-badge">{{ chatStore.artifacts.length }}</span>
      </button>

      <!-- 右：控「右侧」上下文/详情面板（唯一图标 PanelRight，与产物明确区分） -->
      <button
        class="hc-chat__toolbar-btn"
        :class="{ 'hc-chat__toolbar-btn--active': appStore.detailPanelOpen }"
        :title="t('chat.contextPanel')"
        @click="appStore.toggleDetailPanel"
      >
        <PanelRight :size="14" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.hc-chat__toolbar {
  flex-shrink: 0;
  border-bottom: 0.5px solid var(--hc-divider);
  background: var(--hc-bg-panel);
  padding: 0 14px;
}

.hc-chat__toolbar-row {
  height: 42px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.hc-chat__stat-strip {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 2px;
}

.hc-token-badge {
  font-size: 11px;
  color: var(--hc-text-muted);
  white-space: nowrap;
}

.hc-chat__toolbar-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--hc-text-secondary);
  border-radius: 6px;
  cursor: pointer;
  position: relative;
  transition: background 0.15s, color 0.15s;
}

.hc-chat__toolbar-btn:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}

.hc-chat__toolbar-btn--active {
  color: var(--hc-accent);
  background: var(--hc-accent-subtle, rgba(0, 122, 255, 0.08));
}

.hc-chat__toolbar-sep {
  width: 1px;
  height: 16px;
  background: var(--hc-divider);
  margin: 0 2px;
}

.hc-chat__artifact-badge {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 14px;
  height: 14px;
  border-radius: 7px;
  background: var(--hc-accent);
  color: var(--hc-text-inverse);
  font-size: 9px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 3px;
}
</style>
