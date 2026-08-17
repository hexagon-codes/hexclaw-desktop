<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Key,
  Palette,
  Eye,
  EyeOff,
  Plus,
  ChevronDown,
  ChevronUp,
  Loader2,
  CheckCircle,
  XCircle,
  Power,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-vue-next'
import { useSettingsStore } from '@/stores/settings'
import {
  useModelCatalogStore,
  AUTO_ENABLE_CATALOG_LIMIT,
  beginProviderCatalogSync,
  reconcileProviderCatalog,
} from '@/stores/model-catalog'
import {
  canonicalizeModelOption,
  isChatModelOption,
  normalizeModelCapabilities,
  resolveProviderSelectedModelId,
} from '@/stores/settings-helpers'
import { getRuntimeConfig } from '@/api/settings'
import { getLLMConfig, testLLMConnection, fetchProviderModels } from '@/api/config'
import { fetchCapabilities, probeCapability } from '@/api/capabilities'
import { messageFromUnknownError } from '@/utils/errors'
import { thirdPartyAiServicesUrl } from '@/utils/legal-links'
import { logger } from '@/utils/logger'
import { isMaskedApiKey } from '@/stores/settings-provider-secrets'
import {
  classifyProviderEndpoint,
  resolveEffectiveProviderLocality,
} from '@/utils/provider-endpoint'
import { useTheme, type ThemeMode } from '@/composables/useTheme'
import { useAboutWindow } from '@/composables/useAboutWindow'
import { useToast } from '@/composables'
import { setLocale } from '@/i18n'
import { PROVIDER_PRESETS, PROVIDER_LOGOS, inferCapabilitiesFromId } from '@/config/providers'
import { MODEL_CAPABILITY_DISPLAY } from '@/config/model-capability-display'
import { OLLAMA_BASE } from '@/config/env'
import { isCatalogModelFree } from '@/types'
import type {
  ProviderConfig,
  ProviderType,
  ModelOption,
  ModelCapability,
  BackendRuntimeConfig,
  BackendLLMConfig,
} from '@/types'
import PageToolbar from '@/components/common/PageToolbar.vue'
import ProviderSelect from '@/components/common/ProviderSelect.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import HcSelect from '@/components/common/HcSelect.vue'
import OllamaCard from '@/components/settings/OllamaCard.vue'
import ModelManagerModal from '@/components/settings/ModelManagerModal.vue'
import AutomationPermissionsPanel from '@/components/settings/AutomationPermissionsPanel.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import { scenarioRegistry } from '@/shell/scenario/registry'

const { t, locale } = useI18n()
const toast = useToast()
const settingsStore = useSettingsStore()
const thirdPartyAiServicesHref = computed(() => thirdPartyAiServicesUrl(locale.value))

const catalogStore = useModelCatalogStore()
const { themeMode, setTheme } = useTheme()
const appearanceSettingsExtensions = scenarioRegistry.appearanceSettingsExtensions
const activeSection = ref('llm')
const saved = ref(false)
const saveFailed = ref(false)

// Provider 编辑状态
const editingProviderId = ref<string | null>(null)
const showApiKeys = ref<Record<string, boolean>>({})
const showAddProvider = ref(false)
const addProviderType = ref<ProviderType>('openai')

// 自定义模型输入
const newModelId = ref('')
const newModelCapability = ref<ModelCapability>('text')
const customModelDialogProviderId = ref<string | null>(null)
const customModelInputRef = ref<HTMLInputElement | null>(null)
const customModelDialogRef = ref<HTMLDivElement | null>(null)
let customModelReturnFocus: HTMLElement | null = null

// 编辑模型 Modal
const editingModel = ref<{ providerId: string; idx: number; model: ModelOption } | null>(null)
const editModelOverlayRef = ref<HTMLDivElement | null>(null)
watch(editingModel, (v) => {
  if (v) nextTick(() => editModelOverlayRef.value?.focus())
})
const editModelForm = ref<{ name: string; id: string; caps: Record<ModelCapability, boolean> }>({
  name: '',
  id: '',
  caps: {
    text: true,
    vision: false,
    video: false,
    audio: false,
    code: false,
    image_generation: false,
    video_generation: false,
    embedding: false,
  },
})
const pendingDeleteProviderId = ref<string | null>(null)
const pendingDeleteModel = ref<{ providerId: string; modelId: string; modelName: string } | null>(
  null,
)
const runtimeConfig = ref<BackendRuntimeConfig | null>(null)
const runtimeLLMConfig = ref<BackendLLMConfig | null>(null)
const appVersion = ref('—')
const openAbout = useAboutWindow()

// Load desktop app version from Tauri
onMounted(() => {
  import('@tauri-apps/api/app')
    .then(({ getVersion }) => getVersion().then((v) => (appVersion.value = 'v' + v)))
    .catch(() => {})
})
const runtimeInfoLoading = ref(false)
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null
const autoTestTimers: Record<string, ReturnType<typeof setTimeout>> = {}
let autoSavePromise: Promise<void> | null = null
let hasPendingAutoSave = false
let autoSaveGeneration = 0
let persistedAutoSaveGeneration = 0
let unlistenCloseRequested: (() => void) | null = null
let closingAfterFlush = false

// tab 序：AI 能力域配置（LLM/自动化权限）相邻靠前，平台工具类（系统设置）居尾。
const sections = computed(() => [
  { key: 'llm', label: t('settings.llm.title'), icon: Key },
  {
    key: 'automation',
    label: t('autonomy.settings.sectionTitle', '自动化权限'),
    icon: ShieldCheck,
  },
  { key: 'system', label: t('settings.system.title'), icon: Palette },
])

// v0.4.0 Features 面板已删（Apple HIG 不适合 alpha 技术 flag 列表给最终用户）。
// flag 完整清单见仓库 CHANGELOG.md + ~/.hexclaw/hexclaw.yaml 的 features 段示例。

function handleLocaleChange(locale: string) {
  setLocale(locale as 'zh-CN' | 'en' | 'ug-CN')
}

function handleThemeSelect(mode: ThemeMode) {
  setTheme(mode)
  autoSave()
}

const themeOptions = computed(() => [
  { key: 'light' as ThemeMode, label: t('settings.appearance.light') },
  { key: 'dark' as ThemeMode, label: t('settings.appearance.dark') },
  { key: 'system' as ThemeMode, label: t('settings.appearance.system') },
])

function handleThemeKeydown(event: KeyboardEvent, index: number) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
  event.preventDefault()
  const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1
  const target = (index + delta + themeOptions.value.length) % themeOptions.value.length
  handleThemeSelect(themeOptions.value[target]!.key)
  const group = (event.currentTarget as HTMLElement).closest('[role="radiogroup"]')
  group?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[target]?.focus()
}

// U5: 开机自启开关——之前只落 Store（假开关），现桥接到 Rust set_autostart command，
// 让 plugin-autostart 真正 enable()/disable() 系统 LaunchAgent。
async function handleAutoStartChange() {
  autoSave() // 保留原有 Store 持久化
  if (!isDesktopRuntime() || !config.value) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('set_autostart', { enable: !!config.value.general.auto_start })
  } catch (e) {
    logger.error('[HexClaw] 设置开机自启失败:', e)
  }
}

// U5: 启动时把 UI 开关与系统真实自启状态对齐（Store 值可能与系统层面不一致）。
async function syncAutoStartState() {
  if (!isDesktopRuntime() || !config.value) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const enabled = await invoke<boolean>('is_autostart_enabled')
    config.value.general.auto_start = enabled
  } catch (e) {
    logger.warn('[HexClaw] 同步开机自启状态失败:', e)
  }
}

function handleRoutingToggle() {
  if (!config.value) return
  config.value.llm.routing = {
    enabled: config.value.llm.routing?.enabled ?? false,
    strategy: config.value.llm.routing?.strategy || 'cost-aware',
  }
  autoSave()
}

const isDirty = ref(false)

const maxToolsDisplay = computed(() => {
  const v = config.value?.llm.tools?.maxTools ?? 0
  return v === 0 ? t('settings.llm.toolsNoLimit', '不限') : String(v)
})

function stepMaxTools(delta: number) {
  if (!config.value) return
  const current = config.value.llm.tools?.maxTools ?? 0
  const next = Math.max(0, current + delta)
  config.value.llm.tools = {
    enabled: config.value.llm.tools?.enabled ?? 'auto',
    maxTools: next,
  }
  autoSave()
}

const nonOllamaProviders = computed(
  () => config.value?.llm.providers.filter((p) => p.type !== 'ollama') ?? [],
)

function isDesktopRuntime() {
  return !!(globalThis as Record<string, unknown>).isTauri
}

function hasUnsavedChanges() {
  return hasPendingAutoSave || autoSaveTimer !== null
}

function hasUnfinishedSettingsPersistence() {
  return hasUnsavedChanges() || autoSavePromise !== null
}

function markAutoSavePending() {
  autoSaveGeneration += 1
  hasPendingAutoSave = true
  isDirty.value = true
}

function refreshAutoSaveDirtyState() {
  hasPendingAutoSave = persistedAutoSaveGeneration < autoSaveGeneration
  isDirty.value = hasPendingAutoSave
}

function resetPendingModelDraft() {
  newModelId.value = ''
  newModelCapability.value = 'text'
}

async function persistSettings({
  showSavedFeedback = false,
  refreshRuntimeInfo = false,
}: {
  showSavedFeedback?: boolean
  refreshRuntimeInfo?: boolean
} = {}) {
  if (!settingsStore.config) return

  const result = await settingsStore.saveConfig(settingsStore.config)

  if (refreshRuntimeInfo) {
    await loadRuntimeInfo()
  }

  if (showSavedFeedback && !result.securitySyncFailed) {
    saved.value = true
    setTimeout(() => {
      saved.value = false
    }, 2000)
  }
}

async function flushAutoSave({
  force = false,
  showSavedFeedback = false,
  refreshRuntimeInfo = false,
}: {
  force?: boolean
  showSavedFeedback?: boolean
  refreshRuntimeInfo?: boolean
} = {}) {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer)
    autoSaveTimer = null
  }

  const hasPendingModelDraft = !!newModelId.value.trim()
  const shouldSave = force || hasPendingAutoSave || hasPendingModelDraft
  if (!shouldSave) {
    if (autoSavePromise) {
      await autoSavePromise
    }
    return
  }
  if (!settingsStore.config) return
  if ((force || hasPendingModelDraft) && persistedAutoSaveGeneration >= autoSaveGeneration) {
    markAutoSavePending()
  }
  while (persistedAutoSaveGeneration < autoSaveGeneration) {
    if (autoSavePromise) {
      await autoSavePromise
      continue
    }

    const savingGeneration = autoSaveGeneration
    hasPendingAutoSave = false
    isDirty.value = false
    autoSavePromise = persistSettings({ showSavedFeedback, refreshRuntimeInfo })
    try {
      await autoSavePromise
      persistedAutoSaveGeneration = Math.max(persistedAutoSaveGeneration, savingGeneration)
    } catch (e) {
      refreshAutoSaveDirtyState()
      throw e
    } finally {
      autoSavePromise = null
      refreshAutoSaveDirtyState()
    }
  }
}

function handleBeforeUnload() {
  if (!hasUnfinishedSettingsPersistence()) return
  void flushAutoSave({ force: true })
}

function toggleEditingProvider(providerId: string) {
  editingProviderId.value = editingProviderId.value === providerId ? null : providerId
}

function handleLanguageChange() {
  if (!config.value) return
  handleLocaleChange(config.value.general.language)
  autoSave()
}

// 语言下拉（替代原生 <select class="hc-input">，原 @change=handleLanguageChange 改由 setter 触发）
const languageOptions = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
  { value: 'ug-CN', label: '维吾尔语' },
]
const languageModel = computed<string>({
  get: () => config.value?.general.language ?? 'zh-CN',
  set: (v) => {
    if (!config.value || config.value.general.language === v) return
    config.value.general.language = v
    handleLanguageChange()
  },
})

// ─── A7 模型 tool_call 能力探测 ──────────────────────────

/** 正在探测中的 model，格式 "providerId:modelId" */
const probingKey = ref<string | null>(null)

/** 从后端拉取所有能力缓存并合并到对应 provider.models[*].toolReliability */
async function loadCapabilities() {
  if (!config.value?.llm) return
  try {
    const records = await fetchCapabilities()
    if (records.length === 0) return
    // 后端按 provider_name 存储，前端 provider 可能用中文名（比如"智谱"），按 name 匹配
    const byKey = new Map<string, (typeof records)[number]>()
    for (const r of records) byKey.set(`${r.providerName}:${r.modelName}`, r)

    for (const provider of config.value.llm.providers) {
      const pName = provider.backendKey || provider.name
      for (const model of provider.models) {
        if (!isChatModelOption(model)) continue
        const key = `${pName}:${model.id}`
        const rec = byKey.get(key)
        if (rec) model.toolReliability = rec.reliability
      }
    }
  } catch (e) {
    logger.warn('[HexClaw] A7 能力探测缓存加载失败:', e)
  }
}

/** 手动刷新单个模型的 tool_call 能力探测 */
async function refreshCapability(provider: ProviderConfig, model: ModelOption) {
  if (!isChatModelOption(model)) return
  const key = `${provider.id}:${model.id}`
  if (probingKey.value === key) return
  probingKey.value = key
  try {
    const pName = provider.backendKey || provider.name
    const rec = await probeCapability(pName, model.id)
    model.toolReliability = rec.reliability
  } catch (e) {
    logger.warn('[HexClaw] A7 能力探测失败:', e)
    // 手动点击探测按钮失败不能静默——告知用户重试
    toast.error(t('settings.llm.probeFailed', '能力探测失败，请重试'))
  } finally {
    probingKey.value = null
  }
}

function reliabilityIcon(level: string): string {
  return { good: '✅', partial: '⚠️', bad: '❌' }[level] ?? '❔'
}

function reliabilityTooltip(r: { level: string; lastProbe?: string; probeError?: string }): string {
  const label =
    { good: '工具调用可靠', partial: '工具调用部分可靠', bad: '工具调用不可靠', unknown: '未检测' }[
      r.level
    ] ?? r.level
  const parts = [label]
  if (r.lastProbe) {
    const d = new Date(r.lastProbe)
    parts.push(`上次检测：${d.toLocaleDateString()}`)
  }
  if (r.probeError) parts.push(`错误：${r.probeError}`)
  return parts.join(' · ')
}

function probingModel(providerId: string, modelId: string): boolean {
  return probingKey.value === `${providerId}:${modelId}`
}

