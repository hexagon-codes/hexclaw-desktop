<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { FileText, FileJson, FileType, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { exportConversationSnapshot } from './conversation-export'
import type { ConversationExportFormat } from './conversation-export'
import { useToast } from '@/composables/useToast'

const { t } = useI18n()
const toast = useToast()
const exporting = ref(false)

const props = defineProps<{
  messages: { id: string; role: string; content: string; timestamp: string; agent_name?: string }[]
  sessionTitle?: string
  /** 开关按钮元素：排除它，避免「开关按钮重开」死循环（mousedown 关→click 又切回开）。 */
  triggerEl?: HTMLElement | null
}>()

const emit = defineEmits<{
  close: []
}>()

// 点击菜单外的空白区域 → 关闭（与 HcSelect/SplitButton 等下拉一致）。捕获阶段拦
// mousedown；排除菜单本体 + 开关按钮（后者是 toggle，否则点它会关后又被 click 重开）。
const rootEl = ref<HTMLElement>()
function onClickOutside(e: MouseEvent) {
  const target = e.target as Node
  if (rootEl.value?.contains(target)) return
  if (props.triggerEl?.contains(target)) return
  emit('close')
}
onMounted(() => document.addEventListener('mousedown', onClickOutside, true))
onBeforeUnmount(() => document.removeEventListener('mousedown', onClickOutside, true))

async function exportFormat(format: ConversationExportFormat) {
  if (exporting.value) return
  exporting.value = true
  try {
    await exportConversationSnapshot({
      format,
      title: props.sessionTitle || t('chat.title'),
      messages: props.messages,
      exportedAtLabel: t('chat.exportedAt'),
      userLabel: t('chat.exportUser'),
      assistantLabel: t('chat.modeAgent'),
    })
    emit('close')
  } catch (cause) {
    toast.error(cause instanceof Error ? cause.message : String(cause))
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <div ref="rootEl" class="hc-export-menu">
    <div class="hc-export-menu__header">
      <span class="hc-export-menu__title">{{ t('chat.exportConversation') }}</span>
      <button class="hc-export-menu__close" @click="emit('close')">
        <X :size="14" />
      </button>
    </div>
    <button class="hc-export-menu__item" :disabled="exporting" @click="exportFormat('markdown')">
      <FileText :size="16" />
      <div class="hc-export-menu__info">
        <span class="hc-export-menu__name">Markdown</span>
        <span class="hc-export-menu__desc">{{ t('chat.exportMarkdownDesc') }}</span>
      </div>
    </button>
    <button class="hc-export-menu__item" :disabled="exporting" @click="exportFormat('json')">
      <FileJson :size="16" />
      <div class="hc-export-menu__info">
        <span class="hc-export-menu__name">JSON</span>
        <span class="hc-export-menu__desc">{{ t('chat.exportJsonDesc') }}</span>
      </div>
    </button>
    <button class="hc-export-menu__item" :disabled="exporting" @click="exportFormat('pdf')">
      <FileType :size="16" />
      <div class="hc-export-menu__info">
        <span class="hc-export-menu__name">PDF</span>
        <span class="hc-export-menu__desc">{{ t('chat.exportPdfDesc') }}</span>
      </div>
    </button>
  </div>
</template>

<style scoped>
.hc-export-menu {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 260px;
  border-radius: var(--hc-radius-lg);
  background: var(--hc-bg-elevated);
  border: 1px solid var(--hc-border);
  box-shadow: var(--hc-shadow-float);
  z-index: var(--hc-z-dropdown);
  overflow: hidden;
  animation: hc-scale-in 0.15s ease-out;
}

.hc-export-menu__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--hc-divider);
}

.hc-export-menu__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--hc-text-primary);
}

.hc-export-menu__close {
  padding: 2px;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  border-radius: var(--hc-radius-sm);
}

.hc-export-menu__item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 14px;
  border: none;
  background: transparent;
  color: var(--hc-text-secondary);
  cursor: pointer;
  text-align: left;
  transition: background 0.15s;
}

.hc-export-menu__item:hover {
  background: var(--hc-bg-hover);
}

.hc-export-menu__info {
  display: flex;
  flex-direction: column;
}

.hc-export-menu__name {
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-primary);
}

.hc-export-menu__desc {
  font-size: 11px;
  color: var(--hc-text-muted);
}
</style>
