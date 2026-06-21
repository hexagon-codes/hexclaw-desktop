<script setup lang="ts">
/**
 * 统一命令面板（斜杠 `/` + ✨Prompt 按钮 + 🔧Skill 按钮 共用）。
 *   - scope='all'：Skill + Prompt 一起列（`/` 召回）
 *   - scope='skills'：只列 Skill（🔧 按钮召回）
 *   - scope='prompts'：只列 Prompt（✨ 按钮召回）
 * 选中 skill → 抛 {kind:'skill', name}（ChatInput 插 @name）；
 * 选中 prompt → 抛 {kind:'prompt', content}（ChatInput 插正文，含 $ARGUMENTS 填参）。
 * Prompt 数据 = 服务端 Prompt 库（运营增删不发版）+ 本地模板；Skill 数据由父组件传入。
 */
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { FileText, Pin, Plus, Wrench } from 'lucide-vue-next'
import { getPrompts } from '@/api/prompts'
import type { Skill } from '@/types'

// Template storage migrated from SQLite to localStorage
interface PromptTemplate {
  id: string
  title: string
  content: string
  category: string
  useCount: number
  pinned: boolean
  createdAt: string
  updatedAt: string
}

/** 统一命令项：skill 或 prompt。 */
interface PaletteItem {
  kind: 'skill' | 'prompt'
  id: string
  title: string
  desc?: string
  /** prompt 正文（插入用）。 */
  content?: string
  /** skill 名（@name 插入用）。 */
  name?: string
  pinned?: boolean
}

const TEMPLATES_KEY = 'hexclaw_prompt_templates'

function loadTemplatesFromStorage(): PromptTemplate[] {
  try {
    const raw = localStorage.getItem(TEMPLATES_KEY)
    if (!raw) return []
    return JSON.parse(raw) as PromptTemplate[]
  } catch {
    return []
  }
}

function saveTemplatesToStorage(templates: PromptTemplate[]): void {
  localStorage.setItem(TEMPLATES_KEY, JSON.stringify(templates))
}

function dbGetTemplates(): PromptTemplate[] {
  const all = loadTemplatesFromStorage()
  return all.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.useCount - a.useCount
  })
}

function dbSearchTemplates(query: string): PromptTemplate[] {
  const q = query.toLowerCase()
  return dbGetTemplates().filter(
    t => t.title.toLowerCase().includes(q) || t.content.toLowerCase().includes(q) || t.category.toLowerCase().includes(q),
  )
}

// §11.8：服务端 Prompt 库（运营增删不发版）映射成 PromptTemplate 形态，与本地模板合并。
// 服务端条目 id 以 "pr-" 开头，用于在 handleSelect 跳过本地 useCount 自增。
async function fetchServerTemplates(query: string): Promise<PromptTemplate[]> {
  try {
    const list = (await getPrompts()).prompts ?? []
    const q = query.toLowerCase()
    return list
      .map((p) => ({
        id: p.id, title: p.title, content: p.body_md, category: p.category || p.type,
        useCount: 0, pinned: false, createdAt: p.updated_at, updatedAt: p.updated_at,
      }))
      .filter((t) => !q || t.title.toLowerCase().includes(q) || t.content.toLowerCase().includes(q) || t.category.toLowerCase().includes(q))
  } catch {
    return [] // 离线 / 后端未启用 → 只用本地模板
  }
}

// loadMerged 合并服务端 Prompt 库（在前）+ 本地模板。服务端不可用时退化为纯本地。
async function loadMerged(query: string): Promise<PromptTemplate[]> {
  const local = query ? dbSearchTemplates(query) : dbGetTemplates()
  const server = await fetchServerTemplates(query)
  return [...server, ...local]
}

function dbTemplateIncrementUse(id: string): void {
  const all = loadTemplatesFromStorage()
  const tpl = all.find(t => t.id === id)
  if (tpl) {
    tpl.useCount++
    tpl.updatedAt = new Date().toISOString()
    saveTemplatesToStorage(all)
  }
}

const { t } = useI18n()

const props = withDefaults(defineProps<{
  visible: boolean
  query: string
  position: { bottom: number; left: number }
  skills?: Skill[]
  /** 面板范围：all=斜杠召回(Skill+Prompt) / skills=🔧按钮 / prompts=✨按钮 */
  scope?: 'all' | 'skills' | 'prompts'
}>(), { skills: () => [], scope: 'all' })

const emit = defineEmits<{
  select: [item: PaletteItem]
  close: []
  create: []
}>()

const templates = ref<PromptTemplate[]>([])
const selectedIndex = ref(0)

// Skill 项（按 query 过滤）——scope=prompts 时不参与。
const skillItems = computed<PaletteItem[]>(() => {
  if (props.scope === 'prompts') return []
  const q = props.query.toLowerCase()
  return (props.skills ?? [])
    .filter((s) => {
      const dn = (s.display_name || s.name).toLowerCase()
      return !q || dn.includes(q) || s.name.toLowerCase().includes(q)
    })
    .map((s) => ({ kind: 'skill' as const, id: `skill:${s.name}`, title: s.display_name || s.name, desc: s.description, name: s.name }))
})

// Prompt 项（scope=skills 时不参与）。
const promptItems = computed<PaletteItem[]>(() => {
  if (props.scope === 'skills') return []
  const q = props.query.toLowerCase()
  return templates.value
    .filter((tpl) => !q || tpl.title.toLowerCase().includes(q) || tpl.category.toLowerCase().includes(q))
    .map((tpl) => ({ kind: 'prompt' as const, id: tpl.id, title: tpl.title, desc: tpl.content, content: tpl.content, pinned: tpl.pinned }))
})

