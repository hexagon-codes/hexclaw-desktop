<script setup lang="ts">
import { onMounted, ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Archive, ArchiveRestore, Brain, Search, Save, Pencil, Trash2, X, Check } from 'lucide-vue-next'
import {
  getMemoryEntries,
  createMemoryEntry,
  updateMemoryEntry,
  updateLegacyMemoryEntry,
  deleteMemoryEntry,
  deleteLegacyMemoryEntry,
  archiveMemoryEntry,
  restoreMemoryEntry,
  clearAllMemory,
  searchMemory,
} from '@/api/memory'
import type { MemoryEntry, VectorSearchResult } from '@/api/memory'
import type { MemorySource, MemoryType, MemoryViewMode } from '@/types'
import { formatTime } from '@/utils/time'
import { emit } from '@/utils/eventBus'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const { t } = useI18n()

const loading = ref(true)
const errorMsg = ref('')
const entries = ref<MemoryEntry[]>([])
const summary = ref('')
const capacity = ref<{ used: number; max: number; archived?: number } | null>(null)
const legacyMode = ref(false)
const legacyContent = ref('')
const activeTab = ref<'view'>('view')
const memoryView = ref<MemoryViewMode>('active')
const typeFilter = ref<'all' | MemoryType>('all')
const sourceFilter = ref<'all' | MemorySource>('all')
const nextCursor = ref('')
const hasMore = ref(false)
const totalEntries = ref(0)
const loadingMore = ref(false)
const movingId = ref<string | null>(null)
const MEMORY_PAGE_SIZE = 50

// Edit state
const editingId = ref<string | null>(null)
const editValue = ref('')
const savingEdit = ref(false)
const deletingId = ref<string | null>(null)

// Archive confirm
const archiveTarget = ref<MemoryEntry | null>(null)

// Clear all
const showClearAllConfirm = ref(false)
const deleting = ref(false)

// Add
const newContent = ref('')
const newType = ref<MemoryType>('fact')
const showAddDialog = ref(false)
const saving = ref(false)

// Search
const searchQuery = ref('')
const searchResults = ref<MemoryEntry[]>([])
const vectorResults = ref<VectorSearchResult[]>([])
const searching = ref(false)
const searchApplied = ref(false)
let searchRequestGen = 0
let searchAbortController: AbortController | null = null

const hasVisibleSummary = computed(() => memoryView.value !== 'archived' && !!summary.value)
const showingSearchResults = computed(() => searching.value || searchApplied.value)
const supportsStructuredMemory = computed(() => !legacyMode.value)
const currentMemoryCount = computed(() => capacity.value?.used ?? entries.value.length)
const showMemoryListToolbar = computed(() => (
  supportsStructuredMemory.value
  || !!capacity.value?.archived
  || totalEntries.value > entries.value.length
))

const TYPE_COLORS: Record<string, string> = {
  identity: 'var(--hc-accent)',
  preference: '#8b5cf6',
  fact: '#06b6d4',
  instruction: '#f59e0b',
  context: 'var(--hc-text-muted)',
}

const MEMORY_TYPES: MemoryType[] = ['identity', 'preference', 'fact', 'instruction', 'context']
const MEMORY_SOURCES: MemorySource[] = ['manual', 'chat_explicit', 'chat_extract', 'system']

function normalizeMemoryText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('## '))
    .map((line) => line
      .replace(/^- \[\d{1,2}:\d{2}\]\s*/, '')  // strip timestamp prefix
      .replace(/^\[[\w:]+\]\s*/, '')             // strip [type:source] tag
      .replace(/^- /, '')                        // strip list marker
      .trim(),
    )
    .filter(Boolean)
    .join('\n')
}

const shouldShowSummary = computed(() => {
  if (!hasVisibleSummary.value) return false
  const normalizedSummary = normalizeMemoryText(summary.value)
  if (!normalizedSummary) return false
  const normalizedEntries = entries.value
    .map((entry) => normalizeMemoryText(entry.content))
    .filter(Boolean)
    .join('\n')
  if (!normalizedEntries) return true
  return normalizedSummary !== normalizedEntries
})

onMounted(async () => {
  await loadMemory()
})

watch(searchQuery, (value) => {
  if (!value.trim()) {
    clearSearchState(true)
    return
  }
  if (searchApplied.value) {
    searchApplied.value = false
    searchResults.value = []
    vectorResults.value = []
  }
})

