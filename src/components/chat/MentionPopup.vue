<script setup lang="ts">
/**
 * `@` 召唤面板 —— 分栏多实体上下文召唤（全部 / Agent / 知识 / 连接 / 会话）。
 *   - Agent：选中插入 @name（路由到该 Agent，行为不变）
 *   - 知识 / 连接 / 会话：选中作为「上下文引用」挂到本轮（由 ChatInput 解析为 chip + 注入 backendText）
 * 不含「成员」：本应用是单用户本地工作站，多用户协作不在定位内。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { Bot, BookOpen, Plug, MessageSquare } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import type { KnowledgeDoc, ChatSession } from '@/types'
import type { ConnectionSummary } from '@/api/im-channels'

type MentionType = 'agent' | 'knowledge' | 'connection' | 'session'
interface MentionItem {
  type: MentionType
  id: string
  name: string
  description?: string
  meta?: { provider?: string }
}
type TabKey = 'all' | MentionType

const props = defineProps<{
  visible: boolean
  query: string
  position: { bottom: number; left: number }
  agents: { name: string; title?: string; goal?: string }[]
  knowledgeDocs?: KnowledgeDoc[]
  connections?: ConnectionSummary[]
  sessions?: ChatSession[]
}>()

const emit = defineEmits<{
  select: [item: MentionItem]
  close: []
}>()

const { t } = useI18n()
const activeTab = ref<TabKey>('all')
const selectedIndex = ref(0)

const tabs = computed<{ key: TabKey; label: string }[]>(() => [
  { key: 'all', label: t('chat.mentionTabs.all', '全部') },
  { key: 'agent', label: t('chat.mentionTabs.agent', 'Agent') },
  { key: 'knowledge', label: t('chat.mentionTabs.knowledge', '知识') },
  { key: 'connection', label: t('chat.mentionTabs.connection', '连接') },
  { key: 'session', label: t('chat.mentionTabs.session', '会话') },
])

function matches(q: string, ...fields: (string | undefined)[]): boolean {
  if (!q) return true
  return fields.some((f) => (f ?? '').toLowerCase().includes(q))
}

const agentItems = computed<MentionItem[]>(() => {
  const q = props.query.toLowerCase()
  return (props.agents ?? [])
    .filter((a) => matches(q, a.name, a.title))
    .map((a) => ({ type: 'agent' as const, id: a.name, name: a.title || a.name, description: a.goal }))
})
const knowledgeItems = computed<MentionItem[]>(() => {
  const q = props.query.toLowerCase()
  return (props.knowledgeDocs ?? [])
    .filter((d) => matches(q, d.title, d.source))
    .map((d) => ({ type: 'knowledge' as const, id: d.id, name: d.title, description: d.source || `${d.chunk_count} chunks` }))
})
const connectionItems = computed<MentionItem[]>(() => {
  const q = props.query.toLowerCase()
  return (props.connections ?? [])
    .filter((c) => matches(q, c.name, c.provider))
    .map((c) => ({ type: 'connection' as const, id: c.id, name: c.name, description: c.provider, meta: { provider: c.provider } }))
})
const sessionItems = computed<MentionItem[]>(() => {
  const q = props.query.toLowerCase()
  return (props.sessions ?? [])
    .filter((s) => matches(q, s.title))
    .map((s) => ({ type: 'session' as const, id: s.id, name: s.title, description: `${s.message_count} 条` }))
})

/** 当前 tab 下的扁平项（用于键盘导航 + 渲染）。 */
const items = computed<MentionItem[]>(() => {
  switch (activeTab.value) {
    case 'agent': return agentItems.value.slice(0, 12)
    case 'knowledge': return knowledgeItems.value.slice(0, 12)
    case 'connection': return connectionItems.value.slice(0, 12)
    case 'session': return sessionItems.value.slice(0, 12)
    default:
      return [
        ...agentItems.value.slice(0, 5),
        ...knowledgeItems.value.slice(0, 5),
        ...connectionItems.value.slice(0, 5),
        ...sessionItems.value.slice(0, 5),
      ]
  }
})

/** 全部 tab 下分组渲染的边界（首项出现处加分组头）。 */
const groupStartIds = computed(() => {
  if (activeTab.value !== 'all') return new Set<string>()
  const starts = new Set<string>()
  let prev: MentionType | null = null
  for (const it of items.value) {
    if (it.type !== prev) {
      starts.add(it.type + ':' + it.id)
      prev = it.type
    }
  }
  return starts
})

function iconFor(type: MentionType) {
  return type === 'agent' ? Bot : type === 'knowledge' ? BookOpen : type === 'connection' ? Plug : MessageSquare
}
function badgeFor(type: MentionType): string {
  return type === 'agent'
    ? t('chat.mentionTabs.agent', 'Agent')
    : type === 'knowledge'
      ? t('chat.mentionTabs.knowledge', '知识')
      : type === 'connection'
        ? t('chat.mentionTabs.connection', '连接')
        : t('chat.mentionTabs.session', '会话')
}
function groupLabel(type: MentionType): string {
  return badgeFor(type)
}

