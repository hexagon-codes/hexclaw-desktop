<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Download, PanelLeft, PanelRight, Boxes } from 'lucide-vue-next'
import ChatExportMenu from '@/components/chat/ChatExportMenu.vue'
import { useChatStore } from '@/stores/chat'
import { ref } from 'vue'
import {
  toggleChatWorkspaceEntry,
  type ChatWorkspaceMode,
} from '@/components/chat/workspace-mode'

const { t } = useI18n()
const chatStore = useChatStore()

const workspaceMode = defineModel<ChatWorkspaceMode>('workspaceMode', { required: true })

const showExport = ref(false)
const exportBtn = ref<HTMLButtonElement>()

function toggleSessionsRail() {
  workspaceMode.value = toggleChatWorkspaceEntry(workspaceMode.value, 'sessions')
}

function toggleArtifactsRail() {
  workspaceMode.value = toggleChatWorkspaceEntry(workspaceMode.value, 'artifacts')
}

function toggleContextRail() {
  workspaceMode.value = toggleChatWorkspaceEntry(workspaceMode.value, 'context')
}

defineProps<{
  messageCount: number
  tokenBadge: string
}>()
</script>

<template>
  <div class="hc-chat__toolbar">
    <div class="hc-chat__toolbar-row">
      <!-- Desktop refinement: the control for the left session rail stays on the left. -->
      <button
        class="hc-chat__toolbar-btn"
        :class="{ 'hc-chat__toolbar-btn--active': workspaceMode === 'sessions' }"
        :title="t('chat.toggleSessions')"
        :aria-pressed="workspaceMode === 'sessions'"
        @click="toggleSessionsRail"
      >
        <PanelLeft :size="15" />
      </button>

      <div class="hc-chat__stat-strip">
        <span v-if="messageCount > 0" class="hc-token-badge" :title="tokenBadge">
          {{ messageCount }} {{ t('chat.messagesStat') }} · {{ tokenBadge }}
        </span>
      </div>

      <div style="flex: 1" />

      <!-- 右：会话操作 -->
      <button v-if="messageCount > 0" ref="exportBtn" class="hc-chat__toolbar-btn" :title="t('common.download')" @click="showExport = !showExport">
        <Download :size="15" />
      </button>
      <ChatExportMenu v-if="showExport" :messages="chatStore.messages" :trigger-el="exportBtn" @close="showExport = false" />

      <span class="hc-chat__toolbar-sep" />

      <!-- 右：控「右侧」产物面板（唯一图标 Boxes + 计数） -->
      <button
        class="hc-chat__toolbar-btn"
        :class="{ 'hc-chat__toolbar-btn--active': workspaceMode === 'artifacts' }"
        :title="t('chat.artifacts')"
        :aria-pressed="workspaceMode === 'artifacts'"
        @click="toggleArtifactsRail"
      >
        <Boxes :size="15" />
        <span v-if="chatStore.artifacts.length > 0" class="hc-chat__artifact-badge">{{ chatStore.artifacts.length }}</span>
      </button>

      <!-- 右：控「右侧」上下文/详情面板（唯一图标 PanelRight，与产物明确区分） -->
      <button
        class="hc-chat__toolbar-btn"
        :class="{ 'hc-chat__toolbar-btn--active': workspaceMode === 'context' }"
        :title="t('chat.contextPanel')"
        :aria-pressed="workspaceMode === 'context'"
        @click="toggleContextRail"
      >
        <PanelRight :size="15" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.hc-chat__toolbar {
  flex-shrink: 0;
  border-bottom: 0.5px solid var(--hc-divider);
  padding: 11px 16px;
}

.hc-chat__toolbar-row {
  height: 30px;
  display: flex;
  align-items: center;
}

.hc-chat__stat-strip {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 6px;
}

.hc-token-badge {
  font-size: 11px;
  color: var(--hc-text-muted);
  white-space: nowrap;
}

.hc-chat__toolbar-btn {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--hc-text-secondary);
  border-radius: 8px;
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
  margin: 0 4px;
}

.hc-chat__artifact-badge {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 13px;
  height: 13px;
  border-radius: 7px;
  background: var(--hc-accent);
  color: var(--hc-text-inverse);
  font-size: 9px;
  line-height: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 3px;
}
</style>