onMounted(async () => {
  // settings 页面被路由守卫豁免，config 可能尚未加载
  await settingsStore.loadConfig()
  // A7: 页面打开后异步拉一次能力缓存（不 block UI，失败降级为 unknown badge）
  void loadCapabilities()
  // U5: 把开机自启开关与系统真实状态对齐
  void syncAutoStartState()

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', handleBeforeUnload)
  }

  if (isDesktopRuntime()) {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const appWindow = getCurrentWindow()
      unlistenCloseRequested = await appWindow.onCloseRequested(async (event) => {
        if (closingAfterFlush || !hasUnfinishedSettingsPersistence()) return

        event.preventDefault()
        try {
          await flushAutoSave({ force: true })
        } catch (e) {
          logger.error('[HexClaw] 关闭前保存设置失败:', e)
          return
        }

        closingAfterFlush = true
        try {
          await appWindow.close()
        } catch (e) {
          logger.error('[HexClaw] 自动关闭窗口失败:', e)
        } finally {
          closingAfterFlush = false
        }
      })
    } catch (e) {
      logger.warn('[HexClaw] 注册 close-requested 监听失败:', e)
    }
  }
})

onBeforeUnmount(() => {
  if (hasUnfinishedSettingsPersistence()) {
    void flushAutoSave({ force: true })
  }
  if (typeof window !== 'undefined') {
    window.removeEventListener('beforeunload', handleBeforeUnload)
  }
  unlistenCloseRequested?.()
  unlistenCloseRequested = null
  editingModel.value = null
  customModelDialogProviderId.value = null
  customModelReturnFocus = null
  pendingDeleteProviderId.value = null
  pendingDeleteModel.value = null
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer)
    autoSaveTimer = null
  }
  for (const providerId of Object.keys(autoTestTimers)) {
    clearTimeout(autoTestTimers[providerId])
    delete autoTestTimers[providerId]
  }
  editingProviderId.value = null
})

watch(activeSection, (val) => {
  if (val === 'system') {
    loadRuntimeInfo()
  }
})

// 切换编辑的 Provider 时关闭不再属于当前卡片的模型弹窗。
watch(editingProviderId, () => {
  customModelDialogProviderId.value = null
  resetPendingModelDraft()
})

const config = computed(() => settingsStore.config)
const modelManagerProviderId = ref<string | null>(null)
const managerSyncing = ref(false)
let modelManagerReturnFocus: HTMLElement | null = null
const modelManagerProvider = computed(
  () =>
    config.value?.llm.providers.find((provider) => provider.id === modelManagerProviderId.value) ??
    null,
)
const customModelDialogProvider = computed(
  () =>
    config.value?.llm.providers.find(
      (provider) => provider.id === customModelDialogProviderId.value,
    ) ?? null,
)
const customModelCapabilityOptions = computed(() => [
  { value: 'text', label: '文本' },
  { value: 'vision', label: '视觉' },
  { value: 'image_generation', label: '绘图' },
  { value: 'video_generation', label: '视频生成' },
  { value: 'embedding', label: 'Embedding' },
])
const normalizedNewModelId = computed(() => newModelId.value.trim())
const customModelIdIsDuplicate = computed(() => {
  const provider = customModelDialogProvider.value
  const modelId = normalizedNewModelId.value
  return !!provider && !!modelId && provider.models.some((model) => model.id === modelId)
})
const canSubmitCustomModel = computed(
  () =>
    !!customModelDialogProvider.value &&
    !!normalizedNewModelId.value &&
    !customModelIdIsDuplicate.value,
)

watch(customModelDialogProviderId, (providerId) => {
  if (providerId) nextTick(() => customModelInputRef.value?.focus())
})
const memoryEnabled = computed({
  get: () => config.value?.memory?.enabled ?? true,
  set: (enabled: boolean) => {
    if (!config.value) return
    config.value.memory = { enabled }
  },
})
const sandboxNetworkEnabled = computed({
  get: () => config.value?.sandbox?.network_enabled ?? true,
  set: (network_enabled: boolean) => {
    if (!config.value) return
    config.value.sandbox = { network_enabled }
  },
})
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const editableProviders = computed(() => config.value?.llm.providers ?? [])
const defaultModelOptions = computed(() =>
  settingsStore.availableModels.map((m) => ({
    value: `${m.providerId}::${m.modelId}`,
    providerId: m.providerId,
    modelId: m.modelId,
    label: `${m.providerName} / ${m.modelName}`,
  })),
)
// HcSelect 投影：默认模型下拉，首项为「无可用模型」空值占位（替代原生空 <option>）
const defaultModelSelectOptions = computed(() => [
  { value: '', label: t('settings.llm.noEnabledModels') },
  ...defaultModelOptions.value.map((option) => ({ value: option.value, label: option.label })),
])
const selectedDefaultModelValue = computed({
  get() {
    const llmConfig = config.value?.llm
    if (!llmConfig?.defaultModel) return ''
    const providerId =
      llmConfig.defaultProviderId ||
      defaultModelOptions.value.find((option) => option.modelId === llmConfig.defaultModel)
        ?.providerId ||
      ''
    return providerId ? `${providerId}::${llmConfig.defaultModel}` : ''
  },
  set(value: string) {
    if (!config.value) return
    if (!value) {
      config.value.llm.defaultProviderId = ''
      config.value.llm.defaultModel = ''
      autoSave()
      return
    }

    const [providerId, modelId = ''] = value.split('::', 2)
    config.value.llm.defaultProviderId = providerId
    config.value.llm.defaultModel = modelId
    autoSave()
  },
})

// B1: Agent 策略模式（默认 auto 走启发式路由）
const agentModeValue = computed({
  get() {
    return config.value?.llm?.agentMode ?? 'auto'
  },
  set(value: string) {
    if (!config.value?.llm) return
    config.value.llm.agentMode = value as import('@/types').AgentMode
    // 原 <select @change="autoSave">，HcSelect 仅 emit update:modelValue，副作用移入 setter
    autoSave()
  },
})
const agentModeOptions = [
  { value: 'auto', label: '自动（推荐）' },
  { value: 'react', label: 'ReAct — 通用工具循环' },
  { value: 'plan-execute', label: 'Plan-Execute — 先规划再执行' },
  { value: 'reflection', label: 'Reflection — 答后自查' },
  { value: 'tot', label: 'ToT — 多解择优' },
  { value: 'self-reflect', label: 'Self-Reflect — 每步反思' },
  { value: 'mem-augmented', label: 'Memory-Augmented — 个性化档案' },
  { value: 'debate', label: 'Debate — 双视角辩论' },
]
// HcSelect 投影：路由策略下拉。原 <select @change="handleRoutingStrategyChange">，
// HcSelect 仅 emit update:modelValue，故把写值 + 副作用收进 setter。
const routingStrategyValue = computed({
  get() {
    return config.value?.llm.routing?.strategy ?? 'cost-aware'
  },
  set(value: string) {
    if (!config.value) return
    config.value.llm.routing = {
      enabled: config.value.llm.routing?.enabled ?? false,
      strategy: value,
    }
    autoSave()
  },
})
const routingStrategyOptions = computed(() => [
  {
    value: 'cost-aware',
    label: t('settings.llm.routingCostAware', '成本优先'),
  },
  {
    value: 'quality-first',
    label: t('settings.llm.routingQualityFirst', '质量优先'),
  },
  {
    value: 'latency-first',
    label: t('settings.llm.routingLatencyFirst', '延迟优先'),
  },
])

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const runtimeProviderCount = computed(
  () => Object.keys(runtimeLLMConfig.value?.providers ?? {}).length,
)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const runtimeDefaultProvider = computed(() => runtimeLLMConfig.value?.default || '—')
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const runtimeDefaultModel = computed(() => {
  const defaultProvider = runtimeLLMConfig.value?.default
  if (!defaultProvider) return '—'
  return runtimeLLMConfig.value?.providers[defaultProvider]?.model || '—'
})
const runtimeApiEndpoint = computed(
  () =>
    `${runtimeConfig.value?.server.host || '127.0.0.1'}:${runtimeConfig.value?.server.port || '—'}`,
)
const runtimeLocalStoreFile = 'data.db'
const runtimeModeShort = computed(() => {
  const rawMode = runtimeConfig.value?.server.mode?.trim()?.toLowerCase()
  if (!rawMode) return ''
  switch (rawMode) {
    case 'desktop':
      return t('settings.storage.modeDesktop', '桌面模式')
    case 'production':
      return t('settings.storage.modeProduction', '生产模式')
    case 'development':
      return t('settings.storage.modeDevelopment', '开发模式')
    default:
      return rawMode
  }
})

let runtimeInfoGen = 0
async function loadRuntimeInfo() {
  const gen = ++runtimeInfoGen
  runtimeInfoLoading.value = true
  try {
    const [nextRuntimeConfig, nextLLMConfig] = await Promise.all([
      getRuntimeConfig(),
      getLLMConfig(),
    ])
    if (gen !== runtimeInfoGen) return // stale response from earlier call, discard
    runtimeConfig.value = nextRuntimeConfig
    runtimeLLMConfig.value = nextLLMConfig
  } catch (e) {
    if (gen !== runtimeInfoGen) return
    runtimeConfig.value = null
    runtimeLLMConfig.value = null
    logger.warn('[HexClaw] 运行时配置加载失败:', e)
  } finally {
    if (gen === runtimeInfoGen) runtimeInfoLoading.value = false
  }
}

/** 添加一个新 Provider */
function handleAssociateOllama() {
  // 防止重复添加 Ollama
  const alreadyExists = settingsStore.config?.llm.providers.some((p) => p.type === 'ollama')
  if (alreadyExists) return

  const ollamaPreset = PROVIDER_PRESETS['ollama']
  if (ollamaPreset) {
    settingsStore.addProvider({
      name: ollamaPreset.name,
      type: 'ollama' as ProviderType,
      enabled: true,
      apiKey: '',
      baseUrl: ollamaPreset.defaultBaseUrl || OLLAMA_BASE,
      models: [...(ollamaPreset.defaultModels || [])],
    })
    autoSave()
  }
}

function handleAddProvider() {
  const preset = PROVIDER_PRESETS[addProviderType.value]

  // 防止重复添加 Ollama（只允许一个）
  if (preset.type === 'ollama') {
    const alreadyExists = settingsStore.config?.llm.providers.some((p) => p.type === 'ollama')
    if (alreadyExists) {
      showAddProvider.value = false
      return
    }
  }

  settingsStore.addProvider({
    name: preset.name,
    type: preset.type,
    enabled: true,
    apiKey: '',
    baseUrl: preset.defaultBaseUrl,
    models: [...preset.defaultModels],
  })
  showAddProvider.value = false
  // 自动展开编辑
  const providers = settingsStore.config?.llm?.providers
  if (providers?.length) {
    editingProviderId.value = providers[providers.length - 1]!.id
  }
  autoSave()
}

/** 真正执行 Provider 删除 */
async function handleDeleteProvider(id: string) {
  // 保存删除前快照，以便失败时恢复
  const snapshot = settingsStore.config
    ? (JSON.parse(
        JSON.stringify(settingsStore.config.llm.providers),
      ) as typeof settingsStore.config.llm.providers)
    : null
  const prevEditingId = editingProviderId.value

  settingsStore.removeProvider(id)
  catalogStore.removeCatalog(id)
  if (editingProviderId.value === id) {
    editingProviderId.value = null
  }
  if (settingsStore.config) {
    try {
      const { securitySyncFailed } = await settingsStore.saveConfig(settingsStore.config)
      if (securitySyncFailed) {
        logger.warn('[HexClaw] 删除 Provider 后安全/沙箱配置同步失败')
      }
    } catch (e) {
      logger.error('[HexClaw] 删除 Provider 后保存失败，已恢复:', e)
      // 恢复 UI 到删除前状态
      if (snapshot && settingsStore.config) {
        settingsStore.config.llm.providers = snapshot
        editingProviderId.value = prevEditingId
      }
      toast.error(t('settings.llm.deleteProviderFailed', '删除失败，已恢复'))
    }
  }
}

function openDeleteProviderConfirm(id: string) {
  pendingDeleteProviderId.value = id
}

async function confirmDeleteProvider() {
  const id = pendingDeleteProviderId.value
  pendingDeleteProviderId.value = null
  if (!id) return
  await handleDeleteProvider(id)
}

/** 切换 Provider 启用/禁用 */
function toggleProvider(provider: ProviderConfig) {
  settingsStore.updateProvider(provider.id, { enabled: !provider.enabled })
  autoSave()
}

function handleToggleOllamaProvider() {
  const ollamaProvider = config.value?.llm.providers.find(
    (p) => p.type === 'ollama' || p.name?.toLowerCase().includes('ollama'),
  )
  if (ollamaProvider) {
    toggleProvider(ollamaProvider)
  }
}

function isEmbeddingOnlyModel(model: ModelOption): boolean {
  const capabilities = normalizeModelCapabilities(model)
  return capabilities.includes('embedding') && !capabilities.includes('text')
}

function providerModelExclusionScope(provider: ProviderConfig): string {
  return provider.providerInstanceId || provider.id
}

function isProviderModelRemovable(provider: ProviderConfig, model: ModelOption): boolean {
  // 上游目录已经移除的已配置模型必须允许用户显式清理；删除仍复用持久化排除集。
  if (isStaleModel(provider, model)) {
    return true
  }
  const presetModels = PROVIDER_PRESETS[provider.type]?.defaultModels ?? []
  if (presetModels.some((preset) => preset.id === model.id)) {
    return false
  }
  if (model.isCustom) {
    return true
  }
  return Boolean(
    catalogStore
      .getCatalog(provider.id)
      ?.models.some((catalogModel) => catalogModel.id === model.id),
  )
}

function requestDeleteProviderModel(provider: ProviderConfig, model: ModelOption) {
  if (!isProviderModelRemovable(provider, model)) return
  pendingDeleteModel.value = {
    providerId: provider.id,
    modelId: model.id,
    modelName: model.name || model.id,
  }
}

function capabilitiesForCustomModel(capability: ModelCapability): ModelCapability[] {
  return capability === 'vision' ? ['text', 'vision'] : [capability]
}

function openCustomModelDialog(provider: ProviderConfig, event?: MouseEvent) {
  resetPendingModelDraft()
  customModelReturnFocus =
    event?.currentTarget instanceof HTMLElement
      ? event.currentTarget
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
  customModelDialogProviderId.value = provider.id
}

function closeCustomModelDialog({ restoreFocus = true } = {}) {
  const returnFocus = customModelReturnFocus
  customModelDialogProviderId.value = null
  customModelReturnFocus = null
  resetPendingModelDraft()
  if (restoreFocus && returnFocus?.isConnected) nextTick(() => returnFocus.focus())
}

function handleCustomModelDialogKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeCustomModelDialog()
    return
  }
  if (event.key !== 'Tab') return

  const dialog = customModelDialogRef.value
  if (!dialog) return
  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      [
        'button:not([disabled])',
        'input:not([disabled])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        'a[href]',
        '[tabindex]:not([tabindex="-1"])',
      ].join(','),
    ),
  )
  if (focusable.length === 0) {
    event.preventDefault()
    dialog.focus()
    return
  }

  const first = focusable[0]!
  const last = focusable[focusable.length - 1]!
  const active = document.activeElement
  if (event.shiftKey && (active === first || !dialog.contains(active))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
    event.preventDefault()
    first.focus()
  }
}

