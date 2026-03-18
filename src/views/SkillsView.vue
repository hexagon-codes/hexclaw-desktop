<script setup lang="ts">
import { onMounted, ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Puzzle,
  Trash2,
  Download,
  FolderOpen,
  Tag,
  Store,
  CheckCircle2,
  Search,
  ArrowDownCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  User,
  Zap,
  Info,
} from 'lucide-vue-next'
import {
  getSkills,
  installSkill,
  uninstallSkill,
  searchClawHub,
  installFromHub,
  CLAWHUB_CATEGORIES,
  type Skill,
  type ClawHubSkill,
  type ClawHubCategory,
} from '@/api/skills'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import SearchInput from '@/components/common/SearchInput.vue'

const { t } = useI18n()

// ─── Tab 切换 ─────────────────────────────────────────
const activeTab = ref<'installed' | 'hub'>('hub')

// ─── 已安装 Skill ─────────────────────────────────────
const skills = ref<Skill[]>([])
const skillsDir = ref('')
const loading = ref(true)
const searchQuery = ref('')
const showInstallDialog = ref(false)
const installSource = ref('')
const installing = ref(false)
const installError = ref('')

onMounted(async () => {
  await Promise.all([loadSkills(), loadHubSkills()])
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
  if (!confirm(t('common.confirm') + ` — ${name}?`)) return
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
  } catch (e: unknown) {
    installError.value = e instanceof Error ? e.message : '安装失败'
  } finally {
    installing.value = false
  }
}

// ─── Enable/Disable + Detail state ──────────────────
const disabledSkills = ref<Set<string>>(new Set())
const expandedSkill = ref<string | null>(null)

function toggleSkillEnabled(name: string) {
  if (disabledSkills.value.has(name)) {
    disabledSkills.value.delete(name)
  } else {
    disabledSkills.value.add(name)
  }
  // Trigger reactivity
  disabledSkills.value = new Set(disabledSkills.value)
  // Persist to localStorage
  localStorage.setItem('hexclaw_disabled_skills', JSON.stringify([...disabledSkills.value]))
}

function isSkillEnabled(name: string): boolean {
  return !disabledSkills.value.has(name)
}

function toggleSkillDetail(name: string) {
  expandedSkill.value = expandedSkill.value === name ? null : name
}

// Load disabled skills from localStorage on mount
onMounted(() => {
  try {
    const raw = localStorage.getItem('hexclaw_disabled_skills')
    if (raw) disabledSkills.value = new Set(JSON.parse(raw))
  } catch { /* ignore */ }
})

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

// ─── ClawHub 技能市场 ────────────────────────────────
const hubSkills = ref<ClawHubSkill[]>([])
const hubLoading = ref(false)
const hubSearchQuery = ref('')
const hubCategory = ref<ClawHubCategory>('all')
const hubInstallingSet = ref<Set<string>>(new Set())
const hubInstalledSet = ref<Set<string>>(new Set())

const categoryLabels: Record<ClawHubCategory, string> = {
  all: 'skills.hub.catAll',
  coding: 'skills.hub.catCoding',
  research: 'skills.hub.catResearch',
  writing: 'skills.hub.catWriting',
  data: 'skills.hub.catData',
  automation: 'skills.hub.catAutomation',
  productivity: 'skills.hub.catProductivity',
}

async function loadHubSkills() {
  hubLoading.value = true
  try {
    hubSkills.value = await searchClawHub(
      hubSearchQuery.value || undefined,
      hubCategory.value,
    )
  } catch (e) {
    console.error('加载 ClawHub 失败:', e)
  } finally {
    hubLoading.value = false
  }
}

watch(activeTab, (tab) => {
  if (tab === 'hub' && hubSkills.value.length === 0 && !hubLoading.value) {
    loadHubSkills()
  }
})

watch(hubCategory, () => {
  loadHubSkills()
})

let hubSearchTimer: ReturnType<typeof setTimeout> | null = null
function onHubSearchInput() {
  if (hubSearchTimer) clearTimeout(hubSearchTimer)
  hubSearchTimer = setTimeout(() => {
    loadHubSkills()
  }, 300)
}

async function handleHubInstall(skill: ClawHubSkill) {
  hubInstallingSet.value = new Set([...hubInstallingSet.value, skill.name])
  try {
    await installFromHub(skill.name)
    hubInstalledSet.value = new Set([...hubInstalledSet.value, skill.name])
    // 刷新已安装列表
    await loadSkills()
  } catch (e) {
    console.error('从 ClawHub 安装失败:', e)
  } finally {
    const s = new Set(hubInstallingSet.value)
    s.delete(skill.name)
    hubInstallingSet.value = s
  }
}

