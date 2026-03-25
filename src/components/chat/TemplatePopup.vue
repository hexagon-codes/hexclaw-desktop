<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { FileText, Pin, Plus } from 'lucide-vue-next'
import { dbGetTemplates, dbSearchTemplates, dbTemplateIncrementUse, type PromptTemplate } from '@/db/templates'

const { t } = useI18n()

const props = defineProps<{
  visible: boolean
  query: string
  position: { bottom: number; left: number }
}>()

const emit = defineEmits<{
  select: [content: string]
  close: []
  create: []
}>()

const templates = ref<PromptTemplate[]>([])
const selectedIndex = ref(0)

const filtered = computed(() => {
  if (!props.query) return templates.value
  const q = props.query.toLowerCase()
  return templates.value.filter(
    (t) => t.title.toLowerCase().includes(q) || t.category.toLowerCase().includes(q),
  )
})

watch(() => props.visible, async (v) => {
  if (v) {
    selectedIndex.value = 0
    try {
      templates.value = props.query
        ? await dbSearchTemplates(props.query)
        : await dbGetTemplates()
    } catch {
      templates.value = []
    }
  }
})

watch(() => props.query, async (q) => {
  if (!props.visible) return
  selectedIndex.value = 0
  try {
    templates.value = q ? await dbSearchTemplates(q) : await dbGetTemplates()
  } catch {
    templates.value = []
  }
})

function handleSelect(tpl: PromptTemplate) {
  dbTemplateIncrementUse(tpl.id).catch(() => {})
  emit('select', tpl.content)
}

function handleKeydown(e: KeyboardEvent) {
  const list = filtered.value
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectedIndex.value = Math.min(selectedIndex.value + 1, list.length)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectedIndex.value = Math.max(selectedIndex.value - 1, 0)
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault()
    if (selectedIndex.value < list.length) {
      handleSelect(list[selectedIndex.value]!)
    } else {
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
        <span class="tpl-popup__title">{{ t('chat.templates', 'Prompt 模板') }}</span>
      </div>

      <div class="tpl-popup__list">
        <button
          v-for="(tpl, idx) in filtered"
          :key="tpl.id"
          class="tpl-popup__item"
          :class="{ 'tpl-popup__item--active': idx === selectedIndex }"
          @click="handleSelect(tpl)"
          @mouseenter="selectedIndex = idx"
        >
          <FileText :size="14" class="tpl-popup__icon" />
          <div class="tpl-popup__info">
            <span class="tpl-popup__name">
              <Pin v-if="tpl.pinned" :size="10" style="color: var(--hc-accent); margin-right: 2px" />
              {{ tpl.title }}
            </span>
            <span v-if="tpl.category" class="tpl-popup__cat">{{ tpl.category }}</span>
          </div>
          <span class="tpl-popup__preview">{{ tpl.content.slice(0, 40) }}{{ tpl.content.length > 40 ? '...' : '' }}</span>
        </button>

        <!-- 新建模板 -->
        <button
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
        {{ t('chat.noTemplates', '没有匹配的模板') }}
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

.tpl-popup__cat {
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
  max-width: 120px;
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
