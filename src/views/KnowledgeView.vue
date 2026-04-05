<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookOpen, Upload, Trash2, Search, FileText, X, FileUp, RefreshCw, AlertTriangle } from 'lucide-vue-next'
import {
  getDocuments,
  getDocumentContent,
  addDocument,
  deleteDocument,
  searchKnowledge,
  uploadDocument,
  reindexDocument,
  isKnowledgeUploadEndpointMissing,
  isKnowledgeUploadUnsupportedFormat,
} from '@/api/knowledge'
// DB cache layer removed — data fetched directly from backend API
import type { KnowledgeDoc, KnowledgeSearchResult } from '@/types'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import { parseDocument } from '@/utils/file-parser'
import { logger } from '@/utils/logger'

const ACCEPTED_TYPES = ['.pdf', '.txt', '.md', '.docx', '.doc', '.xlsx', '.xls', '.csv', '.json']
const props = withDefaults(
  defineProps<{
    knowledgeEnabled?: boolean
  }>(),
  {
    knowledgeEnabled: true,
  },
)
const knowledgeEnabled = computed(() => props.knowledgeEnabled)

const { t, locale } = useI18n()

const docs = ref<KnowledgeDoc[]>([])
const totalDocs = ref(0)
const loading = ref(true)
const errorMsg = ref('')
const errorSeverity = ref<'error' | 'warning' | null>(null)
const revalidating = ref(false)
// CACHE_TTL_MS removed — DB cache layer eliminated
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
let searchRequestGen = 0
const selectedDoc = ref<KnowledgeDoc | null>(null)
const showDocDetail = ref(false)
const reindexingDocIds = ref<Set<string>>(new Set())

// File upload state
const isDragging = ref(false)
const uploadingFiles = ref<
  { name: string; progress: number; status: 'uploading' | 'done' | 'error'; error?: string }[]
>([])
const fileInputRef = ref<HTMLInputElement>()

onMounted(async () => {
  await loadDocs()
})

watch(activeTab, () => {
  errorMsg.value = ''
})

/**
 * 从后端 API 直接加载文档列表（DB 缓存层已移除）
 */
async function loadDocs() {
  errorMsg.value = ''
  errorSeverity.value = null
  loading.value = true
  await revalidateFromApi(false)
}

async function revalidateFromApi(hadCache = docs.value.length > 0) {
  revalidating.value = true
  try {
    const res = await getDocuments()
    const freshDocs = res.documents || []
    docs.value = freshDocs
    totalDocs.value = res.total || freshDocs.length
    errorMsg.value = ''
    errorSeverity.value = null

    // DB cache layer removed — no local cache to update
  } catch (e) {
    if (hadCache) {
      // 有缓存兜底：软提示
      errorMsg.value = t('knowledge.syncFailed')
      errorSeverity.value = 'warning'
    } else {
      // 无缓存：硬错误
      errorMsg.value = e instanceof Error ? e.message : t('knowledge.loadFailed')
      errorSeverity.value = 'error'
    }
    logger.warn('[Knowledge] API revalidation failed', e)
  } finally {
    loading.value = false
    revalidating.value = false
  }
}

function ensureKnowledgeEnabled() {
  if (knowledgeEnabled.value) return true
  errorMsg.value = t('knowledge.backendDisabled')
  return false
}

