<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Brain, Search, Save, Pencil, Trash2, X, Check, Eraser } from 'lucide-vue-next'
import { getMemory, saveMemory, updateMemory, clearAllMemory, searchMemory } from '@/api/memory'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const { t } = useI18n()

const loading = ref(true)
const errorMsg = ref('')
const memoryContent = ref('')
const memoryContext = ref('')
const activeTab = ref<'view' | 'add' | 'search'>('view')

// 编辑状态
const editingContent = ref(false)
const editContentValue = ref('')
const savingEdit = ref(false)

// 删除确认
const showDeleteContentConfirm = ref(false)
const showClearAllConfirm = ref(false)
const deleting = ref(false)

// 添加记忆
const newContent = ref('')
const saving = ref(false)

// 搜索记忆
const searchQuery = ref('')
const searchResults = ref<string[]>([])
const searching = ref(false)

onMounted(async () => {
  await loadMemory()
})

async function loadMemory() {
  loading.value = true
  errorMsg.value = ''
  try {
    const res = await getMemory()
    memoryContent.value = res.content || ''
    memoryContext.value = res.context || ''
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('memory.loadFailed', 'Failed to load memory')
    console.error('Failed to load memory:', e)
  } finally {
    loading.value = false
  }
}

// 编辑记忆内容
function startEditContent() {
  editContentValue.value = memoryContent.value
  editingContent.value = true
}

function cancelEditContent() {
  editingContent.value = false
  editContentValue.value = ''
}

async function saveEditContent() {
  if (!editContentValue.value.trim()) return
  savingEdit.value = true
  errorMsg.value = ''
  try {
    await updateMemory(editContentValue.value.trim())
    memoryContent.value = editContentValue.value.trim()
    editingContent.value = false
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('memory.saveFailed', 'Failed to save memory')
  } finally {
    savingEdit.value = false
  }
}

// 删除记忆内容
async function handleDeleteContent() {
  deleting.value = true
  errorMsg.value = ''
  try {
    await updateMemory('')
    memoryContent.value = ''
    showDeleteContentConfirm.value = false
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('memory.deleteFailed', 'Failed to delete memory')
  } finally {
    deleting.value = false
  }
}

// 清空全部
async function handleClearAll() {
  deleting.value = true
  errorMsg.value = ''
  try {
    await clearAllMemory()
    memoryContent.value = ''
    memoryContext.value = ''
    showClearAllConfirm.value = false
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('memory.clearFailed', 'Failed to clear memory')
  } finally {
    deleting.value = false
  }
}

