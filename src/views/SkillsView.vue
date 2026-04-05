<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed, watch } from 'vue'
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
  setSkillEnabled,
  searchClawHub,
  installFromHub,
  CLAWHUB_CATEGORIES,
  type Skill,
  type ClawHubSkill,
  type ClawHubCategory,
  type SkillInstallType,
} from '@/api/skills'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import { getCurrentWindow } from '@tauri-apps/api/window'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import SearchInput from '@/components/common/SearchInput.vue'
import { useAppStore } from '@/stores/app'

const { t } = useI18n()
const appStore = useAppStore()

const props = withDefaults(defineProps<{
  embeddedSearch?: string
  hideInstalledSearch?: boolean
}>(), {
  embeddedSearch: undefined,
  hideInstalledSearch: false,
})

// ─── Tab 切换 ─────────────────────────────────────────
const activeTab = ref<'installed' | 'hub'>('installed')

// ─── 已安装 Skill ─────────────────────────────────────
const skills = ref<Skill[]>([])
const skillsDir = ref('')
const loading = ref(true)
const searchQuery = ref('')
const showInstallDialog = ref(false)
const installSource = ref('')
const installUrl = ref('')
const installing = ref(false)
const installError = ref('')
const dragOver = ref(false)
const disabledSkills = ref<Set<string>>(readDisabledSkillsFromStorage())
const expandedSkill = ref<string | null>(null)
const statusNotice = ref<{ tone: 'info' | 'warn' | 'success'; message: string } | null>(null)
const togglingSkills = ref<Set<string>>(new Set())

let unlistenDrop: (() => void) | null = null

onMounted(async () => {
  await loadSkills()
  // Tauri 原生拖拽监听
  getCurrentWindow().onDragDropEvent((event) => {
    if (!showInstallDialog.value) return
    if (event.payload.type === 'over') {
      dragOver.value = true
    } else if (event.payload.type === 'drop') {
      dragOver.value = false
      handleFileDrop(event.payload.paths)
    } else if (event.payload.type === 'leave') {
      dragOver.value = false
    }
  }).then((unlisten) => {
    unlistenDrop = unlisten
  })
})