watch(() => props.query, () => { selectedIndex.value = 0 })
watch(() => props.visible, (v) => { if (v) { activeTab.value = 'all'; selectedIndex.value = 0 } })
watch(activeTab, () => { selectedIndex.value = 0 })

function setTab(tab: TabKey) {
  activeTab.value = tab
}

function handleKeydown(e: KeyboardEvent) {
  if (!props.visible) return
  const list = items.value
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectedIndex.value = Math.min(selectedIndex.value + 1, list.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectedIndex.value = Math.max(selectedIndex.value - 1, 0)
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault()
    const item = list[selectedIndex.value]
    if (item) emit('select', item)
  } else if (e.key === 'Escape') {
    emit('close')
  }
}

// 点击弹层外的空白区域 → 关闭（与 HcSelect/SplitButton 等下拉一致）。捕获阶段拦
// mousedown，避免被子元素 stopPropagation 吞掉；仅 visible 时生效。
const rootEl = ref<HTMLElement>()
function onClickOutside(e: MouseEvent) {
  if (!props.visible) return
  if (rootEl.value?.contains(e.target as Node)) return
  emit('close')
}
onMounted(() => document.addEventListener('mousedown', onClickOutside, true))
onBeforeUnmount(() => document.removeEventListener('mousedown', onClickOutside, true))

defineExpose({ handleKeydown })
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="rootEl"
      class="hc-mention"
      :style="{ bottom: position.bottom + 'px', left: position.left + 'px' }"
    >
      <!-- 分栏 tab -->
      <div class="hc-mention__tabs">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          class="hc-mention__tab"
          :class="{ 'hc-mention__tab--active': activeTab === tab.key }"
          @mousedown.prevent="setTab(tab.key)"
        >
          {{ tab.label }}
        </button>
      </div>

      <div class="hc-mention__list">
        <template v-for="(item, idx) in items" :key="item.type + ':' + item.id">
          <div v-if="groupStartIds.has(item.type + ':' + item.id)" class="hc-mention__group">
            {{ groupLabel(item.type) }}
          </div>
          <div
            class="hc-mention__item"
            :class="{ 'hc-mention__item--active': idx === selectedIndex }"
            @mouseenter="selectedIndex = idx"
            @click="emit('select', item)"
          >
            <component :is="iconFor(item.type)" :size="14" class="hc-mention__icon" :class="`hc-mention__icon--${item.type}`" />
            <div class="hc-mention__text">
              <span class="hc-mention__name">{{ item.name }}</span>
              <span v-if="item.description" class="hc-mention__desc">{{ item.description }}</span>
            </div>
            <span class="hc-mention__badge">{{ badgeFor(item.type) }}</span>
          </div>
        </template>

        <div v-if="items.length === 0" class="hc-mention__empty">
          {{ t('chat.palette.noMatch', '没有匹配项') }}
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.hc-mention {
  position: fixed;
  min-width: 260px;
  max-width: 340px;
  max-height: 300px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: var(--hc-radius-md);
  border: 1px solid var(--hc-border);
  /* 浮层须用不透明的「悬浮面」令牌，否则下方聊天内容透出来糊成一片（与 TemplatePopup 一致）。 */
  background: var(--hc-bg-elevated);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08), 0 2px 4px rgba(0, 0, 0, 0.04);
  z-index: var(--hc-z-popover);
}

.hc-mention__tabs {
  display: flex;
  gap: 2px;
  padding: 6px 6px 4px;
  border-bottom: 1px solid var(--hc-divider);
}

.hc-mention__tab {
  flex: none;
  padding: 3px 9px;
  font-size: 12px;
  font-weight: 500;
  color: var(--hc-text-muted);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.1s, color 0.1s;
}

.hc-mention__tab:hover {
  background: var(--hc-bg-hover);
}

.hc-mention__tab--active {
  color: var(--hc-text-primary);
  background: var(--hc-bg-active);
}

.hc-mention__list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}

.hc-mention__group {
  padding: 6px 8px 2px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--hc-text-muted);
}

.hc-mention__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--hc-radius-sm);
  cursor: pointer;
  transition: background 0.1s;
}

.hc-mention__item:hover,
.hc-mention__item--active {
  background: var(--hc-bg-hover);
}

.hc-mention__icon {
  flex-shrink: 0;
}
.hc-mention__icon--agent { color: var(--hc-accent); }
.hc-mention__icon--knowledge { color: #34c759; }
.hc-mention__icon--connection { color: #ff9f0a; }
.hc-mention__icon--session { color: #5e5ce6; }

.hc-mention__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.hc-mention__name {
  font-size: 12px;
  font-weight: 500;
  color: var(--hc-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hc-mention__desc {
  font-size: 11px;
  color: var(--hc-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hc-mention__badge {
  font-size: 10px;
  font-weight: 500;
  padding: 1px 5px;
  border-radius: 3px;
  color: var(--hc-text-muted);
  background: var(--hc-bg-active);
  flex-shrink: 0;
}

.hc-mention__empty {
  padding: 16px;
  text-align: center;
  font-size: 12px;
  color: var(--hc-text-muted);
}
</style>
