<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookOpen, Upload, Trash2, Search, FileText, Plus, X, FileUp, RefreshCw } from 'lucide-vue-next'
import { getDocuments, addDocument, deleteDocument, searchKnowledge, uploadDocument, reindexDocument } from '@/api/knowledge'
import type { KnowledgeDoc, KnowledgeSearchResult } from '@/types'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const ACCEPTED_TYPES = ['.pdf', '.txt', '.md', '.docx', '.doc', '.csv', '.json']

const { t } = useI18n()

const docs = ref<KnowledgeDoc[]>([])
const totalDocs = ref(0)
const loading = ref(true)
const errorMsg = ref('')
const activeTab = ref<'documents' | 'search'>('documents')

const showAddDialog = ref(false)
const newTitle = ref('')
const newContent = ref('')
const newSource = ref('')
const adding = ref(false)

const showDeleteConfirm = ref(false)
const deletingDoc = ref<KnowledgeDoc | null>(null)

const searchQuery = ref('')
const searchResults = ref<KnowledgeSearchResult[]>([])
const searching = ref(false)
const selectedDoc = ref<KnowledgeDoc | null>(null)
const showDocDetail = ref(false)
const reindexingDocIds = ref<Set<string>>(new Set())

// File upload state
const isDragging = ref(false)
const uploadingFiles = ref<{ name: string; progress: number; status: 'uploading' | 'done' | 'error'; error?: string }[]>([])
const fileInputRef = ref<HTMLInputElement>()

onMounted(async () => {
  await loadDocs()
})

async function loadDocs() {
  loading.value = true
  errorMsg.value = ''
  try {
    const res = await getDocuments()
    docs.value = res.documents || []
    totalDocs.value = res.total || 0
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('knowledge.loadFailed')
    console.error('[Knowledge] load failed:', e)
  } finally {
    loading.value = false
  }
}

async function handleAdd() {
  if (!newTitle.value.trim() || !newContent.value.trim()) return
  adding.value = true
  errorMsg.value = ''
  try {
    await addDocument(newTitle.value.trim(), newContent.value.trim(), newSource.value.trim() || undefined)
    showAddDialog.value = false
    newTitle.value = ''
    newContent.value = ''
    newSource.value = ''
    await loadDocs()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('knowledge.addFailed')
    console.error('[Knowledge] add failed:', e)
  } finally {
    adding.value = false
  }
}

function confirmDelete(doc: KnowledgeDoc) {
  deletingDoc.value = doc
  showDeleteConfirm.value = true
}

async function handleDelete() {
  if (!deletingDoc.value) return
  const doc = deletingDoc.value
  errorMsg.value = ''
  try {
    await deleteDocument(doc.id)
    docs.value = docs.value.filter((d) => d.id !== doc.id)
    totalDocs.value = Math.max(0, totalDocs.value - 1)
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('knowledge.deleteFailed')
    console.error('[Knowledge] delete failed:', e)
  } finally {
    showDeleteConfirm.value = false
    deletingDoc.value = null
  }
}

async function handleSearch() {
  if (!searchQuery.value.trim()) {
    searchResults.value = []
    return
  }
  searching.value = true
  errorMsg.value = ''
  try {
    const res = await searchKnowledge(searchQuery.value, 5)
    searchResults.value = res.result || []
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('knowledge.searchFailed')
    console.error('[Knowledge] search failed:', e)
  } finally {
    searching.value = false
  }
}

function formatScore(score: number): string {
  const clamped = Math.max(0, Math.min(1, score))
  return `${(clamped * 100).toFixed(1)}%`
}

function getDocStatus(doc: KnowledgeDoc): 'processing' | 'indexed' | 'failed' {
  if (doc.status) return doc.status
  if (doc.error_message) return 'failed'
  return 'indexed'
}

