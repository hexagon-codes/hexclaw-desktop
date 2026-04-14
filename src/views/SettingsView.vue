<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Key,
  Palette,
  Eye,
  EyeOff,
  Plus,
  Trash2,
  ChevronDown,
  ChevronUp,
  Power,
  Loader2,
  CheckCircle,
  XCircle,
  Zap,
  RotateCcw,
} from 'lucide-vue-next'
import { useSettingsStore } from '@/stores/settings'
import { getRuntimeConfig } from '@/api/settings'
import { getLLMConfig, testLLMConnection, fetchProviderModels } from '@/api/config'
import {
  getBudgetStatus,
  getToolCacheStats,
  getToolMetrics,
  getToolPermissions,
} from '@/api/tools-status'
import type {
  BudgetStatus,
  ToolCacheStats,
  ToolMetrics,
  ToolPermissions,
} from '@/api/tools-status'
import { messageFromUnknownError } from '@/utils/errors'
import { logger } from '@/utils/logger'
import { useTheme, type ThemeMode } from '@/composables/useTheme'
import { setLocale } from '@/i18n'
import { PROVIDER_PRESETS, PROVIDER_LOGOS } from '@/config/providers'
import { OLLAMA_BASE } from '@/config/env'
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
import OllamaCard from '@/components/settings/OllamaCard.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const { t } = useI18n()
const settingsStore = useSettingsStore()
const { themeMode, setTheme } = useTheme()
const activeSection = ref('llm')
const saved = ref(false)

// Provider 编辑状态
const editingProviderId = ref<string | null>(null)
const showApiKeys = ref<Record<string, boolean>>({})
const showAddProvider = ref(false)
const addProviderType = ref<ProviderType>('openai')

// 自定义模型输入
const newModelId = ref('')
const newModelName = ref('')
const newModelCaps = ref<Record<ModelCapability, boolean>>({
  text: true,
  vision: false,
  video: false,
  audio: false,
  code: false,
  image_generation: false,
  video_generation: false,
})
const showAddModelPanel = ref(false)

// 编辑模型 Modal
const editingModel = ref<{ providerId: string; idx: number; model: ModelOption } | null>(null)
const editModelOverlayRef = ref<HTMLDivElement | null>(null)
watch(editingModel, (v) => { if (v) nextTick(() => editModelOverlayRef.value?.focus()) })
const editModelForm = ref<{ name: string; id: string; caps: Record<ModelCapability, boolean> }>({
  name: '',
  id: '',
  caps: { text: true, vision: false, video: false, audio: false, code: false, image_generation: false, video_generation: false },
})
const pendingDeleteProviderId = ref<string | null>(null)
const pendingDeleteModel = ref<{ providerId: string; modelId: string; modelName: string } | null>(
  null,
)
const runtimeConfig = ref<BackendRuntimeConfig | null>(null)
const runtimeLLMConfig = ref<BackendLLMConfig | null>(null)
const appVersion = ref('—')

// Load desktop app version from Tauri
onMounted(() => {
  import('@tauri-apps/api/app').then(({ getVersion }) =>
    getVersion().then((v) => (appVersion.value = 'v' + v)),
  ).catch(() => {})
})
const runtimeInfoLoading = ref(false)
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null
let autoSavePromise: Promise<void> | null = null
let hasPendingAutoSave = false
let unlistenCloseRequested: (() => void) | null = null
let closingAfterFlush = false

const sections = computed(() => [
  { key: 'llm', label: t('settings.llm.title'), icon: Key },
  { key: 'system', label: t('settings.system.title'), icon: Palette },
])

function handleLocaleChange(locale: string) {
  setLocale(locale as 'zh-CN' | 'en')
}

function handleThemeSelect(mode: ThemeMode) {
  setTheme(mode)
  autoSave()
}

function handleRoutingToggle() {
  if (!config.value) return
  config.value.llm.routing = {
    enabled: config.value.llm.routing?.enabled ?? false,
    strategy: config.value.llm.routing?.strategy || 'cost-aware',
  }
  autoSave()
}

