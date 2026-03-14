<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Puzzle, Trash2, Download, FolderOpen, Tag } from 'lucide-vue-next'
import { getSkills, installSkill, uninstallSkill, type Skill } from '@/api/skills'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import SearchInput from '@/components/common/SearchInput.vue'

const { t } = useI18n()

const skills = ref<Skill[]>([])
const skillsDir = ref('')
const loading = ref(true)
const searchQuery = ref('')
const showInstallDialog = ref(false)
const installSource = ref('')
const installing = ref(false)
const installError = ref('')

onMounted(async () => {
  await loadSkills()
})

async function loadSkills() {
  loading.value = true
  try {
    const res = await getSkills()
    skills.value = res.skills || []
    skillsDir.value = res.dir || ''
  } catch (e) {
    console.error('加载 Skill 列表失败:', e)
  } finally {
    loading.value = false
  }
}

async function handleUninstall(name: string) {
  if (!confirm(`确定要卸载技能 "${name}" 吗？`)) return
  try {
    await uninstallSkill(name)
    skills.value = skills.value.filter((s) => s.name !== name)
  } catch (e) {
    console.error('卸载 Skill 失败:', e)
  }
}

async function handleInstall() {
  if (!installSource.value.trim()) return
  installing.value = true
  installError.value = ''
  try {
    await installSkill(installSource.value.trim())
    showInstallDialog.value = false
    installSource.value = ''
    await loadSkills()
  } catch (e: any) {
    installError.value = e?.message || '安装失败'
  } finally {
    installing.value = false
  }
}

const filteredSkills = computed(() => {
  const q = searchQuery.value.toLowerCase()
  if (!q) return skills.value
  return skills.value.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.tags?.some((t) => t.toLowerCase().includes(q)),
  )
})
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <PageHeader :title="t('skills.title')" :description="t('skills.description')">
      <template #actions>
        <div class="flex items-center gap-2">
          <SearchInput v-model="searchQuery" :placeholder="t('skills.searchPlaceholder')" />
          <button
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-white"
            :style="{ background: 'var(--hc-accent)' }"
            @click="showInstallDialog = true"
          >
            <Download :size="14" />
            安装技能
          </button>
        </div>
      </template>
    </PageHeader>

    <div class="flex-1 overflow-y-auto p-6">
      <LoadingState v-if="loading" />

      <EmptyState
        v-else-if="filteredSkills.length === 0"
        :icon="Puzzle"
        :title="t('skills.noSkills')"
        :description="t('skills.noSkillsDesc')"
      >
        <button
          class="mt-4 px-4 py-2 rounded-lg text-sm text-white"
          :style="{ background: 'var(--hc-accent)' }"
          @click="showInstallDialog = true"
        >
          安装第一个技能
        </button>
      </EmptyState>

      <div v-else class="space-y-3 max-w-2xl">
        <!-- 技能目录提示 -->
        <div
          v-if="skillsDir"
          class="flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
          :style="{ background: 'var(--hc-bg-hover)', color: 'var(--hc-text-muted)' }"
        >
          <FolderOpen :size="14" />
          技能目录: {{ skillsDir }}
        </div>

        <div
          v-for="skill in filteredSkills"
          :key="skill.name"
          class="flex items-start gap-4 rounded-xl border p-4"
          :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
        >
          <div
            class="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
            :style="{ background: 'var(--hc-bg-hover)' }"
          >
            <Puzzle :size="20" :style="{ color: 'var(--hc-accent)' }" />
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium" :style="{ color: 'var(--hc-text-primary)' }">
                {{ skill.name }}
              </span>
              <span
                v-if="skill.version"
                class="text-xs px-1.5 py-0.5 rounded"
                :style="{ background: 'var(--hc-bg-hover)', color: 'var(--hc-text-muted)' }"
              >
                v{{ skill.version }}
              </span>
              <span
                v-if="skill.author"
                class="text-xs"
                :style="{ color: 'var(--hc-text-muted)' }"
              >
                by {{ skill.author }}
              </span>
            </div>
            <p class="text-xs mt-1" :style="{ color: 'var(--hc-text-secondary)' }">
              {{ skill.description }}
            </p>
            <!-- 触发词 -->
            <div v-if="skill.triggers?.length" class="flex flex-wrap gap-1.5 mt-2">
              <span
                v-for="trigger in skill.triggers"
                :key="trigger"
                class="text-xs px-1.5 py-0.5 rounded-md"
                :style="{ background: 'var(--hc-bg-hover)', color: 'var(--hc-accent)' }"
              >
                /{{ trigger }}
              </span>
            </div>
            <!-- 标签 -->
            <div v-if="skill.tags?.length" class="flex flex-wrap gap-1.5 mt-1.5">
              <span
                v-for="tag in skill.tags"
                :key="tag"
                class="flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded-md"
                :style="{ background: 'var(--hc-bg-hover)', color: 'var(--hc-text-muted)' }"
              >
                <Tag :size="10" />
                {{ tag }}
              </span>
            </div>
          </div>
          <button
            class="p-1.5 rounded transition-colors hover:bg-red-50"
            :style="{ color: 'var(--hc-text-muted)' }"
            title="卸载"
            @click="handleUninstall(skill.name)"
          >
            <Trash2 :size="16" />
          </button>
        </div>
      </div>
    </div>

    <!-- 安装对话框 -->
    <Teleport to="body">
      <div
        v-if="showInstallDialog"
        class="fixed inset-0 z-50 flex items-center justify-center"
        @click.self="showInstallDialog = false"
      >
        <div class="absolute inset-0 bg-black/50" @click="showInstallDialog = false" />
        <div
          class="relative z-10 w-96 rounded-xl border p-6 shadow-xl"
          :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
        >
          <h3 class="text-base font-medium mb-4" :style="{ color: 'var(--hc-text-primary)' }">
            安装技能
          </h3>
          <p class="text-xs mb-3" :style="{ color: 'var(--hc-text-secondary)' }">
            输入技能文件（.md）或目录的相对路径
          </p>
          <input
            v-model="installSource"
            type="text"
            placeholder="例如: my-skill.md 或 skills/my-skill/"
            class="w-full px-3 py-2 rounded-lg border text-sm"
            :style="{
              background: 'var(--hc-bg-primary)',
              borderColor: 'var(--hc-border)',
              color: 'var(--hc-text-primary)',
            }"
            @keydown.enter="handleInstall"
          />
          <p v-if="installError" class="text-xs mt-2" style="color: var(--hc-error)">
            {{ installError }}
          </p>
          <div class="flex justify-end gap-2 mt-4">
            <button
              class="px-3 py-1.5 rounded-lg text-sm"
              :style="{ color: 'var(--hc-text-secondary)' }"
              @click="showInstallDialog = false"
            >
              取消
            </button>
            <button
              class="px-3 py-1.5 rounded-lg text-sm text-white"
              :style="{ background: installing ? 'var(--hc-text-muted)' : 'var(--hc-accent)' }"
              :disabled="installing || !installSource.trim()"
              @click="handleInstall"
            >
              {{ installing ? '安装中...' : '安装' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
