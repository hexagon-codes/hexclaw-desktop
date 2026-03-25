<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Search, Download, PanelRightOpen, MessageSquarePlus } from 'lucide-vue-next'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import ChatExportMenu from '@/components/chat/ChatExportMenu.vue'
import { useChatStore } from '@/stores/chat'
import { useAppStore } from '@/stores/app'
import { ref, computed } from 'vue'

const { t } = useI18n()
const chatStore = useChatStore()
const appStore = useAppStore()

const activeTab = defineModel<'chat' | 'artifacts' | 'history'>('activeTab', { required: true })
const showSessions = defineModel<boolean>('showSessions', { required: true })

const showExport = ref(false)

const emit = defineEmits<{
  search: []
}>()

const segments = computed(() => [
  { key: 'chat' as const, label: t('chat.chat') },
  { key: 'artifacts' as const, label: t('chat.artifacts') },
  { key: 'history' as const, label: t('chat.history') },
])

defineProps<{
  messageCount: number
  tokenBadge: string
}>()
</script>

<template>
  <div class="hc-chat__toolbar">
    <div class="hc-chat__toolbar-row">
      <SegmentedControl v-model="activeTab" :segments="segments" />

      <div class="hc-chat__stat-strip">
        <span v-if="messageCount > 0" class="hc-token-badge" :title="tokenBadge">
          {{ messageCount }} {{ t('chat.messagesStat') }} · {{ tokenBadge }}
        </span>
      </div>

      <div style="flex: 1" />

      <button v-if="messageCount > 0" class="hc-chat__toolbar-btn" :title="t('common.search') + ' (⌘F)'" @click="emit('search')">
        <Search :size="14" />
      </button>
      <button v-if="messageCount > 0" class="hc-chat__toolbar-btn" :title="t('common.download')" @click="showExport = !showExport">
        <Download :size="14" />
      </button>
      <ChatExportMenu v-if="showExport" :messages="chatStore.messages" @close="showExport = false" />

      <button class="hc-chat__toolbar-btn" :class="{ 'hc-chat__toolbar-btn--active': chatStore.showArtifacts }" :title="t('chat.artifacts')" @click="chatStore.showArtifacts = !chatStore.showArtifacts">
        <PanelRightOpen :size="14" />
        <span v-if="chatStore.artifacts.length > 0" class="hc-chat__artifact-badge">{{ chatStore.artifacts.length }}</span>
      </button>

      <span class="hc-chat__toolbar-sep" />

      <button class="hc-chat__toolbar-btn" :class="{ 'hc-chat__toolbar-btn--active': showSessions }" :title="t('chat.toggleSessions')" @click="showSessions = !showSessions">
        <MessageSquarePlus :size="14" />
      </button>

      <button class="hc-chat__toolbar-btn" :title="t('chat.contextPanel')" @click="appStore.toggleDetailPanel">
        <PanelRightOpen :size="14" />
      </button>
    </div>
  </div>
</template>
