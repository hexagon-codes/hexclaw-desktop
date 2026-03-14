<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Brain, Search, Save } from 'lucide-vue-next'
import { getMemory, saveMemory, searchMemory } from '@/api/memory'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'

const { t } = useI18n()

const loading = ref(true)
const errorMsg = ref('')
const memoryContent = ref('')
const memoryContext = ref('')
const activeTab = ref<'view' | 'add' | 'search'>('view')

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
    errorMsg.value = e instanceof Error ? e.message : '加载记忆失败'
    console.error('加载记忆失败:', e)
  } finally {
    loading.value = false
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
    errorMsg.value = e instanceof Error ? e.message : '保存记忆失败'
    console.error('保存记忆失败:', e)
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
    errorMsg.value = e instanceof Error ? e.message : '搜索记忆失败'
    console.error('搜索记忆失败:', e)
  } finally {
    searching.value = false
  }
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <PageHeader :title="t('memory.title')" :description="t('memory.description')" />

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
          <div
            v-if="memoryContent"
            class="rounded-xl border p-4"
            :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
          >
            <div class="flex items-center gap-2 mb-3">
              <Brain :size="14" :style="{ color: 'var(--hc-accent)' }" />
              <span class="text-xs font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('memory.memoryContent') }}</span>
            </div>
            <p class="text-sm leading-relaxed whitespace-pre-wrap" :style="{ color: 'var(--hc-text-primary)' }">
              {{ memoryContent }}
            </p>
          </div>

          <div
            v-if="memoryContext"
            class="rounded-xl border p-4"
            :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
          >
            <div class="flex items-center gap-2 mb-3">
              <span class="text-xs font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('memory.context') }}</span>
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
  </div>
</template>