function formatDownloads(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

function isHubSkillInstalled(name: string): boolean {
  return (
    hubInstalledSet.value.has(name) ||
    skills.value.some((s) => s.name === name)
  )
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <PageHeader :title="t('skills.title')" :description="t('skills.description')">
      <template #actions>
        <div class="flex items-center gap-2">
          <SearchInput
            v-if="activeTab === 'installed'"
            v-model="searchQuery"
            :placeholder="t('skills.searchPlaceholder')"
          />
          <button
            v-if="activeTab === 'installed'"
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-white"
            :style="{ background: 'var(--hc-accent)' }"
            @click="showInstallDialog = true"
          >
            <Download :size="14" />
            {{ t('skills.hub.installLocal') }}
          </button>
        </div>
      </template>
    </PageHeader>

    <!-- Tab 切换栏 -->
    <div
      class="flex items-center gap-1 px-6 pt-2 pb-0"
    >
      <button
        class="px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors"
        :style="{
          color: activeTab === 'installed' ? 'var(--hc-accent)' : 'var(--hc-text-secondary)',
          borderColor: activeTab === 'installed' ? 'var(--hc-accent)' : 'transparent',
          background: activeTab === 'installed' ? 'var(--hc-bg-hover)' : 'transparent',
        }"
        @click="activeTab = 'installed'"
      >
        <span class="flex items-center gap-1.5">
          <Puzzle :size="14" />
          {{ t('skills.installed') }}
          <span
            v-if="skills.length"
            class="text-xs px-1.5 py-0.5 rounded-full"
            :style="{ background: 'var(--hc-bg-hover)', color: 'var(--hc-text-muted)' }"
          >
            {{ skills.length }}
          </span>
        </span>
      </button>
      <button
        class="px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors"
        :style="{
          color: activeTab === 'hub' ? 'var(--hc-accent)' : 'var(--hc-text-secondary)',
          borderColor: activeTab === 'hub' ? 'var(--hc-accent)' : 'transparent',
          background: activeTab === 'hub' ? 'var(--hc-bg-hover)' : 'transparent',
        }"
        @click="activeTab = 'hub'"
      >
        <span class="flex items-center gap-1.5">
          <Store :size="14" />
          {{ t('skills.hub.title') }}
        </span>
      </button>
    </div>

    <div
      class="mx-6 mb-0"
      :style="{ borderBottom: '1px solid var(--hc-border)' }"
    />

    <!-- ════════ 已安装 Tab ════════ -->
    <div v-if="activeTab === 'installed'" class="flex-1 overflow-y-auto p-6">
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
          @click="activeTab = 'hub'"
        >
          {{ t('skills.browseMarket') }}
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
          {{ t('skills.hub.skillDir') }}: {{ skillsDir }}
        </div>

        <div
          v-for="skill in filteredSkills"
          :key="skill.name"
          class="rounded-xl border overflow-hidden transition-all"
          :style="{
            background: 'var(--hc-bg-card)',
            borderColor: 'var(--hc-border)',
            opacity: isSkillEnabled(skill.name) ? 1 : 0.6,
          }"
        >
          <!-- Main card row -->
          <div class="flex items-start gap-4 p-4">
            <div
              class="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
              :style="{ background: 'var(--hc-bg-hover)' }"
            >
              <Puzzle :size="20" :style="{ color: isSkillEnabled(skill.name) ? 'var(--hc-accent)' : 'var(--hc-text-muted)' }" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <!-- Clickable skill name to expand detail -->
                <button
                  class="text-sm font-medium hover:underline text-left"
                  :style="{ color: 'var(--hc-text-primary)' }"
                  @click="toggleSkillDetail(skill.name)"
                >
                  {{ skill.name }}
                </button>
                <component
                  :is="expandedSkill === skill.name ? ChevronDown : ChevronRight"
                  :size="12"
                  class="cursor-pointer"
                  :style="{ color: 'var(--hc-text-muted)' }"
                  @click="toggleSkillDetail(skill.name)"
                />
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
              <!-- 触发词 (compact in main view) -->
              <div v-if="skill.triggers?.length && expandedSkill !== skill.name" class="flex flex-wrap gap-1.5 mt-2">
                <span
                  v-for="trigger in skill.triggers.slice(0, 3)"
                  :key="trigger"
                  class="text-xs px-1.5 py-0.5 rounded-md"
                  :style="{ background: 'var(--hc-bg-hover)', color: 'var(--hc-accent)' }"
                >
                  /{{ trigger }}
                </span>
                <span v-if="skill.triggers.length > 3" class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">
                  +{{ skill.triggers.length - 3 }}
                </span>
              </div>
            </div>

            <!-- Enable/disable toggle -->
            <button
              class="relative w-9 h-5 rounded-full transition-colors flex-shrink-0 mt-1"
              :style="{
                background: isSkillEnabled(skill.name) ? 'var(--hc-accent)' : 'var(--hc-text-muted)',
              }"
              :title="isSkillEnabled(skill.name) ? t('skills.disableSkill') : t('skills.enableSkill')"
              @click="toggleSkillEnabled(skill.name)"
            >
              <div
                class="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform"
                :style="{
                  transform: isSkillEnabled(skill.name) ? 'translateX(18px)' : 'translateX(2px)',
                }"
              />
            </button>

            <button
              class="p-1.5 rounded transition-colors hover:bg-red-50 flex-shrink-0"
              :style="{ color: 'var(--hc-text-muted)' }"
              :title="t('common.delete')"
              @click="handleUninstall(skill.name)"
            >
              <Trash2 :size="16" />
            </button>
          </div>

          <!-- Expanded detail section -->
          <div
            v-if="expandedSkill === skill.name"
            class="px-4 pb-4 border-t"
            :style="{ borderColor: 'var(--hc-border)' }"
          >
            <div class="grid grid-cols-2 gap-3 mt-3">
              <!-- Version -->
              <div class="flex items-center gap-2">
                <Info :size="12" :style="{ color: 'var(--hc-text-muted)' }" />
                <span class="text-[10px] font-medium" :style="{ color: 'var(--hc-text-muted)' }">{{ t('skills.version') }}</span>
                <span class="text-xs" :style="{ color: 'var(--hc-text-primary)' }">{{ skill.version || '-' }}</span>
              </div>
              <!-- Author -->
              <div class="flex items-center gap-2">
                <User :size="12" :style="{ color: 'var(--hc-text-muted)' }" />
                <span class="text-[10px] font-medium" :style="{ color: 'var(--hc-text-muted)' }">{{ t('skills.author') }}</span>
                <span class="text-xs" :style="{ color: 'var(--hc-text-primary)' }">{{ skill.author || '-' }}</span>
              </div>
            </div>

            <!-- Triggers -->
            <div class="mt-3">
              <div class="flex items-center gap-1.5 mb-1.5">
                <Zap :size="12" :style="{ color: 'var(--hc-text-muted)' }" />
                <span class="text-[10px] font-medium" :style="{ color: 'var(--hc-text-muted)' }">{{ t('skills.triggers') }}</span>
              </div>
              <div v-if="skill.triggers?.length" class="flex flex-wrap gap-1.5">
                <span
                  v-for="trigger in skill.triggers"
                  :key="trigger"
                  class="text-xs px-2 py-0.5 rounded-md"
                  :style="{ background: 'var(--hc-bg-hover)', color: 'var(--hc-accent)' }"
                >
                  /{{ trigger }}
                </span>
              </div>
              <span v-else class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">{{ t('skills.noTriggers') }}</span>
            </div>

            <!-- Tags -->
            <div v-if="skill.tags?.length" class="mt-3">
              <div class="flex items-center gap-1.5 mb-1.5">
                <Tag :size="12" :style="{ color: 'var(--hc-text-muted)' }" />
                <span class="text-[10px] font-medium" :style="{ color: 'var(--hc-text-muted)' }">{{ t('skills.tags') }}</span>
              </div>
              <div class="flex flex-wrap gap-1.5">
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

            <!-- Status -->
            <div class="mt-3 flex items-center gap-2">
              <div
                class="w-2 h-2 rounded-full"
                :style="{ background: isSkillEnabled(skill.name) ? '#10b981' : '#6b7280' }"
              />
              <span class="text-xs" :style="{ color: isSkillEnabled(skill.name) ? '#10b981' : 'var(--hc-text-muted)' }">
                {{ isSkillEnabled(skill.name) ? t('skills.enabled') : t('skills.disabled') }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ════════ ClawHub 市场 Tab ════════ -->
    <div v-if="activeTab === 'hub'" class="flex-1 overflow-y-auto p-6">
      <!-- 搜索栏 -->
      <div class="max-w-4xl mb-4">
        <div class="relative">
          <Search
            :size="16"
            class="absolute left-3 top-1/2 -translate-y-1/2"
            :style="{ color: 'var(--hc-text-muted)' }"
          />
          <input
            v-model="hubSearchQuery"
            type="text"
            :placeholder="t('skills.hub.searchPlaceholder')"
            class="w-full pl-9 pr-3 py-2 rounded-lg border text-sm"
            :style="{
              background: 'var(--hc-bg-primary)',
              borderColor: 'var(--hc-border)',
              color: 'var(--hc-text-primary)',
            }"
            @input="onHubSearchInput"
          />
        </div>
      </div>

      <!-- 分类 Chips -->
      <div class="flex flex-wrap gap-2 mb-5 max-w-4xl">
        <button
          v-for="cat in CLAWHUB_CATEGORIES"
          :key="cat"
          class="px-3 py-1 rounded-full text-xs font-medium transition-colors"
          :style="{
            background: hubCategory === cat ? 'var(--hc-accent)' : 'var(--hc-bg-hover)',
            color: hubCategory === cat ? '#fff' : 'var(--hc-text-secondary)',
          }"
          @click="hubCategory = cat"
        >
          {{ t(categoryLabels[cat]) }}
        </button>
      </div>

      <LoadingState v-if="hubLoading" />

      <EmptyState
        v-else-if="hubSkills.length === 0"
        :icon="Store"
        :title="t('skills.hub.noResults')"
        :description="t('skills.hub.noResultsDesc')"
      />

      <!-- 技能卡片网格 -->
      <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-w-4xl">
        <div
          v-for="skill in hubSkills"
          :key="skill.name"
          class="rounded-xl border p-4 flex flex-col"
          :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
        >
          <!-- 头部: 名称 + 作者 -->
          <div class="flex items-start justify-between gap-2 mb-2">
            <div class="min-w-0">
              <h4 class="text-sm font-medium truncate" :style="{ color: 'var(--hc-text-primary)' }">
                {{ skill.name }}
              </h4>
              <p class="text-xs mt-0.5" :style="{ color: 'var(--hc-text-muted)' }">
                {{ skill.author }} &middot; v{{ skill.version }}
              </p>
            </div>
            <div
              class="flex items-center gap-1 text-xs flex-shrink-0"
              :style="{ color: 'var(--hc-text-muted)' }"
            >
              <ArrowDownCircle :size="12" />
              {{ formatDownloads(skill.downloads) }}
            </div>
          </div>

          <!-- 描述 -->
          <p
            class="text-xs leading-relaxed flex-1 mb-3"
            :style="{ color: 'var(--hc-text-secondary)' }"
          >
            {{ skill.description }}
          </p>

          <!-- 标签 -->
          <div class="flex flex-wrap gap-1.5 mb-3">
            <span
              v-for="tag in skill.tags"
              :key="tag"
              class="text-xs px-1.5 py-0.5 rounded-md"
              :style="{ background: 'var(--hc-bg-hover)', color: 'var(--hc-text-muted)' }"
            >
              {{ tag }}
            </span>
          </div>

          <!-- 安装按钮 -->
          <button
            v-if="isHubSkillInstalled(skill.name)"
            class="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium"
            :style="{ background: 'var(--hc-bg-hover)', color: 'var(--hc-text-muted)' }"
            disabled
          >
            <CheckCircle2 :size="14" />
            {{ t('skills.hub.installed') }}
          </button>
          <button
            v-else-if="hubInstallingSet.has(skill.name)"
            class="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white"
            :style="{ background: 'var(--hc-text-muted)' }"
            disabled
          >
            <Loader2 :size="14" class="animate-spin" />
            {{ t('skills.hub.installing') }}
          </button>
          <button
            v-else
            class="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white transition-opacity hover:opacity-90"
            :style="{ background: 'var(--hc-accent)' }"
            @click="handleHubInstall(skill)"
          >
            <Download :size="14" />
            {{ t('skills.hub.install') }}
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
            {{ t('skills.hub.installLocal') }}
          </h3>
          <p class="text-xs mb-3" :style="{ color: 'var(--hc-text-secondary)' }">
            {{ t('skills.hub.installLocalDesc') }}
          </p>
          <input
            v-model="installSource"
            type="text"
            :placeholder="t('skills.hub.installLocalPlaceholder')"
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
              {{ t('common.cancel') }}
            </button>
            <button
              class="px-3 py-1.5 rounded-lg text-sm text-white"
              :style="{ background: installing ? 'var(--hc-text-muted)' : 'var(--hc-accent)' }"
              :disabled="installing || !installSource.trim()"
              @click="handleInstall"
            >
              {{ installing ? t('skills.hub.installing') : t('common.install') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