function readDisabledSkillsFromStorage(): Set<string> {
  try {
    const raw = localStorage.getItem('hexclaw_disabled_skills')
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

async function loadSkills() {
  loading.value = true
  try {
    const res = await getSkills()
    skills.value = res.skills || []
    skillsDir.value = res.dir || ''
    const localDisabled = readDisabledSkillsFromStorage()
    const next = new Set<string>()
    for (const s of skills.value) {
      if (s.enabled === false || (s.enabled == null && localDisabled.has(s.name))) {
        next.add(s.name)
      }
    }
    disabledSkills.value = next
    localStorage.setItem('hexclaw_disabled_skills', JSON.stringify([...next]))
  } catch (e) {
    console.error('加载 Skill 列表失败:', e)
  } finally {
    loading.value = false
  }
}

function setLocalSkillEnabled(name: string, enabled: boolean) {
  const next = new Set(disabledSkills.value)
  if (enabled) {
    next.delete(name)
  } else {
    next.add(name)
  }
  disabledSkills.value = next
  localStorage.setItem('hexclaw_disabled_skills', JSON.stringify([...next]))
}

function updateSkill(name: string, patch: Partial<Skill>) {
  const idx = skills.value.findIndex((skill) => skill.name === name)
  if (idx < 0) return
  skills.value[idx] = {
    ...skills.value[idx]!,
    ...patch,
  }
}

function getSkillScope(skill: Skill): 'runtime' | 'local' {
  return typeof skill.enabled === 'boolean' ? 'runtime' : 'local'
}

const pendingUninstall = ref<string | null>(null)

async function handleUninstall(name: string) {
  pendingUninstall.value = name
}

async function confirmUninstall() {
  const name = pendingUninstall.value
  if (!name) return
  pendingUninstall.value = null
  try {
    await uninstallSkill(name)
    await restartEngineAfterSkillChange(
      `技能「${name}」已卸载，正在重启引擎...`,
      `技能「${name}」已卸载并重新载入`,
    )
  } catch (e) {
    console.error('卸载 Skill 失败:', e)
  }
}

async function doInstall(source: string, type: SkillInstallType) {
  if (installing.value) return
  installing.value = true
  installError.value = ''
  try {
    await installSkill(source, type)
    closeInstallDialog()
    await restartEngineAfterSkillChange(
      '技能已安装，正在重启引擎...',
      '技能已安装并重新载入',
    )
  } catch (e: unknown) {
    installError.value = e instanceof Error ? e.message : '安装失败'
  } finally {
    installing.value = false
  }
}

async function handlePickFile() {
  const path = await openFileDialog({
    filters: [{ name: 'Skill', extensions: ['md'] }],
    multiple: false,
  })
  if (path) doInstall(path, 'file')
}

function handleUrlInstall() {
  const url = installUrl.value.trim()
  if (!url) return
  if (!url.startsWith('https://')) {
    installError.value = t('skills.installDialog.errorUrlHttps')
    return
  }
  doInstall(url, 'url')
}

function handleFileDrop(paths: string[]) {
  const md = paths.find((p) => p.toLowerCase().endsWith('.md'))
  if (md) {
    doInstall(md, 'file')
  } else {
    installError.value = t('skills.installDialog.errorNotMd')
  }
}

async function toggleSkillEnabled(name: string) {
  if (togglingSkills.value.has(name)) return
  const skill = skills.value.find((item) => item.name === name)
  if (!skill) return

  const previousSkill = { ...skill }
  const previousLocal = new Set(disabledSkills.value)
  const nextEnabled = !isSkillEnabled(skill)

  statusNotice.value = null
  togglingSkills.value = new Set([...togglingSkills.value, name])

  if (getSkillScope(skill) === 'runtime') {
    updateSkill(name, { enabled: nextEnabled })
  } else {
    setLocalSkillEnabled(name, nextEnabled)
  }

  try {
    const result = await setSkillEnabled(name, nextEnabled)
    if (result.success && result.source === 'backend') {
      updateSkill(name, {
        enabled: result.enabled,
        effective_enabled: result.effective_enabled ?? result.enabled,
        requires_restart: result.requires_restart,
        message: result.message,
      })
      if (result.requires_restart) {
        await restartEngineAfterSkillChange(
          result.message || t('skills.restartRequired'),
          `技能「${name}」已更新并重新载入`,
        )
      } else {
        statusNotice.value = result.message
          ? { tone: 'success', message: result.message }
          : null
      }
    } else if (getSkillScope(previousSkill) === 'runtime') {
      updateSkill(name, previousSkill)
      disabledSkills.value = previousLocal
      statusNotice.value = {
        tone: 'warn',
        message: result.message || t('skills.runtimeToggleFailed'),
      }
    } else {
      statusNotice.value = {
        tone: 'info',
        message: t('skills.localOnlyNotice'),
      }
    }
  } catch (e) {
    if (getSkillScope(previousSkill) === 'runtime') {
      updateSkill(name, previousSkill)
    } else {
      disabledSkills.value = previousLocal
    }
    statusNotice.value = {
      tone: 'warn',
      message: e instanceof Error ? e.message : t('skills.runtimeToggleFailed'),
    }
  } finally {
    const nextToggling = new Set(togglingSkills.value)
    nextToggling.delete(name)
    togglingSkills.value = nextToggling
  }
}

function isSkillEnabled(skillOrName: Skill | string): boolean {
  const skill = typeof skillOrName === 'string'
    ? skills.value.find((item) => item.name === skillOrName)
    : skillOrName
  if (!skill) return !disabledSkills.value.has(typeof skillOrName === 'string' ? skillOrName : skillOrName.name)
  return typeof skill.enabled === 'boolean' ? skill.enabled : !disabledSkills.value.has(skill.name)
}

function toggleSkillDetail(name: string) {
  expandedSkill.value = expandedSkill.value === name ? null : name
}

const filteredSkills = computed(() => {
  const q = (props.embeddedSearch ?? searchQuery.value).toLowerCase()
  if (!q) return skills.value
  return skills.value.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.tags?.some((tag) => tag.toLowerCase().includes(q)),
  )
})

const hasLocalOnlySkills = computed(() =>
  skills.value.some((skill) => getSkillScope(skill) === 'local'),
)

// ─── ClawHub 技能市场 ────────────────────────────────
const hubSkills = ref<ClawHubSkill[]>([])
const hubLoading = ref(false)
const hubSearchQuery = ref('')
const hubCategory = ref<ClawHubCategory>('all')
const hubInstallingSet = ref<Set<string>>(new Set())
const hubInstallError = ref('')
const hubSearchError = ref('')
let hubRequestSeq = 0

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
  const requestSeq = ++hubRequestSeq
  hubLoading.value = true
  hubSearchError.value = ''
  try {
    const nextSkills = await searchClawHub(
      hubSearchQuery.value || undefined,
      hubCategory.value,
    )
    if (requestSeq !== hubRequestSeq) return
    hubSkills.value = nextSkills
  } catch (e) {
    if (requestSeq !== hubRequestSeq) return
    hubSkills.value = []
    hubSearchError.value =
      e instanceof Error ? e.message : t('skills.hub.catalogLoadFailed', 'Failed to load skill catalog')
    console.error('加载技能目录失败:', e)
  } finally {
    if (requestSeq !== hubRequestSeq) return
    hubLoading.value = false
  }
}