function getDocStatusLabel(doc: KnowledgeDoc): string {
  switch (getDocStatus(doc)) {
    case 'processing':
      return t('knowledge.statusProcessing')
    case 'failed':
      return t('knowledge.statusFailed')
    default:
      return t('knowledge.statusIndexed')
  }
}

function getDocStatusStyle(doc: KnowledgeDoc) {
  switch (getDocStatus(doc)) {
    case 'processing':
      return { background: '#f59e0b15', color: '#b45309' }
    case 'failed':
      return { background: '#ef444415', color: '#dc2626' }
    default:
      return { background: '#22c55e15', color: '#15803d' }
  }
}

function openDocDetail(doc: KnowledgeDoc) {
  selectedDoc.value = doc
  showDocDetail.value = true
}

async function handleReindex(doc: KnowledgeDoc) {
  const next = new Set(reindexingDocIds.value)
  next.add(doc.id)
  reindexingDocIds.value = next
  errorMsg.value = ''

  try {
    await reindexDocument(doc.id)
    docs.value = docs.value.map((item) => (
      item.id === doc.id
        ? { ...item, status: 'processing', error_message: undefined, updated_at: new Date().toISOString() }
        : item
    ))
  } catch (e) {
    errorMsg.value = e instanceof Error
      ? e.message
      : t('knowledge.reindexUnavailable')
  } finally {
    const current = new Set(reindexingDocIds.value)
    current.delete(doc.id)
    reindexingDocIds.value = current
  }
}

function resultTitle(result: KnowledgeSearchResult): string {
  return result.doc_title || result.source || t('knowledge.searchResult')
}

function resultMeta(result: KnowledgeSearchResult): string {
  const parts: string[] = []
  if (result.source) parts.push(result.source)
  if (typeof result.chunk_index === 'number') {
    const total = typeof result.chunk_count === 'number' ? `/${result.chunk_count}` : ''
    parts.push(`${t('knowledge.chunk')} ${result.chunk_index + 1}${total}`)
  }
  return parts.join(' · ')
}

// --- File Upload ---

function handleDragOver(e: DragEvent) {
  e.preventDefault()
  isDragging.value = true
}

function handleDragLeave() {
  isDragging.value = false
}

function handleDrop(e: DragEvent) {
  e.preventDefault()
  isDragging.value = false
  const files = e.dataTransfer?.files
  if (files) processFiles(files)
}

function handleFileSelect(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files) processFiles(input.files)
  input.value = ''
}

function openFilePicker() {
  fileInputRef.value?.click()
}

async function processFiles(files: FileList) {
  const uploadTasks: Promise<void>[] = []
  let uploadedAny = false

  for (const file of Array.from(files)) {
    const ext = '.' + file.name.split('.').pop()?.toLowerCase()
    if (!ACCEPTED_TYPES.includes(ext)) continue

    const entry = { name: file.name, progress: 0, status: 'uploading' as const }
    uploadingFiles.value.push(entry)
    const idx = uploadingFiles.value.length - 1

    uploadTasks.push((async () => {
      try {
        await uploadDocument(file, (pct) => {
          uploadingFiles.value[idx]!.progress = pct
        })
        uploadingFiles.value[idx]!.status = 'done'
        uploadingFiles.value[idx]!.progress = 100
        uploadedAny = true
      } catch (e) {
        uploadingFiles.value[idx]!.status = 'error'
        uploadingFiles.value[idx]!.error = e instanceof Error ? e.message : 'Upload failed'
      }
    })())
  }

  await Promise.all(uploadTasks)

  if (uploadedAny) {
    await loadDocs()
  }

  // Auto-clear completed items after a delay
  setTimeout(() => {
    uploadingFiles.value = uploadingFiles.value.filter((f) => f.status === 'uploading')
  }, 3000)
}

// Global drag prevention
function preventDefaultDrag(e: DragEvent) { e.preventDefault() }
onMounted(() => {
  document.addEventListener('dragover', preventDefaultDrag)
  document.addEventListener('drop', preventDefaultDrag)
})
onUnmounted(() => {
  document.removeEventListener('dragover', preventDefaultDrag)
  document.removeEventListener('drop', preventDefaultDrag)
})

