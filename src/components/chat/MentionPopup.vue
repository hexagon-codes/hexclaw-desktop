<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { Bot, Wrench } from 'lucide-vue-next'
import type { Skill } from '@/types'

interface MentionItem {
  type: 'agent' | 'skill'
  id: string
  name: string
  description?: string
}

const props = defineProps<{
  visible: boolean
  query: string
  agents: { name: string; title?: string; goal?: string }[]
  skills: Skill[]
  position: { bottom: number; left: number }
}>()

const emit = defineEmits<{
  select: [item: MentionItem]
  close: []
}>()

const selectedIndex = ref(0)

const filteredItems = computed<MentionItem[]>(() => {
  const q = props.query.toLowerCase()
  const items: MentionItem[] = []

  for (const a of props.agents) {
    if (!q || a.name.toLowerCase().includes(q)) {
      items.push({ type: 'agent', id: a.name, name: a.title || a.name, description: a.goal })
    }
  }
  for (const s of props.skills) {
    const displayName = s.display_name || s.name
    if (!q || displayName.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)) {
      items.push({ type: 'skill', id: s.name, name: displayName, description: s.description })
    }
  }

  return items.slice(0, 8)
})

watch(() => props.query, () => { selectedIndex.value = 0 })

function handleKeydown(e: KeyboardEvent) {
  if (!props.visible) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectedIndex.value = Math.min(selectedIndex.value + 1, filteredItems.value.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectedIndex.value = Math.max(selectedIndex.value - 1, 0)
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault()
    const item = filteredItems.value[selectedIndex.value]
    if (item) emit('select', item)
  } else if (e.key === 'Escape') {
    emit('close')
  }
}

defineExpose({ handleKeydown })
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible && filteredItems.length > 0"
      class="hc-mention"
      :style="{ bottom: position.bottom + 'px', left: position.left + 'px' }"
    >
      <div
        v-for="(item, idx) in filteredItems"
        :key="item.type + item.id"
        class="hc-mention__item"
        :class="{ 'hc-mention__item--active': idx === selectedIndex }"
        @mouseenter="selectedIndex = idx"
        @click="emit('select', item)"
      >
        <Bot v-if="item.type === 'agent'" :size="14" class="hc-mention__icon hc-mention__icon--agent" />
        <Wrench v-else :size="14" class="hc-mention__icon hc-mention__icon--skill" />
        <div class="hc-mention__text">
          <span class="hc-mention__name">{{ item.name }}</span>
          <span v-if="item.description" class="hc-mention__desc">{{ item.description }}</span>
        </div>
        <span class="hc-mention__badge">{{ item.type === 'agent' ? 'Agent' : 'Skill' }}</span>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.hc-mention {
  position: fixed;
  min-width: 220px;
  max-width: 320px;
  max-height: 240px;
  overflow-y: auto;
  border-radius: var(--hc-radius-md);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-card);
  /* HIG --shadow-md: popup 弹出层柔和阴影 */
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08), 0 2px 4px rgba(0, 0, 0, 0.04);
  z-index: var(--hc-z-popover);
  padding: 4px;
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

.hc-mention__icon--agent {
  color: var(--hc-accent);
}

.hc-mention__icon--skill {
  color: #af52de;
}

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
</style>
