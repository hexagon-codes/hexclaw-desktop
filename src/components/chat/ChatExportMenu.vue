<script setup lang="ts">
import { FileText, FileJson, X } from 'lucide-vue-next'

const props = defineProps<{
  messages: { id: string; role: string; content: string; timestamp: string; agent_name?: string }[]
  sessionTitle?: string
}>()

const emit = defineEmits<{
  close: []
}>()

function exportMarkdown() {
  const title = props.sessionTitle || '对话记录'
  let md = `# ${title}\n\n`
  md += `> 导出时间: ${new Date().toLocaleString()}\n\n---\n\n`
  for (const msg of props.messages) {
    const who = msg.role === 'user' ? '**用户**' : `**${msg.agent_name || 'Agent'}**`
    const time = new Date(msg.timestamp).toLocaleString()
    md += `### ${who} · ${time}\n\n${msg.content}\n\n---\n\n`
  }
  download(md, `${title}.md`, 'text/markdown')
  emit('close')
}

function exportJSON() {
  const title = props.sessionTitle || '对话记录'
  const data = {
    title,
    exported_at: new Date().toISOString(),
    message_count: props.messages.length,
    messages: props.messages.map(m => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      agent_name: m.agent_name,
    })),
  }
  download(JSON.stringify(data, null, 2), `${title}.json`, 'application/json')
  emit('close')
}

function download(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="hc-export-menu">
    <div class="hc-export-menu__header">
      <span class="hc-export-menu__title">导出对话</span>
      <button class="hc-export-menu__close" @click="emit('close')">
        <X :size="14" />
      </button>
    </div>
    <button class="hc-export-menu__item" @click="exportMarkdown">
      <FileText :size="16" />
      <div class="hc-export-menu__info">
        <span class="hc-export-menu__name">Markdown</span>
        <span class="hc-export-menu__desc">导出为 .md 文件，适合阅读和分享</span>
      </div>
    </button>
    <button class="hc-export-menu__item" @click="exportJSON">
      <FileJson :size="16" />
      <div class="hc-export-menu__info">
        <span class="hc-export-menu__name">JSON</span>
        <span class="hc-export-menu__desc">导出为 .json 文件，适合数据处理</span>
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
  z-index: 20;
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
