<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookOpen, Upload, Trash2, Search, FileText, HardDrive } from 'lucide-vue-next'
import { getDocuments, uploadDocument, deleteDocument, type KnowledgeDoc, type KnowledgeStats } from '@/api/knowledge'
import { apiPost } from '@/api/client'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'

const { t } = useI18n()

const docs = ref<KnowledgeDoc[]>([])
const stats = ref<KnowledgeStats | null>(null)
const loading = ref(true)
const uploading = ref(false)
const fileInput = ref<HTMLInputElement>()
const activeTab = ref<'documents' | 'search'>('documents')
const dragOver = ref(false)

// 分页
const PAGE_SIZE = 50
const visibleCount = ref(PAGE_SIZE)
const visibleDocs = computed(() => docs.value.slice(0, visibleCount.value))

// 搜索测试
const searchQuery = ref('')
const searchResults = ref<{ content: string; score: number; doc_name: string }[]>([])
const searching = ref(false)

onMounted(async () => {
  await loadDocs()
})

async function loadDocs() {
  loading.value = true
  try {
    const res = await getDocuments()
    docs.value = res.documents || []
    stats.value = res.stats || null
  } catch (e) {
    console.error('加载知识库失败:', e)
  } finally {
    loading.value = false
  }
}

function triggerUpload() {
  fileInput.value?.click()
}

async function handleUpload(event: Event) {
  const input = event.target as HTMLInputElement
  const files = input.files
  if (!files?.length) return

  uploading.value = true
  try {
    for (const file of Array.from(files)) {
      const doc = await uploadDocument(file)
      docs.value.unshift(doc)
    }
  } catch (e) {
    console.error('上传文档失败:', e)
  } finally {
    uploading.value = false
    input.value = ''
  }
}

async function handleDelete(doc: KnowledgeDoc) {
  try {
    await deleteDocument(doc.id)
    docs.value = docs.value.filter((d) => d.id !== doc.id)
  } catch (e) {
    console.error('删除文档失败:', e)
  }
}

// 拖放上传
function handleDragOver(e: DragEvent) {
  e.preventDefault()
  dragOver.value = true
}

function handleDragLeave() {
  dragOver.value = false
}

async function handleDrop(e: DragEvent) {
  e.preventDefault()
  dragOver.value = false
  const files = e.dataTransfer?.files
  if (!files?.length) return

  uploading.value = true
  try {
    for (const file of Array.from(files)) {
      const doc = await uploadDocument(file)
      docs.value.unshift(doc)
    }
  } catch (e) {
    console.error('拖放上传失败:', e)
  } finally {
    uploading.value = false
  }
}

// 搜索测试
async function handleSearch() {
  if (!searchQuery.value.trim()) return
  searching.value = true
  try {
    const res = await apiPost<{ results: typeof searchResults.value }>('/api/v1/knowledge/search', {
      query: searchQuery.value,
      limit: 5,
    })
    searchResults.value = res.results || []
  } catch (e) {
    console.error('搜索失败:', e)
  } finally {
    searching.value = false
  }
}

function formatSize(bytes: number): string {
  if (bytes < 0) return '0 B'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
}

function docStatus(s: string): 'online' | 'running' | 'error' | 'idle' {
  const map: Record<string, 'online' | 'running' | 'error' | 'idle'> = { ready: 'online', processing: 'running', error: 'error' }
  return map[s] || 'idle'
}
</script>