/** 添加自定义模型到 Provider；空 ID 与重复 ID保持 fail-closed。 */
function addCustomModel(provider: ProviderConfig): boolean {
  const modelId = normalizedNewModelId.value
  if (!modelId || provider.models.some((model) => model.id === modelId)) return false
  if (!catalogStore.clearModelExclusion(providerModelExclusionScope(provider), modelId)) {
    return false
  }
  const model = canonicalizeModelOption({
    id: modelId,
    name: modelId,
    isCustom: true,
    capabilities: capabilitiesForCustomModel(newModelCapability.value),
  })
  settingsStore.updateProvider(provider.id, {
    models: [...provider.models, model],
    ...(isChatModelOption(model) ? { selectedModelId: model.id } : {}),
  })
  delete testProviderResult.value[provider.id]
  autoSave()
  return true
}

function submitCustomModel() {
  const provider = customModelDialogProvider.value
  if (!provider || !canSubmitCustomModel.value || !addCustomModel(provider)) return
  const addedModelId = normalizedNewModelId.value
  const embeddingOnly = newModelCapability.value === 'embedding'
  closeCustomModelDialog()
  toast.success(
    embeddingOnly
      ? `已添加 ${addedModelId} · 可用于知识库语义索引`
      : `已添加自定义模型 ${addedModelId}`,
  )
}

function handleProviderModelChange(provider: ProviderConfig) {
  const selected = provider.models.find((model) => model.id === provider.selectedModelId)
  if (!selected || !isChatModelOption(selected)) {
    provider.selectedModelId = resolveProviderSelectedModelId(provider)
    return
  }
  clearProviderProbeState(provider)
  settingsStore.updateProvider(provider.id, {
    selectedModelId: provider.selectedModelId,
  })
  autoSave()
}

function providerBaseUrl(provider: ProviderConfig): string {
  return provider.baseUrl || PROVIDER_PRESETS[provider.type]?.defaultBaseUrl || ''
}

function providerEndpointDecision(provider: ProviderConfig) {
  return classifyProviderEndpoint(provider.type, providerBaseUrl(provider))
}

function providerNeedsDestinationConfirmation(provider: ProviderConfig): boolean {
  return providerEndpointDecision(provider).classification === 'ambiguous'
}

function providerDestinationSelection(provider: ProviderConfig): 'local' | 'cloud' | '' {
  const decision = providerEndpointDecision(provider)
  if (
    decision.classification !== 'ambiguous' ||
    provider.localitySource !== 'user' ||
    provider.confirmedEndpointHost !== decision.host
  )
    return ''
  return provider.locality === 'local' ? 'local' : 'cloud'
}

function handleProviderDestinationChange(provider: ProviderConfig, locality: 'local' | 'cloud') {
  const decision = providerEndpointDecision(provider)
  if (decision.classification !== 'ambiguous' || !decision.host) return
  provider.locality = locality
  provider.localitySource = 'user'
  provider.confirmedEndpointHost = decision.host
  provider.privateNetworkAccess = decision.requiresPrivateNetworkAccess
    ? { host: decision.host, allowed: true }
    : undefined
  clearProviderProbeState(provider)
  autoSave()
}

function handleProviderBaseUrlInput(provider: ProviderConfig) {
  const decision = providerEndpointDecision(provider)
  const confirmationStillMatches =
    provider.localitySource === 'user' &&
    !!decision.host &&
    provider.confirmedEndpointHost === decision.host

  if (!confirmationStillMatches) {
    provider.confirmedEndpointHost = undefined
    provider.privateNetworkAccess = undefined
    provider.localitySource = 'system'
    provider.locality =
      decision.classification === 'local'
        ? 'local'
        : decision.classification === 'cloud'
          ? 'cloud'
          : 'auto'
  }
  clearProviderProbeState(provider)
  autoSave()
}

function handleProviderNameInput(provider: ProviderConfig) {
  void provider
  autoSave()
}

function effectiveProviderLocality(provider: ProviderConfig): 'local' | 'cloud' {
  return resolveEffectiveProviderLocality({ ...provider, baseUrl: providerBaseUrl(provider) })
}

/** 删除模型 */
function removeModel(provider: ProviderConfig, modelId: string) {
  const models = provider.models.filter((m) => m.id !== modelId)
  settingsStore.updateProvider(provider.id, {
    models,
    selectedModelId: resolveProviderSelectedModelId({ ...provider, models }),
  })
  autoSave()
}

async function confirmDeleteModel() {
  const target = pendingDeleteModel.value
  if (!target) return

  const provider = settingsStore.config?.llm.providers.find((p) => p.id === target.providerId)
  if (!provider) return
  const model = provider.models.find((candidate) => candidate.id === target.modelId)
  if (!model || !isProviderModelRemovable(provider, model)) {
    pendingDeleteModel.value = null
    return
  }

  const previousModels = [...provider.models]
  const previousSelectedModelId = provider.selectedModelId
  const exclusionScope = providerModelExclusionScope(provider)
  if (!catalogStore.excludeModel(exclusionScope, target.modelId)) {
    toast.error(t('settings.llm.deleteModelFailed', '删除模型失败，请重试'))
    return
  }
  removeModel(provider, target.modelId)
  try {
    await flushAutoSave({ force: true })
    pendingDeleteModel.value = null
  } catch (e) {
    catalogStore.clearModelExclusion(exclusionScope, target.modelId)
    settingsStore.updateProvider(provider.id, {
      models: previousModels,
      selectedModelId: previousSelectedModelId,
    })
    logger.error('[Settings] 删除模型持久化失败:', e)
    toast.error(t('settings.llm.deleteModelFailed', '删除模型失败，请重试'))
  }
}

/** 保存编辑的模型 */
function saveEditModel() {
  if (!editingModel.value) return
  const { providerId, idx } = editingModel.value
  const provider = settingsStore.config?.llm.providers.find((p) => p.id === providerId)
  if (!provider) return
  const previousModelId = provider.models[idx]!.id

  const caps = (Object.entries(editModelForm.value.caps) as [ModelCapability, boolean][])
    .filter(([, v]) => v)
    .map(([k]) => k)

  const updated = [...provider.models]
  updated[idx] = {
    ...updated[idx]!,
    name: editModelForm.value.name || editModelForm.value.id,
    id: editModelForm.value.id,
    capabilities: caps.length > 0 ? caps : ['text'],
  }
  settingsStore.updateProvider(providerId, {
    models: updated,
    selectedModelId:
      provider.selectedModelId === previousModelId
        ? editModelForm.value.id
        : provider.selectedModelId,
  })
  editingModel.value = null
  autoSave()
}

// ─── Provider 连接测试 ────────────────────────────────
const testingProviderId = ref<string | null>(null)
const testProviderResult = ref<
  Record<string, { ok: boolean; msg: string; locality?: 'local' | 'cloud' }>
>({})

function clearProviderProbeState(provider: ProviderConfig) {
  provider.probeReceipt = undefined
  delete testProviderResult.value[provider.id]
}

function providerConnectionResult(provider: ProviderConfig) {
  const receipt = provider.probeReceipt
  if (receipt) {
    return {
      ok: receipt.outcome === 'passed',
      msg:
        receipt.errorMessage ||
        (receipt.outcome === 'passed'
          ? t('settings.llm.connectionOk')
          : t('settings.llm.connectionFailed')),
      locality: receipt.locality,
    }
  }
  return testProviderResult.value[provider.id]
}