async function loadMemory(reset = true) {
  if (!reset && !nextCursor.value) return
  if (reset) loading.value = true
  else loadingMore.value = true
  errorMsg.value = ''
  try {
    const params: { view: MemoryViewMode; limit: number; cursor?: string; type?: MemoryType; source?: MemorySource } = {
      view: memoryView.value,
      limit: MEMORY_PAGE_SIZE,
    }
    if (typeFilter.value !== 'all') params.type = typeFilter.value
    if (sourceFilter.value !== 'all') params.source = sourceFilter.value
    if (!reset) params.cursor = nextCursor.value
    const res = await getMemoryEntries(params)
    legacyMode.value = Boolean(res.legacy_mode)
    legacyContent.value = res.legacy_content ?? ''
    const nextEntries = res.entries || []
    entries.value = reset ? nextEntries : [...entries.value, ...nextEntries]
    summary.value = res.summary || ''
    capacity.value = res.capacity || null
    if (legacyMode.value) {
      memoryView.value = 'active'
      typeFilter.value = 'all'
      sourceFilter.value = 'all'
      nextCursor.value = ''
      hasMore.value = false
    } else {
      nextCursor.value = res.next_cursor || ''
      hasMore.value = Boolean(res.has_more)
    }
    totalEntries.value = res.total ?? entries.value.length
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('memory.loadFailed', 'Failed to load memory')
  } finally {
    if (reset) loading.value = false
    else loadingMore.value = false
  }
}

async function switchMemoryView(view: MemoryViewMode) {
  if (legacyMode.value || memoryView.value === view || loading.value) return
  memoryView.value = view
  cancelEdit()
  await loadMemory()
}

async function refreshMemoryList() {
  cancelEdit()
  clearSearchState()
  await loadMemory()
}

async function loadMoreMemory() {
  await loadMemory(false)
}

function clearSearchState(preserveQuery = false) {
  searchRequestGen++
  if (searchAbortController) {
    searchAbortController.abort()
    searchAbortController = null
  }
  searchApplied.value = false
  searchResults.value = []
  vectorResults.value = []
  searching.value = false
  if (!preserveQuery) {
    searchQuery.value = ''
  }
}

// ─── Single-entry edit ───────────────────────────────────
function startEdit(entry: MemoryEntry) {
  editingId.value = entry.id
  editValue.value = entry.content
}

function cancelEdit() {
  editingId.value = null
  editValue.value = ''
}

async function saveEdit() {
  if (savingEdit.value || !editingId.value) return
  const trimmed = editValue.value.trim()
  if (!trimmed) return
  savingEdit.value = true
  errorMsg.value = ''
  try {
    if (legacyMode.value && editingId.value.startsWith('legacy-')) {
      // 重新加载最新 legacyContent，避免 auto-extract 写入的条目被覆盖
      const fresh = await getMemoryEntries()
      const freshContent = fresh.legacy_content ?? legacyContent.value
      await updateLegacyMemoryEntry(editingId.value, trimmed, freshContent)
    } else {
      await updateMemoryEntry(editingId.value, trimmed)
    }
    editingId.value = null
    emit('memory:updated')
    await loadMemory()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('memory.saveFailed', 'Failed to save memory')
  } finally {
    savingEdit.value = false
  }
}

// ─── Single-entry delete ─────────────────────────────────
async function handleDeleteEntry(id: string) {
  if (deletingId.value) return
  deletingId.value = id
  errorMsg.value = ''
  try {
    if (legacyMode.value && id.startsWith('legacy-')) {
      // 重新加载最新 legacyContent，避免 auto-extract 写入的条目被覆盖
      const fresh = await getMemoryEntries()
      const freshContent = fresh.legacy_content ?? legacyContent.value
      await deleteLegacyMemoryEntry(id, freshContent)
    } else {
      await deleteMemoryEntry(id)
    }
    emit('memory:updated')
    await loadMemory()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('memory.deleteFailed', 'Failed to delete memory')
  } finally {
    deletingId.value = null
  }
}

function requestArchiveEntry(entry: MemoryEntry) {
  archiveTarget.value = entry
}

async function confirmArchiveEntry() {
  const entry = archiveTarget.value
  archiveTarget.value = null
  if (!entry || movingId.value) return
  movingId.value = entry.id
  errorMsg.value = ''
  try {
    await archiveMemoryEntry(entry.id)
    emit('memory:updated')
    await loadMemory()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('memory.archiveFailed', 'Failed to archive memory')
  } finally {
    movingId.value = null
  }
}

