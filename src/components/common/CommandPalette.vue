<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch, type Component } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Search, MessageSquare, Bot, Clock, Puzzle, BookOpen, Brain, Server, ScrollText, Layout, Settings, MessageCircle, Users, Sun, Plus, BarChart3 } from 'lucide-vue-next'
import { useChatStore } from '@/stores/chat'

const router = useRouter()
const { t } = useI18n()
const chatStore = useChatStore()

const visible = ref(false)
const query = ref('')
const selectedIdx = ref(0)
const inputRef = ref<HTMLInputElement>()

interface CmdItem {
  id: string
  label: string
  icon: Component
  action: () => void
  keywords?: string
  group?: string
}

function toggleTheme() {
  const root = document.documentElement
  const current = root.getAttribute('data-theme')
  root.setAttribute('data-theme', current === 'dark' ? 'light' : 'dark')
  localStorage.setItem('hexclaw-theme', current === 'dark' ? 'light' : 'dark')
}

const allItems = computed<CmdItem[]>(() => [
  // Navigation
  { id: 'chat', label: t('nav.chat'), icon: MessageSquare, action: () => router.push('/chat'), keywords: 'chat 聊天 对话', group: '导航' },
  { id: 'agents', label: t('nav.agents'), icon: Bot, action: () => router.push('/agents'), keywords: 'agents 智能体 角色', group: '导航' },
  { id: 'tasks', label: t('nav.tasks'), icon: Clock, action: () => router.push('/tasks'), keywords: 'tasks 任务 定时 cron', group: '导航' },
  { id: 'skills', label: t('nav.skills'), icon: Puzzle, action: () => router.push('/skills'), keywords: 'skills 技能 插件', group: '导航' },
  { id: 'knowledge', label: t('nav.knowledge'), icon: BookOpen, action: () => router.push('/knowledge'), keywords: 'knowledge 知识库 文档', group: '导航' },
  { id: 'memory', label: t('nav.memory'), icon: Brain, action: () => router.push('/memory'), keywords: 'memory 记忆', group: '导航' },
  { id: 'mcp', label: t('nav.mcp'), icon: Server, action: () => router.push('/mcp'), keywords: 'mcp server 服务器', group: '导航' },
  { id: 'im-channels', label: t('nav.imChannels'), icon: MessageCircle, action: () => router.push('/im-channels'), keywords: 'im channels 通道 飞书 钉钉 slack', group: '导航' },
  { id: 'logs', label: t('nav.logs'), icon: ScrollText, action: () => router.push('/logs'), keywords: 'logs 日志', group: '导航' },
  { id: 'canvas', label: t('nav.canvas'), icon: Layout, action: () => router.push('/canvas'), keywords: 'canvas 画布 工作流', group: '导航' },
  { id: 'team', label: t('nav.team'), icon: Users, action: () => router.push('/team'), keywords: 'team 团队 协作', group: '导航' },
  { id: 'dashboard', label: t('nav.dashboard'), icon: BarChart3, action: () => router.push('/dashboard'), keywords: 'dashboard 概览 首页', group: '导航' },
  { id: 'settings', label: t('nav.settings'), icon: Settings, action: () => router.push('/settings'), keywords: 'settings 设置 偏好', group: '导航' },
  // Actions
  { id: 'new-chat', label: '新建对话', icon: Plus, action: () => { chatStore.newSession(); router.push('/chat') }, keywords: 'new chat 新建 对话 会话', group: '操作' },
  { id: 'toggle-theme', label: '切换主题', icon: Sun, action: toggleTheme, keywords: 'theme 主题 深色 浅色 dark light toggle', group: '操作' },
])

const filtered = computed(() => {
  const q = query.value.toLowerCase().trim()
  if (!q) return allItems.value
  return allItems.value.filter(item =>
    item.label.toLowerCase().includes(q) ||
    item.id.includes(q) ||
    (item.keywords && item.keywords.toLowerCase().includes(q))
  )
})

watch(filtered, () => {
  selectedIdx.value = 0
})

function open() {
  visible.value = true
  query.value = ''
  selectedIdx.value = 0
  nextTick(() => inputRef.value?.focus())
}

function close() {
  visible.value = false
}

