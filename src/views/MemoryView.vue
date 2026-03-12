<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Brain, Trash2, Clock, Tag, CheckSquare, Square } from 'lucide-vue-next'
import { getMemories, searchMemory, deleteMemory, clearMemory, type MemoryEntry } from '@/api/memory'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import SearchInput from '@/components/common/SearchInput.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const { t } = useI18n()

const memories = ref<MemoryEntry[]>([])
const loading = ref(true)
const searchQuery = ref('')
const activeType = ref('')
const selectedIds = ref<Set<string>>(new Set())
const showClearConfirm = ref(false)

const memoryTypes = computed(() => {
  const types = new Set(memories.value.map((m) => m.type))
  return ['', ...Array.from(types)]
})

const filteredMemories = computed(() => {
  if (!activeType.value) return memories.value
  return memories.value.filter((m) => m.type === activeType.value)
})

const isAllSelected = computed(() =>
  filteredMemories.value.length > 0 && filteredMemories.value.every((m) => selectedIds.value.has(m.id)),
)

onMounted(async () => {
  await loadMemories()
})

async function loadMemories() {
  loading.value = true
  try {
    const res = await getMemories()
    memories.value = res.memories || []
  } catch (e) {
    console.error('加载记忆失败:', e)
  } finally {
    loading.value = false
  }
}

async function handleSearch(query: string) {
  searchQuery.value = query
  if (!query.trim()) {
    await loadMemories()
    return
  }
  loading.value = true
  try {
    const res = await searchMemory(query)
    memories.value = res.memories || []
  } catch (e) {
    console.error('搜索记忆失败:', e)
  } finally {
    loading.value = false
  }
}

async function handleDelete(entry: MemoryEntry) {
  try {
    await deleteMemory(entry.id)
    memories.value = memories.value.filter((m) => m.id !== entry.id)
    selectedIds.value.delete(entry.id)
  } catch (e) {
    console.error('删除记忆失败:', e)
  }
}

async function handleBatchDelete() {
  const ids = Array.from(selectedIds.value)
  for (const id of ids) {
    try {
      await deleteMemory(id)
      memories.value = memories.value.filter((m) => m.id !== id)
    } catch (e) {
      console.error('批量删除失败:', e)
    }
  }
  selectedIds.value.clear()
}

async function handleClearAll() {
  try {
    await clearMemory()
    memories.value = []
    selectedIds.value.clear()
  } catch (e) {
    console.error('清空记忆失败:', e)
  }
  showClearConfirm.value = false
}

function toggleSelect(id: string) {
  if (selectedIds.value.has(id)) {
    selectedIds.value.delete(id)
  } else {
    selectedIds.value.add(id)
  }
}

function toggleSelectAll() {
  if (isAllSelected.value) {
    selectedIds.value.clear()
  } else {
    for (const m of filteredMemories.value) {
      selectedIds.value.add(m.id)
    }
  }
}