function parseProviderProbeTime(value: string | number | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

async function providerWithStableIdentity(provider: ProviderConfig): Promise<ProviderConfig> {
  const providerInstanceId = provider.providerInstanceId
  const backendKey = provider.backendKey
  const providerId = provider.id
  markAutoSavePending()
  await flushAutoSave({ force: true })
  await settingsStore.loadConfig({ force: true })

  return (
    config.value?.llm.providers.find(
      (candidate) =>
        !!candidate.providerInstanceId &&
        ((!!providerInstanceId && candidate.providerInstanceId === providerInstanceId) ||
          candidate.id === providerId ||
          (!!backendKey && candidate.backendKey === backendKey) ||
          (candidate.name === provider.name && candidate.type === provider.type)),
    ) ?? provider
  )
}

/** API Key 变化后自动测试连接 + 拉取模型（防抖 1.5s） */
function scheduleAutoTest(provider: ProviderConfig) {
  if (autoTestTimers[provider.id]) clearTimeout(autoTestTimers[provider.id])
  clearProviderProbeState(provider)
  const apiKey = resolveProviderConnectionApiKey(provider)
  if ((!apiKey && !provider.providerInstanceId) || provider.type === 'ollama') return
  autoTestTimers[provider.id] = setTimeout(() => {
    testProvider(provider)
  }, 1500)
}

function resolveProviderConnectionApiKey(provider: ProviderConfig): string {
  const rawApiKey = provider.apiKey?.trim() || ''
  if (!rawApiKey) return ''
  if (isMaskedApiKey(rawApiKey) && provider.providerInstanceId) return ''
  return rawApiKey
}

async function testProvider(provider: ProviderConfig) {
  if (testingProviderId.value !== null) return
  testingProviderId.value = provider.id
  delete testProviderResult.value[provider.id]

  // 此入口只验证 chat-completions；Embedding-only 由知识库 profile preflight 验证。
  const preferred =
    provider.models?.find(
      (model) => model.id === provider.selectedModelId && isChatModelOption(model),
    ) || provider.models?.find(isChatModelOption)
  const selectedModelId = (preferred?.id || '').trim()
  if (!selectedModelId) {
    testProviderResult.value[provider.id] = {
      ok: false,
      msg: t('settings.llm.testNeedsModel'),
    }
    testingProviderId.value = null
    return
  }

  const needsApiKey = provider.type !== 'ollama'

  let activeProvider: ProviderConfig
  try {
    activeProvider = await providerWithStableIdentity(provider)
  } catch (error) {
    testingProviderId.value = null
    throw error
  }

  if (activeProvider.id !== provider.id) {
    delete testProviderResult.value[provider.id]
  }

  const connectionApiKey = resolveProviderConnectionApiKey(activeProvider)
  if (needsApiKey && !connectionApiKey && !activeProvider.providerInstanceId) {
    testProviderResult.value[provider.id] = {
      ok: false,
      msg: t('settings.llm.testNeedsApiKey'),
    }
    if (activeProvider.id !== provider.id) {
      testProviderResult.value[activeProvider.id] = {
        ok: false,
        msg: t('settings.llm.testNeedsApiKey'),
      }
    }
    testingProviderId.value = null
    return
  }

  try {
    if (!activeProvider.providerInstanceId) {
      throw new Error(t('settings.llm.connectionFailed'))
    }
    const activePreferred =
      activeProvider.models?.find(
        (model) =>
          model.id === activeProvider.selectedModelId && isChatModelOption(model),
      ) || activeProvider.models?.find(isChatModelOption)
    const activeModelId = (activePreferred?.id || selectedModelId).trim()
    const preset = PROVIDER_PRESETS[activeProvider.type]
    const result = await testLLMConnection(
      {
        provider: {
          type: activeProvider.type,
          api_key: connectionApiKey,
          base_url: activeProvider.baseUrl || preset?.defaultBaseUrl || '',
          model: activeModelId,
        },
      },
      {
        providerInstanceId: activeProvider.providerInstanceId,
        locality: effectiveProviderLocality(activeProvider),
        privateNetworkAccess: activeProvider.privateNetworkAccess,
      },
    )
    const testedAt = parseProviderProbeTime(result.tested_at)

    if (!result.ok) {
      activeProvider.probeReceipt = undefined
      const failed = {
        ok: false,
        msg: result.error_message || result.message || t('settings.llm.connectionFailed'),
      }
      testProviderResult.value[provider.id] = failed
      if (activeProvider.id !== provider.id) {
        testProviderResult.value[activeProvider.id] = failed
      }
    } else if (result.persisted && testedAt !== undefined) {
      activeProvider.probeReceipt = {
        providerInstanceId: activeProvider.providerInstanceId,
        outcome: 'passed',
        locality: effectiveProviderLocality(activeProvider),
        latencyMs: result.latency_ms ?? 0,
        testedAt,
        ...(result.error_code ? { errorCode: result.error_code } : {}),
      }
      delete testProviderResult.value[activeProvider.id]
      delete testProviderResult.value[provider.id]
    } else {
      activeProvider.probeReceipt = undefined
      const success = {
        ok: true,
        msg: t('settings.llm.connectionOk'),
      }
      testProviderResult.value[provider.id] = success
      if (activeProvider.id !== provider.id) {
        testProviderResult.value[activeProvider.id] = success
      }
    }
    // 连接成功后自动拉取远程模型列表（Ollama 由 syncOllamaModels 处理）
    if (result.ok && activeProvider.type !== 'ollama') {
      syncRemoteModels(activeProvider)
    }
  } catch (e) {
    const failed = {
      ok: false,
      msg: messageFromUnknownError(e),
    }
    testProviderResult.value[provider.id] = failed
    if (activeProvider.id !== provider.id) {
      testProviderResult.value[activeProvider.id] = failed
    }
  } finally {
    testingProviderId.value = null
  }
}

/** 连接成功后，从 Provider 动态拉取可用模型目录 */
async function syncRemoteModels(
  provider: ProviderConfig,
  { waitForPersistence = false }: { waitForPersistence?: boolean } = {},
): Promise<boolean> {
  const preset = PROVIDER_PRESETS[provider.type]
  const baseUrl = provider.baseUrl || preset?.defaultBaseUrl || ''
  if (!baseUrl && !provider.providerInstanceId) return false
  const apiKey = resolveProviderConnectionApiKey(provider)
  if (!apiKey && !provider.providerInstanceId) return false
  const syncLease = beginProviderCatalogSync(provider, baseUrl)
  try {
    const remoteModels = await fetchProviderModels(baseUrl, apiKey, {
      providerType: provider.type,
      providerInstanceId: provider.providerInstanceId,
      locality: effectiveProviderLocality(provider),
      privateNetworkAccess: provider.privateNetworkAccess,
    })
    if (!remoteModels.length) throw new Error('empty model catalog')
    const currentProvider = config.value?.llm.providers.find((candidate) => candidate.id === provider.id)
    if (!currentProvider) return false
    const currentPreset = PROVIDER_PRESETS[currentProvider.type]
    const currentBaseUrl = currentProvider.baseUrl || currentPreset?.defaultBaseUrl || ''
    if (!syncLease.isCurrent(currentProvider, currentBaseUrl)) return false
    // 目录层：全量 + 元数据存本地缓存；Provider 卡片只呈现已配置子集。
    catalogStore.setCatalog(currentProvider.id, remoteModels)
    const result = reconcileProviderCatalog(
      currentProvider,
      remoteModels,
      currentPreset?.defaultModels ?? [],
      catalogStore.getExcludedModelIds(providerModelExclusionScope(currentProvider)),
    )
    if (result.changed) {
      if (waitForPersistence) {
        markAutoSavePending()
        await flushAutoSave({ force: true })
      } else {
        autoSave()
      }
    }
    return true
  } catch (e) {
    // 自动后台同步（testProvider 成功后触发）忽略返回值 → 静默。
    logger.warn('[Settings] 拉取远程模型列表失败（不影响使用）:', e)
    return false
  }
}

function providerCatalogCount(providerId: string): number {
  return catalogStore.getCatalog(providerId)?.models.length ?? 0
}

/** 目录超过阈值时使用“摘要 + 管理器”，避免把聚合商全量目录铺进 Provider 卡片。 */
function isManagedCatalog(providerId: string): boolean {
  return providerCatalogCount(providerId) > AUTO_ENABLE_CATALOG_LIMIT
}

/** 所有云端 Provider 共用目录管理器；本地 Ollama 保持独立的本地模型管理链路。 */
function canManageProviderCatalog(provider: ProviderConfig): boolean {
  return provider.type !== 'ollama' && effectiveProviderLocality(provider) === 'cloud'
}

function providerHasNewModels(providerId: string): boolean {
  return (catalogStore.getCatalog(providerId)?.newIds.length ?? 0) > 0
}

function openModelManager(providerId: string, event: MouseEvent) {
  modelManagerReturnFocus = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  modelManagerProviderId.value = providerId
}

function closeModelManager() {
  modelManagerProviderId.value = null
  const returnFocus = modelManagerReturnFocus
  modelManagerReturnFocus = null
  nextTick(() => {
    if (returnFocus?.isConnected) returnFocus.focus()
  })
}

async function handleManagerResync() {
  const provider = modelManagerProvider.value
  if (!provider || managerSyncing.value) return
  managerSyncing.value = true
  try {
    const ok = await syncRemoteModels(provider, { waitForPersistence: true })
    if (!ok) {
      toast.error(t('settings.llm.syncModelsFailed', '同步模型列表失败，请检查连接'))
    }
  } finally {
    managerSyncing.value = false
  }
}

/** 模型是否免费（仅当目录带价格元数据时返回 true，宁缺勿错） */
function isModelFree(providerId: string, modelId: string): boolean {
  const entry = catalogStore.getCatalog(providerId)?.models.find((m) => m.id === modelId)
  return !!entry && isCatalogModelFree(entry)
}

/**
 * 已启用模型是否已被上游下架（同步过目录、目录里没有它）。
 * 自定义模型和图像/视频生成模型不参与判断（/models 本就不返回它们）。
 */
function isStaleModel(provider: ProviderConfig, model: ModelOption): boolean {
  const catalog = catalogStore.getCatalog(provider.id)
  if (!catalog || catalog.models.length === 0) return false
  if (model.isCustom) return false
  if (model.capabilities?.some((c) => c === 'image_generation' || c === 'video_generation'))
    return false
  return !catalog.models.some((m) => m.id === model.id)
}

/** 自动保存（防抖） */
function autoSave() {
  markAutoSavePending()
  if (autoSaveTimer) clearTimeout(autoSaveTimer)
  autoSaveTimer = setTimeout(async () => {
    try {
      await flushAutoSave()
    } catch (e) {
      logger.error('[HexClaw] 自动保存失败:', e)
    }
  }, 500)
}

function onProviderApiKeyInput(provider: ProviderConfig) {
  clearProviderProbeState(provider)
  autoSave()
  scheduleAutoTest(provider)
}

function selectProviderModel(provider: ProviderConfig, modelId: string) {
  provider.selectedModelId = modelId
  handleProviderModelChange(provider)
}

async function onToolbarReset() {
  if (!settingsStore.config) return
  try {
    await settingsStore.loadConfig({ force: true })
    saved.value = false
  } catch (e) {
    logger.error('[HexClaw] Reset failed:', e)
    toast.error(t('settings.toolbar.resetFailed', '重置失败，请重试'))
  }
}

async function saveConfig() {
  saveFailed.value = false
  try {
    await flushAutoSave({
      force: true,
      showSavedFeedback: true,
      refreshRuntimeInfo: activeSection.value === 'system',
    })
  } catch (e) {
    logger.error('保存配置失败:', e)
    // 保存失败不能静默：清成功态 + 置失败态，按钮显示「保存失败，请重试」（4s 后复位）
    saved.value = false
    saveFailed.value = true
    setTimeout(() => {
      saveFailed.value = false
    }, 4000)
  }
}

/**
 * 渲染时计算模型可用 capability badge。
 * 兼容历史：升级前保存的模型 capabilities=['text']，渲染时按 ID 重新推断
 * （glm-4v / qwen-vl-max / cogview-4 等会自动补回 vision/image_generation）。
 * 若已有非 text 标记则尊重保存值，避免覆盖用户自定义。
 *
 * 参照 HuggingFace pipeline-tag 风格：所有能力都显式标出（包含 text），
 * 避免"什么都没有 = 不知道支持什么"的误解。
 */
function displayCapabilities(model: ModelOption): ModelCapability[] {
  const stored = normalizeModelCapabilities(model)
  if (stored.length === 0 || stored.includes('embedding')) return stored
  const isTextOnly = stored.length === 1 && stored[0] === 'text'
  return (isTextOnly ? inferCapabilitiesFromId(model.id) : stored) as ModelCapability[]
}
</script>

<template>
  <div
    class="hc-settings"
    :inert="customModelDialogProviderId || modelManagerProviderId ? true : undefined"
  >
    <PageToolbar>
      <template #tabs>
        <SegmentedControl
          v-model="activeSection"
          :segments="sections.map((s) => ({ key: s.key, label: s.label }))"
        />
      </template>
      <template #actions>
        <button class="hc-btn hc-btn-ghost" @click="onToolbarReset">
          <RotateCcw :size="14" />
          {{ t('settings.toolbar.reset', 'Reset') }}
        </button>
        <button
          class="hc-btn hc-btn-primary"
          :class="{ 'hc-settings__btn--saved': saved, 'hc-settings__btn--failed': saveFailed }"
          :disabled="!hasUnsavedChanges() && !saved"
          @click="saveConfig"
        >
          <CheckCircle v-if="saved" :size="14" />
          {{
            saved
              ? t('common.saved')
              : saveFailed
                ? t('settings.toolbar.saveFailed', '保存失败，请重试')
                : t('settings.toolbar.saveSettings', '保存')
          }}
          <span class="hc-settings__dirty" :class="{ 'hc-settings__dirty--on': isDirty }"
            >· 未保存</span
          >
        </button>
      </template>
    </PageToolbar>

    <div class="hc-settings__body">
      <div class="hc-settings__content">
        <LoadingState v-if="settingsStore.loading && !config" />

        <template v-if="config">
          <!-- LLM Providers -->
          <div v-if="activeSection === 'llm'" class="hc-settings__section" style="max-width: 600px">
            <!-- ── 默认行为 ── -->
            <div class="hc-settings__sep">
              <span class="hc-settings__sep-label">默认行为</span>
              <span class="hc-settings__sep-line"></span>
            </div>

            <div class="hc-settings__row">
              <span class="hc-settings__row-label">
                {{ t('settings.llm.defaultModel') }}
                <span class="hc-settings__info" :data-info="t('settings.llm.defaultModelHint')"
                  >?</span
                >
              </span>
              <div class="hc-settings__row-right">
                <HcSelect
                  v-model="selectedDefaultModelValue"
                  data-testid="llm-default-model-select"
                  class="hc-settings__select"
                  :options="defaultModelSelectOptions"
                  :disabled="defaultModelOptions.length === 0"
                />
              </div>
            </div>

            <!-- Routing: toggle + select (策略仅在开启时显示) -->
            <div class="hc-settings__row">
              <span class="hc-settings__row-label">
                {{ t('settings.llm.routingEnabled') }}
                <span
                  class="hc-settings__info"
                  data-info="开启后，未指定模型的请求将根据偏好策略自动选择最优模型。"
                  >?</span
                >
              </span>
              <div class="hc-settings__row-right">
                <HcSelect
                  v-if="config.llm.routing?.enabled"
                  v-model="routingStrategyValue"
                  data-testid="llm-routing-strategy-select"
                  class="hc-settings__select"
                  :options="routingStrategyOptions"
                />
                <input
                  v-model="config.llm.routing!.enabled"
                  data-testid="llm-routing-toggle"
                  type="checkbox"
                  class="hc-toggle"
                  @change="handleRoutingToggle"
                />
              </div>
            </div>

            <!-- B1 Agent 策略模式：默认 auto 按问题启发式路由（7 模式 + auto）-->
            <div class="hc-settings__row">
              <span class="hc-settings__row-label">
                Agent 模式
                <span
                  class="hc-settings__info"
                  data-info="auto 按问题自动选；ReAct 工具循环；Plan-Execute 先规划再执行；Reflection 答后自查；ToT 多解择优；Self-Reflect 每步反思；Memory-Augmented 个性化档案；Debate 双视角辩论。"
                  >?</span
                >
              </span>
              <div class="hc-settings__row-right">
                <HcSelect
                  v-model="agentModeValue"
                  data-testid="llm-agent-mode-select"
                  class="hc-settings__select"
                  :options="agentModeOptions"
                />
              </div>
            </div>

            <!-- ── 工具能力 ── -->
            <div class="hc-settings__sep">
              <span class="hc-settings__sep-label">工具能力</span>
              <span class="hc-settings__sep-line"></span>
            </div>

            <div class="hc-settings__row">
              <span class="hc-settings__row-label">
                {{ t('settings.llm.toolsToggle') }}
                <span
                  class="hc-settings__info"
                  data-info="开启后模型可使用已安装的 Skill 和 MCP 工具完成搜索、计算等操作。本地小模型建议关闭。"
                  >?</span
                >
              </span>
              <div class="hc-settings__row-right">
                <input
                  type="checkbox"
                  class="hc-toggle"
                  :checked="(config.llm.tools?.enabled ?? 'auto') !== 'off'"
                  @change="
                    (e: Event) => {
                      const on = (e.target as HTMLInputElement).checked
                      config!.llm.tools = {
                        enabled: on ? 'auto' : 'off',
                        maxTools: config!.llm.tools?.maxTools ?? 0,
                      }
                      autoSave()
                    }
                  "
                />
              </div>
            </div>

            <div v-if="(config.llm.tools?.enabled ?? 'auto') !== 'off'" class="hc-settings__sub">
              <div class="hc-settings__row">
                <span class="hc-settings__row-label">
                  {{ t('settings.llm.maxToolsLabel') }}
                  <span
                    class="hc-settings__info"
                    data-info="限制单次对话注入的工具数量。0 表示不限制，小模型建议 3–5。"
                    >?</span
                  >
                </span>
                <div class="hc-settings__row-right">
                  <div class="hc-settings__stepper">
                    <button @click="stepMaxTools(-1)">−</button>
                    <input :value="maxToolsDisplay" readonly />
                    <button @click="stepMaxTools(1)">+</button>
                  </div>
                </div>
              </div>
            </div>

            <!-- ── 服务商 ── -->
            <div class="hc-settings__sep">
              <span class="hc-settings__sep-label">服务商</span>
              <span class="hc-settings__sep-line"></span>
              <button
                class="hc-btn hc-btn-sm hc-settings__sep-action"
                @click="showAddProvider = !showAddProvider"
              >
                <Plus :size="14" />
                {{ t('settings.llm.addProvider') }}
              </button>
            </div>

            <!-- 添加 Provider 面板 -->
            <div v-if="showAddProvider" class="hc-provider__add-panel">
              <label class="hc-settings__label">{{ t('settings.llm.selectProvider') }}</label>
              <ProviderSelect v-model="addProviderType" :include-custom="true" />
              <div class="hc-provider__add-actions">
                <button class="hc-btn hc-btn-sm" @click="showAddProvider = false">
                  {{ t('common.cancel') }}
                </button>
                <button class="hc-btn hc-btn-primary hc-btn-sm" @click="handleAddProvider">
                  {{ t('common.confirm') }}
                </button>
              </div>
            </div>

            <!-- 本地 LLM (Ollama) 卡片 -->
            <OllamaCard
              @associate="handleAssociateOllama"
              @toggle-provider="handleToggleOllamaProvider"
            />

            <!-- Provider 列表（本地 Ollama 常驻，故不再额外渲染「尚未添加服务商」空态；对齐原型） -->
            <div class="hc-provider__list">
              <div
                v-for="provider in nonOllamaProviders"
                :key="provider.id"
                class="hc-provider__card"
                :class="{ 'hc-provider__card--disabled': !provider.enabled }"
                :data-provider-type="provider.type"
              >
                <!-- Provider 头部 -->
                <div class="hc-provider__card-head" @click="toggleEditingProvider(provider.id)">
                  <div class="hc-provider__card-info">
                    <img
                      :src="PROVIDER_LOGOS[provider.type] || PROVIDER_LOGOS.custom"
                      :alt="provider.type"
                      class="hc-provider__logo"
                    />
                    <span class="hc-provider__card-name">{{ provider.name }}</span>
                    <span class="hc-provider__tag">{{ provider.type }}</span>
                    <span class="hc-provider__model-count"
                      >{{ provider.models.length }}
                      {{ t('settings.llm.models').toLowerCase() }}</span
                    >
                  </div>
                  <div class="hc-provider__card-actions">
                    <span
                      class="hc-provider__connection-status"
                      :class="{
                        'hc-provider__connection-status--testing':
                          testingProviderId === provider.id,
                        'hc-provider__connection-status--ok':
                          testingProviderId !== provider.id &&
                          providerConnectionResult(provider)?.ok,
                        'hc-provider__connection-status--error':
                          testingProviderId !== provider.id &&
                          providerConnectionResult(provider) &&
                          !providerConnectionResult(provider)!.ok,
                      }"
                      aria-live="polite"
                      :aria-label="
                        providerConnectionResult(provider)?.ok
                          ? t('settings.llm.testSuccess', '成功')
                          : undefined
                      "
                    >
                      <Loader2
                        v-if="testingProviderId === provider.id"
                        :size="12"
                        class="animate-spin"
                      />
                      <CheckCircle
                        v-else-if="providerConnectionResult(provider)?.ok"
                        :size="12"
                      />
                      <XCircle v-else-if="providerConnectionResult(provider)" :size="12" />
                      <span v-else class="hc-provider__connection-dot" aria-hidden="true" />
                      {{
                        testingProviderId === provider.id
                          ? t('settings.llm.testing', '测试中…')
                          : providerConnectionResult(provider)?.ok
                            ? t('settings.llm.testSuccess', '成功')
                            : providerConnectionResult(provider)
                              ? t('settings.llm.testFailed', '失败')
                              : t('settings.llm.untested', '未测试')
                      }}
                    </span>
                    <button
                      class="hc-btn hc-btn-sm hc-provider__test-btn"
                      :title="t('settings.llm.testConnection', '测试连接')"
                      :disabled="
                        testingProviderId !== null ||
                        providerEndpointDecision(provider).classification === 'blocked'
                      "
                      @click.stop="testProvider(provider)"
                    >
                      {{ t('settings.llm.testAction', '测试') }}
                    </button>
                    <button
                      class="hc-provider__delete-btn"
                      @click.stop="openDeleteProviderConfirm(provider.id)"
                    >
                      {{ t('settings.llm.deleteAction', '删除') }}
                    </button>
                    <button
                      class="hc-provider__icon-btn"
                      :title="
                        provider.enabled ? t('settings.llm.enabled') : t('settings.llm.disabled')
                      "
                      :aria-label="
                        provider.enabled ? t('settings.llm.enabled') : t('settings.llm.disabled')
                      "
                      @click.stop="toggleProvider(provider)"
                    >
                      <Power
                        :size="14"
                        :class="
                          provider.enabled ? 'hc-provider__power--on' : 'hc-provider__power--off'
                        "
                      />
                    </button>
                    <component
                      :is="editingProviderId === provider.id ? ChevronUp : ChevronDown"
                      :size="14"
                      class="hc-provider__chevron"
                    />
                  </div>
                </div>

                <!-- Provider 编辑面板 -->
                <div v-if="editingProviderId === provider.id" class="hc-provider__edit">
                  <div
                    class="hc-provider__config-grid"
                    :class="
                      provider.type === 'custom'
                        ? 'hc-provider__config-grid--custom'
                        : 'hc-provider__config-grid--builtin'
                    "
                  >
                    <div v-if="provider.type === 'custom'" class="hc-settings__field">
                      <label class="hc-settings__label" :for="`provider-${provider.id}-name`"
                        >{{ t('settings.llm.provider') }}
                        <span class="hc-settings__required">*</span></label
                      >
                      <HcClearableField>
                        <input
                          :id="`provider-${provider.id}-name`"
                          v-model="provider.name"
                          data-provider-field="name"
                          type="text"
                          class="hc-input"
                          @input="handleProviderNameInput(provider)"
                        />
                      </HcClearableField>
                    </div>

                    <div class="hc-settings__field">
                      <label class="hc-settings__label" :for="`provider-${provider.id}-api-key`"
                        >{{ t('settings.llm.apiKey') }}
                        <span class="hc-settings__required">*</span></label
                      >
                      <div class="hc-settings__input-group">
                        <HcClearableField :trailing="38">
                          <input
                            :id="`provider-${provider.id}-api-key`"
                            v-model="provider.apiKey"
                            data-provider-field="api-key"
                            :type="showApiKeys[provider.id] ? 'text' : 'password'"
                            class="hc-input"
                            :placeholder="PROVIDER_PRESETS[provider.type]?.placeholder || 'API Key'"
                            @input="onProviderApiKeyInput(provider)"
                          />
                        </HcClearableField>
                        <button
                          type="button"
                          class="hc-settings__eye-btn"
                          :aria-label="showApiKeys[provider.id] ? '隐藏 API Key' : '显示 API Key'"
                          :title="showApiKeys[provider.id] ? '隐藏 API Key' : '显示 API Key'"
                          @click="showApiKeys[provider.id] = !showApiKeys[provider.id]"
                        >
                          <Eye v-if="!showApiKeys[provider.id]" :size="15" />
                          <EyeOff v-else :size="15" />
                        </button>
                      </div>
                    </div>

                    <div class="hc-settings__field hc-provider__config-url">
                      <label class="hc-settings__label" :for="`provider-${provider.id}-base-url`"
                        >{{ t('settings.llm.baseUrl') }}
                        <span class="hc-settings__required">*</span></label
                      >
                      <HcClearableField>
                        <input
                          :id="`provider-${provider.id}-base-url`"
                          v-model="provider.baseUrl"
                          data-provider-field="base-url"
                          type="text"
                          class="hc-input"
                          :placeholder="PROVIDER_PRESETS[provider.type]?.defaultBaseUrl"
                          @input="handleProviderBaseUrlInput(provider)"
                        />
                      </HcClearableField>
                      <p
                        v-if="providerEndpointDecision(provider).classification === 'blocked'"
                        class="hc-settings__hint hc-settings__hint--error"
                      >
                        {{ t('settings.llm.unsafeEndpoint') }}
                      </p>
                    </div>
                  </div>

                  <div
                    v-if="providerNeedsDestinationConfirmation(provider)"
                    class="hc-settings__field hc-provider-destination"
                  >
                    <label class="hc-settings__label">
                      {{ t('settings.llm.destinationQuestion') }}
                    </label>
                    <div class="hc-provider-destination__choices">
                      <label class="hc-provider-destination__choice">
                        <input
                          type="radio"
                          :name="`provider-destination-${provider.id}`"
                          value="cloud"
                          :checked="providerDestinationSelection(provider) === 'cloud'"
                          :data-testid="`provider-destination-cloud-${provider.id}`"
                          @change="handleProviderDestinationChange(provider, 'cloud')"
                        />
                        <span>
                          <b>{{ t('settings.llm.destinationCloud') }}</b>
                          <small>{{ t('settings.llm.destinationCloudHint') }}</small>
                        </span>
                      </label>
                      <label class="hc-provider-destination__choice">
                        <input
                          type="radio"
                          :name="`provider-destination-${provider.id}`"
                          value="local"
                          :checked="providerDestinationSelection(provider) === 'local'"
                          :data-testid="`provider-destination-local-${provider.id}`"
                          @change="handleProviderDestinationChange(provider, 'local')"
                        />
                        <span>
                          <b>{{ t('settings.llm.destinationLocal') }}</b>
                          <small>{{ t('settings.llm.destinationLocalHint') }}</small>
                        </span>
                      </label>
                    </div>
                    <p
                      v-if="providerEndpointDecision(provider).requiresPrivateNetworkAccess"
                      class="hc-settings__hint"
                    >
                      {{ t('settings.llm.privateNetworkTrustHint') }}
                    </p>
                  </div>

                  <!-- 模型选择（芯片式） -->
                  <div class="hc-settings__field">
                    <div class="hc-model-section-header">
                      <label class="hc-settings__label"
                        >{{ t('settings.llm.models') }}
                        <span class="hc-settings__required">*</span></label
                      >
                      <div class="hc-model-section-actions">
                        <span v-if="isManagedCatalog(provider.id)" class="hc-model-enabled-summary">
                          {{ t('settings.llm.modelsEnabledSummary', '已启用') }}
                          <b>{{ provider.models.length }}</b> /
                          {{ providerCatalogCount(provider.id) }}
                          {{ t('settings.llm.modelsAvailable', '可用') }}
                        </span>
                        <button
                          v-if="canManageProviderCatalog(provider)"
                          type="button"
                          class="hc-model-chip hc-model-chip--manage"
                          @click="openModelManager(provider.id, $event)"
                        >
                          <SlidersHorizontal :size="12" />
                          {{ t('settings.llm.manageModels', '管理模型') }}
                          <span
                            v-if="providerHasNewModels(provider.id)"
                            class="hc-model-chip__new-dot"
                            :title="t('settings.llm.newModelsFound', '本次同步发现新模型')"
                          />
                        </button>
                        <span v-if="testProviderResult[provider.id]?.ok" class="hc-model-sync-hint">
                          {{ t('settings.llm.modelsDynamic', '动态获取') }} ·
                          {{ t('settings.llm.justSynced', '刚刚同步') }}
                        </span>
                        <span
                          v-else-if="provider.models.length > 0 && !isManagedCatalog(provider.id)"
                          class="hc-model-sync-hint"
                        >
                          {{ t('settings.llm.modelsPreset', '预设模型') }}
                        </span>
                      </div>
                    </div>
                    <div class="hc-model-chips">
                      <template v-for="model in provider.models" :key="model.id">
                        <!-- 非对话模型不参与当前模型选择，也不暴露聊天/tool-call 探测。 -->
                        <div
                          v-if="!isChatModelOption(model)"
                          class="hc-model-chip hc-model-chip--non-chat"
                          :class="{
                            'hc-model-chip--embedding': isEmbeddingOnlyModel(model),
                            'hc-model-chip--stale': isStaleModel(provider, model),
                          }"
                          :title="
                            isEmbeddingOnlyModel(model)
                              ? `${model.name || model.id} · Embedding · 仅用于知识库语义索引`
                              : model.name || model.id
                          "
                        >
                          <span class="hc-model-chip__name" :title="model.name || model.id">
                            {{ model.name || model.id }}
                          </span>
                          <span
                            v-for="cap in displayCapabilities(model)"
                            :key="cap"
                            class="hc-model-chip__cap"
                            :class="`hc-model-chip__cap--${cap}`"
                            :title="MODEL_CAPABILITY_DISPLAY[cap].title"
                            >{{ MODEL_CAPABILITY_DISPLAY[cap].icon }}
                            {{ MODEL_CAPABILITY_DISPLAY[cap].label }}</span
                          >
                          <button
                            v-if="isProviderModelRemovable(provider, model)"
                            type="button"
                            class="hc-model-chip__remove"
                            :aria-label="`删除 ${model.name || model.id}`"
                            title="删除模型"
                            @click.stop="requestDeleteProviderModel(provider, model)"
                          >
                            ×
                          </button>
                        </div>

                        <!-- 可删除对话模型用非交互容器承载三个互不嵌套的按钮。 -->
                        <div
                          v-else-if="isProviderModelRemovable(provider, model)"
                          class="hc-model-chip hc-model-chip--custom"
                          :class="{
                            'hc-model-chip--active': provider.selectedModelId === model.id,
                            'hc-model-chip--stale': isStaleModel(provider, model),
                          }"
                          :title="model.name || model.id"
                        >
                          <button
                            type="button"
                            class="hc-model-chip__select"
                            :aria-label="`选择模型 ${model.name || model.id}`"
                            @click="selectProviderModel(provider, model.id)"
                          >
                            <span class="hc-model-chip__name" :title="model.name || model.id">
                              {{ model.name || model.id }}
                            </span>
                            <span
                              v-if="isStaleModel(provider, model)"
                              class="hc-model-chip__stale-label"
                            >
                              {{ t('settings.llm.modelStaleLabel', '已下架') }}
                            </span>
                            <span
                              v-for="cap in displayCapabilities(model)"
                              :key="cap"
                              class="hc-model-chip__cap"
                              :class="`hc-model-chip__cap--${cap}`"
                              :title="MODEL_CAPABILITY_DISPLAY[cap].title"
                              >{{ MODEL_CAPABILITY_DISPLAY[cap].icon }}
                              {{ MODEL_CAPABILITY_DISPLAY[cap].label }}</span
                            >
                            <span
                              v-if="
                                model.toolReliability && model.toolReliability.level !== 'unknown'
                              "
                              class="hc-model-chip__reliability"
                              :class="`hc-model-chip__reliability--${model.toolReliability.level}`"
                              :title="reliabilityTooltip(model.toolReliability)"
                              >{{ reliabilityIcon(model.toolReliability.level) }}</span
                            >
                          </button>
                          <button
                            type="button"
                            class="hc-model-chip__probe"
                            :aria-label="`重新检测 ${model.name || model.id} 工具调用可靠度`"
                            :title="
                              probingModel(provider.id, model.id)
                                ? '探测中…'
                                : '重新检测工具调用可靠度'
                            "
                            @click.stop="refreshCapability(provider, model)"
                          >
                            <Loader2
                              v-if="probingModel(provider.id, model.id)"
                              :size="10"
                              class="animate-spin"
                            />
                            <RotateCcw v-else :size="10" />
                          </button>
                          <button
                            type="button"
                            class="hc-model-chip__remove"
                            :aria-label="`删除 ${model.name || model.id}`"
                            title="删除模型"
                            @click.stop="requestDeleteProviderModel(provider, model)"
                          >
                            ×
                          </button>
                        </div>

                        <!-- 仍存在于上游目录的 Provider 预设对话模型不可删除。 -->
                        <button
                          v-else
                          type="button"
                          class="hc-model-chip"
                          :class="{
                            'hc-model-chip--active': provider.selectedModelId === model.id,
                            'hc-model-chip--stale': isStaleModel(provider, model),
                          }"
                          :title="
                            isStaleModel(provider, model)
                              ? t(
                                  'settings.llm.modelStale',
                                  '上游已下架：该模型在最近一次同步的目录中不存在',
                                )
                              : model.name || model.id
                          "
                          @click="selectProviderModel(provider, model.id)"
                        >
                          <span class="hc-model-chip__name" :title="model.name || model.id">
                            {{ model.name || model.id }}
                          </span>
                          <span
                            v-if="isModelFree(provider.id, model.id)"
                            class="hc-model-chip__free-label"
                          >
                            {{ t('settings.llm.modelFreeLabel', '免费') }}
                          </span>
                          <span
                            v-if="isStaleModel(provider, model)"
                            class="hc-model-chip__stale-label"
                          >
                            {{ t('settings.llm.modelStaleLabel', '已下架') }}
                          </span>
                          <span
                            v-for="cap in displayCapabilities(model)"
                            :key="cap"
                            class="hc-model-chip__cap"
                            :class="`hc-model-chip__cap--${cap}`"
                            :title="MODEL_CAPABILITY_DISPLAY[cap].title"
                            >{{ MODEL_CAPABILITY_DISPLAY[cap].icon }}
                            {{ MODEL_CAPABILITY_DISPLAY[cap].label }}</span
                          >
                        </button>
                      </template>
                      <!-- 添加自定义模型 -->
                      <button
                        type="button"
                        class="hc-model-chip hc-model-chip--add"
                        title="添加自定义模型"
                        @click="openCustomModelDialog(provider, $event)"
                      >
                        <Plus :size="11" /> {{ t('settings.llm.customModel', '自定义') }}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <p class="hc-provider__service-notice" data-testid="third-party-ai-services-notice">
              {{ t('settings.llm.providerServiceNotice') }}
              <a
                :href="thirdPartyAiServicesHref"
                :aria-label="`${t('settings.llm.providerServiceDocs')} — ${t('common.openInNewWindow')}`"
                target="_blank"
                rel="noopener noreferrer"
                data-testid="third-party-ai-services-link"
                >{{ t('settings.llm.providerServiceDocs') }}</a
              >
            </p>
          </div>

          <!-- Automation permissions（治理入口：级别/待处理/审计/矩阵） -->
          <div
            v-else-if="activeSection === 'automation'"
            class="hc-settings__section hc-settings__section--automation"
          >
            <AutomationPermissionsPanel />
          </div>

          <!-- System (merged: appearance + storage) -->
          <div v-else-if="activeSection === 'system'" class="hc-settings__section">
            <div class="hc-settings__form hc-settings__form--system">
              <div class="hc-settings__sep">
                <span class="hc-settings__sep-label">{{ t('settings.appearance.title') }}</span>
                <span class="hc-settings__sep-line"></span>
              </div>
              <div
                class="hc-settings__theme-segmented"
                role="radiogroup"
                :aria-label="t('settings.appearance.title')"
              >
                <button
                  v-for="(opt, index) in themeOptions"
                  :key="opt.key"
                  type="button"
                  role="radio"
                  class="hc-settings__theme-segment"
                  :class="{ 'is-selected': themeMode === opt.key }"
                  :aria-checked="themeMode === opt.key"
                  :tabindex="themeMode === opt.key ? 0 : -1"
                  @click="handleThemeSelect(opt.key)"
                  @keydown="handleThemeKeydown($event, index)"
                >
                  {{ opt.label }}
                </button>
              </div>

              <component
                :is="extension"
                v-for="(extension, index) in appearanceSettingsExtensions"
                :key="index"
              />

              <div class="hc-settings__row">
                <span class="hc-settings__row-label">{{ t('settings.general.language') }}</span>
                <div class="hc-settings__row-right">
                  <HcSelect
                    class="hc-settings__select"
                    v-model="languageModel"
                    :options="languageOptions"
                  />
                </div>
              </div>

              <div class="hc-settings__sep">
                <span class="hc-settings__sep-label">{{ t('settings.general.title') }}</span>
                <span class="hc-settings__sep-line"></span>
              </div>

              <label class="hc-settings__toggle-row">
                <div>
                  <span class="hc-settings__toggle-label">{{
                    t('settings.general.autoStart')
                  }}</span>
                  <p class="hc-settings__toggle-desc">{{ t('settings.general.autoStartDesc') }}</p>
                </div>
                <input
                  v-model="config.general.auto_start"
                  type="checkbox"
                  class="hc-toggle"
                  data-testid="auto-start-toggle"
                  @change="handleAutoStartChange()"
                />
              </label>

              <label class="hc-settings__toggle-row">
                <div>
                  <span class="hc-settings__toggle-label">{{ t('settings.memory.toggle') }}</span>
                  <p class="hc-settings__toggle-desc">{{ t('settings.memory.toggleDesc') }}</p>
                </div>
                <input
                  v-model="memoryEnabled"
                  type="checkbox"
                  class="hc-toggle"
                  @change="autoSave()"
                />
              </label>

              <label class="hc-settings__toggle-row">
                <div>
                  <span class="hc-settings__toggle-label">{{ t('settings.sandbox.toggle') }}</span>
                  <p class="hc-settings__toggle-desc">{{ t('settings.sandbox.toggleDesc') }}</p>
                </div>
                <input
                  v-model="sandboxNetworkEnabled"
                  type="checkbox"
                  class="hc-toggle"
                  @change="autoSave()"
                />
              </label>
            </div>

            <!-- 系统信息 -->
            <div class="hc-settings__sep">
              <span class="hc-settings__sep-label">{{ t('settings.system.info') }}</span>
              <span class="hc-settings__sep-line"></span>
            </div>

            <div class="hc-settings__info-card" style="margin-top: 10px">
              <div class="hc-settings__info-grid">
                <div>
                  <span class="hc-settings__info-label">{{ t('settings.system.version') }}</span>
                  <!-- prettier-ignore -->
                  <div class="hc-settings__info-value hc-settings__info-value--mono" dir="ltr">{{ appVersion }}</div>
                </div>
                <div>
                  <span class="hc-settings__info-label">{{
                    t('settings.system.localStorage')
                  }}</span>
                  <div class="hc-settings__info-value">
                    <bdi class="hc-settings__info-mono">{{ runtimeLocalStoreFile }}</bdi> ·
                    <span
                      :style="{
                        color: runtimeConfig ? 'var(--hc-success)' : 'var(--hc-text-muted)',
                      }"
                    >
                      {{ runtimeConfig ? t('settings.system.connected') : '—' }}
                    </span>
                  </div>
                </div>
                <div>
                  <span class="hc-settings__info-label">{{
                    t('settings.system.knowledgeIndex')
                  }}</span>
                  <div
                    class="hc-settings__info-value"
                    :style="{
                      color: runtimeConfig?.knowledge.enabled
                        ? 'var(--hc-success)'
                        : 'var(--hc-text-muted)',
                    }"
                  >
                    <template v-if="runtimeConfig?.knowledge.enabled"
                      ><bdi class="hc-settings__info-mono">FTS5</bdi> ·
                      {{ t('settings.storage.enabled') }}</template
                    >
                    <template v-else>{{ t('settings.storage.disabled', 'Disabled') }}</template>
                  </div>
                </div>
                <div>
                  <span class="hc-settings__info-label">{{
                    t('settings.system.apiEndpoint')
                  }}</span>
                  <div class="hc-settings__info-value">
                    <template v-if="runtimeModeShort">{{ runtimeModeShort }} · </template>
                    <bdi class="hc-settings__info-mono">{{ runtimeApiEndpoint }}</bdi>
                  </div>
                </div>
              </div>
              <p
                v-if="runtimeInfoLoading"
                class="text-xs"
                :style="{ color: 'var(--hc-text-muted)', margin: '6px 0 0' }"
              >
                {{ t('common.loading', 'Loading...') }}
              </p>
            </div>

            <!-- 关于河蟹（身份入口，与「系统信息」分区风格一致） -->
            <div class="hc-settings__sep" style="margin-top: 18px">
              <span class="hc-settings__sep-label">{{
                t('settings.system.aboutLabel', '关于河蟹')
              }}</span>
              <span class="hc-settings__sep-line"></span>
            </div>
            <div class="hc-settings__about">
              <p class="hc-settings__about-intro">
                <span class="hc-settings__about-emoji" aria-hidden="true">🦀</span>
                {{
                  t('about.subtitle', '一只横行本地的 AI 螃蟹 —— 钳得住活，守得住数据，长得出本事')
                }}
              </p>
              <button type="button" class="hc-settings__about-link" @click="openAbout">
                {{ t('about.learnMore', '了解更多') }}
                <span aria-hidden="true">→</span>
              </button>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>

  <!-- 添加自定义模型：轻量弹窗，不在 Provider 卡片中保留内联编辑表单。 -->
  <Teleport to="body">
    <Transition name="hc-dialog">
      <div
        v-if="customModelDialogProviderId"
        class="hc-dialog-overlay"
        data-testid="custom-model-dialog"
        @click.self="closeCustomModelDialog()"
        @keydown="handleCustomModelDialogKeydown"
      >
        <div
          ref="customModelDialogRef"
          class="hc-edit-model-dialog hc-custom-model-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="hc-custom-model-dialog-title"
          tabindex="-1"
        >
          <div class="hc-edit-model-dialog__header">
            <h3 id="hc-custom-model-dialog-title" class="hc-edit-model-dialog__title">
              添加自定义模型
            </h3>
          </div>
          <div class="hc-edit-model">
            <div class="hc-edit-model__field">
              <label for="hc-custom-model-id"
                >模型 ID <span class="hc-settings__required">*</span></label
              >
              <HcClearableField>
                <input
                  id="hc-custom-model-id"
                  ref="customModelInputRef"
                  v-model="newModelId"
                  data-testid="custom-model-id"
                  type="text"
                  class="hc-input"
                  placeholder="如 anthropic/claude-3.7-sonnet-long-context-preview"
                  autocomplete="off"
                  :aria-invalid="customModelIdIsDuplicate || undefined"
                  :aria-describedby="
                    customModelIdIsDuplicate ? 'hc-custom-model-id-error' : undefined
                  "
                  @keyup.enter="canSubmitCustomModel && submitCustomModel()"
                />
              </HcClearableField>
              <p
                v-if="customModelIdIsDuplicate"
                id="hc-custom-model-id-error"
                data-testid="custom-model-id-error"
                class="hc-settings__hint hc-settings__hint--error"
                role="alert"
              >
                该模型已在列表中
              </p>
            </div>
            <fieldset class="hc-edit-model__field hc-custom-model-dialog__capability">
              <legend>核心能力</legend>
              <HcSelect
                v-model="newModelCapability"
                data-testid="custom-model-capability"
                aria-label="核心能力"
                :options="customModelCapabilityOptions"
              />
            </fieldset>
          </div>
          <div class="hc-edit-model-dialog__actions">
            <button type="button" class="hc-btn hc-btn-secondary" @click="closeCustomModelDialog()">
              {{ t('common.cancel', '取消') }}
            </button>
            <button
              type="button"
              class="hc-btn hc-btn-primary"
              data-testid="custom-model-submit"
              :disabled="!canSubmitCustomModel"
              @click="submitCustomModel"
            >
              {{ t('common.add', '添加') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 编辑模型 Modal -->
  <Teleport to="body">
    <Transition name="hc-dialog">
      <div
        v-if="editingModel"
        ref="editModelOverlayRef"
        class="hc-dialog-overlay"
        tabindex="-1"
        @click.self="editingModel = null"
        @keydown.esc="editingModel = null"
      >
        <div class="hc-edit-model-dialog">
          <div class="hc-edit-model-dialog__header">
            <h3 class="hc-edit-model-dialog__title">编辑模型</h3>
          </div>
          <div class="hc-edit-model">
            <div class="hc-edit-model__field">
              <label>模型 ID <span class="hc-settings__required">*</span></label>
              <HcClearableField>
                <input
                  v-model="editModelForm.id"
                  type="text"
                  class="hc-input"
                  placeholder="如 gpt-4o, claude-sonnet-4-6"
                />
              </HcClearableField>
            </div>
            <div class="hc-edit-model__field">
              <label>显示名称</label>
              <HcClearableField>
                <input
                  v-model="editModelForm.name"
                  type="text"
                  class="hc-input"
                  placeholder="留空则使用模型 ID"
                />
              </HcClearableField>
            </div>
            <div class="hc-edit-model__field">
              <label>模型能力</label>
              <div class="hc-edit-model__caps">
                <label
                  v-for="cap in [
                    'text',
                    'vision',
                    'video',
                    'audio',
                    'code',
                    'image_generation',
                    'video_generation',
                    'embedding',
                  ] as ModelCapability[]"
                  :key="cap"
                  class="hc-edit-model__cap-item"
                >
                  <input
                    v-model="editModelForm.caps[cap]"
                    type="checkbox"
                    :disabled="cap === 'text'"
                  />
                  <span class="hc-edit-model__cap-icon">{{
                    MODEL_CAPABILITY_DISPLAY[cap].icon
                  }}</span>
                  <span>{{ MODEL_CAPABILITY_DISPLAY[cap].label }}</span>
                </label>
              </div>
            </div>
          </div>
          <div class="hc-edit-model-dialog__actions">
            <button class="hc-btn hc-btn-secondary" @click="editingModel = null">取消</button>
            <button
              class="hc-btn hc-btn-primary"
              :disabled="!editModelForm.id.trim()"
              @click="saveEditModel"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <ConfirmDialog
    :open="pendingDeleteProviderId !== null"
    :confirmation-key="pendingDeleteProviderId"
    :title="t('settings.llm.deleteProvider')"
    :message="t('settings.llm.deleteProviderConfirm')"
    :confirm-text="t('common.delete')"
    :cancel-text="t('common.cancel')"
    @confirm="confirmDeleteProvider"
    @cancel="pendingDeleteProviderId = null"
  />

  <ConfirmDialog
    :open="pendingDeleteModel !== null"
    :confirmation-key="
      pendingDeleteModel
        ? `${pendingDeleteModel.providerId}:${pendingDeleteModel.modelId}`
        : null
    "
    :title="t('settings.llm.deleteModel')"
    :message="
      pendingDeleteModel
        ? t('settings.llm.deleteModelConfirm', { name: pendingDeleteModel.modelName })
        : ''
    "
    :confirm-text="t('common.delete')"
    :cancel-text="t('common.cancel')"
    @confirm="confirmDeleteModel"
    @cancel="pendingDeleteModel = null"
  />

  <ModelManagerModal
    v-if="modelManagerProvider"
    :open="!!modelManagerProvider"
    :provider="modelManagerProvider"
    :syncing="managerSyncing"
    @close="closeModelManager"
    @change="autoSave()"
    @resync="handleManagerResync"
  />
</template>

<style scoped>
.hc-settings {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.hc-settings__body {
  flex: 1;
  display: flex;
  overflow: hidden;
}

/* ─── Content ─────
   滚动归属：滚动条挂在「全宽内容面板」.hc-settings__content，而非内部 max-width 受限的 section。
   故 thumb 紧贴面板右缘（与顶栏「保存配置」对齐）——这是 macOS/桌面端的原生预期落点；
   内层 section 仍以 max-width 维持易读列宽并左对齐，不再背负滚动（避免滚动条悬浮在宽窗口中部）。
   scrollbar-gutter: stable 预留槽位，切换标签页时内容不因滚动条出现/隐藏而横向跳动。 */
.hc-settings__content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-gutter: stable;
  padding: 16px 24px;
}

.hc-settings__section {
  max-width: 520px;
  width: 100%;
  min-height: 100%;
  display: flex;
  flex-direction: column;
  animation: hc-fade-in 0.25s ease-out;
}

.hc-settings__section--storage {
  max-width: 600px;
  margin: 0;
  padding-right: 4px;
}

/* 自动化权限：三档卡片 + 策略矩阵需要比表单列更宽的呼吸空间 */
.hc-settings__section--automation {
  max-width: 640px;
}

.hc-settings__section-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--hc-text-primary);
  margin: 0 0 12px;
  letter-spacing: -0.01em;
  flex-shrink: 0;
}