async function handleRestoreEntry(entry: MemoryEntry) {
  if (movingId.value) return
  movingId.value = entry.id
  errorMsg.value = ''
  try {
    await restoreMemoryEntry(entry.id)
    emit('memory:updated')
    await loadMemory()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('memory.restoreFailed', 'Failed to restore memory')
  } finally {
    movingId.value = null
  }
}

// ─── Clear all ───────────────────────────────────────────
async function handleClearAll() {
  if (deleting.value) return
  deleting.value = true
  errorMsg.value = ''
  try {
    await clearAllMemory()
    showClearAllConfirm.value = false
    emit('memory:updated')
    await loadMemory()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('memory.clearFailed', 'Failed to clear memory')
  } finally {
    deleting.value = false
  }
}

// ─── Add new entry ───────────────────────────────────────
function resetAddDialogForm() {
  newContent.value = ''
  newType.value = 'fact'
}

function openAddDialog() {
  errorMsg.value = ''
  resetAddDialogForm()
  showAddDialog.value = true
}

function closeAddDialog() {
  showAddDialog.value = false
  errorMsg.value = ''
  resetAddDialogForm()
}

function setToolbarSearch(value: string) {
  searchQuery.value = value
}

async function submitToolbarSearch() {
  await handleSearch()
}

function requestClearAll() {
  showClearAllConfirm.value = true
}

defineExpose({ openAddDialog, setToolbarSearch, submitToolbarSearch, requestClearAll })

async function handleSave() {
  if (!newContent.value.trim()) return
  saving.value = true
  errorMsg.value = ''
  try {
    await createMemoryEntry(newContent.value.trim(), newType.value, 'manual')
    resetAddDialogForm()
    showAddDialog.value = false
    emit('memory:updated')
    memoryView.value = 'active'
    await loadMemory()
    activeTab.value = 'view'
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('memory.saveFailed', 'Failed to save memory')
  } finally {
    saving.value = false
  }
}

