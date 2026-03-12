<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Puzzle, ToggleLeft, ToggleRight, Download, Search } from 'lucide-vue-next'
import { getSkills, toggleSkill, type Skill } from '@/api/skills'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import SearchInput from '@/components/common/SearchInput.vue'

const { t } = useI18n()

const skills = ref<Skill[]>([])
const loading = ref(true)
const activeTab = ref<'installed' | 'marketplace'>('installed')
const searchQuery = ref('')

// 示例市场 Skill 数据
const marketplaceSkills = ref([
  { id: 'email', name: 'email', display_name: 'Email', description: '收发邮件', version: '1.2.0', author: 'HexClaw', category: 'communication', rating: 4.8 },
  { id: 'calendar', name: 'calendar', display_name: 'Calendar', description: '日程管理', version: '0.8.0', author: 'HexClaw', category: 'productivity', rating: 4.5 },
  { id: 'github', name: 'github', display_name: 'GitHub', description: 'GitHub 操作', version: '2.1.0', author: 'Community', category: 'development', rating: 4.9 },
  { id: 'slack', name: 'slack', display_name: 'Slack', description: 'Slack 消息', version: '1.0.0', author: 'Community', category: 'communication', rating: 4.3 },
  { id: 'notion', name: 'notion', display_name: 'Notion', description: 'Notion 文档', version: '0.5.0', author: 'Community', category: 'productivity', rating: 4.1 },
])

onMounted(async () => {
  try {
    const res = await getSkills()
    skills.value = res.skills || []
  } catch (e) {
    console.error('加载 Skill 列表失败:', e)
  } finally {
    loading.value = false
  }
})

async function handleToggle(skill: Skill) {
  try {
    await toggleSkill(skill.id, !skill.enabled)
    skill.enabled = !skill.enabled
  } catch (e) {
    console.error('切换 Skill 失败:', e)
  }
}

const filteredSkills = computed(() => {
  const q = searchQuery.value.toLowerCase()
  if (!q) return skills.value
  return skills.value.filter(
    (s) => s.name.toLowerCase().includes(q) || (s.display_name || '').toLowerCase().includes(q),
  )
})

const filteredMarketplace = computed(() => {
  const q = searchQuery.value.toLowerCase()
  if (!q) return marketplaceSkills.value
  return marketplaceSkills.value.filter(
    (s) => s.name.toLowerCase().includes(q) || s.display_name.toLowerCase().includes(q),
  )
})
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <PageHeader :title="t('skills.title')" :description="t('skills.description')">
      <template #actions>
        <SearchInput v-model="searchQuery" :placeholder="t('skills.searchPlaceholder')" />
      </template>
    </PageHeader>

    <!-- 标签页 -->
    <div class="flex items-center gap-0 px-6 pt-3 border-b" :style="{ borderColor: 'var(--hc-border)' }">
      <button
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px"
        :style="{
          borderColor: activeTab === 'installed' ? 'var(--hc-accent)' : 'transparent',
          color: activeTab === 'installed' ? 'var(--hc-text-primary)' : 'var(--hc-text-secondary)',
        }"
        @click="activeTab = 'installed'"
      >
        {{ t('skills.installed') }} ({{ skills.length }})
      </button>
      <button
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px"
        :style="{
          borderColor: activeTab === 'marketplace' ? 'var(--hc-accent)' : 'transparent',
          color: activeTab === 'marketplace' ? 'var(--hc-text-primary)' : 'var(--hc-text-secondary)',
        }"
        @click="activeTab = 'marketplace'"
      >
        {{ t('skills.marketplace') }}
      </button>
    </div>

    <div class="flex-1 overflow-y-auto p-6">
      <LoadingState v-if="loading" />

      <!-- 已安装标签 -->
      <template v-else-if="activeTab === 'installed'">
        <EmptyState
          v-if="filteredSkills.length === 0"
          :icon="Puzzle"
          :title="t('skills.noSkills')"
          :description="t('skills.noSkillsDesc')"
        >
          <button
            class="mt-4 px-4 py-2 rounded-lg text-sm text-white"
            :style="{ background: 'var(--hc-accent)' }"
            @click="activeTab = 'marketplace'"
          >
            {{ t('skills.browseMarket') }}
          </button>
        </EmptyState>

        <div v-else class="space-y-3 max-w-2xl">
          <div
            v-for="skill in filteredSkills"
            :key="skill.id"
            class="flex items-center gap-4 rounded-xl border p-4"
            :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
          >
            <div
              class="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
              :style="{ background: 'var(--hc-bg-hover)' }"
            >
              <Puzzle :size="20" :style="{ color: 'var(--hc-accent)' }" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium" :style="{ color: 'var(--hc-text-primary)' }">
                  {{ skill.display_name || skill.name }}
                </span>
                <span
                  class="text-xs px-1.5 py-0.5 rounded"
                  :style="{ background: 'var(--hc-bg-hover)', color: 'var(--hc-text-muted)' }"
                >
                  v{{ skill.version }}
                </span>
              </div>
              <p class="text-xs mt-0.5 truncate" :style="{ color: 'var(--hc-text-secondary)' }">
                {{ skill.description }}
              </p>
            </div>
            <button
              class="p-1 rounded transition-colors"
              :style="{ color: skill.enabled ? 'var(--hc-success)' : 'var(--hc-text-muted)' }"
              @click="handleToggle(skill)"
            >
              <ToggleRight v-if="skill.enabled" :size="28" />
              <ToggleLeft v-else :size="28" />
            </button>
          </div>
        </div>
      </template>

      <!-- 市场标签 -->
      <template v-else>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-w-4xl">
          <div
            v-for="skill in filteredMarketplace"
            :key="skill.id"
            class="rounded-xl border p-4"
            :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
          >
            <div class="flex items-center gap-3 mb-3">
              <div
                class="w-10 h-10 rounded-lg flex items-center justify-center"
                :style="{ background: 'var(--hc-bg-hover)' }"
              >
                <Puzzle :size="20" :style="{ color: 'var(--hc-accent)' }" />
              </div>
              <div>
                <div class="text-sm font-medium" :style="{ color: 'var(--hc-text-primary)' }">
                  {{ skill.display_name }}
                </div>
                <div class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">
                  v{{ skill.version }} · {{ skill.author }}
                </div>
              </div>
            </div>
            <p class="text-xs mb-3" :style="{ color: 'var(--hc-text-secondary)' }">
              {{ skill.description }}
            </p>
            <div class="flex items-center justify-between">
              <span class="text-xs" :style="{ color: 'var(--hc-warning)' }">
                ★ {{ skill.rating }}
              </span>
              <button
                class="flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-medium text-white"
                :style="{ background: 'var(--hc-accent)' }"
              >
                <Download :size="12" />
                {{ t('common.install') }}
              </button>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