function handleRoutingStrategyChange() {
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

const nonOllamaProviders = computed(() =>
  config.value?.llm.providers.filter((p) => p.type !== 'ollama') ?? [],
)

function isDesktopRuntime() {
  return !!(globalThis as Record<string, unknown>).isTauri
}

function hasUnsavedChanges() {
  return hasPendingAutoSave || autoSaveTimer !== null || !!newModelId.value.trim()
}

function resetPendingModelDraft() {
  newModelId.value = ''
  newModelName.value = ''
  newModelCaps.value = { text: true, vision: false, video: false, audio: false, code: false }
}

function commitPendingModelDraft() {
  if (!settingsStore.config || !newModelId.value.trim() || !editingProviderId.value) return

  const provider = settingsStore.config.llm.providers.find((p) => p.id === editingProviderId.value)
  if (!provider) return

  const caps = (Object.entries(newModelCaps.value) as [ModelCapability, boolean][])
    .filter(([, v]) => v)
    .map(([k]) => k)
  const pendingModel: ModelOption = {
    id: newModelId.value.trim(),
    name: newModelName.value.trim() || newModelId.value.trim(),
    isCustom: true,
    capabilities: caps.length > 0 ? caps : ['text'],
  }
  settingsStore.updateProvider(provider.id, {
    models: [...provider.models, pendingModel],
    selectedModelId: provider.selectedModelId || pendingModel.id,
  })
  resetPendingModelDraft()
}

async function persistSettings({
  showSavedFeedback = false,
  refreshRuntimeInfo = false,
}: {
  showSavedFeedback?: boolean
  refreshRuntimeInfo?: boolean
} = {}) {
  if (!settingsStore.config) return

  commitPendingModelDraft()
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

  const shouldSave = force || hasPendingAutoSave || !!newModelId.value.trim()
  if (!shouldSave) {
    if (autoSavePromise) {
      await autoSavePromise
    }
    return
  }
  if (!settingsStore.config) return
  if (autoSavePromise) {
    await autoSavePromise
    return
  }

  hasPendingAutoSave = false
  isDirty.value = false
  autoSavePromise = persistSettings({ showSavedFeedback, refreshRuntimeInfo })
  try {
    await autoSavePromise
  } catch (e) {
    hasPendingAutoSave = true
    isDirty.value = true
    throw e
  } finally {
    autoSavePromise = null
  }
}

function handleBeforeUnload() {
  if (!hasUnsavedChanges()) return
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


onMounted(async () => {
  // settings 页面被路由守卫豁免，config 可能尚未加载
  await settingsStore.loadConfig()

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', handleBeforeUnload)
  }

  if (isDesktopRuntime()) {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const appWindow = getCurrentWindow()
      unlistenCloseRequested = await appWindow.onCloseRequested(async (event) => {
        if (closingAfterFlush || !hasUnsavedChanges()) return

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
  if (hasUnsavedChanges()) {
    void flushAutoSave({ force: true })
  }
  if (typeof window !== 'undefined') {
    window.removeEventListener('beforeunload', handleBeforeUnload)
  }
  unlistenCloseRequested?.()
  unlistenCloseRequested = null
  editingModel.value = null
  showAddModelPanel.value = false
  pendingDeleteProviderId.value = null
  pendingDeleteModel.value = null
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer)
    autoSaveTimer = null
  }
  editingProviderId.value = null
})

watch(activeSection, (val) => {
  if (val === 'system') {
    loadRuntimeInfo()
  }
  if (val === 'status' && statusExpanded.value && !budgetStatus.value && !statusError.value) {
    loadSystemStatus()
  }
})

// 切换编辑的 Provider 时重置模型添加面板
watch(editingProviderId, () => {
  showAddModelPanel.value = false
  resetPendingModelDraft()
})

const config = computed(() => settingsStore.config)
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
const selectedDefaultModelValue = computed({
  get() {
    const llmConfig = config.value?.llm
    if (!llmConfig?.defaultModel) return ''
    const providerId =
      llmConfig.defaultProviderId ||
      defaultModelOptions.value.find((option) => option.modelId === llmConfig.defaultModel)?.providerId ||
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
  () => `${runtimeConfig.value?.server.host || '127.0.0.1'}:${runtimeConfig.value?.server.port || '—'}`,
)
const runtimeLocalStoreFile = 'data.db'
const runtimeModeShort = computed(() => {
  const rawMode = runtimeConfig.value?.server.mode?.trim()?.toLowerCase()
  if (!rawMode) return ''
  switch (rawMode) {
    case 'desktop': return t('settings.storage.modeDesktop', '桌面模式')
    case 'production': return t('settings.storage.modeProduction', '生产模式')
    case 'development': return t('settings.storage.modeDevelopment', '开发模式')
    default: return rawMode
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

// ─── 系统状态 (Status) ────────────────────────────────
const statusExpanded = ref(false)
const statusLoading = ref(false)
const budgetStatus = ref<BudgetStatus | null>(null)
const toolCacheStats = ref<ToolCacheStats | null>(null)
const toolMetrics = ref<ToolMetrics | null>(null)
const toolPermissions = ref<ToolPermissions | null>(null)
const statusError = ref('')

async function loadSystemStatus() {
  if (statusLoading.value) return
  statusLoading.value = true
  statusError.value = ''
  try {
    const [budget, cache, metrics, permissions] = await Promise.all([
      getBudgetStatus(),
      getToolCacheStats(),
      getToolMetrics(),
      getToolPermissions(),
    ])
    budgetStatus.value = budget
    toolCacheStats.value = cache
    toolMetrics.value = metrics
    toolPermissions.value = permissions
  } catch (e) {
    statusError.value = messageFromUnknownError(e)
  } finally {
    statusLoading.value = false
  }
}

function toggleStatusSection() {
  statusExpanded.value = !statusExpanded.value
  if (statusExpanded.value && !budgetStatus.value && !statusError.value) {
    loadSystemStatus()
  }
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function formatDuration(value: string | number): string {
  if (typeof value === 'string') return value
  if (value < 60) return `${value.toFixed(0)}s`
  if (value < 3600) return `${(value / 60).toFixed(1)}m`
  return `${(value / 3600).toFixed(1)}h`
}

function formatCost(value: number): string {
  return `$${value.toFixed(4)}`
}

const topToolsByUsage = computed(() => {
  if (!toolMetrics.value?.tools) return []
  return [...toolMetrics.value.tools]
    .sort((a, b) => b.call_count - a.call_count)
    .slice(0, 10)
})

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
    ? JSON.parse(JSON.stringify(settingsStore.config.llm.providers)) as typeof settingsStore.config.llm.providers
    : null
  const prevEditingId = editingProviderId.value

  settingsStore.removeProvider(id)
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

/** 添加自定义模型到 Provider */
function addCustomModel(provider: ProviderConfig) {
  if (!newModelId.value.trim()) return
  const caps = (Object.entries(newModelCaps.value) as [ModelCapability, boolean][])
    .filter(([, v]) => v)
    .map(([k]) => k)
  const model: ModelOption = {
    id: newModelId.value.trim(),
    name: newModelName.value.trim() || newModelId.value.trim(),
    isCustom: true,
    capabilities: caps.length > 0 ? caps : ['text'],
  }
  settingsStore.updateProvider(provider.id, {
    models: [...provider.models, model],
  })
  resetPendingModelDraft()
  autoSave()
}

function handleAddCustomModel(provider: ProviderConfig) {
  addCustomModel(provider)
  showAddModelPanel.value = false
}

function handleProviderModelChange(provider: ProviderConfig) {
  settingsStore.updateProvider(provider.id, {
    selectedModelId: provider.selectedModelId || provider.models[0]?.id || '',
  })
  autoSave()
}

/** 删除模型 */
function removeModel(provider: ProviderConfig, modelId: string) {
  settingsStore.updateProvider(provider.id, {
    models: provider.models.filter((m) => m.id !== modelId),
  })
  autoSave()
}

function confirmDeleteModel() {
  const target = pendingDeleteModel.value
  pendingDeleteModel.value = null
  if (!target) return

  const provider = settingsStore.config?.llm.providers.find((p) => p.id === target.providerId)
  if (!provider) return

  removeModel(provider, target.modelId)
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
      provider.selectedModelId === previousModelId ? editModelForm.value.id : provider.selectedModelId,
  })
  editingModel.value = null
  autoSave()
}

// ─── Provider 连接测试 ────────────────────────────────
const testingProviderId = ref<string | null>(null)
const testProviderResult = ref<Record<string, { ok: boolean; msg: string }>>({})
const autoTestTimers: Record<string, ReturnType<typeof setTimeout>> = {}

/** API Key 变化后自动测试连接 + 拉取模型（防抖 1.5s） */
function scheduleAutoTest(provider: ProviderConfig) {
  if (autoTestTimers[provider.id]) clearTimeout(autoTestTimers[provider.id])
  // 清空旧结果，显示"待验证"状态
  delete testProviderResult.value[provider.id]
  const apiKey = provider.apiKey?.trim() || ''
  if (!apiKey || provider.type === 'ollama') return
  autoTestTimers[provider.id] = setTimeout(() => {
    testProvider(provider)
  }, 1500)
}

async function testProvider(provider: ProviderConfig) {
  testingProviderId.value = provider.id
  delete testProviderResult.value[provider.id]

  const selectedModelId = (provider.selectedModelId || provider.models?.[0]?.id || '').trim()
  if (!selectedModelId) {
    testProviderResult.value[provider.id] = {
      ok: false,
      msg: t('settings.llm.testNeedsModel'),
    }
    testingProviderId.value = null
    return
  }

  const needsApiKey = provider.type !== 'ollama'
  if (needsApiKey && !provider.apiKey?.trim()) {
    testProviderResult.value[provider.id] = {
      ok: false,
      msg: t('settings.llm.testNeedsApiKey'),
    }
    testingProviderId.value = null
    return
  }

  try {
    const preset = PROVIDER_PRESETS[provider.type]
    const result = await testLLMConnection({
      provider: {
        type: provider.type,
        api_key: provider.apiKey?.trim() ?? '',
        base_url: provider.baseUrl || preset?.defaultBaseUrl || '',
        model: selectedModelId,
      },
    })
    testProviderResult.value[provider.id] = {
      ok: result.ok,
      msg:
        result.message ||
        (result.ok ? t('settings.llm.connectionOk') : t('settings.llm.connectionFailed')),
    }
    // 连接成功后自动拉取远程模型列表（Ollama 由 syncOllamaModels 处理）
    if (result.ok && provider.type !== 'ollama') {
      syncRemoteModels(provider)
    }
  } catch (e) {
    testProviderResult.value[provider.id] = {
      ok: false,
      msg: messageFromUnknownError(e),
    }
  } finally {
    testingProviderId.value = null
  }
}

/** 连接成功后，从 Provider 动态拉取可用模型列表，与预设合并 */
async function syncRemoteModels(provider: ProviderConfig) {
  const preset = PROVIDER_PRESETS[provider.type]
  const baseUrl = provider.baseUrl || preset?.defaultBaseUrl || ''
  const apiKey = provider.apiKey?.trim() || ''
  if (!baseUrl) return
  try {
    const remoteModels = await fetchProviderModels(baseUrl, apiKey)
    if (!remoteModels.length) return
    // 合并：远程模型为主，保留预设中的 capabilities 信息
    const presetMap = new Map((preset?.defaultModels ?? []).map(m => [m.id, m]))
    const existingMap = new Map(provider.models.map(m => [m.id, m]))
    const merged: typeof provider.models = []
    for (const rm of remoteModels) {
      const existing = existingMap.get(rm.id) || presetMap.get(rm.id)
      merged.push({
        id: rm.id,
        name: rm.name || rm.id,
        capabilities: existing?.capabilities ?? ['text'],
        isCustom: existing?.isCustom,
      })
    }
    provider.models = merged
    // 若当前选中模型不在新列表中，自动选第一个
    if (!merged.some(m => m.id === provider.selectedModelId) && merged.length) {
      provider.selectedModelId = merged[0]!.id
    }
    autoSave()
  } catch (e) {
    logger.warn('[Settings] 拉取远程模型列表失败（不影响使用）:', e)
  }
}

/** 自动保存（防抖） */
function autoSave() {
  hasPendingAutoSave = true
  isDirty.value = true
  if (autoSaveTimer) clearTimeout(autoSaveTimer)
  autoSaveTimer = setTimeout(async () => {
    try {
      await flushAutoSave()
    } catch (e) {
      logger.error('[HexClaw] 自动保存失败:', e)
    }
  }, 500)
}

async function onToolbarReset() {
  if (!settingsStore.config) return
  try {
    await settingsStore.loadConfig({ force: true })
    saved.value = false
  } catch (e) {
    logger.error('[HexClaw] Reset failed:', e)
  }
}

async function saveConfig() {
  try {
    await flushAutoSave({
      force: true,
      showSavedFeedback: true,
      refreshRuntimeInfo: activeSection.value === 'system',
    })
  } catch (e) {
    logger.error('保存配置失败:', e)
  }
}
</script>

<template>
  <div class="hc-settings">
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
          :class="{ 'hc-settings__btn--saved': saved }"
          :disabled="!hasUnsavedChanges() && !saved"
          @click="saveConfig"
        >
          <CheckCircle v-if="saved" :size="14" />
          {{ saved ? t('common.saved') : t('settings.toolbar.saveSettings', '保存') }}
          <span class="hc-settings__dirty" :class="{ 'hc-settings__dirty--on': isDirty }">· 未保存</span>
        </button>
      </template>
    </PageToolbar>

    <div class="hc-settings__body">
      <div class="hc-settings__content">
        <LoadingState v-if="settingsStore.loading && !config" />

        <template v-if="config">
          <!-- LLM Providers -->
          <div
            v-if="activeSection === 'llm'"
            class="hc-settings__section hc-settings__section--scroll"
            style="max-width: 600px"
          >
            <!-- ── 默认行为 ── -->
            <div class="hc-settings__sep">
              <span class="hc-settings__sep-label">默认行为</span>
              <span class="hc-settings__sep-line"></span>
            </div>

            <div class="hc-settings__row">
              <span class="hc-settings__row-label">
                {{ t('settings.llm.defaultModel') }}
                <span class="hc-settings__info" :data-info="t('settings.llm.defaultModelHint')">?</span>
              </span>
              <div class="hc-settings__row-right">
                <select
                  v-model="selectedDefaultModelValue"
                  data-testid="llm-default-model-select"
                  class="hc-settings__select"
                  :disabled="defaultModelOptions.length === 0"
                >
                  <option value="">{{ t('settings.llm.noEnabledModels') }}</option>
                  <option v-for="option in defaultModelOptions" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </option>
                </select>
              </div>
            </div>

            <!-- Routing: toggle + select (策略仅在开启时显示) -->
            <div class="hc-settings__row">
              <span class="hc-settings__row-label">
                {{ t('settings.llm.routingEnabled') }}
                <span class="hc-settings__info" data-info="开启后，未指定模型的请求将根据偏好策略自动选择最优模型。">?</span>
              </span>
              <div class="hc-settings__row-right">
                <select
                  v-if="config.llm.routing?.enabled"
                  v-model="config.llm.routing!.strategy"
                  data-testid="llm-routing-strategy-select"
                  class="hc-settings__select"
                  @change="handleRoutingStrategyChange"
                >
                  <option v-for="option in routingStrategyOptions" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </option>
                </select>
                <input
                  v-model="config.llm.routing!.enabled"
                  data-testid="llm-routing-toggle"
                  type="checkbox"
                  class="hc-toggle"
                  @change="handleRoutingToggle"
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
                <span class="hc-settings__info" data-info="开启后模型可使用已安装的 Skill 和 MCP 工具完成搜索、计算等操作。本地小模型建议关闭。">?</span>
              </span>
              <div class="hc-settings__row-right">
                <input
                  type="checkbox"
                  class="hc-toggle"
                  :checked="(config.llm.tools?.enabled ?? 'auto') !== 'off'"
                  @change="(e: Event) => {
                    const on = (e.target as HTMLInputElement).checked
                    config!.llm.tools = { enabled: on ? 'auto' : 'off', maxTools: config!.llm.tools?.maxTools ?? 0 }
                    autoSave()
                  }"
                />
              </div>
            </div>

            <div v-if="(config.llm.tools?.enabled ?? 'auto') !== 'off'" class="hc-settings__sub">
              <div class="hc-settings__row">
                <span class="hc-settings__row-label">
                  {{ t('settings.llm.maxToolsLabel') }}
                  <span class="hc-settings__info" data-info="限制单次对话注入的工具数量。0 表示不限制，小模型建议 3–5。">?</span>
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
              <button class="hc-btn hc-btn-sm hc-settings__sep-action" @click="showAddProvider = !showAddProvider">
                <Plus :size="14" />
                {{ t('settings.llm.addProvider') }}
              </button>
            </div>

            <!-- 添加 Provider 面板 -->
            <div v-if="showAddProvider" class="hc-provider__add-panel">
              <label class="hc-settings__label">{{ t('settings.llm.selectProvider') }}</label>
              <ProviderSelect v-model="addProviderType" />
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
            <OllamaCard @associate="handleAssociateOllama" @toggle-provider="handleToggleOllamaProvider" />

            <!-- Provider 列表 -->
            <div
              v-if="nonOllamaProviders.length === 0 && !showAddProvider"
              class="hc-provider__empty"
            >
              <p class="hc-provider__empty-title">{{ t('settings.llm.noProviders') }}</p>
              <p class="hc-provider__empty-desc">{{ t('settings.llm.noProvidersDesc') }}</p>
            </div>

            <div class="hc-provider__list">
              <div
                v-for="provider in nonOllamaProviders"
                :key="provider.id"
                class="hc-provider__card"
                :class="{ 'hc-provider__card--disabled': !provider.enabled }"
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
                    <button
                      class="hc-provider__icon-btn"
                      title="测试连接"
                      :disabled="testingProviderId === provider.id"
                      @click.stop="testProvider(provider)"
                    >
                      <Loader2
                        v-if="testingProviderId === provider.id"
                        :size="14"
                        class="animate-spin"
                        style="color: var(--hc-text-muted)"
                      />
                      <CheckCircle
                        v-else-if="testProviderResult[provider.id]?.ok"
                        :size="14"
                        style="color: var(--hc-success)"
                      />
                      <XCircle
                        v-else-if="
                          testProviderResult[provider.id] && !testProviderResult[provider.id]!.ok
                        "
                        :size="14"
                        style="color: var(--hc-error)"
                      />
                      <Zap v-else :size="14" style="color: var(--hc-text-muted)" />
                    </button>
                    <button
                      class="hc-provider__icon-btn"
                      :title="
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
                  <div class="hc-settings__field">
                    <label class="hc-settings__label"
                      >{{ t('settings.llm.provider') }}
                      <span class="hc-settings__required">*</span></label
                    >
                    <input
                      v-model="provider.name"
                      type="text"
                      class="hc-input"
                      @input="autoSave()"
                    />
                  </div>

                  <div v-if="provider.type !== 'ollama'" class="hc-settings__field">
                    <label class="hc-settings__label"
                      >{{ t('settings.llm.apiKey') }}
                      <span class="hc-settings__required">*</span></label
                    >
                    <div class="hc-settings__input-group">
                      <input
                        v-model="provider.apiKey"
                        :type="showApiKeys[provider.id] ? 'text' : 'password'"
                        class="hc-input"
                        :placeholder="PROVIDER_PRESETS[provider.type]?.placeholder || 'API Key'"
                        @input="autoSave(); scheduleAutoTest(provider)"
                      />
                      <button
                        class="hc-settings__eye-btn"
                        @click="showApiKeys[provider.id] = !showApiKeys[provider.id]"
                      >
                        <Eye v-if="!showApiKeys[provider.id]" :size="15" />
                        <EyeOff v-else :size="15" />
                      </button>
                    </div>
                  </div>

                  <div class="hc-settings__field">
                    <label class="hc-settings__label"
                      >{{ t('settings.llm.baseUrl') }}
                      <span class="hc-settings__required">*</span></label
                    >
                    <input
                      v-model="provider.baseUrl"
                      type="text"
                      class="hc-input"
                      :placeholder="PROVIDER_PRESETS[provider.type]?.defaultBaseUrl"
                      @input="autoSave()"
                    />
                    <p v-if="provider.type === 'ollama'" class="hc-settings__hint">
                      {{ t('settings.llm.ollamaBaseUrlHint', '本地 Ollama 服务地址，默认端口 11434。如需修改端口，请同步修改此地址。') }}
                    </p>
                  </div>

                  <!-- 模型选择（芯片式） -->
                  <div class="hc-settings__field">
                    <div class="hc-model-section-header">
                      <label class="hc-settings__label">{{ t('settings.llm.models') }} <span class="hc-settings__required">*</span></label>
                      <span v-if="testProviderResult[provider.id]?.ok" class="hc-model-sync-hint">
                        {{ t('settings.llm.modelsDynamic', '动态获取') }} · {{ t('settings.llm.justSynced', '刚刚同步') }}
                      </span>
                      <span v-else-if="provider.models.length > 0" class="hc-model-sync-hint">
                        {{ t('settings.llm.modelsPreset', '预设模型') }}
                      </span>
                    </div>
                    <div class="hc-model-chips">
                      <button
                        v-for="model in provider.models"
                        :key="model.id"
                        class="hc-model-chip"
                        :class="{ 'hc-model-chip--active': provider.selectedModelId === model.id }"
                        @click="provider.selectedModelId = model.id; handleProviderModelChange(provider)"
                      >
                        {{ model.name || model.id }}
                        <span
                          v-for="cap in (model.capabilities || []).filter((c: string) => c !== 'text')"
                          :key="cap"
                          class="hc-model-chip__cap"
                          :class="`hc-model-chip__cap--${cap}`"
                        >{{ { vision: '视觉', video: '视频', audio: '音频', code: '代码', image_generation: '绘图', video_generation: '视频生成' }[cap] || cap }}</span>
                      </button>
                      <!-- 添加自定义模型 -->
                      <button
                        v-if="!showAddModelPanel"
                        class="hc-model-chip hc-model-chip--add"
                        @click="showAddModelPanel = true"
                      >
                        <Plus :size="11" /> {{ t('settings.llm.customModel', '自定义') }}
                      </button>
                    </div>
                    <!-- 添加自定义模型表单（内联） -->
                    <div v-if="showAddModelPanel" class="hc-model-add-inline">
                      <input
                        v-model="newModelId"
                        type="text"
                        class="hc-input hc-input--sm"
                        placeholder="模型 ID（如 gpt-4o）"
                        @keyup.enter="newModelId.trim() && handleAddCustomModel(provider)"
                        @keyup.escape="showAddModelPanel = false"
                      />
                      <button
                        class="hc-btn hc-btn-primary hc-btn-sm"
                        :disabled="!newModelId.trim()"
                        @click="handleAddCustomModel(provider)"
                      >
                        <Plus :size="12" /> {{ t('common.add', '添加') }}
                      </button>
                      <button class="hc-btn hc-btn-sm" @click="showAddModelPanel = false">
                        {{ t('common.cancel', '取消') }}
                      </button>
                    </div>
                  </div>

                  <!-- 测试连接 -->
                  <div class="hc-provider__test-row">
                    <button
                      class="hc-btn hc-btn-sm"
                      :disabled="testingProviderId === provider.id"
                      @click="testProvider(provider)"
                    >
                      <Loader2
                        v-if="testingProviderId === provider.id"
                        :size="13"
                        class="animate-spin"
                      />
                      <Zap v-else :size="13" />
                      {{ testingProviderId === provider.id ? '测试中...' : '测试连接' }}
                    </button>
                    <span
                      v-if="testProviderResult[provider.id]"
                      class="hc-provider__test-badge"
                      :class="
                        testProviderResult[provider.id]!.ok
                          ? 'hc-provider__test-badge--ok'
                          : 'hc-provider__test-badge--err'
                      "
                    >
                      <CheckCircle v-if="testProviderResult[provider.id]!.ok" :size="12" />
                      <XCircle v-else :size="12" />
                      {{ testProviderResult[provider.id]!.msg }}
                    </span>
                  </div>

                  <div class="hc-provider__edit-footer">
                    <button
                      class="hc-provider__delete-btn"
                      @click="openDeleteProviderConfirm(provider.id)"
                    >
                      <Trash2 :size="13" />
                      {{ t('settings.llm.deleteProvider') }}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- System (merged: appearance + storage) -->
          <div v-else-if="activeSection === 'system'" class="hc-settings__section">
            <h3 class="hc-settings__section-title">{{ t('settings.system.title') }}</h3>

            <div class="hc-settings__form">
              <div class="hc-settings__field">
                <label class="hc-settings__label">{{ t('settings.appearance.themeMode') }}</label>
                <div class="hc-settings__theme-grid">
                  <button
                    v-for="opt in [
                      {
                        key: 'light' as ThemeMode,
                        label: t('settings.appearance.light'),
                        desc: t('settings.appearance.lightDesc'),
                      },
                      {
                        key: 'dark' as ThemeMode,
                        label: t('settings.appearance.dark'),
                        desc: t('settings.appearance.darkDesc'),
                      },
                      {
                        key: 'system' as ThemeMode,
                        label: t('settings.appearance.system'),
                        desc: t('settings.appearance.systemDesc'),
                      },
                    ]"
                    :key="opt.key"
                    class="hc-settings__theme-card"
                    :class="{ 'hc-settings__theme-card--active': themeMode === opt.key }"
                    @click="handleThemeSelect(opt.key)"
                  >
                    <div class="hc-settings__theme-label">{{ opt.label }}</div>
                    <div class="hc-settings__theme-desc">{{ opt.desc }}</div>
                  </button>
                </div>
              </div>

              <div class="hc-settings__field">
                <label class="hc-settings__label">{{ t('settings.general.language') }}</label>
                <select
                  v-model="config.general.language"
                  class="hc-input"
                  @change="handleLanguageChange"
                >
                  <option value="zh-CN">中文</option>
                  <option value="en">English</option>
                </select>
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
                  @change="autoSave()"
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
            <div class="hc-settings__sep" style="margin-top: 16px">
              <span class="hc-settings__sep-label">{{ t('settings.system.info') }}</span>
              <span class="hc-settings__sep-line"></span>
            </div>

            <div class="hc-card hc-settings__info-card" style="margin-top: 10px">
              <div class="hc-settings__info-grid">
                <div>
                  <span class="hc-settings__info-label">{{ t('settings.system.version') }}</span>
                  <div class="hc-settings__info-value hc-settings__info-value--mono">{{ appVersion }}</div>
                </div>
                <div>
                  <span class="hc-settings__info-label">{{ t('settings.system.localStorage') }}</span>
                  <div class="hc-settings__info-value">
                    {{ runtimeLocalStoreFile }} ·
                    <span :style="{ color: runtimeConfig ? 'var(--hc-success)' : 'var(--hc-text-muted)' }">
                      {{ runtimeConfig ? t('settings.system.connected') : '—' }}
                    </span>
                  </div>
                </div>
                <div>
                  <span class="hc-settings__info-label">{{ t('settings.system.knowledgeIndex') }}</span>
                  <div
                    class="hc-settings__info-value"
                    :style="{
                      color: runtimeConfig?.knowledge.enabled
                        ? 'var(--hc-success)'
                        : 'var(--hc-text-muted)',
                    }"
                  >
                    {{
                      runtimeConfig?.knowledge.enabled
                        ? 'FTS5 · ' + t('settings.storage.enabled')
                        : t('settings.storage.disabled', 'Disabled')
                    }}
                  </div>
                </div>
                <div>
                  <span class="hc-settings__info-label">{{ t('settings.system.apiEndpoint') }}</span>
                  <div class="hc-settings__info-value hc-settings__info-value--mono">
                    <template v-if="runtimeModeShort">{{ runtimeModeShort }} · </template>{{ runtimeApiEndpoint }}
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
          </div>

          <!-- System Status -->
          <div
            v-else-if="activeSection === 'status'"
            class="hc-settings__section hc-settings__section--scroll hc-settings__section--storage"
          >
            <h3 class="hc-settings__section-title">
              {{ t('settings.status.title', '系统状态') }}
            </h3>

            <!-- Collapsible trigger -->
            <button class="hc-status__trigger" @click="toggleStatusSection">
              <span class="hc-status__trigger-label">
                {{ t('settings.status.loadData', '加载运行时状态') }}
              </span>
              <component :is="statusExpanded ? ChevronUp : ChevronDown" :size="14" />
            </button>

            <template v-if="statusExpanded">
              <!-- Loading -->
              <p v-if="statusLoading" class="hc-status__loading">
                <Loader2 :size="14" class="animate-spin" />
                {{ t('common.loading', 'Loading...') }}
              </p>

              <!-- Error -->
              <p v-else-if="statusError" class="hc-settings__error">
                {{ statusError }}
              </p>

              <template v-else-if="budgetStatus">
                <!-- Budget -->
                <div class="hc-card hc-settings__info-card hc-settings__info-card--wide">
                  <div class="hc-settings__info-title">
                    {{ t('settings.status.budget', 'Budget') }}
                  </div>

                  <div class="hc-status__progress-list">
                    <!-- Tokens -->
                    <div class="hc-status__progress-item">
                      <div class="hc-status__progress-header">
                        <span class="hc-settings__info-label">Tokens</span>
                        <span class="hc-status__progress-value">
                          {{ budgetStatus.tokens_used.toLocaleString() }} / {{ budgetStatus.tokens_max.toLocaleString() }}
                        </span>
                      </div>
                      <div class="hc-status__progress-bar">
                        <div
                          class="hc-status__progress-fill"
                          :style="{ width: budgetStatus.tokens_max > 0 ? `${Math.min((budgetStatus.tokens_used / budgetStatus.tokens_max) * 100, 100)}%` : '0%' }"
                          :class="{ 'hc-status__progress-fill--warn': budgetStatus.tokens_max > 0 && budgetStatus.tokens_used / budgetStatus.tokens_max > 0.8 }"
                        />
                      </div>
                    </div>

                    <!-- Cost -->
                    <div class="hc-status__progress-item">
                      <div class="hc-status__progress-header">
                        <span class="hc-settings__info-label">Cost</span>
                        <span class="hc-status__progress-value">
                          {{ formatCost(budgetStatus.cost_used) }} / {{ formatCost(budgetStatus.cost_max) }}
                        </span>
                      </div>
                      <div class="hc-status__progress-bar">
                        <div
                          class="hc-status__progress-fill"
                          :style="{ width: budgetStatus.cost_max > 0 ? `${Math.min((budgetStatus.cost_used / budgetStatus.cost_max) * 100, 100)}%` : '0%' }"
                          :class="{ 'hc-status__progress-fill--warn': budgetStatus.cost_max > 0 && budgetStatus.cost_used / budgetStatus.cost_max > 0.8 }"
                        />
                      </div>
                    </div>

                    <!-- Duration -->
                    <div class="hc-status__progress-item">
                      <div class="hc-status__progress-header">
                        <span class="hc-settings__info-label">Duration</span>
                        <span class="hc-status__progress-value">
                          {{ formatDuration(budgetStatus.duration_used) }} / {{ formatDuration(budgetStatus.duration_max) }}
                        </span>
                      </div>
                      <div class="hc-status__progress-bar">
                        <div
                          class="hc-status__progress-fill"
                          :style="{ width: budgetStatus.exhausted ? '100%' : '0%' }"
                          :class="{ 'hc-status__progress-fill--warn': budgetStatus.exhausted }"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <!-- Tool Cache -->
                <div v-if="toolCacheStats" class="hc-card hc-settings__info-card">
                  <div class="hc-settings__info-title">
                    {{ t('settings.status.toolCache', 'Tool Cache') }}
                  </div>
                  <div class="hc-settings__info-grid">
                    <div>
                      <span class="hc-settings__info-label">Entries</span>
                      <div class="hc-settings__info-value">{{ toolCacheStats.entries }}</div>
                    </div>
                    <div>
                      <span class="hc-settings__info-label">Hit Rate</span>
                      <div
                        class="hc-settings__info-value"
                        :style="{ color: toolCacheStats.hit_rate > 0.5 ? 'var(--hc-success)' : 'var(--hc-text-primary)' }"
                      >
                        {{ formatPercent(toolCacheStats.hit_rate) }}
                      </div>
                    </div>
                    <div>
                      <span class="hc-settings__info-label">Hits</span>
                      <div class="hc-settings__info-value">{{ toolCacheStats.hits }}</div>
                    </div>
                    <div>
                      <span class="hc-settings__info-label">Misses</span>
                      <div class="hc-settings__info-value">{{ toolCacheStats.misses }}</div>
                    </div>
                  </div>
                </div>

                <!-- Tool Metrics -->
                <div v-if="topToolsByUsage.length > 0" class="hc-card hc-settings__info-card hc-settings__info-card--wide">
                  <div class="hc-settings__info-title">
                    {{ t('settings.status.toolMetrics', 'Tool Metrics') }}
                  </div>
                  <table class="hc-status__table">
                    <thead>
                      <tr>
                        <th>{{ t('settings.status.toolName', 'Tool') }}</th>
                        <th>{{ t('settings.status.toolCalls', 'Calls') }}</th>
                        <th>{{ t('settings.status.toolSuccessRate', 'Success') }}</th>
                        <th>{{ t('settings.status.toolLatency', 'Avg Latency') }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="tool in topToolsByUsage" :key="tool.tool">
                        <td class="hc-status__table-name">{{ tool.tool }}</td>
                        <td>{{ tool.call_count }}</td>
                        <td :style="{ color: tool.success_rate >= 0.95 ? 'var(--hc-success)' : tool.success_rate < 0.8 ? 'var(--hc-error)' : 'var(--hc-text-primary)' }">
                          {{ formatPercent(tool.success_rate) }}
                        </td>
                        <td>{{ tool.avg_latency_ms.toFixed(0) }}ms</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <!-- Tool Permissions -->
                <div v-if="toolPermissions && toolPermissions.rules && toolPermissions.rules.length > 0" class="hc-card hc-settings__info-card">
                  <div class="hc-settings__info-title">
                    {{ t('settings.status.toolPermissions', 'Tool Permissions') }}
                  </div>
                  <div class="hc-status__permissions">
                    <div
                      v-for="(rule, idx) in toolPermissions.rules"
                      :key="idx"
                      class="hc-status__permission-row"
                    >
                      <code class="hc-status__permission-pattern">{{ rule.pattern }}</code>
                      <span
                        class="hc-status__permission-action"
                        :class="{
                          'hc-status__permission-action--allow': rule.action === 'allow',
                          'hc-status__permission-action--deny': rule.action === 'deny',
                        }"
                      >
                        {{ rule.action }}
                      </span>
                    </div>
                  </div>
                </div>

                <!-- Refresh button -->
                <button class="hc-btn hc-btn-ghost hc-btn-sm" @click="loadSystemStatus">
                  <RotateCcw :size="12" />
                  {{ t('settings.status.refresh', 'Refresh') }}
                </button>
              </template>
            </template>
          </div>
        </template>
      </div>
    </div>
  </div>

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
              <input
                v-model="editModelForm.id"
                type="text"
                class="hc-input"
                placeholder="如 gpt-4o, claude-sonnet-4-6"
              />
            </div>
            <div class="hc-edit-model__field">
              <label>显示名称</label>
              <input
                v-model="editModelForm.name"
                type="text"
                class="hc-input"
                placeholder="留空则使用模型 ID"
              />
            </div>
            <div class="hc-edit-model__field">
              <label>模型能力</label>
              <div class="hc-edit-model__caps">
                <label
                  v-for="cap in ['text', 'vision', 'video', 'audio', 'image_generation', 'video_generation'] as ModelCapability[]"
                  :key="cap"
                  class="hc-edit-model__cap-item"
                >
                  <input v-model="editModelForm.caps[cap]" type="checkbox" :disabled="cap === 'text'" />
                  <span class="hc-edit-model__cap-icon">{{
                    { text: '💬', vision: '👁', video: '🎬', audio: '🎤', image_generation: '🎨', video_generation: '📹' }[cap]
                  }}</span>
                  <span>{{
                    { text: '文本', vision: '视觉', video: '视频', audio: '音频', image_generation: '绘图', video_generation: '视频生成' }[cap]
                  }}</span>
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
    :title="t('settings.llm.deleteProvider')"
    :message="t('settings.llm.deleteProviderConfirm')"
    :confirm-text="t('common.delete')"
    :cancel-text="t('common.cancel')"
    @confirm="confirmDeleteProvider"
    @cancel="pendingDeleteProviderId = null"
  />

  <ConfirmDialog
    :open="pendingDeleteModel !== null"
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

/* ─── Content ───── */
.hc-settings__content {
  flex: 1;
  overflow: hidden;
  padding: 16px 24px;
}

.hc-settings__section {
  max-width: 520px;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  animation: hc-fade-in 0.25s ease-out;
}

.hc-settings__section--scroll {
  overflow-y: auto;
}

.hc-settings__section--storage {
  max-width: 600px;
  margin: 0;
  padding-right: 4px;
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
  padding: 4px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  display: flex;
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
  font-size: 13px;
  font-weight: 500;
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
  transition: color 0.18s, border-color 0.18s;
}

.hc-settings__info:hover {
  color: var(--hc-text-secondary);
  border-color: var(--hc-text-muted);
}

.hc-settings__info::before {
  content: attr(data-info);
  position: absolute;
  top: calc(100% + 8px);
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
  top: calc(100% + 4px);
  left: 8px;
  border: 5px solid transparent;
  border-bottom-color: var(--hc-text-primary);
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
  border-left: 2px solid var(--hc-accent-subtle);
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
.hc-settings__select {
  height: 32px;
  border: 1px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  padding: 0 30px 0 10px;
  font-size: 13px;
  color: var(--hc-text-primary);
  appearance: none;
  outline: none;
  cursor: pointer;
  background: var(--hc-bg-main, var(--hc-bg-card))
    url("data:image/svg+xml,%3Csvg width='10' height='6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%238b919a' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E")
    right 10px center no-repeat;
  transition: border-color 0.18s, box-shadow 0.18s;
}

.hc-settings__select:focus {
  border-color: var(--hc-accent);
  box-shadow: 0 0 0 3px var(--hc-accent-subtle);
}

.hc-settings__select:disabled {
  opacity: 0.35;
  pointer-events: none;
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

/* ─── Theme Cards ───── */
.hc-settings__theme-grid {
  display: flex;
  gap: 10px;
}

.hc-settings__theme-card {
  flex: 1;
  border-radius: var(--hc-radius-md);
  border: 1.5px solid var(--hc-border);
  background: var(--hc-bg-card);
  padding: 10px 12px;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.2s,
    box-shadow 0.2s;
}

.hc-settings__theme-card:hover {
  border-color: var(--hc-accent-subtle);
}

.hc-settings__theme-card--active {
  border-color: var(--hc-accent);
  box-shadow: 0 0 0 3px var(--hc-accent-subtle);
}

.hc-settings__theme-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--hc-text-primary);
}

.hc-settings__theme-desc {
  font-size: 11px;
  color: var(--hc-text-muted);
  margin-top: 2px;
}

/* ─── Info Display ───── */
.hc-settings__info-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--hc-text-primary);
  margin-bottom: 6px;
}

.hc-settings__info-card {
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
  font-size: 11px;
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
    ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    'Liberation Mono',
    'Courier New',
    monospace;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
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

.hc-provider__empty {
  padding: 32px 16px;
  text-align: center;
}

.hc-provider__empty-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--hc-text-secondary);
  margin: 0 0 4px;
}