.hc-settings__form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 12px;
}

.hc-settings__form--system {
  gap: 0;
  margin-bottom: 0;
}

.hc-settings__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.hc-settings__label {
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-secondary);
}

.hc-settings__input-group {
  position: relative;
}

.hc-settings__input-group .hc-input {
  padding-right: 36px;
}

.hc-settings__eye-btn {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  width: 24px;
  height: 24px;
  padding: 0;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s;
}

.hc-settings__eye-btn:hover {
  color: var(--hc-text-secondary);
}

.hc-settings__required {
  color: var(--hc-error);
  font-weight: 400;
  margin-left: 1px;
}

.hc-settings__optional {
  color: var(--hc-text-muted);
  font-weight: 400;
  font-size: 11px;
  margin-left: 4px;
}

.hc-settings__input--error {
  border-color: var(--hc-error) !important;
}

.hc-settings__error {
  font-size: 12px;
  color: var(--hc-error);
  margin: 0;
}

.hc-settings__slider {
  display: flex;
  align-items: center;
  gap: 12px;
}

.hc-settings__range {
  flex: 1;
  accent-color: var(--hc-accent);
  height: 4px;
}

.hc-settings__range-value {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--hc-text-muted);
  width: 28px;
  text-align: right;
}

/* ─── Toggle Row ───── */
.hc-settings__toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
  cursor: pointer;
}