function rebuildAll() {
  for (const doc of docs.value) {
    handleReindex(doc)
  }
}

function openUpload() {
  showAddDialog.value = true
}

defineExpose({ rebuildAll, openUpload })
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <PageHeader :title="t('knowledge.title')" :description="t('knowledge.description')">
      <template #actions>
        <div class="flex items-center gap-2">
          <button
            class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white"
            :style="{ background: 'var(--hc-accent)' }"
            @click="openFilePicker"
          >
            <FileUp :size="16" />
            {{ t('knowledge.uploadDoc') }}
          </button>
          <button
            class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white"
            :style="{ background: 'var(--hc-accent)' }"
            @click="showAddDialog = true"
          >
            <Plus :size="16" />
            {{ t('knowledge.addDoc') }}
          </button>
        </div>
        <input
          ref="fileInputRef"
          type="file"
          :accept="'.pdf,.txt,.md,.docx,.doc,.csv,.json'"
          multiple
          class="hidden"
          @change="handleFileSelect"
        />
      </template>
    </PageHeader>

    <!-- 错误提示 -->
    <div
      v-if="errorMsg"
      class="mx-6 mt-2 px-4 py-2 rounded-lg text-sm flex items-center justify-between"
      style="background: #ef444420; color: #ef4444;"
    >
      <span>{{ errorMsg }}</span>
      <button class="text-xs underline ml-4" @click="errorMsg = ''">{{ t('common.close') }}</button>
    </div>

    <!-- 标签页 -->
    <div class="flex items-center gap-0 px-6 pt-3 border-b" :style="{ borderColor: 'var(--hc-border)' }">
      <button
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px"
        :style="{
          borderColor: activeTab === 'documents' ? 'var(--hc-accent)' : 'transparent',
          color: activeTab === 'documents' ? 'var(--hc-text-primary)' : 'var(--hc-text-secondary)',
        }"
        @click="activeTab = 'documents'"
      >
        {{ t('knowledge.documents') }} ({{ docs.length }})
      </button>
      <button
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px"
        :style="{
          borderColor: activeTab === 'search' ? 'var(--hc-accent)' : 'transparent',
          color: activeTab === 'search' ? 'var(--hc-text-primary)' : 'var(--hc-text-secondary)',
        }"
        @click="activeTab = 'search'"
      >
        {{ t('knowledge.searchTest') }}
      </button>
    </div>

    <div
      class="flex-1 overflow-y-auto p-6 relative"
      @dragover="handleDragOver"
      @dragleave="handleDragLeave"
      @drop="handleDrop"
    >
      <!-- Drag overlay -->
      <Transition name="modal">
        <div v-if="isDragging" class="absolute inset-0 z-30 flex items-center justify-center bg-black/20 backdrop-blur-sm rounded-xl pointer-events-none">
          <div class="flex flex-col items-center gap-3 p-8 rounded-2xl border-2 border-dashed" :style="{ borderColor: 'var(--hc-accent)', background: 'var(--hc-bg-elevated)' }">
            <FileUp :size="40" :style="{ color: 'var(--hc-accent)' }" />
            <span class="text-sm font-medium" :style="{ color: 'var(--hc-accent)' }">{{ t('knowledge.dropHint') }}</span>
          </div>
        </div>
      </Transition>

      <!-- Upload progress list -->
      <div v-if="uploadingFiles.length > 0" class="mb-4 space-y-2 max-w-2xl">
        <div
          v-for="(uf, idx) in uploadingFiles"
          :key="idx"
          class="flex items-center gap-3 px-4 py-2.5 rounded-lg border"
          :style="{
            background: 'var(--hc-bg-card)',
            borderColor: uf.status === 'error' ? '#ef4444' : uf.status === 'done' ? '#10b981' : 'var(--hc-border)',
          }"
        >
          <Upload :size="14" :class="{ 'animate-pulse': uf.status === 'uploading' }" :style="{ color: uf.status === 'error' ? '#ef4444' : uf.status === 'done' ? '#10b981' : 'var(--hc-accent)' }" />
          <div class="flex-1 min-w-0">
            <div class="text-xs font-medium truncate" :style="{ color: 'var(--hc-text-primary)' }">{{ uf.name }}</div>
            <div v-if="uf.status === 'uploading'" class="mt-1 h-1 rounded-full overflow-hidden" :style="{ background: 'var(--hc-bg-hover)' }">
              <div class="h-full rounded-full transition-all" :style="{ width: uf.progress + '%', background: 'var(--hc-accent)' }" />
            </div>
            <div v-else-if="uf.status === 'error'" class="text-xs mt-0.5" style="color: #ef4444">{{ uf.error }}</div>
          </div>
          <span class="text-xs tabular-nums" :style="{ color: 'var(--hc-text-muted)' }">
            {{ uf.status === 'uploading' ? uf.progress + '%' : uf.status === 'done' ? '✓' : '✗' }}
          </span>
        </div>
      </div>

      <LoadingState v-if="loading" />

      <!-- 文档标签 -->
      <template v-else-if="activeTab === 'documents'">
        <EmptyState
          v-if="docs.length === 0"
          :icon="BookOpen"
          :title="t('knowledge.noDocs')"
          :description="t('knowledge.noDocsDesc')"
        >
          <p class="text-xs mt-2 mb-4" :style="{ color: 'var(--hc-text-muted)' }">{{ t('knowledge.dragHint') }}</p>
          <button
            class="px-4 py-2 rounded-lg text-sm text-white"
            :style="{ background: 'var(--hc-accent)' }"
            @click="openFilePicker"
          >
            {{ t('knowledge.uploadDoc') }}
          </button>
        </EmptyState>

        <template v-else>
          <!-- 统计栏 -->
          <div
            class="flex items-center gap-6 mb-4 px-4 py-3 rounded-xl border"
            :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
          >
            <div class="flex items-center gap-2">
              <FileText :size="14" :style="{ color: 'var(--hc-accent)' }" />
              <span class="text-xs" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('knowledge.docCount', { count: totalDocs }) }}</span>
            </div>
          </div>

          <!-- 文档列表 -->
          <div class="space-y-3 max-w-2xl">
            <div
              v-for="doc in docs"
              :key="doc.id"
              class="flex items-center gap-4 rounded-xl border p-4"
              :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
            >
              <button class="flex-1 min-w-0 text-left" @click="openDocDetail(doc)">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-medium truncate" :style="{ color: 'var(--hc-text-primary)' }">
                    {{ doc.title }}
                  </span>
                  <span
                    class="text-[10px] px-2 py-0.5 rounded-full"
                    :style="getDocStatusStyle(doc)"
                  >
                    {{ getDocStatusLabel(doc) }}
                  </span>
                </div>
                <div class="flex items-center gap-3 mt-1 text-xs" :style="{ color: 'var(--hc-text-muted)' }">
                  <span>{{ doc.chunk_count }} chunks</span>
                  <span v-if="doc.source">{{ t('knowledge.source') }}: {{ doc.source }}</span>
                  <span>{{ new Date(doc.updated_at || doc.created_at).toLocaleDateString('zh-CN') }}</span>
                </div>
                <p v-if="doc.error_message" class="text-[11px] mt-2" style="color: #dc2626;">
                  {{ doc.error_message }}
                </p>
              </button>
              <button
                class="px-2 py-1 rounded-md text-xs hover:bg-white/5 transition-colors"
                :style="{ color: 'var(--hc-text-secondary)' }"
                :disabled="reindexingDocIds.has(doc.id)"
                @click="handleReindex(doc)"
              >
                <span class="inline-flex items-center gap-1">
                  <RefreshCw :size="12" :class="{ 'animate-spin': reindexingDocIds.has(doc.id) }" />
                  {{ getDocStatus(doc) === 'failed' ? t('knowledge.retryIndex') : t('knowledge.reindex') }}
                </span>
              </button>
              <button
                class="p-1.5 rounded-md hover:bg-white/5 transition-colors"
                :style="{ color: 'var(--hc-error)' }"
                :title="t('common.delete')"
                @click="confirmDelete(doc)"
              >
                <Trash2 :size="16" />
              </button>
            </div>
          </div>
        </template>
      </template>

      <!-- 搜索测试标签 -->
      <template v-else>
        <div class="max-w-2xl">
          <p class="text-sm mb-4" :style="{ color: 'var(--hc-text-secondary)' }">
            {{ t('knowledge.searchDesc') }}
          </p>

          <div class="flex gap-2 mb-6">
            <input
              v-model="searchQuery"
              type="text"
              class="flex-1 rounded-lg border px-3 py-2 text-sm outline-none"
              :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
              :placeholder="t('knowledge.searchPlaceholder')"
              @keydown.enter="handleSearch"
            />
            <button
              class="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
              :style="{ background: 'var(--hc-accent)' }"
              :disabled="searching || !searchQuery.trim()"
              @click="handleSearch"
            >
              <Search :size="14" />
              {{ searching ? t('knowledge.searching') : t('common.search') }}
            </button>
          </div>

          <div v-if="searchResults.length > 0" class="space-y-3">
            <div
              v-for="(result, idx) in searchResults"
              :key="idx"
              class="rounded-xl border p-4"
              :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
            >
              <div class="flex items-center justify-between mb-2">
                <div class="min-w-0">
                  <div class="text-sm font-medium truncate" :style="{ color: 'var(--hc-text-primary)' }">
                    {{ resultTitle(result) }}
                  </div>
                  <div v-if="resultMeta(result)" class="text-[11px] mt-1" :style="{ color: 'var(--hc-text-muted)' }">
                    {{ resultMeta(result) }}
                  </div>
                </div>
                <span class="text-xs tabular-nums" :style="{ color: 'var(--hc-text-muted)' }">
                  {{ t('knowledge.similarity', { score: formatScore(result.score) }) }}
                </span>
              </div>
              <p class="text-sm leading-relaxed" :style="{ color: 'var(--hc-text-primary)' }">
                {{ result.content }}
              </p>
            </div>
          </div>

          <EmptyState
            v-else-if="!searching && searchQuery"
            :icon="Search"
            :title="t('knowledge.noResults')"
            :description="t('knowledge.noResultsDesc')"
          />
        </div>
      </template>
    </div>

    <!-- 添加文档对话框 -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showAddDialog" class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-sm" @click.self="showAddDialog = false">
          <div
            class="w-full max-w-lg rounded-2xl border flex flex-col overflow-hidden"
            :style="{ background: 'var(--hc-bg-elevated)', borderColor: 'var(--hc-border)' }"
          >
            <div class="flex items-center justify-between px-5 py-4 border-b" :style="{ borderColor: 'var(--hc-border)' }">
              <h2 class="text-[15px] font-semibold m-0" :style="{ color: 'var(--hc-text-primary)' }">{{ t('knowledge.addDocTitle') }}</h2>
              <button class="p-1 rounded-md hover:bg-white/5" :style="{ color: 'var(--hc-text-muted)' }" @click="showAddDialog = false">
                <X :size="17" />
              </button>
            </div>
            <div class="p-5 flex flex-col gap-3.5">
              <div class="flex flex-col gap-1.5">
                <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('knowledge.docTitle') }}</label>
                <input
                  v-model="newTitle"
                  type="text"
                  class="rounded-lg border px-3 py-2 text-sm outline-none"
                  :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                  :placeholder="t('knowledge.docTitlePlaceholder')"
                />
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('knowledge.docContent') }}</label>
                <textarea
                  v-model="newContent"
                  rows="6"
                  class="rounded-lg border px-3 py-2 text-sm outline-none resize-none"
                  :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                  :placeholder="t('knowledge.docContentPlaceholder')"
                />
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('knowledge.docSource') }}</label>
                <input
                  v-model="newSource"
                  type="text"
                  class="rounded-lg border px-3 py-2 text-sm outline-none"
                  :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                  :placeholder="t('knowledge.docSourcePlaceholder')"
                />
              </div>
            </div>
            <div class="flex items-center justify-end gap-2 px-5 py-3.5 border-t" :style="{ borderColor: 'var(--hc-border)' }">
              <button
                class="px-3 py-1.5 rounded-lg text-sm font-medium"
                :style="{ color: 'var(--hc-text-secondary)', background: 'var(--hc-bg-hover)' }"
                @click="showAddDialog = false"
              >
                {{ t('common.cancel') }}
              </button>
              <button
                class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white"
                :style="{ background: 'var(--hc-accent)', opacity: (!newTitle.trim() || !newContent.trim() || adding) ? 0.4 : 1 }"
                :disabled="!newTitle.trim() || !newContent.trim() || adding"
                @click="handleAdd"
              >
                <Upload :size="14" />
                {{ adding ? t('knowledge.adding') : t('knowledge.add') }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 删除确认 -->
    <ConfirmDialog
      :open="showDeleteConfirm"
      :title="t('knowledge.deleteConfirmTitle')"
      :message="t('knowledge.deleteConfirmMessage')"
      :confirm-text="t('common.delete')"
      @confirm="handleDelete"
      @cancel="showDeleteConfirm = false; deletingDoc = null"
    />

    <Teleport to="body">
      <Transition name="modal">
        <div
          v-if="showDocDetail && selectedDoc"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-sm"
          @click.self="showDocDetail = false"
        >
          <div
            class="w-full max-w-3xl max-h-[80vh] rounded-2xl border flex flex-col overflow-hidden"
            :style="{ background: 'var(--hc-bg-elevated)', borderColor: 'var(--hc-border)' }"
          >
            <div class="flex items-center justify-between px-5 py-4 border-b" :style="{ borderColor: 'var(--hc-border)' }">
              <div class="min-w-0">
                <h2 class="text-[15px] font-semibold truncate" :style="{ color: 'var(--hc-text-primary)' }">{{ selectedDoc.title }}</h2>
                <p class="text-xs mt-1" :style="{ color: 'var(--hc-text-secondary)' }">
                  {{ getDocStatusLabel(selectedDoc) }}
                  <span v-if="selectedDoc.source"> · {{ selectedDoc.source }}</span>
                </p>
              </div>
              <button class="p-1 rounded-md hover:bg-white/5" :style="{ color: 'var(--hc-text-muted)' }" @click="showDocDetail = false">
                <X :size="17" />
              </button>
            </div>
            <div class="p-5 overflow-y-auto space-y-4">
              <div class="grid grid-cols-2 gap-4 text-xs" :style="{ color: 'var(--hc-text-secondary)' }">
                <div>{{ t('knowledge.docCount', { count: 1 }) }} · {{ selectedDoc.chunk_count }} chunks</div>
                <div>{{ t('knowledge.updatedAt') }}: {{ new Date(selectedDoc.updated_at || selectedDoc.created_at).toLocaleString('zh-CN') }}</div>
              </div>
              <div v-if="selectedDoc.error_message" class="rounded-lg px-3 py-2 text-sm" style="background: #ef444415; color: #dc2626;">
                {{ selectedDoc.error_message }}
              </div>
              <div
                class="rounded-xl border p-4 whitespace-pre-wrap break-words text-sm leading-6"
                :style="{ background: 'var(--hc-bg-main)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
              >
                {{ selectedDoc.content || t('knowledge.noContentDetail') }}
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.modal-enter-active { transition: opacity 0.2s ease-out; }
.modal-leave-active { transition: opacity 0.15s ease-in; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