.hc-provider__empty-desc {
  font-size: 12px;
  color: var(--hc-text-muted);
  margin: 0;
}

.hc-provider__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.hc-provider__card {
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-card);
  border: 1px solid var(--hc-border);
  overflow: hidden;
  transition: border-color 0.15s;
}

.hc-provider__card:hover {
  border-color: var(--hc-accent-subtle);
}

.hc-provider__card--disabled {
  opacity: 0.6;
}

.hc-provider__card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  cursor: pointer;
  user-select: none;
}

.hc-provider__card-info {
  display: flex;
  align-items: center;
  gap: 8px;
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
}

.hc-provider__tag {
  font-size: 10px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 3px;
  color: var(--hc-accent);
  background: var(--hc-accent-subtle);
}

.hc-provider__model-count {
  font-size: 11px;
  color: var(--hc-text-muted);
}

.hc-provider__card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.hc-provider__icon-btn {
  padding: 4px;
  border: none;
  background: transparent;
  cursor: pointer;
  border-radius: var(--hc-radius-sm);
  display: flex;
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
}

.hc-provider__edit {
  padding: 0 14px 14px;
  border-top: 1px solid var(--hc-divider);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 12px;
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

.hc-provider__test-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0 4px;
}

.hc-provider__test-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 6px;
}
.hc-provider__test-badge--ok {
  background: color-mix(in srgb, var(--hc-success) 8%, transparent);
  color: var(--hc-success);
}
.hc-provider__test-badge--err {
  background: color-mix(in srgb, var(--hc-error) 8%, transparent);
  color: var(--hc-error);
}