// ─── Search ──────────────────────────────────────────────
async function handleSearch() {
  if (!searchQuery.value.trim()) {
    clearSearchState(true)
    return
  }
  const requestGen = ++searchRequestGen
  const query = searchQuery.value.trim()
  if (searchAbortController) searchAbortController.abort()
  const ac = new AbortController()
  searchAbortController = ac
  searching.value = true
  searchApplied.value = true
  errorMsg.value = ''
  try {
    const res = await searchMemory(query)
    if (ac.signal.aborted || requestGen !== searchRequestGen) return
    searchResults.value = res.results || []
    vectorResults.value = res.vector_results || []
  } catch (e) {
    if (ac.signal.aborted || requestGen !== searchRequestGen) return
    errorMsg.value = e instanceof Error ? e.message : t('memory.searchFailed', 'Search failed')
  } finally {
    if (requestGen === searchRequestGen) {
      searching.value = false
    }
  }
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- Error -->
    <div
      v-if="errorMsg"
      class="mx-6 mt-2 px-4 py-2 rounded-lg text-sm flex items-center justify-between"
      style="background: color-mix(in srgb, var(--hc-error) 12%, transparent); color: var(--hc-error);"
    >
      <span>{{ errorMsg }}</span>
      <button class="text-xs underline ml-4" @click="errorMsg = ''">{{ t('common.close') }}</button>
    </div>

    <!-- Tabs -->
    <div
      data-testid="memory-tabs-row"
      class="flex items-center gap-0 px-6 pt-3 border-b"
      :style="{ borderColor: 'var(--hc-border)' }"
    >
      <button
        v-for="tab in [
          { key: 'view' as const, label: t('memory.currentMemory') },
        ]"
        :key="tab.key"
        :data-testid="`memory-tab-${tab.key}`"
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px"
        :style="{
          borderColor: activeTab === tab.key ? 'var(--hc-accent)' : 'transparent',
          color: activeTab === tab.key ? 'var(--hc-text-primary)' : 'var(--hc-text-secondary)',
        }"
        @click="activeTab = tab.key"
      >
        {{ `${tab.label} (${currentMemoryCount})` }}
      </button>
    </div>

    <div data-testid="memory-content" class="flex-1 overflow-y-auto p-6">
      <LoadingState v-if="loading" />

      <!-- View: structured entries -->
      <template v-else-if="activeTab === 'view'">
        <div
          v-if="showMemoryListToolbar"
          data-testid="memory-list-toolbar"
          class="max-w-2xl mb-4 space-y-2.5"
        >
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex flex-wrap items-center gap-2">
              <template v-if="supportsStructuredMemory">
                <div class="inline-flex rounded-xl border p-1" :style="{ borderColor: 'var(--hc-border)', background: 'var(--hc-bg-card)' }">
                  <button
                    v-for="view in [
                      { key: 'active' as const, label: t('memory.activeMemory') },
                      { key: 'archived' as const, label: t('memory.archivedMemory') },
                      { key: 'all' as const, label: t('memory.allMemory') },
                    ]"
                    :key="view.key"
                    class="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                    :style="{
                      background: memoryView === view.key ? 'var(--hc-bg-hover)' : 'transparent',
                      color: memoryView === view.key ? 'var(--hc-text-primary)' : 'var(--hc-text-secondary)',
                    }"
                    @click="switchMemoryView(view.key)"
                  >
                    {{ view.label }}
                  </button>
                </div>
                <select
                  v-model="typeFilter"
                  class="hc-input"
                  style="width: auto; font-size: 12px;"
                  @change="refreshMemoryList"
                >
                  <option value="all">{{ t('memory.allTypes') }}</option>
                  <option v-for="type in MEMORY_TYPES" :key="type" :value="type">
                    {{ t(`memory.type.${type}`, type) }}
                  </option>
                </select>
                <select
                  v-model="sourceFilter"
                  class="hc-input"
                  style="width: auto; font-size: 12px;"
                  @change="refreshMemoryList"
                >
                  <option value="all">{{ t('memory.allSources') }}</option>
                  <option v-for="source in MEMORY_SOURCES" :key="source" :value="source">
                    {{ t(`memory.sourceType.${source}`, source) }}
                  </option>
                </select>
              </template>
            </div>
          </div>
          <div data-testid="memory-status-toolbar" class="flex flex-wrap items-center gap-2">
            <span
              v-if="capacity?.archived"
              class="text-[11px] px-2 py-1 rounded-full whitespace-nowrap"
              :style="{ background: 'var(--hc-bg-card)', color: 'var(--hc-text-muted)' }"
            >
              {{ t('memory.archivedCount', { count: capacity.archived }) }}
            </span>
            <span v-if="totalEntries > entries.length" class="text-xs whitespace-nowrap" :style="{ color: 'var(--hc-text-muted)' }">
              {{ t('memory.loadedCount', { loaded: entries.length, total: totalEntries }) }}
            </span>
          </div>
        </div>

        <template v-if="showingSearchResults">
          <LoadingState v-if="searching" />

          <div v-else class="max-w-2xl space-y-4">
            <div v-if="searchResults.length > 0" class="space-y-3">
              <div class="text-xs font-medium" :style="{ color: 'var(--hc-text-muted)' }">
                {{ t('memory.searchMatches', { count: searchResults.length }) }}
              </div>
              <div
                v-for="result in searchResults"
                :key="result.id"
                class="rounded-xl border p-4"
                :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
              >
                <p class="text-sm leading-relaxed" :style="{ color: 'var(--hc-text-primary)' }">
                  {{ result.content }}
                </p>
                <div class="flex items-center gap-2 mt-1.5">
                  <span
                    class="text-[10px] px-1.5 py-0.5 rounded font-medium"
                    :style="{
                      background: `color-mix(in srgb, ${TYPE_COLORS[result.type] || 'var(--hc-accent)'} 12%, transparent)`,
                      color: TYPE_COLORS[result.type] || 'var(--hc-accent)',
                    }"
                  >
                    {{ t(`memory.type.${result.type}`, result.type) }}
                  </span>
                  <span class="text-[10px]" :style="{ color: 'var(--hc-text-muted)' }">
                    {{ formatTime(result.created_at, true) }}
                  </span>
                </div>
              </div>
            </div>

            <div v-if="vectorResults.length > 0" class="space-y-3">
              <div class="text-xs font-medium" :style="{ color: 'var(--hc-text-muted)' }">
                {{ t('memory.semanticResults', { count: vectorResults.length }) }}
              </div>
              <div
                v-for="(vr, idx) in vectorResults"
                :key="'v-' + idx"
                class="rounded-xl border p-4"
                :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-accent-border)' }"
              >
                <div class="flex items-center gap-2 mb-2">
                  <span class="text-xs tabular-nums" :style="{ color: 'var(--hc-text-muted)' }">
                    Score: {{ (vr.score * 100).toFixed(1) }}%
                  </span>
                </div>
                <p class="text-sm leading-relaxed" :style="{ color: 'var(--hc-text-primary)' }">
                  {{ vr.content }}
                </p>
              </div>
            </div>

            <EmptyState
              v-if="searchResults.length === 0 && vectorResults.length === 0"
              :icon="Search"
              :title="t('common.noData')"
              :description="t('memory.noSearchResults')"
            />
          </div>
        </template>

        <template v-else>
          <EmptyState
            v-if="entries.length === 0 && !hasVisibleSummary"
            :icon="Brain"
            :title="t('common.noData')"
            :description="t('memory.description')"
          />

          <div v-else class="max-w-2xl space-y-3">
            <div
              v-for="entry in entries"
              :key="entry.id"
              data-testid="memory-entry-card"
              class="rounded-xl border p-3 flex items-start gap-3 group"
              :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
            >
              <Brain :size="13" class="mt-0.5 flex-shrink-0" :style="{ color: TYPE_COLORS[entry.type] || 'var(--hc-accent)' }" />

              <!-- Editing -->
              <template v-if="editingId === entry.id">
                <input
                  v-model="editValue"
                  data-testid="memory-edit-input"
                  class="flex-1 rounded-lg border px-2 py-1 text-sm outline-none"
                  :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                  @keydown.enter="saveEdit"
                  @keydown.escape="cancelEdit"
                />
                <button
                  class="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                  :style="{ color: 'var(--hc-success, #10b981)' }"
                  :disabled="savingEdit"
                  @click="saveEdit"
                >
                  <Check :size="14" />
                </button>
                <button
                  class="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                  :style="{ color: 'var(--hc-text-muted)' }"
                  @click="cancelEdit"
                >
                  <X :size="14" />
                </button>
              </template>

              <!-- Display -->
              <template v-else>
                <div class="flex-1 min-w-0">
                  <p class="text-sm leading-relaxed" :style="{ color: 'var(--hc-text-primary)' }">
                    {{ entry.content }}
                  </p>
                  <div class="flex items-center gap-2 mt-1.5">
                    <span
                      class="text-[10px] px-1.5 py-0.5 rounded font-medium"
                      :style="{
                        background: `color-mix(in srgb, ${TYPE_COLORS[entry.type] || 'var(--hc-accent)'} 12%, transparent)`,
                        color: TYPE_COLORS[entry.type] || 'var(--hc-accent)',
                      }"
                    >
                      {{ t(`memory.type.${entry.type}`, entry.type) }}
                    </span>
                    <span class="text-[10px]" :style="{ color: 'var(--hc-text-muted)' }">
                      {{ formatTime(entry.created_at, true) }}
                    </span>
                    <span v-if="entry.hit_count > 0" class="text-[10px]" :style="{ color: 'var(--hc-text-muted)' }">
                      {{ t('memory.hitCount', { count: entry.hit_count }) }}
                    </span>
                    <span
                      v-if="entry.status === 'archived'"
                      class="text-[10px] px-1.5 py-0.5 rounded"
                      :style="{ background: 'var(--hc-bg-hover)', color: 'var(--hc-text-muted)' }"
                    >
                      {{ t('memory.archived') }}
                    </span>
                  </div>
                </div>
                <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <template v-if="supportsStructuredMemory">
                    <button
                      v-if="entry.status === 'archived'"
                      class="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                      :style="{ color: 'var(--hc-text-muted)' }"
                      :disabled="movingId === entry.id"
                      :title="t('memory.restoreMemory')"
                      @click="handleRestoreEntry(entry)"
                    >
                      <ArchiveRestore :size="12" />
                    </button>
                    <button
                      v-else
                      class="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                      :style="{ color: 'var(--hc-text-muted)' }"
                      :disabled="movingId === entry.id"
                      :title="t('memory.archiveMemory')"
                      @click="requestArchiveEntry(entry)"
                    >
                      <Archive :size="12" />
                    </button>
                  </template>
                  <button
                    class="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    :style="{ color: 'var(--hc-text-muted)' }"
                    @click="startEdit(entry)"
                  >
                    <Pencil :size="12" />
                  </button>
                  <button
                    class="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    style="color: var(--hc-error);"
                    :disabled="deletingId === entry.id"
                    @click="handleDeleteEntry(entry.id)"
                  >
                    <Trash2 :size="12" />
                  </button>
                </div>
              </template>
            </div>

            <button
              v-if="hasMore"
              class="w-full rounded-xl border p-3 flex items-center justify-center gap-2 text-sm transition-colors"
              :style="{ borderColor: 'var(--hc-border)', color: 'var(--hc-text-secondary)', opacity: loadingMore ? 0.5 : 1 }"
              :disabled="loadingMore"
              @click="loadMoreMemory"
            >
              {{ loadingMore ? t('memory.loadingMore') : t('memory.loadMore') }}
            </button>

            <!-- Summary (auto-generated, read-only) -->
            <div
              v-if="shouldShowSummary"
              class="rounded-xl border p-4"
              :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
            >
              <div class="flex items-center gap-2 mb-3">
                <span class="text-xs font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('memory.context') }}</span>
                <span class="text-[10px] px-1.5 py-0.5 rounded" :style="{ background: 'var(--hc-bg-hover)', color: 'var(--hc-text-muted)' }">{{ t('memory.readOnly', 'Read-only') }}</span>
              </div>
              <p class="text-sm leading-relaxed whitespace-pre-wrap" :style="{ color: 'var(--hc-text-primary)' }">
                {{ summary }}
              </p>
            </div>
          </div>
        </template>
      </template>

    </div>

    <Teleport to="body">
      <Transition name="modal">
        <div
          v-if="showAddDialog"
          data-testid="memory-add-dialog"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-sm"
          @click.self="closeAddDialog"
        >
          <div
            data-testid="memory-add-panel"
            class="w-full max-w-lg rounded-2xl border flex flex-col overflow-hidden"
            :style="{ background: 'var(--hc-bg-elevated)', borderColor: 'var(--hc-border)' }"
          >
            <div
              class="flex items-center justify-between px-5 py-4 border-b"
              :style="{ borderColor: 'var(--hc-border)' }"
            >
              <h2
                class="text-[15px] font-semibold m-0"
                :style="{ color: 'var(--hc-text-primary)' }"
              >
                {{ t('memory.addMemory') }}
              </h2>
              <button
                class="p-1 rounded-md hover:bg-white/5"
                :style="{ color: 'var(--hc-text-muted)' }"
                @click="closeAddDialog"
              >
                <X :size="17" />
              </button>
            </div>
            <div class="p-5">
              <textarea
                v-model="newContent"
                data-testid="memory-add-input"
                rows="7"
                class="w-full rounded-lg border px-3 py-2 text-sm leading-relaxed outline-none resize-none"
                :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                :placeholder="t('memory.inputPlaceholder')"
              />
            </div>
            <div
              data-testid="memory-add-footer"
              class="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 border-t"
              :style="{ borderColor: 'var(--hc-border)' }"
            >
              <div data-testid="memory-add-actions" class="flex flex-wrap items-center gap-2">
                <select
                  id="memory-type"
                  data-testid="memory-add-type-select"
                  v-model="newType"
                  class="w-[150px] rounded-lg border px-3 py-1.5 text-sm outline-none"
                  :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                >
                  <option v-for="type in MEMORY_TYPES" :key="type" :value="type">
                    {{ t(`memory.type.${type}`, type) }}
                  </option>
                </select>
                <button
                  data-testid="memory-add-save"
                  class="w-[96px] flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white"
                  :style="{ background: 'var(--hc-accent)', opacity: (!newContent.trim() || saving) ? 0.4 : 1 }"
                  :disabled="!newContent.trim() || saving"
                  @click="handleSave"
                >
                  <Save :size="14" />
                  {{ saving ? t('memory.saving') : t('common.save') }}
                </button>
              </div>
              <button
                data-testid="memory-add-cancel"
                class="w-[96px] flex items-center justify-center px-3 py-1.5 rounded-lg text-sm font-medium"
                :style="{ color: 'var(--hc-text-secondary)', background: 'var(--hc-bg-hover)' }"
                @click="closeAddDialog"
              >
                {{ t('common.cancel') }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <ConfirmDialog
      :open="!!archiveTarget"
      :title="t('memory.archiveTitle', 'Archive memory')"
      :message="t('memory.archiveMessage', 'This memory will be moved to the archive. You can restore it later.')"
      :confirm-text="t('memory.archiveConfirm', 'Archive')"
      @confirm="confirmArchiveEntry"
      @cancel="archiveTarget = null"
    />

    <ConfirmDialog
      :open="showClearAllConfirm"
      :title="t('memory.clearTitle')"
      :message="t('memory.clearMessage')"
      :confirm-text="t('memory.clearConfirm')"
      :danger="true"
      @confirm="handleClearAll"
      @cancel="showClearAllConfirm = false"
    />
  </div>
</template>