.hc-settings__toggle-row--compact {
  padding: 0;
  margin-bottom: 8px;
}

.hc-settings__toggle-label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--hc-text-primary);
}

.hc-settings__toggle-desc {
  font-size: 12px;
  color: var(--hc-text-muted);
  margin: 2px 0 0;
}

/* ─── Row Layout (v2 redesign) ───── */
.hc-settings__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 44px;
  padding: 0;
  gap: 16px;
}

.hc-settings__row + .hc-settings__row {
  border-top: 1px solid var(--hc-border-subtle, var(--hc-border));
}

.hc-settings__row-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-primary);
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}

.hc-settings__row-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

/* ─── Info Tooltip ───── */
.hc-settings__info {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  font-size: 10px;
  font-weight: 700;
  font-style: normal;
  color: var(--hc-text-muted);
  border: 1px solid var(--hc-border);
  cursor: help;
  position: relative;
  flex-shrink: 0;
  transition:
    color 0.18s,
    border-color 0.18s;
}

.hc-settings__info:hover {
  color: var(--hc-text-secondary);
  border-color: var(--hc-text-muted);
}

.hc-settings__info::before {
  content: attr(data-info);
  position: absolute;
  /* 向上展开：避免滚动容器(.hc-settings__content overflow-y:auto)
     在靠近面板底部时把向下的 tooltip 裁切。 */
  bottom: calc(100% + 8px);
  left: 0;
  width: max-content;
  max-width: 240px;
  padding: 8px 12px;
  border-radius: var(--hc-radius-md);
  background: var(--hc-text-primary);
  color: var(--hc-text-inverse, #fff);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.5;
  white-space: normal;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.15s;
  z-index: 100;
  text-align: left;
}

.hc-settings__info::after {
  content: '';
  position: absolute;
  /* 三角随 tooltip 改为向上，指向下方的 `?` 图标 */
  bottom: calc(100% + 4px);
  left: 8px;
  border: 5px solid transparent;
  border-top-color: var(--hc-text-primary);
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.15s;
  z-index: 100;
}

.hc-settings__info:hover::before,
.hc-settings__info:hover::after {
  opacity: 1;
}

/* ─── Sub-option ───── */
.hc-settings__sub {
  padding-left: 18px;
  /* HIG: 1px 细边框形成 sub-option 缩进视觉 */
  border-left: 1px solid var(--hc-accent-subtle);
  margin-left: 4px;
  margin-top: -1px;
}

.hc-settings__sub .hc-settings__row {
  min-height: 40px;
  border-top: none;
}

.hc-settings__sub .hc-settings__row-label {
  font-size: 12px;
  color: var(--hc-text-secondary);
  font-weight: 450;
}

/* ─── Section Divider ───── */
.hc-settings__sep {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 24px 0 8px;
}

.hc-settings__sep:first-child {
  margin-top: 0;
}

.hc-settings__sep-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--hc-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  flex-shrink: 0;
}