// 统一列表：Skill 在前、Prompt 在后。
const filtered = computed<PaletteItem[]>(() => [...skillItems.value, ...promptItems.value])

// 是否显示「新建模板」（仅 prompt 语义；纯 skills 范围不显示）。
const showCreate = computed(() => props.scope !== 'skills')

const headerTitle = computed(() => {
  if (props.scope === 'skills') return t('chat.palette.skills', 'Skill')
  if (props.scope === 'prompts') return t('chat.templates', 'Prompt 模板')
  return t('chat.palette.all', '命令 · Skill / Prompt')
})

async function reload(query: string) {
  selectedIndex.value = 0
  if (props.scope === 'skills') { templates.value = []; return } // 纯 skill 范围不必拉 prompt
  try {
    templates.value = await loadMerged(query)
  } catch {
    templates.value = []
  }
}

watch(() => props.visible, (v) => { if (v) reload(props.query) })
watch(() => props.query, (q) => { if (props.visible) reload(q) })

function handleSelect(item: PaletteItem) {
  if (item.kind === 'prompt' && !item.id.startsWith('pr-')) dbTemplateIncrementUse(item.id) // 服务端条目无本地 useCount
  emit('select', item)
}

function handleKeydown(e: KeyboardEvent) {
  const list = filtered.value
  const createIdx = showCreate.value ? list.length : -1
  const maxIdx = showCreate.value ? list.length : Math.max(0, list.length - 1)
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectedIndex.value = Math.min(selectedIndex.value + 1, maxIdx)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectedIndex.value = Math.max(selectedIndex.value - 1, 0)
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault()
    if (selectedIndex.value < list.length) {
      handleSelect(list[selectedIndex.value]!)
    } else if (selectedIndex.value === createIdx) {
      emit('create')
    }
  } else if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}

defineExpose({ handleKeydown })
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="tpl-popup"
      :style="{ bottom: position.bottom + 'px', left: position.left + 'px' }"
    >
      <div class="tpl-popup__header">
        <span class="tpl-popup__title">{{ headerTitle }}</span>
      </div>

      <div class="tpl-popup__list">
        <button
          v-for="(item, idx) in filtered"
          :key="item.id"
          class="tpl-popup__item"
          :class="{ 'tpl-popup__item--active': idx === selectedIndex }"
          @click="handleSelect(item)"
          @mouseenter="selectedIndex = idx"
        >
          <Wrench v-if="item.kind === 'skill'" :size="14" class="tpl-popup__icon tpl-popup__icon--skill" />
          <FileText v-else :size="14" class="tpl-popup__icon" />
          <div class="tpl-popup__info">
            <span class="tpl-popup__name">
              <Pin v-if="item.pinned" :size="10" style="color: var(--hc-accent); margin-right: 2px" />
              {{ item.title }}
            </span>
            <span class="tpl-popup__badge">{{ item.kind === 'skill' ? 'Skill' : 'Prompt' }}</span>
          </div>
          <span v-if="item.desc" class="tpl-popup__preview">{{ item.desc.slice(0, 40) }}{{ item.desc.length > 40 ? '…' : '' }}</span>
        </button>

        <!-- 新建模板（prompt 语义；🔧 纯 skill 范围隐藏） -->
        <button
          v-if="showCreate"
          class="tpl-popup__item tpl-popup__item--create"
          :class="{ 'tpl-popup__item--active': selectedIndex === filtered.length }"
          @click="emit('create')"
          @mouseenter="selectedIndex = filtered.length"
        >
          <Plus :size="14" class="tpl-popup__icon" />
          <span class="tpl-popup__name">{{ t('chat.newTemplate', '新建模板') }}</span>
        </button>
      </div>

      <div v-if="filtered.length === 0 && query" class="tpl-popup__empty">
        {{ t('chat.palette.noMatch', '没有匹配项') }}
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.tpl-popup {
  position: fixed;
  z-index: 1000;
  width: 340px;
  max-height: 320px;
  background: var(--hc-bg-elevated);
  border: 1px solid var(--hc-border);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tpl-popup__header {
  padding: 8px 12px 4px;
  border-bottom: 1px solid var(--hc-divider);
}

.tpl-popup__title {
  font-size: 11px;
  font-weight: 600;
  color: var(--hc-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.tpl-popup__list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}

.tpl-popup__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  background: transparent;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.1s;
  text-align: left;
}

.tpl-popup__item:hover,
.tpl-popup__item--active {
  background: var(--hc-bg-hover);
}

.tpl-popup__icon {
  color: var(--hc-text-muted);
  flex-shrink: 0;
}

.tpl-popup__icon--skill {
  color: #af52de;
}

.tpl-popup__info {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.tpl-popup__name {
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: flex;
  align-items: center;
}

.tpl-popup__badge {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--hc-bg-active);
  color: var(--hc-text-muted);
  flex-shrink: 0;
}

.tpl-popup__preview {
  font-size: 11px;
  color: var(--hc-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 110px;
  flex-shrink: 0;
}

.tpl-popup__item--create {
  border-top: 1px solid var(--hc-divider);
  margin-top: 2px;
  padding-top: 10px;
}

.tpl-popup__item--create .tpl-popup__icon {
  color: var(--hc-accent);
}

.tpl-popup__item--create .tpl-popup__name {
  color: var(--hc-accent);
}

.tpl-popup__empty {
  padding: 16px;
  text-align: center;
  font-size: 12px;
  color: var(--hc-text-muted);
}
</style>
