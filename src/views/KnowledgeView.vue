<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookOpen, Upload, Trash2, Search, FileText, Plus, X } from 'lucide-vue-next'
import { getDocuments, addDocument, deleteDocument, searchKnowledge } from '@/api/knowledge'
import type { KnowledgeDoc, KnowledgeSearchResult } from '@/types'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const { t } = useI18n()

const docs = ref<KnowledgeDoc[]>([])
const totalDocs = ref(0)
const loading = ref(true)
const errorMsg = ref('')
const activeTab = ref<'documents' | 'search'>('documents')

// 添加文档对话框
const showAddDialog = ref(false)
const newTitle = ref('')
const newContent = ref('')
const newSource = ref('')
const adding = ref(false)

// 删除确认
const showDeleteConfirm = ref(false)
const deletingDoc = ref<KnowledgeDoc | null>(null)

// 搜索测试
const searchQuery = ref('')
const searchResults = ref<KnowledgeSearchResult[]>([])
const searching = ref(false)

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
    errorMsg.value = e instanceof Error ? e.message : '加载知识库失败'
    console.error('加载知识库失败:', e)
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
    errorMsg.value = e instanceof Error ? e.message : '添加文档失败'
    console.error('添加文档失败:', e)
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
    errorMsg.value = e instanceof Error ? e.message : '删除文档失败'
    console.error('删除文档失败:', e)
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
    errorMsg.value = e instanceof Error ? e.message : '搜索失败'
    console.error('搜索失败:', e)
  } finally {
    searching.value = false
  }
}

/** 安全格式化相似度分数 — clamp 到 0~1 后显示百分比 */
function formatScore(score: number): string {
  const clamped = Math.max(0, Math.min(1, score))
  return `${(clamped * 100).toFixed(1)}%`
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <PageHeader :title="t('knowledge.title')" :description="t('knowledge.description')">
      <template #actions>
        <button
          class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white"
          :style="{ background: 'var(--hc-accent)' }"
          @click="showAddDialog = true"
        >
          <Plus :size="16" />
          {{ t('knowledge.addDoc') }}
        </button>
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
            @click="showAddDialog = true"
          >
            {{ t('knowledge.addDoc') }}
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
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-medium truncate" :style="{ color: 'var(--hc-text-primary)' }">
                    {{ doc.title }}
                  </span>
                </div>
                <div class="flex items-center gap-3 mt-1 text-xs" :style="{ color: 'var(--hc-text-muted)' }">
                  <span>{{ doc.chunk_count }} chunks</span>
                  <span v-if="doc.source">{{ t('knowledge.source') }}: {{ doc.source }}</span>
                  <span>{{ new Date(doc.created_at).toLocaleDateString('zh-CN') }}</span>
                </div>
              </div>
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
  </div>
</template>

<style scoped>
.modal-enter-active { transition: opacity 0.2s ease-out; }
.modal-leave-active { transition: opacity 0.15s ease-in; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