.hc-settings__sep-line {
  flex: 1;
  height: 1px;
  background: var(--hc-border-subtle, var(--hc-border));
}

.hc-settings__sep-action {
  margin-left: auto;
}

/* ─── Stepper ───── */
.hc-settings__stepper {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  overflow: hidden;
  height: 28px;
}

.hc-settings__stepper input {
  width: 44px;
  height: 100%;
  border: none;
  text-align: center;
  font-size: 12px;
  color: var(--hc-text-primary);
  background: transparent;
  outline: none;
  font-variant-numeric: tabular-nums;
}

.hc-settings__stepper button {
  width: 24px;
  height: 100%;
  border: none;
  background: var(--hc-bg-hover);
  cursor: pointer;
  font-size: 13px;
  color: var(--hc-text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.18s;
}

.hc-settings__stepper button:hover {
  background: var(--hc-bg-active, var(--hc-bg-hover));
  color: var(--hc-text-primary);
}

/* ─── Custom Select ───── */
/* HcSelect 外层尺寸 wrapper —— 边框/圆角/chevron/聚焦态全部由 HcSelect 自渲染，
   这里只约束宽度（旧原生 <select> 的盒样式+背景 chevron 会与 HcSelect 自带 chevron 叠成双层，已移除）。 */
.hc-settings__select {
  width: 240px;
  max-width: 100%;
}

/* ─── Dirty Indicator ───── */
.hc-settings__dirty {
  font-size: 11px;
  color: var(--hc-accent);
  font-weight: 500;
  display: none;
}

.hc-settings__dirty--on {
  display: inline;
}

/* ─── Appearance segmented control ───── */
.hc-settings__theme-segmented {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 2px;
  height: 44px;
  margin: 6px 0 16px;
  padding: 3px;
  border: 1px solid var(--hc-border);
  border-radius: 11px;
  background: var(--hc-bg-input);
}

.hc-settings__theme-segment {
  min-width: 0;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--hc-text-muted);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.hc-settings__theme-segment:hover,
.hc-settings__theme-segment:focus-visible {
  color: var(--hc-text-primary);
  outline: none;
}

.hc-settings__theme-segment.is-selected {
  background: var(--hc-bg-elevated);
  color: var(--hc-accent);
  box-shadow: var(--hc-shadow-sm), inset 0 0 0 0.5px var(--hc-border);
}

/* ─── Info Display ───── */
.hc-settings__info-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--hc-text-primary);
  margin-bottom: 6px;
}

.hc-settings__info-card {
  border: 1px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-card);
  padding: 10px 14px;
}

.hc-settings__info-card--wide {
  grid-column: 1 / -1;
}

.hc-settings__info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 16px;
}

.hc-settings__info-grid--runtime {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.hc-settings__info-label {
  display: block;
  font-size: 11px;
  line-height: 1.5;
  color: var(--hc-text-muted);
}

.hc-settings__info-value {
  font-size: 12.5px;
  line-height: 1.35;
  color: var(--hc-text-primary);
  margin-top: 1px;
}

.hc-settings__info-value--mono {
  font-family:
    ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New',
    monospace;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  /* 纯技术值（版本/IP）强制 LTR 并 bidi 隔离：RTL（维语）下不被重排、不跟翻译文本黏连 */
  direction: ltr;
  unicode-bidi: isolate;
}

/* 内联技术 token（IP/版本/文件名等 ASCII）：等宽 + LTR 隔离，可安全嵌进 RTL 翻译文本里。
   关键：等宽字体不含维吾尔/阿拉伯连写字形，绝不能套在翻译标签上（会断字、字距拉宽）。 */
.hc-settings__info-mono {
  font-family:
    ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New',
    monospace;
  font-size: 12px;
  direction: ltr;
  unicode-bidi: isolate;
}

/* 关于分区：身份入口（一行介绍 + 蓝色链接），复用单一 /about。 */
.hc-settings__about {
  margin-top: 10px;
}
.hc-settings__about-intro {
  margin: 0 0 6px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--hc-text-secondary);
}
.hc-settings__about-emoji {
  margin-right: 0;
}
.hc-settings__about-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 12.5px;
  color: var(--hc-accent);
}
.hc-settings__about-link span {
  transition: transform 0.15s ease;
}
.hc-settings__about-link:hover {
  text-decoration: underline;
}
.hc-settings__about-link:hover span {
  transform: translateX(2px);
}
.hc-settings__about-link:active {
  opacity: 0.8;
}

/* ─── Engine ───── */
/* ─── Provider Management ───── */
.hc-settings__restart-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-radius: 10px;
  background: rgba(59, 130, 246, 0.08);
  border: 1px solid rgba(59, 130, 246, 0.2);
  margin-bottom: 10px;
  flex-shrink: 0;
}

.hc-settings__restart-text {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--hc-accent);
}

.hc-settings__restart-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.hc-provider__add-panel {
  padding: 14px;
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-card);
  border: 1px solid var(--hc-border);
  margin-bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.hc-provider__add-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.hc-provider__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.hc-provider__service-notice {
  margin: 10px 2px 0;
  color: var(--hc-text-muted);
  font-size: 11.5px;
  line-height: 1.5;
}

.hc-provider__service-notice a {
  color: var(--hc-text-secondary);
  text-decoration: none;
  white-space: nowrap;
}

.hc-provider__service-notice a:hover {
  color: var(--hc-accent);
  text-decoration: underline;
}

.hc-provider__service-notice a:focus-visible {
  border-radius: 3px;
  outline: 2px solid color-mix(in srgb, var(--hc-accent) 55%, transparent);
  outline-offset: 2px;
}

.hc-provider__card {
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-card);
  border: 1px solid var(--hc-border);
  overflow: hidden;
  container-type: inline-size;
  transition: border-color 0.15s;
}

.hc-provider__card:hover {
  border-color: var(--hc-accent-subtle);
}

.hc-provider__card--disabled {
  opacity: 0.6;
}

.hc-provider__card-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 10px 14px;
  cursor: pointer;
  user-select: none;
}

.hc-provider__card-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.hc-provider__logo {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  flex-shrink: 0;
}

.hc-provider__led {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.hc-provider__led--on {
  background: var(--hc-success);
  box-shadow: 0 0 5px color-mix(in srgb, var(--hc-success) 35%, transparent);
}

.hc-provider__led--off {
  background: var(--hc-text-muted);
  opacity: 0.4;
}

.hc-provider__card-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--hc-text-primary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hc-provider__tag {
  font-size: 10px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 3px;
  color: var(--hc-accent);
  background: var(--hc-accent-subtle);
  flex: 0 0 auto;
  white-space: nowrap;
}

.hc-provider__model-count {
  font-size: 11px;
  color: var(--hc-text-muted);
  flex: 0 0 auto;
  white-space: nowrap;
}

.hc-provider__card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 0 0 auto;
  justify-content: flex-end;
}

.hc-provider__connection-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 999px;
  color: var(--hc-text-muted);
  background: var(--hc-bg-hover);
  font-size: 11px;
  white-space: nowrap;
  transition:
    color 0.18s,
    background 0.18s;
  flex: 0 0 auto;
}

.hc-provider__connection-status--testing {
  color: var(--hc-accent);
  background: var(--hc-accent-subtle);
}

.hc-provider__connection-status--ok {
  color: var(--hc-success);
  background: color-mix(in srgb, var(--hc-success) 10%, transparent);
  animation: hc-provider-status-pop 0.22s ease-out;
}

.hc-provider__connection-status--error {
  color: var(--hc-error);
  background: color-mix(in srgb, var(--hc-error) 10%, transparent);
}

.hc-provider__connection-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.55;
}

@keyframes hc-provider-status-pop {
  from {
    transform: scale(0.96);
    opacity: 0.72;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}

.hc-provider__test-btn {
  flex: 0 0 auto;
  white-space: nowrap;
}

.hc-provider__connection-detail {
  margin: 0;
  padding: 7px 14px;
  border-top: 1px solid color-mix(in srgb, var(--hc-error) 18%, var(--hc-divider));
  color: var(--hc-error);
  background: color-mix(in srgb, var(--hc-error) 5%, transparent);
  font-size: 11px;
  line-height: 1.5;
  word-break: break-word;
}

.hc-provider__icon-btn {
  padding: 4px;
  border: none;
  background: transparent;
  cursor: pointer;
  border-radius: var(--hc-radius-sm);
  display: flex;
  flex: 0 0 auto;
  transition: background 0.15s;
}

.hc-provider__icon-btn:hover {
  background: var(--hc-bg-hover);
}

.hc-provider__power--on {
  color: var(--hc-success);
}

.hc-provider__power--off {
  color: var(--hc-text-muted);
}

.hc-provider__chevron {
  color: var(--hc-text-muted);
  flex: 0 0 auto;
}

.hc-provider__edit {
  padding: 0 14px 14px;
  border-top: 1px solid var(--hc-divider);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 12px;
  container-type: inline-size;
}

.hc-provider__config-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px 12px;
}

@container (min-width: 520px) {
  .hc-provider__config-grid--builtin {
    grid-template-columns: minmax(0, 0.72fr) minmax(0, 1fr);
  }

  .hc-provider__config-grid--custom {
    grid-template-columns: minmax(0, 0.7fr) minmax(0, 1.3fr);
  }

  .hc-provider__config-grid--custom .hc-provider__config-url {
    grid-column: 1 / -1;
  }
}

@container (min-width: 900px) {
  .hc-provider__config-grid--custom {
    grid-template-columns: minmax(150px, 0.56fr) minmax(220px, 0.82fr) minmax(280px, 1.2fr);
  }

  .hc-provider__config-grid--custom .hc-provider__config-url {
    grid-column: auto;
  }
}

.hc-provider__models {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.hc-provider__model-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: var(--hc-radius-sm);
  background: var(--hc-bg-hover);
  font-size: 12px;
}

.hc-provider__model-name {
  font-weight: 500;
  color: var(--hc-text-primary);
}

.hc-provider__model-name-input {
  font-weight: 500;
  color: var(--hc-text-primary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 2px 4px;
  font-size: 13px;
  max-width: 180px;
}

.hc-provider__model-name-input:hover,
.hc-provider__model-name-input:focus {
  border-color: var(--hc-border);
  background: var(--hc-bg-hover);
  outline: none;
}

.hc-provider__model-id {
  color: var(--hc-text-muted);
  font-family: 'SF Mono', 'Menlo', monospace;
  font-size: 11px;
  flex: 1;
}

.hc-provider__model-id-input {
  color: var(--hc-text-muted);
  font-family: 'SF Mono', 'Menlo', monospace;
  font-size: 11px;
  flex: 1;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 2px 4px;
}

.hc-provider__model-id-input:hover,
.hc-provider__model-id-input:focus {
  border-color: var(--hc-border);
  background: var(--hc-bg-hover);
  outline: none;
}

.hc-provider__model-del {
  padding: 0 4px;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  font-size: 14px;
  border-radius: 3px;
}

.hc-provider__model-del:hover {
  color: var(--hc-error);
  background: rgba(255, 69, 58, 0.1);
}

.hc-provider__add-model {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}

.hc-provider__add-model .hc-input--sm {
  font-size: 12px;
  padding: 4px 8px;
  flex: 1;
}

.hc-provider__caps-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--hc-text-muted);
}

.hc-provider__caps-label {
  font-weight: 500;
}

.hc-provider__cap-check {
  display: flex;
  align-items: center;
  gap: 3px;
  cursor: pointer;
}

.hc-provider__cap-check input {
  accent-color: var(--hc-accent);
  width: 13px;
  height: 13px;
}

.hc-provider__model-caps {
  display: flex;
  gap: 3px;
  margin-left: auto;
}

.hc-cap-tag {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: 500;
}

.hc-cap-tag--vision {
  background: color-mix(in srgb, var(--hc-success) 12%, transparent);
  color: var(--hc-success);
}

.hc-cap-tag--video {
  background: color-mix(in srgb, var(--hc-warning) 12%, transparent);
  color: var(--hc-warning);
}

.hc-cap-tag--audio {
  background: color-mix(in srgb, var(--hc-accent) 12%, transparent);
  color: var(--hc-accent);
}