watch(activeTab, (tab) => {
  hubInstallError.value = ''
  hubSearchError.value = ''
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

onBeforeUnmount(() => {
  if (hubSearchTimer) clearTimeout(hubSearchTimer)
  unlistenDrop?.()
})

async function handleHubInstall(skill: ClawHubSkill) {
  if (hubInstallingSet.value.has(skill.name)) return
  hubInstallingSet.value = new Set([...hubInstallingSet.value, skill.name])
  hubInstallError.value = ''
  try {
    await installFromHub(skill.name)
    await restartEngineAfterSkillChange(
      `技能「${skill.name}」已安装，正在重启引擎...`,
      `技能「${skill.name}」已安装并重新载入`,
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    hubInstallError.value = `${skill.name}: ${msg}`
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
  return skills.value.some((s) => s.name === name)
}

function openInstallDialog() {
  resetInstallDialog()
  showInstallDialog.value = true
}

function resetInstallDialog() {
  installSource.value = ''
  installUrl.value = ''
  installError.value = ''
  dragOver.value = false
}

function closeInstallDialog() {
  showInstallDialog.value = false
  resetInstallDialog()
}

async function restartEngineAfterSkillChange(startMessage: string, successMessage: string) {
  statusNotice.value = { tone: 'info', message: startMessage }
  const ok = await appStore.restartSidecar()
  if (ok) {
    statusNotice.value = { tone: 'success', message: successMessage }
    await loadSkills()
  } else {
    statusNotice.value = {
      tone: 'warn',
      message: '技能变更已保存，但引擎重启失败，请手动重试。',
    }
  }
}

function switchToHub() {
  activeTab.value = 'hub'
}

defineExpose({ openInstallDialog, switchToHub })
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- Inline search for installed tab -->
    <div v-if="activeTab === 'installed' && !props.hideInstalledSearch" class="px-6 pt-2">
      <SearchInput
        v-model="searchQuery"
        :placeholder="t('skills.searchPlaceholder')"
      />
    </div>

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

    <div v-if="statusNotice || hasLocalOnlySkills" class="px-6 pt-4">
      <div
        class="rounded-xl border px-4 py-3 text-sm"
        :style="{
          borderColor: statusNotice?.tone === 'warn' ? '#f59e0b55' : statusNotice?.tone === 'success' ? '#22c55e55' : 'var(--hc-border)',
          background: statusNotice?.tone === 'warn' ? '#f59e0b12' : statusNotice?.tone === 'success' ? '#22c55e12' : 'var(--hc-bg-card)',
          color: statusNotice?.tone === 'warn' ? '#b45309' : statusNotice?.tone === 'success' ? '#15803d' : 'var(--hc-text-secondary)',
        }"
      >
        {{ statusNotice?.message || t('skills.localOnlyNotice') }}
      </div>
    </div>

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
          class="rounded-xl border overflow-hidden transition"
          :style="{
            background: 'var(--hc-bg-card)',
            borderColor: 'var(--hc-border)',
            opacity: isSkillEnabled(skill) ? 1 : 0.6,
          }"
        >
          <!-- Main card row -->
          <div class="flex items-start gap-4 p-4">
            <div
              class="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
              :style="{ background: 'var(--hc-bg-hover)' }"
            >
              <Puzzle :size="20" :style="{ color: isSkillEnabled(skill) ? 'var(--hc-accent)' : 'var(--hc-text-muted)' }" />
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
                  class="text-[10px] px-1.5 py-0.5 rounded-full"
                  :style="{
                    background: getSkillScope(skill) === 'runtime' ? '#0ea5e91a' : '#f59e0b1a',
                    color: getSkillScope(skill) === 'runtime' ? '#0284c7' : '#b45309',
                  }"
                >
                  {{ getSkillScope(skill) === 'runtime' ? t('skills.runtimeState') : t('skills.localPreference') }}
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
              <p
                v-if="skill.requires_restart || skill.message"
                class="text-[11px] mt-2"
                :style="{ color: skill.requires_restart ? '#b45309' : 'var(--hc-text-muted)' }"
              >
                {{ skill.message || t('skills.restartRequired') }}
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
                background: isSkillEnabled(skill) ? 'var(--hc-accent)' : 'var(--hc-text-muted)',
                opacity: togglingSkills.has(skill.name) ? 0.65 : 1,
              }"
              :title="isSkillEnabled(skill) ? t('skills.disableSkill') : t('skills.enableSkill')"
              :disabled="togglingSkills.has(skill.name)"
              @click="toggleSkillEnabled(skill.name)"
            >
              <div
                class="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform"
                :style="{
                  transform: isSkillEnabled(skill) ? 'translateX(18px)' : 'translateX(2px)',
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
                :style="{ background: isSkillEnabled(skill) ? '#10b981' : '#6b7280' }"
              />
              <span class="text-xs" :style="{ color: isSkillEnabled(skill) ? '#10b981' : 'var(--hc-text-muted)' }">
                {{ isSkillEnabled(skill) ? t('skills.enabled') : t('skills.disabled') }}
              </span>
              <span class="text-[10px]" :style="{ color: 'var(--hc-text-muted)' }">
                · {{ getSkillScope(skill) === 'runtime' ? t('skills.runtimeState') : t('skills.localPreference') }}
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

      <template v-else>
        <!-- 安装错误提示 -->
        <div
          v-if="hubInstallError"
          class="mb-4 max-w-4xl rounded-lg border px-4 py-3 text-sm"
          :style="{ background: 'color-mix(in srgb, var(--hc-danger) 10%, transparent)', borderColor: 'var(--hc-danger)', color: 'var(--hc-danger)' }"
        >
          {{ hubInstallError }}
        </div>

        <!-- 目录加载失败（网络 / 仓库不可用） -->
        <div
          v-if="hubSearchError"
          class="mb-4 max-w-4xl rounded-lg border px-4 py-3 text-sm"
          :style="{ background: 'color-mix(in srgb, var(--hc-danger) 10%, transparent)', borderColor: 'var(--hc-danger)', color: 'var(--hc-danger)' }"
        >
          {{ hubSearchError }}
        </div>

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
                {{ skill.display_name || skill.name }}
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
            v-else-if="skill._mock"
            class="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium"
            :style="{ background: 'var(--hc-bg-hover)', color: 'var(--hc-text-muted)' }"
            disabled
          >
            {{ t('skills.hub.comingSoon', '即将上线') }}
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
      </template>
    </div>

    <!-- 安装对话框 -->
    <Teleport to="body">
      <div
        v-if="showInstallDialog"
        class="fixed inset-0 z-50 flex items-center justify-center"
        @click.self="closeInstallDialog"
      >
        <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" @click="closeInstallDialog" />
        <div
          class="relative z-10 w-[420px] rounded-xl border p-6 shadow-xl"
          :style="{ background: 'var(--hc-bg-elevated)', borderColor: 'var(--hc-border)' }"
        >
          <!-- Header -->
          <div class="flex items-center justify-between mb-5">
            <h3 class="text-base font-semibold" :style="{ color: 'var(--hc-text-primary)' }">
              {{ t('skills.installDialog.title') }}
            </h3>
            <button
              class="p-1 rounded-md transition-colors"
              :style="{ color: 'var(--hc-text-muted)' }"
              @click="closeInstallDialog"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>

          <!-- Drop zone -->
          <div
            class="rounded-lg border-2 border-dashed p-8 text-center transition-colors mb-4"
            :style="{
              borderColor: dragOver ? 'var(--hc-accent)' : 'var(--hc-border)',
              background: dragOver ? 'color-mix(in srgb, var(--hc-accent) 8%, transparent)' : 'var(--hc-bg-primary)',
            }"
          >
            <div class="mb-3" :style="{ color: dragOver ? 'var(--hc-accent)' : 'var(--hc-text-muted)' }">
              <Download :size="28" class="mx-auto" />
            </div>
            <p class="text-sm mb-1" :style="{ color: dragOver ? 'var(--hc-accent)' : 'var(--hc-text-secondary)' }">
              {{ dragOver ? t('skills.installDialog.dropHint') : t('skills.installDialog.dropZone') }}
            </p>
            <p class="text-xs mb-3" :style="{ color: 'var(--hc-text-muted)' }">
              {{ t('skills.installDialog.dropZoneOr') }}
            </p>
            <button
              class="px-4 py-1.5 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
              :style="{ background: 'var(--hc-accent)' }"
              :disabled="installing"
              @click="handlePickFile"
            >
              <FolderOpen :size="14" class="inline -mt-0.5 mr-1" />
              {{ t('skills.installDialog.pickFile') }}
            </button>
          </div>

          <!-- URL input -->
          <div class="mb-4">
            <label class="block text-xs font-medium mb-1.5" :style="{ color: 'var(--hc-text-muted)' }">
              {{ t('skills.installDialog.urlLabel') }}
            </label>
            <div class="flex gap-2">
              <input
                v-model="installUrl"
                type="text"
                :placeholder="t('skills.installDialog.urlPlaceholder')"
                class="flex-1 px-3 py-2 rounded-lg border text-sm"
                :style="{
                  background: 'var(--hc-bg-primary)',
                  borderColor: 'var(--hc-border)',
                  color: 'var(--hc-text-primary)',
                }"
                :disabled="installing"
                @keydown.enter="handleUrlInstall"
              />
              <button
                class="px-3 py-2 rounded-lg text-sm font-medium text-white flex-shrink-0 transition-opacity hover:opacity-90"
                :style="{ background: installing ? 'var(--hc-text-muted)' : 'var(--hc-accent)' }"
                :disabled="installing || !installUrl.trim()"
                @click="handleUrlInstall"
              >
                {{ installing ? t('skills.installDialog.installing') : t('common.install') }}
              </button>
            </div>
          </div>

          <!-- Error -->
          <p v-if="installError" class="text-xs px-1" style="color: var(--hc-error)">
            {{ installError }}
          </p>

          <!-- Installing spinner -->
          <div v-if="installing" class="flex items-center gap-2 mt-3 px-1">
            <Loader2 :size="14" class="animate-spin" :style="{ color: 'var(--hc-accent)' }" />
            <span class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">{{ t('skills.installDialog.installing') }}</span>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 卸载确认对话框 -->
    <Teleport to="body">
      <div
        v-if="pendingUninstall"
        class="fixed inset-0 z-50 flex items-center justify-center"
        @click.self="pendingUninstall = null"
      >
        <div class="absolute inset-0 bg-black/50" @click="pendingUninstall = null" />
        <div
          class="relative z-10 w-80 rounded-xl border p-6 shadow-xl"
          :style="{ background: 'var(--hc-bg-elevated)', borderColor: 'var(--hc-border)' }"
        >
          <p class="text-sm mb-4" :style="{ color: 'var(--hc-text-primary)' }">
            {{ t('common.confirm') }} — {{ pendingUninstall }}?
          </p>
          <div class="flex justify-end gap-2">
            <button
              class="px-3 py-1.5 rounded-lg text-sm"
              :style="{ color: 'var(--hc-text-secondary)' }"
              @click="pendingUninstall = null"
            >
              {{ t('common.cancel') }}
            </button>
            <button
              class="px-3 py-1.5 rounded-lg text-sm text-white"
              style="background: #ef4444;"
              @click="confirmUninstall"
            >
              {{ t('common.delete') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