function execute(item: CmdItem) {
  item.action()
  close()
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectedIdx.value = Math.min(selectedIdx.value + 1, filtered.value.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectedIdx.value = Math.max(selectedIdx.value - 1, 0)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const item = filtered.value[selectedIdx.value]
    if (item) execute(item)
  } else if (e.key === 'Escape') {
    close()
  }
}

function handleGlobalKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault()
    if (visible.value) close()
    else open()
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleGlobalKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleGlobalKeydown)
})

defineExpose({ open, close })
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="hc-cmd--enter"
      leave-active-class="hc-cmd--leave"
      enter-from-class="hc-cmd--hidden"
      leave-to-class="hc-cmd--hidden"
    >
      <div v-if="visible" class="hc-cmd-overlay" @click.self="close">
        <div class="hc-cmd">
          <div class="hc-cmd__input-wrap">
            <Search :size="16" class="hc-cmd__search-icon" />
            <input
              ref="inputRef"
              v-model="query"
              class="hc-cmd__input"
              placeholder="搜索页面、功能..."
              @keydown="handleKeydown"
            />
            <kbd class="hc-cmd__kbd">ESC</kbd>
          </div>

          <div v-if="filtered.length" class="hc-cmd__list">
            <template v-for="(item, idx) in filtered" :key="item.id">
              <div
                v-if="idx === 0 || filtered[idx - 1]?.group !== item.group"
                class="hc-cmd__group-label"
              >
                {{ item.group || '其他' }}
              </div>
              <button
                class="hc-cmd__item"
                :class="{ 'hc-cmd__item--active': idx === selectedIdx }"
                @click="execute(item)"
                @mouseenter="selectedIdx = idx"
              >
                <component :is="item.icon" :size="16" class="hc-cmd__item-icon" />
                <span>{{ item.label }}</span>
              </button>
            </template>
          </div>
          <div v-else class="hc-cmd__empty">
            无匹配结果
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.hc-cmd-overlay {
  position: fixed;
  top: var(--hc-titlebar-height);
  left: 0;
  right: 0;
  bottom: 0;
  z-index: var(--hc-z-modal);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 16vh;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.hc-cmd {
  width: 100%;
  max-width: 480px;
  border-radius: var(--hc-radius-lg);
  background: var(--hc-bg-elevated);
  border: 1px solid var(--hc-border);
  box-shadow: var(--hc-shadow-float);
  overflow: hidden;
}

.hc-cmd__input-wrap {
  display: flex;
  align-items: center;
  gap: var(--hc-space-3);
  padding: 12px 16px;
  border-bottom: 1px solid var(--hc-divider);
}

.hc-cmd__search-icon {
  flex-shrink: 0;
  color: var(--hc-text-muted);
}

.hc-cmd__input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 15px;
  color: var(--hc-text-primary);
}

.hc-cmd__input::placeholder {
  color: var(--hc-text-muted);
}

.hc-cmd__kbd {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--hc-bg-hover);
  color: var(--hc-text-muted);
  font-family: inherit;
  border: 1px solid var(--hc-border);
}

.hc-cmd__list {
  max-height: 320px;
  overflow-y: auto;
  padding: 6px;
}

.hc-cmd__item {
  display: flex;
  align-items: center;
  gap: var(--hc-space-3);
  width: 100%;
  padding: 8px 12px;
  border: none;
  border-radius: var(--hc-radius-sm);
  background: transparent;
  color: var(--hc-text-primary);
  font-size: 14px;
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;
}

.hc-cmd__item--active {
  background: var(--hc-accent);
  color: #fff;
}

.hc-cmd__item-icon {
  flex-shrink: 0;
  opacity: 0.7;
}

.hc-cmd__item--active .hc-cmd__item-icon {
  opacity: 1;
}

.hc-cmd__group-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--hc-text-muted);
  padding: 6px 12px 2px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.hc-cmd__empty {
  padding: 24px;
  text-align: center;
  font-size: 13px;
  color: var(--hc-text-muted);
}

.hc-cmd--enter {
  transition: opacity 0.15s ease-out;
}

.hc-cmd--leave {
  transition: opacity 0.1s ease-in;
}

.hc-cmd--hidden {
  opacity: 0;
}
</style>