async function handleAdd() {
  if (!ensureKnowledgeEnabled()) return
  if (!newTitle.value.trim() || !newContent.value.trim()) return
  adding.value = true
  errorMsg.value = ''
  try {
    await addDocument(
      newTitle.value.trim(),
      newContent.value.trim(),
      newSource.value.trim() || undefined,
    )
    closeAddDialog()
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

function closeDeleteConfirm() {
  showDeleteConfirm.value = false
  deletingDoc.value = null
}

async function handleSearch() {
  if (!ensureKnowledgeEnabled()) return
  const requestGen = ++searchRequestGen
  if (!searchQuery.value.trim()) {
    searchResults.value = []
    return
  }
  searching.value = true
  errorMsg.value = ''
  try {
    const res = await searchKnowledge(searchQuery.value, 5)
    if (requestGen !== searchRequestGen) return
    searchResults.value = res.result || []
  } catch (e) {
    if (requestGen !== searchRequestGen) return
    errorMsg.value = e instanceof Error ? e.message : t('knowledge.searchFailed')
    console.error('[Knowledge] search failed:', e)
  } finally {
    if (requestGen === searchRequestGen) {
      searching.value = false
    }
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

const loadingDocContent = ref(false)
let docContentRequestGen = 0

async function openDocDetail(doc: KnowledgeDoc) {
  const requestGen = ++docContentRequestGen
  selectedDoc.value = doc
  showDocDetail.value = true
  loadingDocContent.value = false

  // 如果列表接口未返回正文，主动获取内容
  if (!doc.content?.trim()) {
    loadingDocContent.value = true
    try {
      const content = await getDocumentContent(doc)
      if (content && requestGen === docContentRequestGen && selectedDoc.value?.id === doc.id) {
        selectedDoc.value = { ...doc, content }
        // 同步更新列表中的文档对象，避免下次打开重复请求
        const idx = docs.value.findIndex((d) => d.id === doc.id)
        if (idx >= 0) docs.value[idx] = selectedDoc.value
      }
    } catch {
      // 获取失败保持原提示
    } finally {
      if (requestGen === docContentRequestGen) {
        loadingDocContent.value = false
      }
    }
  }
}

async function handleReindex(doc: KnowledgeDoc) {
  if (!ensureKnowledgeEnabled()) return
  if (reindexingDocIds.value.has(doc.id)) return
  const next = new Set(reindexingDocIds.value)
  next.add(doc.id)
  reindexingDocIds.value = next
  errorMsg.value = ''

  try {
    const result = await reindexDocument(doc.id)
    // 用后端返回的真实状态更新（reindex 是同步的，返回时已完成）
    docs.value = docs.value.map((item) =>
      item.id === doc.id
        ? {
            ...item,
            status: (result.status as KnowledgeDoc['status']) || 'indexed',
            chunk_count: result.chunk_count ?? item.chunk_count,
            error_message: undefined,
            updated_at: result.updated_at || new Date().toISOString(),
          }
        : item,
    )
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('knowledge.reindexUnavailable')
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
  if (!knowledgeEnabled.value) return
  isDragging.value = true
}

function handleDragLeave() {
  isDragging.value = false
}

function handleDrop(e: DragEvent) {
  e.preventDefault()
  if (!ensureKnowledgeEnabled()) return
  isDragging.value = false
  const files = e.dataTransfer?.files
  if (files) processFiles(files)
}

function handleFileSelect(e: Event) {
  if (!ensureKnowledgeEnabled()) return
  const input = e.target as HTMLInputElement
  if (input.files && input.files.length > 0) {
    showAddDialog.value = false
    processFiles(input.files)
  }
  input.value = ''
}

function openFilePicker() {
  if (!ensureKnowledgeEnabled()) return
  fileInputRef.value?.click()
}

async function uploadDocumentThroughLegacyFallback(file: File, onProgress?: (pct: number) => void) {
  onProgress?.(10)
  const parsed = await parseDocument(file)
  const content = parsed.text.trim()

  if (!content) {
    throw new Error(t('knowledge.parsedContentEmpty'))
  }

  onProgress?.(75)
  await addDocument(parsed.fileName, content, file.name)
  onProgress?.(100)
}

const MAX_FILE_SIZE = 50 * 1024 * 1024 // 50 MB

async function processFiles(files: FileList) {
  if (!ensureKnowledgeEnabled()) return
  const uploadTasks: Promise<void>[] = []
  let uploadedAny = false

  for (const file of Array.from(files)) {
    if (file.size === 0) {
      uploadingFiles.value.push({
        name: file.name,
        progress: 0,
        status: 'error',
        error: t('knowledge.fileEmpty', '文件为空'),
      })
      continue
    }

    if (file.size > MAX_FILE_SIZE) {
      uploadingFiles.value.push({
        name: file.name,
        progress: 0,
        status: 'error',
        error: t('knowledge.fileTooLarge', { max: '50 MB' }),
      })
      continue
    }

    const ext = '.' + file.name.split('.').pop()?.toLowerCase()
    if (!ACCEPTED_TYPES.includes(ext)) {
      uploadingFiles.value.push({
        name: file.name,
        progress: 0,
        status: 'error',
        error: t('knowledge.unsupportedFileType', { types: ACCEPTED_TYPES.join(', ') }),
      })
      continue
    }

    const entry: { name: string; progress: number; status: 'uploading' | 'done' | 'error'; error?: string } = { name: file.name, progress: 0, status: 'uploading' }
    uploadingFiles.value.push(entry)

    uploadTasks.push(
      (async () => {
        const updateProgress = (pct: number) => {
          entry.progress = pct
        }

        try {
          await uploadDocument(file, updateProgress)
          entry.status = 'done'
          entry.progress = 100
          uploadedAny = true
        } catch (e) {
          if (isKnowledgeUploadEndpointMissing(e) || isKnowledgeUploadUnsupportedFormat(e)) {
            try {
              await uploadDocumentThroughLegacyFallback(file, updateProgress)
              entry.status = 'done'
              entry.progress = 100
              uploadedAny = true
              return
            } catch (fallbackError) {
              e = fallbackError
            }
          }

          entry.status = 'error'
          entry.error = e instanceof Error ? e.message : t('knowledge.uploadFailed')
        }
      })(),
    )
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
function preventDefaultDrag(e: DragEvent) {
  e.preventDefault()
}
onMounted(() => {
  document.addEventListener('dragover', preventDefaultDrag)
  document.addEventListener('drop', preventDefaultDrag)
})
onUnmounted(() => {
  document.removeEventListener('dragover', preventDefaultDrag)
  document.removeEventListener('drop', preventDefaultDrag)
})

function rebuildAll() {
  if (!ensureKnowledgeEnabled()) return
  for (const doc of docs.value) {
    handleReindex(doc)
  }
}

function resetAddDialogForm() {
  newTitle.value = ''
  newContent.value = ''
  newSource.value = ''
}

function closeAddDialog() {
  showAddDialog.value = false
  errorMsg.value = ''
  resetAddDialogForm()
}

function openUpload() {
  if (!ensureKnowledgeEnabled()) return
  closeAddDialog()
  showAddDialog.value = true
}

defineExpose({ rebuildAll, openUpload, openFilePicker, docs })
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <input
      ref="fileInputRef"
      type="file"
      :accept="ACCEPTED_TYPES.join(',')"
      multiple
      class="hidden"
      @change="handleFileSelect"
    />

    <!-- 错误/警告提示 -->
    <div
      v-if="errorMsg"
      class="mx-6 mt-2 px-4 py-2 rounded-lg text-sm flex items-center justify-between"
      :style="{
        background: errorSeverity === 'warning' ? '#f59e0b20' : '#ef444420',
        color: errorSeverity === 'warning' ? '#d97706' : '#ef4444',
      }"
    >
      <span class="flex items-center gap-2">
        <AlertTriangle v-if="errorSeverity === 'warning'" :size="14" />
        {{ errorMsg }}
      </span>
      <span class="flex items-center gap-2">
        <button
          v-if="errorSeverity === 'error'"
          class="text-xs underline"
          @click="revalidateFromApi(false)"
        >
          {{ t('knowledge.retrySync') }}
        </button>
        <button class="text-xs underline" @click="errorMsg = ''">{{ t('common.close') }}</button>
      </span>
    </div>

    <div
      v-if="!knowledgeEnabled"
      class="mx-6 mt-2 px-4 py-3 rounded-xl text-sm"
      :style="{ background: 'var(--hc-warning-soft, #f59e0b15)', color: 'var(--hc-warning-text, #b45309)' }"
    >
      <div class="font-medium">{{ t('knowledge.backendDisabled') }}</div>
      <div class="mt-1 text-xs" :style="{ color: 'var(--hc-text-secondary)' }">
        {{ t('knowledge.backendDisabledDesc') }}
      </div>
    </div>

    <!-- 标签页 -->
    <div
      class="flex items-center gap-0 px-6 pt-3 border-b"
      :style="{ borderColor: 'var(--hc-border)' }"
    >
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
        <div
          v-if="isDragging"
          class="absolute inset-0 z-30 flex items-center justify-center bg-black/20 backdrop-blur-sm rounded-xl pointer-events-none"
        >
          <div
            class="flex flex-col items-center gap-3 p-8 rounded-2xl border-2 border-dashed"
            :style="{ borderColor: 'var(--hc-accent)', background: 'var(--hc-bg-elevated)' }"
          >
            <FileUp :size="40" :style="{ color: 'var(--hc-accent)' }" />
            <span class="text-sm font-medium" :style="{ color: 'var(--hc-accent)' }">{{
              t('knowledge.dropHint')
            }}</span>
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
            borderColor:
              uf.status === 'error'
                ? '#ef4444'
                : uf.status === 'done'
                  ? '#10b981'
                  : 'var(--hc-border)',
          }"
        >
          <Upload
            :size="14"
            :class="{ 'animate-pulse': uf.status === 'uploading' }"
            :style="{
              color:
                uf.status === 'error'
                  ? '#ef4444'
                  : uf.status === 'done'
                    ? '#10b981'
                    : 'var(--hc-accent)',
            }"
          />
          <div class="flex-1 min-w-0">
            <div class="text-xs font-medium truncate" :style="{ color: 'var(--hc-text-primary)' }">
              {{ uf.name }}
            </div>
            <div
              v-if="uf.status === 'uploading'"
              class="mt-1 h-1 rounded-full overflow-hidden"
              :style="{ background: 'var(--hc-bg-hover)' }"
            >
              <div
                class="h-full rounded-full transition-[width]"
                :style="{ width: uf.progress + '%', background: 'var(--hc-accent)' }"
              />
            </div>
            <div v-else-if="uf.status === 'error'" class="text-xs mt-0.5" style="color: #ef4444">
              {{ uf.error }}
            </div>
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
          <p
            v-if="knowledgeEnabled"
            class="text-xs mt-2 mb-2"
            :style="{ color: 'var(--hc-text-secondary)' }"
          >
            {{ t('knowledge.modeHint') }}
          </p>
          <p class="text-xs mt-2 mb-4" :style="{ color: 'var(--hc-text-muted)' }">
            {{ t('knowledge.dragHint') }}
          </p>
        </EmptyState>

        <template v-else>
          <!-- 统计栏 -->
          <div
            class="flex items-center gap-6 mb-4 px-4 py-3 rounded-xl border"
            :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
          >
            <div class="flex items-center gap-2">
              <FileText :size="14" :style="{ color: 'var(--hc-accent)' }" />
              <span class="text-xs" :style="{ color: 'var(--hc-text-secondary)' }">{{
                t('knowledge.docCount', { count: totalDocs })
              }}</span>
            </div>
            <div v-if="revalidating" class="flex items-center gap-1.5">
              <RefreshCw :size="12" class="animate-spin" :style="{ color: 'var(--hc-text-muted)' }" />
              <span class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">{{ t('knowledge.syncing') }}</span>
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
                  <span
                    class="text-sm font-medium truncate"
                    :style="{ color: 'var(--hc-text-primary)' }"
                  >
                    {{ doc.title }}
                  </span>
                  <span
                    class="text-[10px] px-2 py-0.5 rounded-full"
                    :style="getDocStatusStyle(doc)"
                  >
                    {{ getDocStatusLabel(doc) }}
                  </span>
                </div>
                <div
                  class="flex items-center gap-3 mt-1 text-xs"
                  :style="{ color: 'var(--hc-text-muted)' }"
                >
                  <span>{{ doc.chunk_count }} chunks</span>
                  <span v-if="doc.source">{{ t('knowledge.source') }}: {{ doc.source }}</span>
                  <span>{{
                    new Date(doc.updated_at || doc.created_at).toLocaleDateString(locale)
                  }}</span>
                </div>
                <p v-if="doc.error_message" class="text-[11px] mt-2" style="color: #dc2626">
                  {{ doc.error_message }}
                </p>
              </button>
              <button
                class="px-2 py-1 rounded-md text-xs hover:bg-white/5 transition-colors"
                :style="{ color: 'var(--hc-text-secondary)' }"
                :disabled="!knowledgeEnabled || reindexingDocIds.has(doc.id)"
                @click="handleReindex(doc)"
              >
                <span class="inline-flex items-center gap-1">
                  <RefreshCw :size="12" :class="{ 'animate-spin': reindexingDocIds.has(doc.id) }" />
                  {{
                    getDocStatus(doc) === 'failed'
                      ? t('knowledge.retryIndex')
                      : t('knowledge.reindex')
                  }}
                </span>
              </button>
              <button
                class="p-1.5 rounded-md hover:bg-white/5 transition-colors"
                :style="{ color: 'var(--hc-error)' }"
                :title="t('common.delete')"
                :disabled="!knowledgeEnabled"
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
              :style="{
                background: 'var(--hc-bg-input)',
                borderColor: 'var(--hc-border)',
                color: 'var(--hc-text-primary)',
              }"
              :disabled="!knowledgeEnabled"
              :placeholder="t('knowledge.searchPlaceholder')"
              @keydown.enter="handleSearch"
            />
            <button
              class="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
              :style="{ background: 'var(--hc-accent)' }"
              :disabled="!knowledgeEnabled || searching || !searchQuery.trim()"
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
                  <div
                    class="text-sm font-medium truncate"
                    :style="{ color: 'var(--hc-text-primary)' }"
                  >
                    {{ resultTitle(result) }}
                  </div>
                  <div
                    v-if="resultMeta(result)"
                    class="text-[11px] mt-1"
                    :style="{ color: 'var(--hc-text-muted)' }"
                  >
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
        <div
          v-if="showAddDialog"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-sm"
          @click.self="closeAddDialog"
        >
          <div
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
                {{ t('knowledge.addDocTitle') }}
              </h2>
              <button
                class="p-1 rounded-md hover:bg-white/5"
                :style="{ color: 'var(--hc-text-muted)' }"
                @click="closeAddDialog"
              >
                <X :size="17" />
              </button>
            </div>
            <div class="p-5 flex flex-col gap-3.5">
              <!-- 文件上传区 -->
              <div
                class="flex items-center gap-3 p-3 rounded-lg border border-dashed cursor-pointer hover:border-solid transition-colors"
                :style="{ borderColor: 'var(--hc-border)', background: 'var(--hc-bg-secondary)' }"
                @click="openFilePicker"
              >
                <Upload :size="20" style="color: var(--hc-accent)" />
                <div>
                  <div class="text-sm font-medium" :style="{ color: 'var(--hc-text-primary)' }">
                    {{ t('knowledge.uploadFile', '上传文件') }}
                  </div>
                  <div class="text-xs" :style="{ color: 'var(--hc-text-secondary)' }">
                    PDF / Word / TXT / Markdown / CSV / Excel
                  </div>
                </div>
              </div>
              <div class="text-center text-xs" :style="{ color: 'var(--hc-text-tertiary)' }">
                {{ t('knowledge.orManualInput', '— 或手动输入 —') }}
              </div>
              <div class="flex flex-col gap-1.5">
                <label
                  class="text-[13px] font-medium"
                  :style="{ color: 'var(--hc-text-secondary)' }"
                  >{{ t('knowledge.docTitle') }}</label
                >
                <input
                  v-model="newTitle"
                  type="text"
                  class="rounded-lg border px-3 py-2 text-sm outline-none"
                  :style="{
                    background: 'var(--hc-bg-input)',
                    borderColor: 'var(--hc-border)',
                    color: 'var(--hc-text-primary)',
                  }"
                  :placeholder="t('knowledge.docTitlePlaceholder')"
                />
              </div>
              <div class="flex flex-col gap-1.5">
                <label
                  class="text-[13px] font-medium"
                  :style="{ color: 'var(--hc-text-secondary)' }"
                  >{{ t('knowledge.docContent') }}</label
                >
                <textarea
                  v-model="newContent"
                  rows="6"
                  class="rounded-lg border px-3 py-2 text-sm outline-none resize-none"
                  :style="{
                    background: 'var(--hc-bg-input)',
                    borderColor: 'var(--hc-border)',
                    color: 'var(--hc-text-primary)',
                  }"
                  :placeholder="t('knowledge.docContentPlaceholder')"
                />
              </div>
              <div class="flex flex-col gap-1.5">
                <label
                  class="text-[13px] font-medium"
                  :style="{ color: 'var(--hc-text-secondary)' }"
                  >{{ t('knowledge.docSource') }}</label
                >
                <input
                  v-model="newSource"
                  type="text"
                  class="rounded-lg border px-3 py-2 text-sm outline-none"
                  :style="{
                    background: 'var(--hc-bg-input)',
                    borderColor: 'var(--hc-border)',
                    color: 'var(--hc-text-primary)',
                  }"
                  :placeholder="t('knowledge.docSourcePlaceholder')"
                />
              </div>
            </div>
            <div
              class="flex items-center justify-end gap-2 px-5 py-3.5 border-t"
              :style="{ borderColor: 'var(--hc-border)' }"
            >
              <button
                class="px-3 py-1.5 rounded-lg text-sm font-medium"
                :style="{ color: 'var(--hc-text-secondary)', background: 'var(--hc-bg-hover)' }"
                @click="closeAddDialog"
              >
                {{ t('common.cancel') }}
              </button>
              <button
                class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white"
                :style="{
                  background: 'var(--hc-accent)',
                  opacity:
                    !knowledgeEnabled || !newTitle.trim() || !newContent.trim() || adding ? 0.4 : 1,
                }"
                :disabled="!knowledgeEnabled || !newTitle.trim() || !newContent.trim() || adding"
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
      @cancel="closeDeleteConfirm"
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
            <div
              class="flex items-center justify-between px-5 py-4 border-b"
              :style="{ borderColor: 'var(--hc-border)' }"
            >
              <div class="min-w-0">
                <h2
                  class="text-[15px] font-semibold truncate"
                  :style="{ color: 'var(--hc-text-primary)' }"
                >
                  {{ selectedDoc.title }}
                </h2>
                <p class="text-xs mt-1" :style="{ color: 'var(--hc-text-secondary)' }">
                  {{ getDocStatusLabel(selectedDoc) }}
                  <span v-if="selectedDoc.source"> · {{ selectedDoc.source }}</span>
                </p>
              </div>
              <button
                class="p-1 rounded-md hover:bg-white/5"
                :style="{ color: 'var(--hc-text-muted)' }"
                @click="showDocDetail = false"
              >
                <X :size="17" />
              </button>
            </div>
            <div class="p-5 overflow-y-auto space-y-4">
              <div
                class="grid grid-cols-2 gap-4 text-xs"
                :style="{ color: 'var(--hc-text-secondary)' }"
              >
                <div>
                  {{ t('knowledge.docCount', { count: 1 }) }} · {{ selectedDoc.chunk_count }} chunks
                </div>
                <div>
                  {{ t('knowledge.updatedAt') }}:
                  {{
                    new Date(selectedDoc.updated_at || selectedDoc.created_at).toLocaleString(
                      locale,
                    )
                  }}
                </div>
              </div>
              <div
                v-if="selectedDoc.error_message"
                class="rounded-lg px-3 py-2 text-sm"
                style="background: #ef444415; color: #dc2626"
              >
                {{ selectedDoc.error_message }}
              </div>
              <div
                class="rounded-xl border p-4 whitespace-pre-wrap break-words text-sm leading-6"
                :style="{
                  background: 'var(--hc-bg-main)',
                  borderColor: 'var(--hc-border)',
                  color: loadingDocContent ? 'var(--hc-text-muted)' : 'var(--hc-text-primary)',
                }"
              >
                <template v-if="loadingDocContent">{{ t('common.loading', '加载中...') }}</template>
                <template v-else>{{ selectedDoc.content || t('knowledge.noContentDetail') }}</template>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.modal-enter-active {
  transition: opacity 0.2s ease-out;
}
.modal-leave-active {
  transition: opacity 0.15s ease-in;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
</style>