async function handleSave() {
  if (!newContent.value.trim()) return
  saving.value = true
  errorMsg.value = ''
  try {
    await saveMemory(newContent.value.trim())
    newContent.value = ''
    await loadMemory()
    activeTab.value = 'view'
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('memory.saveFailed', 'Failed to save memory')
    console.error('Failed to save memory:', e)
  } finally {
    saving.value = false
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
    const res = await searchMemory(searchQuery.value)
    searchResults.value = res.results || []
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('memory.searchFailed', 'Search failed')
    console.error('Failed to search memory:', e)
  } finally {
    searching.value = false
  }
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- Clear All button (contextual, only when content exists) -->
    <div v-if="memoryContent || memoryContext" class="flex justify-end px-6 pt-2">
      <button
        class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
        style="background: rgba(239, 68, 68, 0.1); color: #ef4444;"
        @click="showClearAllConfirm = true"
      >
        <Eraser :size="13" />
        {{ t('memory.clearAll') }}
      </button>
    </div>

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
          borderColor: activeTab === 'view' ? 'var(--hc-accent)' : 'transparent',
          color: activeTab === 'view' ? 'var(--hc-text-primary)' : 'var(--hc-text-secondary)',
        }"
        @click="activeTab = 'view'"
      >
        {{ t('memory.currentMemory') }}
      </button>
      <button
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px"
        :style="{
          borderColor: activeTab === 'add' ? 'var(--hc-accent)' : 'transparent',
          color: activeTab === 'add' ? 'var(--hc-text-primary)' : 'var(--hc-text-secondary)',
        }"
        @click="activeTab = 'add'"
      >
        {{ t('memory.addMemory') }}
      </button>
      <button
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px"
        :style="{
          borderColor: activeTab === 'search' ? 'var(--hc-accent)' : 'transparent',
          color: activeTab === 'search' ? 'var(--hc-text-primary)' : 'var(--hc-text-secondary)',
        }"
        @click="activeTab = 'search'"
      >
        {{ t('memory.searchMemory') }}
      </button>
    </div>

    <div class="flex-1 overflow-y-auto p-6">
      <LoadingState v-if="loading" />

      <!-- 查看记忆 -->
      <template v-else-if="activeTab === 'view'">
        <EmptyState
          v-if="!memoryContent && !memoryContext"
          :icon="Brain"
          :title="t('common.noData')"
          :description="t('memory.description')"
        />

        <div v-else class="max-w-2xl space-y-4">
          <!-- 记忆内容卡片 -->
          <div
            v-if="memoryContent || editingContent"
            class="rounded-xl border p-4"
            :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
          >
            <div class="flex items-center gap-2 mb-3">
              <Brain :size="14" :style="{ color: 'var(--hc-accent)' }" />
              <span class="text-xs font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('memory.memoryContent') }}</span>
              <div class="ml-auto flex items-center gap-1">
                <template v-if="editingContent">
                  <button
                    class="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    :style="{ color: 'var(--hc-success, #10b981)' }"
                    :disabled="savingEdit"
                    @click="saveEditContent"
                  >
                    <Check :size="14" />
                  </button>
                  <button
                    class="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    :style="{ color: 'var(--hc-text-muted)' }"
                    @click="cancelEditContent"
                  >
                    <X :size="14" />
                  </button>
                </template>
                <template v-else>
                  <button
                    class="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    :style="{ color: 'var(--hc-text-muted)' }"
                    title="编辑"
                    @click="startEditContent"
                  >
                    <Pencil :size="13" />
                  </button>
                  <button
                    class="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    style="color: #ef4444;"
                    title="删除"
                    @click="showDeleteContentConfirm = true"
                  >
                    <Trash2 :size="13" />
                  </button>
                </template>
              </div>
            </div>
            <textarea
              v-if="editingContent"
              v-model="editContentValue"
              rows="6"
              class="w-full rounded-lg border px-3 py-2 text-sm outline-none resize-none"
              :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
            />
            <p v-else class="text-sm leading-relaxed whitespace-pre-wrap" :style="{ color: 'var(--hc-text-primary)' }">
              {{ memoryContent }}
            </p>
          </div>

          <!-- 上下文卡片 (read-only — context is auto-generated by the backend) -->
          <div
            v-if="memoryContext"
            class="rounded-xl border p-4"
            :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
          >
            <div class="flex items-center gap-2 mb-3">
              <span class="text-xs font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('memory.context') }}</span>
              <span class="text-[10px] px-1.5 py-0.5 rounded" :style="{ background: 'var(--hc-bg-hover)', color: 'var(--hc-text-muted)' }">{{ t('memory.readOnly', 'Read-only') }}</span>
            </div>
            <p class="text-sm leading-relaxed whitespace-pre-wrap" :style="{ color: 'var(--hc-text-primary)' }">
              {{ memoryContext }}
            </p>
          </div>
        </div>
      </template>

      <!-- 添加记忆 -->
      <template v-else-if="activeTab === 'add'">
        <div class="max-w-2xl">
          <p class="text-sm mb-4" :style="{ color: 'var(--hc-text-secondary)' }">
            {{ t('memory.addDesc') }}
          </p>
          <textarea
            v-model="newContent"
            rows="8"
            class="w-full rounded-lg border px-3 py-2 text-sm outline-none resize-none mb-4"
            :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
            :placeholder="t('memory.inputPlaceholder')"
          />
          <button
            class="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
            :style="{ background: 'var(--hc-accent)', opacity: (!newContent.trim() || saving) ? 0.4 : 1 }"
            :disabled="!newContent.trim() || saving"
            @click="handleSave"
          >
            <Save :size="14" />
            {{ saving ? t('memory.saving') : t('memory.saveMemory') }}
          </button>
        </div>
      </template>

      <!-- 搜索记忆 -->
      <template v-else>
        <div class="max-w-2xl">
          <p class="text-sm mb-4" :style="{ color: 'var(--hc-text-secondary)' }">
            {{ t('memory.searchDesc') }}
          </p>

          <div class="flex gap-2 mb-6">
            <input
              v-model="searchQuery"
              type="text"
              class="flex-1 rounded-lg border px-3 py-2 text-sm outline-none"
              :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
              :placeholder="t('memory.searchPlaceholder')"
              @keydown.enter="handleSearch"
            />
            <button
              class="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
              :style="{ background: 'var(--hc-accent)' }"
              :disabled="searching || !searchQuery.trim()"
              @click="handleSearch"
            >
              <Search :size="14" />
              {{ searching ? t('memory.searching') : t('common.search') }}
            </button>
          </div>

          <div v-if="searchResults.length > 0" class="space-y-3">
            <div
              v-for="(result, idx) in searchResults"
              :key="idx"
              class="rounded-xl border p-4"
              :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
            >
              <div class="flex items-center gap-2 mb-2">
                <span class="text-xs tabular-nums" :style="{ color: 'var(--hc-text-muted)' }">
                  #{{ idx + 1 }}
                </span>
              </div>
              <p class="text-sm leading-relaxed" :style="{ color: 'var(--hc-text-primary)' }">
                {{ result }}
              </p>
            </div>
          </div>

          <EmptyState
            v-else-if="!searching && searchQuery"
            :icon="Search"
            :title="t('common.noData')"
            :description="t('memory.noSearchResults')"
          />
        </div>
      </template>
    </div>

    <!-- 确认对话框 -->
    <ConfirmDialog
      :open="showDeleteContentConfirm"
      :title="t('memory.deleteTitle', 'Delete Memory')"
      :message="t('memory.deleteMessage', 'Are you sure you want to delete this memory? This cannot be undone.')"
      :confirm-text="t('common.delete')"
      :danger="true"
      @confirm="handleDeleteContent"
      @cancel="showDeleteContentConfirm = false"
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