<template>
  <div
    class="h-full flex flex-col overflow-hidden"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
  >
    <PageHeader :title="t('knowledge.title')" :description="t('knowledge.description')">
      <template #actions>
        <button
          class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white"
          :style="{ background: 'var(--hc-accent)' }"
          :disabled="uploading"
          @click="triggerUpload"
        >
          <Upload :size="16" />
          {{ uploading ? t('knowledge.uploading') : t('knowledge.uploadDoc') }}
        </button>
        <input ref="fileInput" type="file" class="hidden" accept=".pdf,.txt,.md,.doc,.docx,.csv" multiple @change="handleUpload" />
      </template>
    </PageHeader>

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

    <!-- 拖放遮罩 -->
    <div
      v-if="dragOver"
      class="absolute inset-0 z-40 flex items-center justify-center bg-blue-500/10 border-2 border-dashed border-blue-500/50 rounded-xl m-2"
    >
      <div class="text-center">
        <Upload :size="48" class="mx-auto mb-2" :style="{ color: 'var(--hc-accent)' }" />
        <p class="text-sm font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ t('knowledge.dropHint') }}</p>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto p-6 relative">
      <LoadingState v-if="loading" />

      <!-- 文档标签 -->
      <template v-else-if="activeTab === 'documents'">
        <EmptyState
          v-if="docs.length === 0"
          :icon="BookOpen"
          :title="t('knowledge.noDocs')"
          :description="t('knowledge.noDocsDesc')"
        >
          <button
            class="mt-4 px-4 py-2 rounded-lg text-sm text-white"
            :style="{ background: 'var(--hc-accent)' }"
            @click="triggerUpload"
          >
            {{ t('knowledge.uploadDoc') }}
          </button>
        </EmptyState>

        <template v-else>
          <!-- 统计栏 -->
          <div
            v-if="stats"
            class="flex items-center gap-6 mb-4 px-4 py-3 rounded-xl border"
            :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
          >
            <div class="flex items-center gap-2">
              <FileText :size="14" :style="{ color: 'var(--hc-accent)' }" />
              <span class="text-xs" :style="{ color: 'var(--hc-text-secondary)' }">{{ stats.total_docs }} 文档</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-xs" :style="{ color: 'var(--hc-text-secondary)' }">{{ stats.total_chunks }} chunks</span>
            </div>
            <div class="flex items-center gap-2">
              <HardDrive :size="14" :style="{ color: 'var(--hc-text-muted)' }" />
              <span class="text-xs" :style="{ color: 'var(--hc-text-secondary)' }">{{ formatSize(stats.total_size) }}</span>
            </div>
          </div>

          <!-- 文档列表 -->
          <div class="space-y-3 max-w-2xl">
            <div
              v-for="doc in visibleDocs"
              :key="doc.id"
              class="flex items-center gap-4 rounded-xl border p-4"
              :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
            >
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-medium truncate" :style="{ color: 'var(--hc-text-primary)' }">
                    {{ doc.filename }}
                  </span>
                  <StatusBadge :status="docStatus(doc.status)" />
                </div>
                <div class="flex items-center gap-3 mt-1 text-xs" :style="{ color: 'var(--hc-text-muted)' }">
                  <span>{{ formatSize(doc.size) }}</span>
                  <span>{{ doc.chunk_count }} chunks</span>
                  <span>{{ new Date(doc.created_at).toLocaleDateString('zh-CN') }}</span>
                </div>
                <p v-if="doc.error" class="text-xs mt-1" :style="{ color: 'var(--hc-error)' }">{{ doc.error }}</p>
              </div>
              <button
                class="p-1.5 rounded-md hover:bg-white/5 transition-colors"
                :style="{ color: 'var(--hc-error)' }"
                :title="t('common.delete')"
                @click="handleDelete(doc)"
              >
                <Trash2 :size="16" />
              </button>
            </div>
          </div>

          <!-- 加载更多 -->
          <div v-if="visibleCount < docs.length" class="mt-4 max-w-2xl text-center">
            <button
              class="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              :style="{ background: 'var(--hc-bg-hover)', color: 'var(--hc-text-primary)' }"
              @click="visibleCount += PAGE_SIZE"
            >
              加载更多（还有 {{ docs.length - visibleCount }} 个文档）
            </button>
          </div>

          <!-- 拖放区 -->
          <div
            class="mt-4 max-w-2xl rounded-xl border-2 border-dashed p-8 text-center"
            :style="{ borderColor: 'var(--hc-border)' }"
          >
            <Upload :size="24" class="mx-auto mb-2 opacity-30" :style="{ color: 'var(--hc-text-muted)' }" />
            <p class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">{{ t('knowledge.dragHint') }}</p>
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
                <span class="text-xs font-medium" :style="{ color: 'var(--hc-accent)' }">
                  {{ result.doc_name }}
                </span>
                <span class="text-xs tabular-nums" :style="{ color: 'var(--hc-text-muted)' }">
                  相似度: {{ (result.score * 100).toFixed(1) }}%
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
  </div>
</template>