function formatTime(ts: string): string {
  const d = new Date(ts)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return t('memory.justNow')
  if (mins < 60) return t('memory.minutesAgo', { n: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('memory.hoursAgo', { n: hours })
  const days = Math.floor(hours / 24)
  if (days < 7) return t('memory.daysAgo', { n: days })
  return d.toLocaleDateString()
}

function typeColor(type: string): string {
  const colors: Record<string, string> = {
    episodic: '#3b82f6',
    semantic: '#8b5cf6',
    procedural: '#10b981',
    fact: '#f59e0b',
  }
  return colors[type] || 'var(--hc-accent)'
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <PageHeader :title="t('memory.title')" :description="t('memory.description')">
      <template #actions>
        <SearchInput
          :model-value="searchQuery"
          :placeholder="t('common.search') + '...'"
          @update:model-value="handleSearch"
        />
      </template>
    </PageHeader>

    <!-- 类型标签页 + 批量操作栏 -->
    <div class="flex items-center gap-3 px-6 py-2 border-b" :style="{ borderColor: 'var(--hc-border)' }">
      <div class="flex gap-1">
        <button
          v-for="type in memoryTypes"
          :key="type"
          class="px-3 py-1 rounded-md text-xs font-medium transition-colors"
          :style="{
            background: activeType === type ? 'var(--hc-accent)' : 'transparent',
            color: activeType === type ? '#fff' : 'var(--hc-text-secondary)',
          }"
          @click="activeType = type"
        >
          {{ type || t('logs.all') }}
        </button>
      </div>
      <div class="flex-1" />
      <template v-if="selectedIds.size > 0">
        <span class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">
          {{ t('memory.selected', { count: selectedIds.size }) }}
        </span>
        <button
          class="px-2.5 py-1 rounded-md text-xs font-medium"
          :style="{ color: 'var(--hc-error)' }"
          @click="handleBatchDelete"
        >
          {{ t('common.delete') }}
        </button>
      </template>
      <button
        v-if="memories.length > 0"
        class="px-2.5 py-1 rounded-md text-xs"
        :style="{ color: 'var(--hc-text-muted)' }"
        @click="showClearConfirm = true"
      >
        {{ t('memory.clearAll') }}
      </button>
      <span class="text-xs tabular-nums" :style="{ color: 'var(--hc-text-muted)' }">
        {{ t('memory.items', { count: filteredMemories.length }) }}
      </span>
    </div>

    <div class="flex-1 overflow-y-auto p-6">
      <LoadingState v-if="loading" />

      <EmptyState
        v-else-if="filteredMemories.length === 0"
        :icon="Brain"
        :title="t('common.noData')"
        :description="searchQuery ? t('common.noData') : t('memory.description')"
      />

      <!-- 时间线视图 -->
      <div v-else class="max-w-2xl">
        <!-- 全选 -->
        <div class="flex items-center gap-2 mb-3 px-1">
          <button class="p-0.5" @click="toggleSelectAll">
            <CheckSquare v-if="isAllSelected" :size="14" :style="{ color: 'var(--hc-accent)' }" />
            <Square v-else :size="14" :style="{ color: 'var(--hc-text-muted)' }" />
          </button>
          <span class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">{{ t('memory.selectAll') }}</span>
        </div>

        <div class="relative">
          <!-- 时间线竖线 -->
          <div
            class="absolute left-[22px] top-0 bottom-0 w-px"
            :style="{ background: 'var(--hc-border)' }"
          />

          <div
            v-for="entry in filteredMemories"
            :key="entry.id"
            class="relative flex gap-4 pb-4 group"
          >
            <!-- 时间线节点 -->
            <div class="relative z-10 flex-shrink-0 mt-1">
              <button class="p-0.5" @click="toggleSelect(entry.id)">
                <CheckSquare
                  v-if="selectedIds.has(entry.id)"
                  :size="14"
                  :style="{ color: 'var(--hc-accent)' }"
                />
                <div
                  v-else
                  class="w-3.5 h-3.5 rounded-full border-2"
                  :style="{ borderColor: typeColor(entry.type), background: 'var(--hc-bg-main)' }"
                />
              </button>
            </div>

            <!-- 内容 -->
            <div
              class="flex-1 rounded-xl border p-4"
              :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
            >
              <div class="flex items-start justify-between mb-2">
                <div class="flex items-center gap-2">
                  <span
                    class="text-xs px-2 py-0.5 rounded font-medium"
                    :style="{ background: typeColor(entry.type) + '20', color: typeColor(entry.type) }"
                  >
                    <Tag :size="10" class="inline mr-0.5" />
                    {{ entry.type }}
                  </span>
                  <span v-if="entry.importance > 0.7" class="text-xs" :style="{ color: 'var(--hc-warning)' }">
                    ★ {{ entry.importance.toFixed(1) }}
                  </span>
                </div>
                <div class="flex items-center gap-1">
                  <span class="text-[10px] flex items-center gap-1" :style="{ color: 'var(--hc-text-muted)' }">
                    <Clock :size="10" />
                    {{ formatTime(entry.created_at) }}
                  </span>
                  <button
                    class="p-1 rounded-md opacity-0 group-hover:opacity-100 hover:bg-white/5 transition-all"
                    :style="{ color: 'var(--hc-text-muted)' }"
                    :title="t('common.delete')"
                    @click="handleDelete(entry)"
                  >
                    <Trash2 :size="12" />
                  </button>
                </div>
              </div>
              <p class="text-sm leading-relaxed" :style="{ color: 'var(--hc-text-primary)' }">
                {{ entry.content }}
              </p>
              <div v-if="entry.source" class="mt-2 text-[10px]" :style="{ color: 'var(--hc-text-muted)' }">
                {{ t('memory.source') }}: {{ entry.source }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <ConfirmDialog
      :open="showClearConfirm"
      :title="t('memory.clearTitle')"
      :message="t('memory.clearMessage')"
      :confirm-text="t('memory.clearConfirm')"
      @confirm="handleClearAll"
      @cancel="showClearConfirm = false"
    />
  </div>
</template>