.hc-provider__delete-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  padding: 5px 10px;
  border: none;
  border-radius: var(--hc-radius-sm);
  background: transparent;
  color: var(--hc-error);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
  white-space: nowrap;
}

.hc-provider__delete-btn:hover {
  background: rgba(255, 69, 58, 0.1);
}

@container (max-width: 959px) {
  .hc-provider__card-head {
    grid-template-columns: minmax(0, 1fr);
  }

  .hc-provider__card-actions {
    width: 100%;
    flex-wrap: wrap;
    justify-content: flex-start;
  }
}

.hc-btn-sm {
  font-size: 12px;
  padding: 5px 10px;
  display: flex;
  align-items: center;
  gap: 4px;
}

/* ─── Misc ───── */
.hc-settings__link {
  color: var(--hc-accent);
  text-decoration: none;
  font-size: 13px;
  font-weight: 500;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
}

.hc-settings__link:hover {
  text-decoration: underline;
}

.hc-settings__desc-text {
  font-size: 13px;
  color: var(--hc-text-secondary);
  margin-bottom: 10px;
}

.hc-settings__hint {
  font-size: 12px;
  color: var(--hc-text-muted);
}

.hc-settings__hint--error {
  color: var(--hc-error);
}

.hc-provider-destination {
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--hc-accent) 24%, var(--hc-border));
  border-radius: 10px;
  background: color-mix(in srgb, var(--hc-accent) 4%, transparent);
}

.hc-provider-destination__choices {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.hc-provider-destination__choice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--hc-border);
  border-radius: 8px;
  background: var(--hc-bg-primary);
  cursor: pointer;
}

.hc-provider-destination__choice:has(input:checked) {
  border-color: var(--hc-accent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--hc-accent) 25%, transparent);
}

.hc-provider-destination__choice input {
  margin-top: 2px;
  accent-color: var(--hc-accent);
}

.hc-provider-destination__choice span {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.hc-provider-destination__choice b {
  color: var(--hc-text-primary);
  font-size: 12px;
  font-weight: 600;
}

.hc-provider-destination__choice small {
  color: var(--hc-text-muted);
  font-size: 11px;
  line-height: 1.35;
}

@media (max-width: 560px) {
  .hc-provider-destination__choices {
    grid-template-columns: 1fr;
  }
}

.hc-settings__btn--saved {
  background: var(--hc-success, #10b981);
  color: #fff;
}

.hc-settings__btn--saved:hover {
  background: var(--hc-success, #10b981);
  filter: brightness(1.1);
}

.hc-settings :deep(.hc-toolbar__right) {
  flex-shrink: 0;
}

/* ─── Webhook ───── */
.hc-webhook__add-panel {
  padding: 14px;
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-card);
  border: 1px solid var(--hc-border);
  margin-bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.hc-webhook__type-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.hc-webhook__type-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: var(--hc-radius-sm);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-card);
  color: var(--hc-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    color 0.15s;
}

.hc-webhook__type-btn:hover {
  border-color: var(--hc-accent-subtle);
}

.hc-webhook__type-btn--active {
  font-weight: 500;
}

.hc-webhook__type-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.hc-webhook__events {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.hc-webhook__event-check {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--hc-text-secondary);
  cursor: pointer;
}

.hc-webhook__event-check input {
  accent-color: var(--hc-accent);
}

.hc-webhook__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.hc-webhook__card {
  padding: 10px 14px;
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-card);
  border: 1px solid var(--hc-border);
  transition: border-color 0.15s;
}

.hc-webhook__card:hover {
  border-color: var(--hc-accent-subtle);
}

.hc-webhook__card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hc-webhook__card-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--hc-text-primary);
}

.hc-webhook__tag {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 4px;
}

.hc-webhook__card-url {
  font-size: 11px;
  color: var(--hc-text-muted);
  font-family: 'SF Mono', 'Menlo', monospace;
  margin-top: 6px;
  word-break: break-all;
}

.hc-webhook__card-events {
  display: flex;
  gap: 4px;
  margin-top: 6px;
  flex-wrap: wrap;
}

.hc-webhook__event-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  color: var(--hc-text-secondary);
  background: var(--hc-bg-hover);
}

/* ─── 模型芯片选择 ─── */
.hc-model-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 4px;
}

.hc-model-section-actions {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 6px;
}

.hc-model-sync-hint {
  font-size: 11px;
  color: var(--hc-text-muted, #5c5c6b);
}

.hc-model-chips {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 172px), 1fr));
  gap: 6px;
}

.hc-model-chip {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  min-height: 32px;
  gap: 4px;
  padding: 5px 12px;
  border-radius: 100px;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid var(--hc-border, rgba(255, 255, 255, 0.12));
  background: var(--hc-bg-main, rgba(255, 255, 255, 0.02));
  color: var(--hc-text-secondary);
  /* HIG: 显式列出过渡属性，禁用 transition: all（性能 + 可预期性） */
  transition:
    background-color 0.15s cubic-bezier(0.16, 1, 0.3, 1),
    border-color 0.15s cubic-bezier(0.16, 1, 0.3, 1),
    color 0.15s cubic-bezier(0.16, 1, 0.3, 1);
}

.hc-model-chip__name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hc-model-chip--non-chat {
  cursor: default;
}

.hc-model-chip--custom {
  cursor: default;
}

.hc-model-chip__select {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  flex: 1;
  gap: 4px;
  padding: 0;
  border: 0;
  border-radius: var(--hc-radius-sm);
  color: inherit;
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.hc-model-chip__select:focus-visible {
  outline: 2px solid var(--hc-accent, #5fb3ea);
  outline-offset: 2px;
}

.hc-model-chip--embedding {
  border-color: color-mix(in srgb, var(--hc-accent, #5fb3ea) 34%, var(--hc-border));
}

.hc-model-chip:hover:not(.hc-model-chip--active) {
  background: var(--hc-bg-hover, rgba(255, 255, 255, 0.06));
  border-color: var(--hc-text-muted, #5c5c6b);
}

/* 删除按钮：默认隐藏，hover chip 时出现 */
.hc-model-chip__remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 2px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  font-size: 13px;
  line-height: 1;
  color: var(--hc-text-muted, #5c5c6b);
  border: 0;
  padding: 0;
  background: transparent;
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 0.15s,
    background 0.15s,
    color 0.15s;
}

.hc-model-chip:hover .hc-model-chip__remove,
.hc-model-chip--active .hc-model-chip__remove,
.hc-model-chip:focus-within .hc-model-chip__remove,
.hc-model-chip__remove:focus-visible {
  opacity: 0.6;
}

.hc-model-chip__remove:hover {
  opacity: 1 !important;
  background: color-mix(in srgb, var(--hc-error, #ff453a) 15%, transparent);
  color: var(--hc-error, #ff453a);
}

/* A7 工具调用可靠度 badge（emoji 本身自带颜色，给一个柔和着色背景）
   HIG：圆角 var(--hc-radius-sm)、字号 10、letter-spacing 微负、不用硬编码 fallback */
.hc-model-chip__reliability {
  flex: none;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: var(--hc-radius-sm);
  line-height: 1;
  letter-spacing: -0.005em;
  background: color-mix(in srgb, var(--hc-text-muted) 10%, transparent);
}
.hc-model-chip__reliability--good {
  background: color-mix(in srgb, var(--hc-success) 16%, transparent);
}
.hc-model-chip__reliability--partial {
  background: color-mix(in srgb, var(--hc-warning) 20%, transparent);
}
.hc-model-chip__reliability--bad {
  background: color-mix(in srgb, var(--hc-error) 16%, transparent);
}

/* A7 手动触发探测按钮（和 remove 同构，hover 才显形）
   HIG：弹性曲线、显式 transition、按下微缩放反馈 */
.hc-model-chip__probe {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 3px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  color: var(--hc-text-muted);
  border: 0;
  padding: 0;
  background: transparent;
  opacity: 0;
  cursor: pointer;
  transition:
    opacity 140ms cubic-bezier(0.25, 0.1, 0.25, 1),
    background 140ms cubic-bezier(0.25, 0.1, 0.25, 1),
    color 140ms cubic-bezier(0.25, 0.1, 0.25, 1),
    transform 140ms cubic-bezier(0.25, 0.1, 0.25, 1);
}
.hc-model-chip:hover .hc-model-chip__probe,
.hc-model-chip--active .hc-model-chip__probe,
.hc-model-chip:focus-within .hc-model-chip__probe {
  opacity: 0.6;
}
.hc-model-chip__probe:hover {
  opacity: 1 !important;
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  transform: scale(1.08);
}
.hc-model-chip__probe:active {
  transform: scale(0.92);
}

.hc-model-chip--active {
  border-color: var(--hc-accent, #5fb3ea);
  background: color-mix(in srgb, var(--hc-accent, #5fb3ea) 10%, transparent);
  color: var(--hc-accent, #5fb3ea);
  font-weight: 500;
}

.hc-model-chip--add {
  border-style: dashed;
  color: var(--hc-text-muted, #5c5c6b);
}

.hc-model-chip--add:hover {
  color: var(--hc-accent, #5fb3ea);
  border-color: var(--hc-accent, #5fb3ea);
  background: color-mix(in srgb, var(--hc-accent, #5fb3ea) 5%, transparent);
}

/* 管理模型入口：目录/启用两层架构的主入口（聚合商数百模型场景） */
.hc-model-chip--manage {
  position: relative;
  min-height: 26px;
  padding: 3px 10px;
  border-style: dashed;
  border-color: var(--hc-accent, #5fb3ea);
  color: var(--hc-accent, #5fb3ea);
  white-space: nowrap;
}

.hc-model-chip--manage:hover {
  background: var(--hc-accent-subtle);
  border-color: var(--hc-accent, #5fb3ea);
}

.hc-model-chip__new-dot {
  position: absolute;
  top: -3px;
  right: -3px;
  width: 7px;
  height: 7px;
  border: 1.5px solid var(--hc-bg-panel);
  border-radius: 50%;
  background: var(--hc-accent, #5fb3ea);
}

/* 已启用摘要（目录存在时显示"已启用 N / M 可用"） */
.hc-model-enabled-summary {
  font-size: 11px;
  color: var(--hc-text-secondary, #8b95a2);
}

.hc-model-enabled-summary b {
  color: var(--hc-text-primary, #e8ecf0);
  font-weight: 600;
}

/* 免费模型：目录价格元数据为 0 时显示 */
.hc-model-chip__free-label {
  flex: none;
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: 500;
  background: color-mix(in srgb, var(--hc-success, #32d583) 14%, transparent);
  color: var(--hc-success, #32d583);
  white-space: nowrap;
}

/* 上游已下架：橙色警示，不静默删除，由用户处置 */
.hc-model-chip--stale {
  border-color: var(--hc-warning, #f0b429);
  background: color-mix(in srgb, var(--hc-warning, #f0b429) 8%, transparent);
}

.hc-model-chip__stale-label {
  flex: none;
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: 500;
  background: color-mix(in srgb, var(--hc-warning, #f0b429) 16%, transparent);
  color: var(--hc-warning, #f0b429);
  white-space: nowrap;
}

.hc-model-chip__cap {
  flex: none;
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: 500;
  white-space: nowrap;
}

.hc-model-chip__cap--vision {
  background: color-mix(in srgb, var(--hc-success, #34c759) 12%, transparent);
  color: var(--hc-success, #34c759);
}

.hc-model-chip__cap--video {
  background: color-mix(in srgb, var(--hc-warning, #ff9f0a) 12%, transparent);
  color: var(--hc-warning, #ff9f0a);
}

.hc-model-chip__cap--audio {
  background: color-mix(in srgb, var(--hc-accent, #5fb3ea) 12%, transparent);
  color: var(--hc-accent, #5fb3ea);
}

.hc-model-chip__cap--code {
  background: color-mix(in srgb, var(--hc-text-secondary) 12%, transparent);
  color: var(--hc-text-secondary);
}

.hc-model-chip__cap--text {
  background: color-mix(in srgb, var(--hc-text-muted) 14%, transparent);
  color: var(--hc-text-secondary);
}

.hc-model-chip__cap--image_generation {
  background: color-mix(in srgb, #ec4899 14%, transparent);
  color: #ec4899;
}

.hc-model-chip__cap--video_generation {
  background: color-mix(in srgb, #f59e0b 14%, transparent);
  color: #f59e0b;
}

.hc-model-chip__cap--embedding {
  background: color-mix(in srgb, var(--hc-accent, #5fb3ea) 14%, transparent);
  color: var(--hc-accent, #5fb3ea);
}

.hc-custom-model-dialog__capability {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.hc-custom-model-dialog__capability legend {
  margin-bottom: 6px;
}

/* ─── 编辑模型 Modal ─── */
.hc-dialog-overlay {
  position: fixed;
  top: var(--hc-titlebar-height);
  left: 0;
  right: 0;
  bottom: 0;
  z-index: var(--hc-z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.hc-dialog-enter-active {
  transition: opacity 0.2s ease-out;
}
.hc-dialog-leave-active {
  transition: opacity 0.15s ease-in;
}
.hc-dialog-enter-from,
.hc-dialog-leave-to {
  opacity: 0;
}

.hc-edit-model-dialog {
  width: 100%;
  max-width: 420px;
  border-radius: var(--hc-radius-xl);
  background: var(--hc-bg-elevated);
  border: 1px solid var(--hc-border);
  box-shadow: var(--hc-shadow-float);
  padding: 24px;
  animation: hc-scale-in 0.2s cubic-bezier(0.25, 0.1, 0.25, 1);
}

.hc-edit-model-dialog__header {
  margin-bottom: 20px;
}

.hc-edit-model-dialog__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--hc-text-primary);
  margin: 0;
}

.hc-edit-model-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}

.hc-edit-model {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.hc-edit-model__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.hc-edit-model__field label {
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-secondary);
}

.hc-edit-model__caps {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.hc-edit-model__cap-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--hc-border, rgba(255, 255, 255, 0.08));
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}

.hc-edit-model__cap-item:hover {
  background: var(--hc-bg-hover, rgba(255, 255, 255, 0.04));
}

.hc-edit-model__cap-item input {
  accent-color: var(--hc-accent, #5fb3ea);
}

.hc-edit-model__cap-icon {
  font-size: 16px;
}

@media (max-width: 1100px) {
  .hc-settings__content {
    padding: 14px 18px;
  }
}

@media (max-width: 880px) {
  .hc-settings :deep(.hc-toolbar) {
    gap: 8px;
    padding: 0 10px;
  }

  .hc-settings :deep(.hc-toolbar__left) {
    gap: 8px;
  }

  .hc-settings :deep(.hc-toolbar__right) {
    gap: 6px;
  }

  .hc-settings__theme-grid {
    grid-template-columns: 1fr;
  }

  .hc-settings__info-grid {
    grid-template-columns: 1fr;
    gap: 10px;
  }

  .hc-settings__info-grid--runtime {
    grid-template-columns: 1fr;
  }
}
</style>