.hc-provider__edit-footer {
  display: flex;
  justify-content: flex-end;
  padding-top: 4px;
}

.hc-provider__delete-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border: none;
  background: transparent;
  color: var(--hc-error);
  font-size: 12px;
  cursor: pointer;
  border-radius: var(--hc-radius-sm);
  transition: background 0.15s;
}

.hc-provider__delete-btn:hover {
  background: rgba(255, 69, 58, 0.1);
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
  transition: border-color 0.15s, color 0.15s;
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
  margin-bottom: 4px;
}

.hc-model-sync-hint {
  font-size: 11px;
  color: var(--hc-text-muted, #5c5c6b);
}

.hc-model-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.hc-model-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  border-radius: 100px;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid var(--hc-border, rgba(255, 255, 255, 0.12));
  background: var(--hc-bg-main, rgba(255, 255, 255, 0.02));
  color: var(--hc-text-secondary);
  transition: all 0.15s;
}

.hc-model-chip:hover:not(.hc-model-chip--active) {
  background: var(--hc-bg-hover, rgba(255, 255, 255, 0.06));
  border-color: var(--hc-text-muted, #5c5c6b);
}

.hc-model-chip--active {
  border-color: var(--hc-accent, #4a90d9);
  background: color-mix(in srgb, var(--hc-accent, #4a90d9) 10%, transparent);
  color: var(--hc-accent, #4a90d9);
  font-weight: 500;
}

.hc-model-chip--add {
  border-style: dashed;
  color: var(--hc-text-muted, #5c5c6b);
}

.hc-model-chip--add:hover {
  color: var(--hc-accent, #4a90d9);
  border-color: var(--hc-accent, #4a90d9);
  background: color-mix(in srgb, var(--hc-accent, #4a90d9) 5%, transparent);
}

.hc-model-chip__cap {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: 500;
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
  background: color-mix(in srgb, var(--hc-accent, #4a90d9) 12%, transparent);
  color: var(--hc-accent, #4a90d9);
}

.hc-model-chip__cap--code {
  background: color-mix(in srgb, var(--hc-text-secondary) 12%, transparent);
  color: var(--hc-text-secondary);
}

/* ─── 添加自定义模型（内联） ─── */
.hc-model-add-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.hc-model-add-inline .hc-input {
  flex: 1;
  min-width: 0;
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
  accent-color: var(--hc-accent, #4a90d9);
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
    flex-direction: column;
  }

  .hc-settings__info-grid {
    grid-template-columns: 1fr;
    gap: 10px;
  }

  .hc-settings__info-grid--runtime {
    grid-template-columns: 1fr;
  }
}

/* ─── System Status ───── */
.hc-status__trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 10px 14px;
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-card);
  border: 1px solid var(--hc-border);
  color: var(--hc-text-primary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  margin-bottom: 10px;
}

.hc-status__trigger:hover {
  border-color: var(--hc-accent-subtle);
}

.hc-status__trigger-label {
  display: flex;
  align-items: center;
  gap: 6px;
}

.hc-status__loading {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--hc-text-muted);
  margin: 8px 0;
}

.hc-status__progress-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.hc-status__progress-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.hc-status__progress-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.hc-status__progress-value {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--hc-text-muted);
}

.hc-status__progress-bar {
  height: 6px;
  border-radius: 3px;
  background: var(--hc-bg-hover);
  overflow: hidden;
}

.hc-status__progress-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--hc-accent);
  transition: width 0.4s ease;
  min-width: 0;
}

.hc-status__progress-fill--warn {
  background: var(--hc-warning, #f5a623);
}

.hc-status__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.hc-status__table th {
  text-align: left;
  font-size: 11px;
  font-weight: 500;
  color: var(--hc-text-muted);
  padding: 4px 8px 6px 0;
  border-bottom: 1px solid var(--hc-divider);
}

.hc-status__table td {
  padding: 5px 8px 5px 0;
  color: var(--hc-text-primary);
  font-variant-numeric: tabular-nums;
}

.hc-status__table-name {
  font-weight: 500;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
}

.hc-status__table tbody tr {
  border-bottom: 1px solid var(--hc-divider);
}

.hc-status__table tbody tr:last-child {
  border-bottom: none;
}

.hc-status__permissions {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.hc-status__permission-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
}

.hc-status__permission-pattern {
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  color: var(--hc-text-secondary);
}

.hc-status__permission-action {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
}

.hc-status__permission-action--allow {
  color: var(--hc-success);
  background: color-mix(in srgb, var(--hc-success) 12%, transparent);
}

.hc-status__permission-action--deny {
  color: var(--hc-error);
  background: color-mix(in srgb, var(--hc-error) 12%, transparent);
}
</style>
