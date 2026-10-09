<script setup lang="ts">
import BackendServiceCard from '@/components/settings/BackendServiceCard.vue'
import WechatFollowContent from '@/components/settings/WechatFollowContent.vue'
import { backendContext, backendScopeKey, backendLocalStorage, backendStorageKey, readModelSettingsReturn, clearModelSettingsReturn, registerBackendDraftFlush } from '@/services/backend-context'
import { onMounted, onBeforeUnmount, ref, computed, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useChatStore } from '@/stores/chat'
import { useI18n } from 'vue-i18n'
import {
  Key,
  Palette,
  Eye,
  Plus,
  ChevronDown,
  Loader2,
  CheckCircle,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  GripVertical,
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
  backendToProviders,
  isChatModelOption,
  invalidateChangedProviderNativeReasoning,
  normalizeModelCapabilities,
  providerProbeConnectivityFingerprint,
  reconcileDefaultSelection,
  resolveProviderSelectedModelId,
} from '@/stores/settings-helpers'
import { getRuntimeConfig } from '@/api/settings'
import {
  getLLMConfig,
  testLLMConnection,
  fetchProviderModels,
  readProviderApiKey,
} from '@/api/config'
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
import { PROVIDER_PRESETS, PROVIDER_LOGOS } from '@/config/providers'
import {
  displayModelCapabilities as displayCapabilities,
  MODEL_CAPABILITY_DISPLAY,
} from '@/config/model-capability-display'
import { getOllamaTarget } from '@/api/ollama'
import { isCatalogModelFree } from '@/types'
import type {
  AppConfig,
  ProviderConfig,
  ProviderType,
  ModelOption,
  ModelCapability,
  BackendRuntimeConfig,
  BackendLLMConfig,
} from '@/types'
import PageToolbar from '@/components/common/PageToolbar.vue'
import ProviderSelect from '@/components/common/ProviderSelect.vue'
import HcModal from '@/components/common/HcModal.vue'
import HcCollapsePanel from '@/components/common/HcCollapsePanel.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import HcSelect from '@/components/common/HcSelect.vue'
import ModelSelector from '@/components/common/ModelSelector.vue'
import ReasoningPolicySelect from '@/components/settings/ReasoningPolicySelect.vue'
import OllamaCard from '@/components/settings/OllamaCard.vue'
import ModelManagerModal from '@/components/settings/ModelManagerModal.vue'
import AutomationPermissionsPanel from '@/components/settings/AutomationPermissionsPanel.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import { scenarioRegistry } from '@/shell/scenario/registry'
import { normalizeDefaultReasoningPolicy } from '@/utils/reasoning-policy'
import { INPUT_LIMITS, inputLimitError } from '@/utils/input-limits'

const { t, locale } = useI18n()
const toast = useToast()
const settingsStore = useSettingsStore()
let originalProviders = (settingsStore.config?.llm.providers ?? []).map(provider => ({ ...provider }))

function providerInputError(provider: ProviderConfig): string {
  const original = originalProviders.find(item => item.id === provider.id ||
    (!!provider.providerInstanceId && item.providerInstanceId === provider.providerInstanceId) ||
    (!!provider.backendKey && item.backendKey === provider.backendKey))
  return inputLimitError(provider.name, 'Provider name', INPUT_LIMITS.displayName, { original: original?.name }) ||
    inputLimitError(provider.baseUrl ?? '', 'Base URL', INPUT_LIMITS.urlBytes, { unit: 'bytes', original: original?.baseUrl ?? (original ? '' : undefined) }) ||
    inputLimitError(provider.apiKey ?? '', 'API Key', INPUT_LIMITS.secretBytes, { unit: 'bytes', original: original?.apiKey ?? (original ? '' : undefined) })
}
const router = useRouter()
const taskReturn = ref(readModelSettingsReturn())
const returningToTask = ref(false)
const settingsPersisting = ref(false)
const returnModelReady = computed(() => Boolean(settingsStore.config?.llm.defaultModel) && !isDirty.value && !settingsPersisting.value)
async function resumeConfiguredTask() {
  const target = taskReturn.value
  if (!target || returningToTask.value) return
  returningToTask.value = true
  try {
    await flushAutoSave()
    const chat = useChatStore()
    if (target.sessionId && chat.currentSessionId !== target.sessionId) await chat.selectSession(target.sessionId)
    chat.agentRole = target.agentRole
    chat.chatMode = target.chatMode
    await router.push(target.path)
    clearModelSettingsReturn()
    taskReturn.value = null
  } catch (error) { toast.error(String(error)) }
  finally { returningToTask.value = false }
}
const thirdPartyAiServicesHref = computed(() => thirdPartyAiServicesUrl(locale.value))

const catalogStore = useModelCatalogStore()
const { themeMode, setTheme } = useTheme()
const appearanceSettingsExtensions = scenarioRegistry.appearanceSettingsExtensions
const activeSection = ref('llm')
const saved = ref(false)
const saveFailed = ref(false)

// Provider 编辑状态
const editingProviderId = ref<string | null>(null)
/** 眼睛仅切换展示层：type 是否 text（显示明文） */
const shownApiKeys = ref<Record<string, boolean>>({})
const showAddProvider = ref(false)
const addProviderType = ref<ProviderType>('openai')
const addingProvider = ref(false)
let addProviderSession = 0
const addProviderDraft = ref({ name: '', baseUrl: '', apiKey: '' })
const showAddProviderKey = ref(false)
const settingsContentRef = ref<HTMLElement | null>(null)
const providerListRef = ref<HTMLElement | null>(null)
const providerOrderIds = ref<string[]>([])
const providerOrderFeedback = ref('')
const providerDropTarget = ref<{ id: string; after: boolean } | null>(null)
const draggingProviderId = ref<string | null>(null)
let providerIgnoreNextClick = false
let providerTextGesture = false
let providerControlPointerGesture = false
let providerDrag: { id: string; scope: string; pointerId: number; header: HTMLElement; startX: number; startY: number; x: number; y: number; offsetX: number; offsetY: number; active: boolean; frame: number; preview: HTMLElement | null } | null = null

// 自定义模型输入（多选，仅系统自动识别的能力）
const newModelId = ref('')
const newModelCapability = ref<Record<ModelCapability, boolean>>({
  text: true,
  vision: false,
  video: false,
  audio: false,
  code: false,
  image_generation: false,
  video_generation: false,
  embedding: false,
})
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
const modelExclusionDraftUndos: Array<{ scope: string; modelId: string }> = []
function revertModelExclusionDraft() {
  for (const item of modelExclusionDraftUndos.splice(0)) catalogStore.clearModelExclusion(item.scope, item.modelId)
}
const runtimeConfig = ref<BackendRuntimeConfig | null>(null)
const runtimeLLMConfig = ref<BackendLLMConfig | null>(null)
const appVersion = ref('—')
const openAbout = useAboutWindow()
const showWechatFollow = ref(false)
const ollamaCardRef = ref<{ saveTarget: (draft?: import('@/api/ollama').OllamaTarget) => Promise<void>; resetTarget: () => void; targetDraft: () => import('@/api/ollama').OllamaTarget | undefined }>()
const ollamaTargetDirty = ref(false)

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
let settingsOwnerSession = 0
let autoSavePromiseOwnerSession: number | null = null
let autoSavePromiseScope = ''
let settingsPersistOperation = 0
let toolbarSaveSession = 0
let hasPendingAutoSave = false
let autoSaveGeneration = 0
let persistedAutoSaveGeneration = 0
let unlistenCloseRequested: (() => void) | null = null
let closingAfterFlush = false
const unregisterBackendDraftFlush = registerBackendDraftFlush(() => flushAutoSave())

// tab 序：AI 能力域配置（LLM/自动化权限）相邻靠前，平台工具类（系统设置）居尾。
const sections = computed(() => [
  { key: 'llm', label: t('settings.llm.modelServices', 'Model services'), icon: Key },
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
  if (!isDesktopRuntime() || !config.value) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('set_autostart', { enable: !!config.value.general.auto_start })
    await settingsStore.saveImmediateSetting('general')
  } catch (e) {
    logger.error('[HexClaw] 设置开机自启失败:', e)
    await syncAutoStartState()
    toast.error(messageFromUnknownError(e))
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
const persistedSettingsSignature = ref('')
const modelBaseline = ref<AppConfig['llm'] | null>(null)
let persistedProviderInstances = new Map<string, string>()
let ignoreModelReceiptsThrough = 0

function recordSavedSettingsBaseline(signature: string, llm = settingsStore.config?.llm) {
  persistedSettingsSignature.value = signature
  if (llm) modelBaseline.value = JSON.parse(JSON.stringify(llm)) as AppConfig['llm']
  const baseline = JSON.parse(signature) as AppConfig | null
  const ids = new Set(baseline?.llm.providers.map(provider => provider.id) ?? [])
  persistedProviderInstances = new Map((settingsStore.config?.llm.providers ?? [])
    .filter(provider => provider.providerInstanceId && ids.has(provider.id))
    .map(provider => [provider.providerInstanceId!, provider.id]))
}

// 连接回执、能力探测与后端身份回填不是用户编辑，不参与保存按钮的差异判断。
function editableSettingsSignature(owner = settingsStore.config) {
  // 后端补齐的合同默认值与系统推导位置是同一配置语义；显式用户位置和模式保持原值。
  const comparableOwner = owner ? {
    llm: {
      ...owner.llm,
      providers: owner.llm.providers.map(provider => ({
        ...provider,
        locality: provider.localitySource === 'user' ? provider.locality : resolveEffectiveProviderLocality(provider),
        modelSpecsMode: provider.modelSpecsMode ?? 'legacy',
        keepAlive: provider.keepAlive || '',
        numCtx: provider.numCtx ?? 0,
        toolsEnabled: provider.toolsEnabled ?? null,
        maxTools: provider.maxTools ?? 0,
        // 写入器补齐的 replace/delete 不等于新编辑；实际 Key 字符串仍参与差异。
        // 显式删除非空已保存 Key 保留意图，空 Key 的例行 delete 与未声明同义。
        apiKeyMutation: provider.apiKeyMutation === 'delete' && (provider.apiKey.trim() || provider.credentialPresent === true)
          ? 'delete'
          : provider.apiKey.trim() && !isMaskedApiKey(provider.apiKey) ? 'replace' : undefined,
      })),
    },
  } : owner
  return JSON.stringify(comparableOwner, (key, value) =>
    ['probeReceipt', 'toolReliability', 'providerInstanceId', 'backendKey', 'apiKeyLength', 'credentialRef', 'credentialPresent', 'nativeReasoningSourceFingerprint', 'effectiveNativeReasoningSupport', 'effectiveNativeReasoningSourceFingerprint'].includes(key) ? undefined : value,
  ) ?? ''
}

/** 仅将仍等于本次冻结输入的字段规范化，保存期间的新编辑逐字段保留。 */
function reconcileSavedModelFields(submitted: AppConfig['llm'], persisted: AppConfig['llm']) {
  const current = settingsStore.config?.llm
  if (!current) return
  const sameField = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
  const cloneField = (value: unknown) => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
  const submittedIds = submitted.providers.map(provider => provider.id)
  const currentIds = current.providers.map(provider => provider.id)
  const structuralUnchanged = sameField(currentIds, submittedIds)
  for (const key of new Set([...Object.keys(submitted), ...Object.keys(persisted)])) {
    if (key === 'providers') continue
    const target = current as unknown as Record<string, unknown>
    const frozen = submitted as unknown as Record<string, unknown>
    const saved = persisted as unknown as Record<string, unknown>
    if (sameField(target[key], frozen[key])) target[key] = cloneField(saved[key])
  }
  for (const frozen of submitted.providers) {
    const target = current.providers.find(provider => provider.id === frozen.id)
    const saved = persisted.providers.find(provider => provider.id === frozen.id || Boolean(frozen.providerInstanceId && provider.providerInstanceId === frozen.providerInstanceId))
    if (!target || !saved) continue
    for (const key of new Set([...Object.keys(frozen), ...Object.keys(saved)])) {
      const liveFields = target as unknown as Record<string, unknown>
      const frozenFields = frozen as unknown as Record<string, unknown>
      const savedFields = saved as unknown as Record<string, unknown>
      if (sameField(liveFields[key], frozenFields[key])) liveFields[key] = cloneField(savedFields[key])
    }
  }
  if (structuralUnchanged) {
    current.providers = persisted.providers.map(saved => current.providers.find(provider => provider.id === saved.id) ?? JSON.parse(JSON.stringify(saved)) as ProviderConfig)
  }
}

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

function providerOrderId(provider: ProviderConfig) { return provider.providerInstanceId || provider.id }
const nonOllamaProviders = computed(() => {
  const providers = config.value?.llm.providers.filter(p => p.type !== 'ollama') ?? []
  const ranks = new Map(providerOrderIds.value.map((id, index) => [id, index]))
  return [...providers].sort((a, b) => (ranks.get(providerOrderId(a)) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(providerOrderId(b)) ?? Number.MAX_SAFE_INTEGER))
})

const PROVIDER_ORDER_KEY = 'settings-provider-display-order-v1'
function restoreProviderOrder() {
  cancelProviderDrag()
  try {
    const value: unknown = JSON.parse(backendLocalStorage.getItem(PROVIDER_ORDER_KEY) || '[]')
    providerOrderIds.value = Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string'))] : []
  } catch { providerOrderIds.value = [] }
}
watch(() => backendStorageKey(PROVIDER_ORDER_KEY), restoreProviderOrder, { immediate: true })

function commitProviderOrder(ids: string[], movedId: string) {
  const previous = providerOrderIds.value
  providerOrderIds.value = ids
  try {
    // 仅持久化稳定身份的显示偏好，不写配置、凭据或连接测试状态。
    backendLocalStorage.setItem(PROVIDER_ORDER_KEY, JSON.stringify(ids))
    const index = ids.indexOf(movedId)
    providerOrderFeedback.value = `Provider moved to position ${index + 1} of ${ids.length}`
  } catch {
    providerOrderIds.value = previous
    providerOrderFeedback.value = 'Provider order could not be saved'
    toast.error('Provider order could not be saved')
  }
}

function cancelProviderDrag() {
  const state = providerDrag
  if (state) {
    if (state.frame) cancelAnimationFrame(state.frame)
    if (state.header.hasPointerCapture(state.pointerId)) state.header.releasePointerCapture(state.pointerId)
    state.preview?.remove()
  }
  providerDrag = null
  draggingProviderId.value = null
  providerDropTarget.value = null
}

function updateProviderDropTarget() {
  const state = providerDrag, list = providerListRef.value
  providerDropTarget.value = null
  if (!state || !list) return
  const bounds = list.getBoundingClientRect()
  if (state.x < bounds.left || state.x > bounds.right || state.y < bounds.top - 12 || state.y > bounds.bottom + 12) return
  const cards = [...list.querySelectorAll<HTMLElement>('[data-provider-order-id]')].filter(card => card.dataset.providerOrderId !== state.id)
  const target = cards.find(card => state.y < card.getBoundingClientRect().bottom) ?? cards[cards.length - 1]
  if (!target?.dataset.providerOrderId) return
  const rect = target.getBoundingClientRect()
  providerDropTarget.value = { id: target.dataset.providerOrderId, after: state.y > rect.top + rect.height / 2 }
}

function providerDragFrame() {
  const state = providerDrag
  if (!state?.active) return
  if (!state.header.isConnected || state.scope !== backendStorageKey(PROVIDER_ORDER_KEY)) { cancelProviderDrag(); return }
  const content = settingsContentRef.value, bounds = content?.getBoundingClientRect()
  if (content && bounds && state.x >= bounds.left && state.x <= bounds.right) {
    if (state.y < bounds.top + 36) content.scrollTop -= 10
    else if (state.y > bounds.bottom - 36) content.scrollTop += 10
  }
  if (state.preview) { state.preview.style.left = `${state.x - state.offsetX}px`; state.preview.style.top = `${state.y - state.offsetY}px` }
  updateProviderDropTarget()
  state.frame = requestAnimationFrame(providerDragFrame)
}

function startProviderPointer(event: PointerEvent, provider: ProviderConfig) {
  if (event.button !== 0 || !event.isPrimary) return
  providerIgnoreNextClick = false
  providerTextGesture = false
  providerControlPointerGesture = false
  cancelProviderDrag()
  const target = event.target instanceof HTMLElement ? event.target : event.target instanceof Element ? event.target.parentElement : null
  if (!target) return
  if (target.closest('.hc-provider__card-meta,.hc-provider__connection-status')) { providerTextGesture = true; return }
  if (target.closest('a,input,textarea,select,[contenteditable],button:not(.hc-provider__drag-handle)')) { providerControlPointerGesture = true; return }
  const header = event.currentTarget as HTMLElement
  const rect = header.closest('.hc-provider__card')?.getBoundingClientRect() ?? header.getBoundingClientRect()
  providerDrag = { id: providerOrderId(provider), scope: backendStorageKey(PROVIDER_ORDER_KEY), pointerId: event.pointerId, header, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, active: false, frame: 0, preview: null }
}

function moveProviderPointer(event: PointerEvent) {
  const state = providerDrag
  if (!state || state.pointerId !== event.pointerId) return
  state.x = event.clientX; state.y = event.clientY
  if (!state.active) {
    if (Math.hypot(state.x - state.startX, state.y - state.startY) < 8) return
    state.active = true
    providerIgnoreNextClick = true
    draggingProviderId.value = state.id
    state.header.setPointerCapture(state.pointerId)
    const preview = document.createElement('div'), clone = state.header.cloneNode(true) as HTMLElement
    const originals = [state.header, ...state.header.querySelectorAll<HTMLElement>('*')]
    const copies = [clone, ...clone.querySelectorAll<HTMLElement>('*')]
    const properties = ['display', 'grid-template-columns', 'grid-column', 'grid-row', 'gap', 'align-items', 'font-family', 'font-size', 'font-weight', 'line-height', 'color', 'background-color', 'border', 'border-radius', 'padding', 'width', 'height']
    // 预览只复制卡头排版，不包含正文 API Key，也不承载交互或页面身份。
    originals.forEach((node, index) => { const style = getComputedStyle(node); properties.forEach(property => copies[index]!.style.setProperty(property, style.getPropertyValue(property))); copies[index]!.removeAttribute('id') })
    preview.style.cssText = `position:fixed;z-index:1800;padding:14px 20px;box-sizing:border-box;border:1px solid var(--hc-border-hl);border-radius:12px;background:var(--hc-bg-elevated);box-shadow:var(--hc-shadow-md);pointer-events:none;opacity:.96;width:${state.header.closest('.hc-provider__card')?.getBoundingClientRect().width ?? state.header.getBoundingClientRect().width}px`
    preview.inert = true; preview.setAttribute('aria-hidden', 'true'); preview.append(clone); document.body.append(preview)
    state.preview = preview
    providerDragFrame()
  }
  event.preventDefault()
}

function finishProviderPointer(event: PointerEvent) {
  const state = providerDrag
  if (!state || state.pointerId !== event.pointerId) return
  if (!state.active) { cancelProviderDrag(); return }
  event.preventDefault()
  state.x = event.clientX; state.y = event.clientY
  updateProviderDropTarget()
  const target = providerDropTarget.value
  const ids = nonOllamaProviders.value.map(providerOrderId)
  if (target && state.scope === backendStorageKey(PROVIDER_ORDER_KEY)) {
    const remaining = ids.filter(id => id !== state.id), index = remaining.indexOf(target.id)
    if (index >= 0) { remaining.splice(index + (target.after ? 1 : 0), 0, state.id); commitProviderOrder(remaining, state.id) }
  }
  cancelProviderDrag()
}

function handleProviderSortKeydown(event: KeyboardEvent, provider?: ProviderConfig) {
  if (event.key === 'Escape' && providerDrag) { providerIgnoreNextClick = true; cancelProviderDrag(); event.preventDefault(); return }
  if (!provider || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return
  event.preventDefault(); event.stopPropagation(); cancelProviderDrag()
  const ids = nonOllamaProviders.value.map(providerOrderId), id = providerOrderId(provider), index = ids.indexOf(id), next = index + (event.key === 'ArrowUp' ? -1 : 1)
  if (next < 0 || next >= ids.length) return
  ids.splice(index, 1); ids.splice(next, 0, id); commitProviderOrder(ids, id)
  nextTick(() => providerListRef.value?.querySelector<HTMLButtonElement>(`[data-provider-order-id="${CSS.escape(id)}"] .hc-provider__drag-handle`)?.focus())
}

function isDesktopRuntime() {
  return !!(globalThis as Record<string, unknown>).isTauri
}

function hasUnsavedChanges() {
  return isDirty.value || ollamaTargetDirty.value || !!newModelId.value.trim()
}

function hasUnfinishedSettingsPersistence() {
  return autoSavePromise !== null
}

function markAutoSavePending() {
  autoSaveGeneration += 1
  refreshAutoSaveDirtyState()
}

function refreshAutoSaveDirtyState() {
  isDirty.value = !!persistedSettingsSignature.value && editableSettingsSignature() !== persistedSettingsSignature.value
  hasPendingAutoSave = isDirty.value && persistedAutoSaveGeneration < autoSaveGeneration
}

watch(editableSettingsSignature, refreshAutoSaveDirtyState)
watch(() => settingsStore.persistedModelReceipt, receipt => {
  if (!receipt || receipt.scope !== backendScopeKey() || receipt.sequence <= ignoreModelReceiptsThrough || !persistedSettingsSignature.value) return
  const baseline = JSON.parse(persistedSettingsSignature.value) as AppConfig | null
  if (!baseline) return
  let changed = false
  for (const persisted of receipt.providers) {
    const baselineId = persistedProviderInstances.get(persisted.providerInstanceId)
    const provider = baselineId ? baseline.llm.providers.find(item => item.id === baselineId) : undefined
    if (!provider) continue
    // 仅更新实际已提交的模型字段；当前表单与其他字段不受后台回执影响。
    provider.models = JSON.parse(JSON.stringify(persisted.models)) as ModelOption[]
    provider.selectedModelId = persisted.selectedModelId
    const actualBaselineProvider = modelBaseline.value?.providers.find(item => item.id === baselineId)
    if (actualBaselineProvider) {
      actualBaselineProvider.models = JSON.parse(JSON.stringify(persisted.models)) as ModelOption[]
      actualBaselineProvider.selectedModelId = persisted.selectedModelId
    }
    changed = true
  }
  if (!changed) return
  persistedSettingsSignature.value = editableSettingsSignature(baseline)
  refreshAutoSaveDirtyState()
}, { flush: 'sync' })

function resetPendingModelDraft() {
  newModelId.value = ''
  newModelCapability.value = {
    text: true,
    vision: false,
    video: false,
    audio: false,
    code: false,
    image_generation: false,
    video_generation: false,
    embedding: false,
  }
}

async function persistSettings({
  showSavedFeedback = false,
  refreshRuntimeInfo = false,
}: {
  showSavedFeedback?: boolean
  refreshRuntimeInfo?: boolean
} = {}) {
  if (!settingsStore.config) return

  const owner: AppConfig = JSON.parse(JSON.stringify(settingsStore.config))
  const ownerSession = settingsOwnerSession
  const scope = backendScopeKey()
  const isCurrentOwner = () => ownerSession === settingsOwnerSession && backendScopeKey() === scope
  const limitError = owner.llm.providers.map(providerInputError).find(Boolean)
  if (limitError) { toast.error(limitError); throw new Error(limitError) }
  const savedProviders = owner.llm.providers.map(provider => ({ ...provider }))
  const operation = ++settingsPersistOperation
  const feedbackSession = toolbarSaveSession
  const targetDraft = ollamaCardRef.value?.targetDraft()

  settingsPersisting.value = true
  try {
    if (targetDraft) await ollamaCardRef.value?.saveTarget(targetDraft)
    if (!isCurrentOwner()) return
    const result = await settingsStore.saveConfig(owner, { modelOnly: true })
    if (!isCurrentOwner()) return
    originalProviders = savedProviders
    reconcileSavedModelFields(owner.llm, (result.savedConfig ?? owner).llm)
    // 共享保存会规范化配置快照；只有没有后来编辑时才承认该规范化结果。
    recordSavedSettingsBaseline(editableSettingsSignature(result.savedConfig ?? owner), (result.savedConfig ?? owner).llm)
    for (let index = modelExclusionDraftUndos.length - 1; index >= 0; index--) {
      const undo = modelExclusionDraftUndos[index]!
      if (!owner.llm.providers.some(provider => providerModelExclusionScope(provider) === undo.scope && provider.models.some(model => model.id === undo.modelId))) modelExclusionDraftUndos.splice(index, 1)
    }
    if (refreshRuntimeInfo) {
      await loadRuntimeInfo()
    }
    if (showSavedFeedback && !result.securitySyncFailed && isCurrentOwner() && feedbackSession === toolbarSaveSession && editableSettingsSignature() === persistedSettingsSignature.value && !ollamaTargetDirty.value) {
      saved.value = true
      setTimeout(() => {
        if (isCurrentOwner() && feedbackSession === toolbarSaveSession) saved.value = false
      }, 2000)
    }
  } finally {
    if (operation === settingsPersistOperation) settingsPersisting.value = false
  }
}

async function flushAutoSave({
  force = false,
  explicitSubmit = false,
  showSavedFeedback = false,
  refreshRuntimeInfo = false,
}: {
  force?: boolean
  explicitSubmit?: boolean
  showSavedFeedback?: boolean
  refreshRuntimeInfo?: boolean
} = {}) {
  // 生命周期只等待已经点击保存的请求；force 不能把未保存模型草稿隐式提交。
  if (!explicitSubmit) {
    if (autoSavePromise) await autoSavePromise
    return
  }
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer)
    autoSaveTimer = null
  }

  const hasPendingModelDraft = !!newModelId.value.trim()
  const shouldSave = force || hasPendingAutoSave || hasPendingModelDraft
  const owner = settingsStore.config
  const ownerSession = settingsOwnerSession
  const scope = backendScopeKey()
  const isCurrentOwner = () => ownerSession === settingsOwnerSession && backendScopeKey() === scope
  if (!owner) return
  if (!shouldSave) {
    if (autoSavePromise) {
      const sameOwner = autoSavePromiseOwnerSession === ownerSession && autoSavePromiseScope === scope
      try { await autoSavePromise } catch (error) { if (sameOwner) throw error }
    }
    return
  }
  if ((force || hasPendingModelDraft) && persistedAutoSaveGeneration >= autoSaveGeneration) {
    markAutoSavePending()
  }
  const requestedGeneration = autoSaveGeneration
  while (persistedAutoSaveGeneration < requestedGeneration) {
    if (!isCurrentOwner()) return
    if (autoSavePromise) {
      const sameOwner = autoSavePromiseOwnerSession === ownerSession && autoSavePromiseScope === scope
      // 等待旧 owner 的操作收口，但旧失败不能冒充当前 owner 的保存失败。
      try { await autoSavePromise } catch (error) { if (sameOwner) throw error }
      if (!isCurrentOwner()) return
      continue
    }

    const savingGeneration = autoSaveGeneration
    hasPendingAutoSave = false
    autoSavePromiseOwnerSession = ownerSession
    autoSavePromiseScope = scope
    const savingPromise = persistSettings({ showSavedFeedback, refreshRuntimeInfo })
    autoSavePromise = savingPromise
    try {
      await savingPromise
      if (isCurrentOwner()) persistedAutoSaveGeneration = Math.max(persistedAutoSaveGeneration, savingGeneration)
    } catch (e) {
      if (isCurrentOwner()) refreshAutoSaveDirtyState()
      throw e
    } finally {
      if (autoSavePromise === savingPromise) {
        autoSavePromise = null
        autoSavePromiseOwnerSession = null
        autoSavePromiseScope = ''
      }
      if (isCurrentOwner()) refreshAutoSaveDirtyState()
    }
  }
}

function handleBeforeUnload() {
  if (!hasUnfinishedSettingsPersistence()) return
  void flushAutoSave({ force: true })
}

function toggleEditingProvider(providerId: string, explicitControl = false) {
  if (!explicitControl) {
    if (providerIgnoreNextClick) { providerIgnoreNextClick = false; return }
    if (providerTextGesture) { providerTextGesture = false; return }
    // 从按钮按下后移出产生的共同祖先 click 不属于卡头展开手势。
    if (providerControlPointerGesture) { providerControlPointerGesture = false; return }
  }
  providerIgnoreNextClick = false
  providerTextGesture = false
  providerControlPointerGesture = false
  const previous = editingProviderId.value
  const panel = previous ? document.getElementById(`provider-details-${previous}`) : null
  if (panel?.contains(document.activeElement)) {
    panel.closest('.hc-provider__card')?.querySelector<HTMLElement>('.hc-provider__expand')?.focus({ preventScroll: true })
  }
  editingProviderId.value = editingProviderId.value === providerId ? null : providerId
}

// 语言下拉（替代原生 <select class="hc-input">，原 @change=handleLanguageChange 改由 setter 触发）
const languageOptions = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
  { value: 'ug-CN', label: 'ئۇيغۇرچە' },
]
const languageModel = computed<string>({
  get: () => locale.value,
  set: (v) => {
    if (locale.value === v) return
    handleLocaleChange(v)
  },
})

async function saveImmediateSetting(section: 'memory' | 'sandbox') {
  try { await settingsStore.saveImmediateSetting(section) }
  catch (error) { toast.error(messageFromUnknownError(error)); await loadRuntimeInfo(section) }
}

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
  const limitError = providerInputError(provider)
  if (limitError) { toast.error(limitError); return }
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
  if (!localStorage.getItem('hc-locale') && ['zh-CN', 'en', 'ug-CN'].includes(settingsStore.config?.general.language ?? '')) {
    handleLocaleChange(settingsStore.config!.general.language)
  }
  settingsStore.setModelDraftEditing(true)
  originalProviders = (settingsStore.config?.llm.providers ?? []).map(provider => ({ ...provider }))
  recordSavedSettingsBaseline(editableSettingsSignature())
  refreshAutoSaveDirtyState()
  // A7: 页面打开后异步拉一次能力缓存（不 block UI，失败降级为 unknown badge）
  void loadCapabilities()
  // U5: 把开机自启开关与系统真实状态对齐
  void syncAutoStartState()

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', handleBeforeUnload)
    window.addEventListener('pointermove', moveProviderPointer, { passive: false })
    window.addEventListener('pointerup', finishProviderPointer)
    window.addEventListener('pointercancel', cancelProviderDrag)
    window.addEventListener('keydown', handleProviderSortKeydown)
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
  unregisterBackendDraftFlush()
  const scope = backendScopeKey()
  const releaseDraft = () => {
    if (scope !== backendScopeKey()) return
    if (settingsStore.config && modelBaseline.value && editableSettingsSignature() !== persistedSettingsSignature.value) {
      settingsStore.config.llm = JSON.parse(JSON.stringify(modelBaseline.value)) as AppConfig['llm']
      revertModelExclusionDraft()
    }
    settingsStore.setModelDraftEditing(false)
  }
  // 离开期间只收口已发起的保存，随后释放未提交编辑，避免后台目录同步带出草稿。
  if (autoSavePromise) void autoSavePromise.catch(() => undefined).finally(releaseDraft)
  else releaseDraft()
  if (hasUnfinishedSettingsPersistence()) {
    void flushAutoSave({ force: true })
  }
  if (typeof window !== 'undefined') {
    window.removeEventListener('beforeunload', handleBeforeUnload)
    window.removeEventListener('pointermove', moveProviderPointer)
    window.removeEventListener('pointerup', finishProviderPointer)
    window.removeEventListener('pointercancel', cancelProviderDrag)
    window.removeEventListener('keydown', handleProviderSortKeydown)
  }
  cancelProviderDrag()
  modelManagerSession += 1
  managerSyncing.value = false
  addProviderDraft.value.apiKey = ''
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
  cancelProviderDrag()
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
let modelManagerSession = 0
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
    config.value.sandbox = { ...config.value.sandbox, network_enabled }
  },
})
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const editableProviders = computed(() => config.value?.llm.providers ?? [])
const selectedDefaultModelValue = computed({
  get() {
    const llmConfig = config.value?.llm
    if (!llmConfig?.defaultModel) return ''
    const providerId =
      llmConfig.defaultProviderId ||
      settingsStore.availableModels.find((option) => option.modelId === llmConfig.defaultModel)
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

    const model = settingsStore.availableModels.find(
      (entry) => `${entry.providerId}::${entry.modelId}` === value,
    )
    if (!model) return
    config.value.llm.defaultProviderId = model.providerId
    config.value.llm.defaultModel = model.modelId
    autoSave()
  },
})

const selectedDefaultReasoningModel = computed(() => {
  const llmConfig = config.value?.llm
  if (!llmConfig?.defaultProviderId || !llmConfig.defaultModel) return undefined
  return settingsStore.availableModels.find(
    (model) =>
      model.providerId === llmConfig.defaultProviderId && model.modelId === llmConfig.defaultModel,
  )
})

const defaultReasoningPolicyValue = computed({
  get: () => normalizeDefaultReasoningPolicy(config.value?.llm.defaultReasoningPolicy),
  set: (policy: import('@/types').ReasoningPolicy) => {
    if (!config.value?.llm) return
    config.value.llm.defaultReasoningPolicy = normalizeDefaultReasoningPolicy(policy)
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
    backendContext.value?.apiBase ?? `${runtimeConfig.value?.server.host || '127.0.0.1'}:${runtimeConfig.value?.server.port || '—'}`,
)
const runtimeLocalStoreFile = computed(() => backendContext.value?.kind === 'remote' ? '云端服务 · 独立数据' : '本机服务 · data.db')
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
async function loadRuntimeInfo(preferenceSection?: 'memory' | 'sandbox') {
  const gen = ++runtimeInfoGen
  const scope = backendScopeKey()
  // 即时保存的失败回读只恢复本次字段，避免覆盖其他尚未保存的草稿。
  const currentPreferences = () => preferenceSection === 'sandbox'
    ? config.value?.sandbox?.network_enabled
    : preferenceSection === 'memory'
      ? config.value?.memory?.enabled
      : { memory: config.value?.memory, sandbox: config.value?.sandbox }
  const preferenceSnapshot = JSON.stringify(currentPreferences())
  runtimeInfoLoading.value = true
  try {
    const [nextRuntimeConfig, nextLLMConfig] = await Promise.all([
      getRuntimeConfig(),
      getLLMConfig(),
    ])
    if (gen !== runtimeInfoGen || scope !== backendScopeKey()) return
    runtimeConfig.value = nextRuntimeConfig
    runtimeLLMConfig.value = nextLLMConfig
    if (config.value && preferenceSnapshot === JSON.stringify({ memory: config.value.memory, sandbox: config.value.sandbox })) {
      if (nextRuntimeConfig.memory) config.value.memory = { ...nextRuntimeConfig.memory }
      config.value.sandbox = { ...config.value.sandbox, ...nextRuntimeConfig.sandbox }
    }
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
async function handleAssociateOllama() {
  // 防止重复添加 Ollama
  const alreadyExists = settingsStore.config?.llm.providers.some((p) => p.type === 'ollama')
  if (alreadyExists) return

  const ollamaPreset = PROVIDER_PRESETS['ollama']
  if (ollamaPreset) {
    try {
    const target = await getOllamaTarget()
    settingsStore.addProvider({
      name: ollamaPreset.name,
      type: 'ollama' as ProviderType,
      enabled: true,
      apiKey: '',
      baseUrl: target.resolved_base_url,
      models: [],
    })
    await flushAutoSave({ force: true })
    const provider = settingsStore.config?.llm.providers.find((p) => p.type === 'ollama')
    if (provider?.providerInstanceId) {
      await settingsStore.saveOllamaConnection(target, [provider.providerInstanceId])
    }
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
  }
}

function resetAddProviderDraft(type: ProviderType) {
  const preset = PROVIDER_PRESETS[type]
  addProviderDraft.value = { name: '', baseUrl: preset.defaultBaseUrl || '', apiKey: '' }
  showAddProviderKey.value = false
}
watch(addProviderType, (type, previous) => {
  if (type !== previous && showAddProvider.value) resetAddProviderDraft(type)
})
function openAddProvider() {
  addProviderSession += 1
  addProviderType.value = 'openai'
  resetAddProviderDraft('openai')
  showAddProvider.value = true
}
function closeAddProvider() {
  if (addingProvider.value) return
  addProviderSession += 1
  showAddProvider.value = false
  addProviderDraft.value = { name: '', baseUrl: '', apiKey: '' }
  showAddProviderKey.value = false
}

async function handleAddProvider() {
  if (addingProvider.value || !settingsStore.config) return
  const owner = settingsStore.config
  const ownerSession = settingsOwnerSession
  const scope = backendScopeKey()
  const session = addProviderSession
  const isCurrentOwner = () => ownerSession === settingsOwnerSession && backendScopeKey() === scope
  const isCurrentSession = () => isCurrentOwner() && session === addProviderSession && showAddProvider.value
  const preset = PROVIDER_PRESETS[addProviderType.value]

  // 防止重复添加 Ollama（只允许一个）
  if (preset.type === 'ollama') {
    const alreadyExists = settingsStore.config?.llm.providers.some((p) => p.type === 'ollama')
    if (alreadyExists) {
      showAddProvider.value = false
      return
    }
    await handleAssociateOllama()
    if (!isCurrentSession()) return
    showAddProvider.value = false
    const provider = settingsStore.config?.llm.providers.find((item) => item.type === 'ollama')
    if (provider) editingProviderId.value = provider.id
    return
  }

  const draft = addProviderDraft.value
  const limitError = inputLimitError(draft.name, 'Provider name', INPUT_LIMITS.displayName) ||
    inputLimitError(draft.baseUrl, 'Base URL', INPUT_LIMITS.urlBytes, { unit: 'bytes' }) ||
    inputLimitError(draft.apiKey, 'API Key', INPUT_LIMITS.secretBytes, { unit: 'bytes' })
  if (limitError) { toast.error(limitError); return }
  const previousDefaultModel = owner.llm.defaultModel
  const previousDefaultProviderId = owner.llm.defaultProviderId
  const previousEditingId = editingProviderId.value
  const provider = settingsStore.addProvider({
    name: preset.type === 'custom' ? draft.name.trim() || preset.name : preset.name,
    type: preset.type,
    enabled: true,
    apiKey: draft.apiKey,
    baseUrl: draft.baseUrl.trim(),
    models: [...preset.defaultModels],
  })
  if (!provider) return
  const addedDefaultModel = owner.llm.defaultModel
  const addedDefaultProviderId = owner.llm.defaultProviderId
  addingProvider.value = true
  try {
    markAutoSavePending()
    await flushAutoSave({ force: true })
    if (!isCurrentSession()) return
    editingProviderId.value = provider.id
    addingProvider.value = false
    closeAddProvider()
    const current = settingsStore.config?.llm.providers.find(item => item.id === provider.id || (provider.providerInstanceId && item.providerInstanceId === provider.providerInstanceId))
    if (current) {
      // 自定义服务没有预设聊天模型时，先恢复目录，再使用已有连接测试链路。
      void (async () => {
        if (!isCurrentOwner()) return
        if (!current.models.length) await syncRemoteModels(current, { waitForPersistence: true })
        if (!isCurrentOwner()) return
        await testProvider(current)
      })()
    }
  } catch (error) {
    // 新增保存失败只撤回本次新增项，不覆盖其他已存在配置。
    const rollbackOwner = isCurrentOwner() ? settingsStore.config : owner
    if (isCurrentOwner()) settingsStore.removeProvider(provider.id)
    else owner.llm.providers = owner.llm.providers.filter(item => item.id !== provider.id)
    if (rollbackOwner && rollbackOwner.llm.defaultModel === addedDefaultModel && rollbackOwner.llm.defaultProviderId === addedDefaultProviderId) {
      rollbackOwner.llm.defaultModel = previousDefaultModel
      rollbackOwner.llm.defaultProviderId = previousDefaultProviderId
    }
    if (isCurrentSession()) {
      editingProviderId.value = previousEditingId
      refreshAutoSaveDirtyState()
      toast.error(messageFromUnknownError(error))
    }
  } finally {
    if (isCurrentSession()) addingProvider.value = false
  }
}

watch(() => backendScopeKey(), () => {
  // 后端切换只使页面添加会话失效，已进入原持久化链的请求继续使用自己的后端快照。
  addProviderSession += 1
  settingsOwnerSession += 1
  ignoreModelReceiptsThrough = settingsStore.modelPersistenceStarted
  showAddProvider.value = false
  addingProvider.value = false
  addProviderDraft.value = { name: '', baseUrl: '', apiKey: '' }
  showAddProviderKey.value = false
  settingsPersisting.value = false
  toolbarSaveSession += 1
  saved.value = false
  saveFailed.value = false
})

/** 删除只修改模型草稿，确认后的实际配置提交仍由保存配置负责。 */
async function handleDeleteProvider(id: string) {
  settingsStore.removeProvider(id)
  catalogStore.removeCatalog(id)
  if (editingProviderId.value === id) editingProviderId.value = null
  autoSave()
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

async function handleToggleOllamaProvider() {
  const ollamaProvider = config.value?.llm.providers.find(
    (p) => p.type === 'ollama' || p.name?.toLowerCase().includes('ollama'),
  )
  if (ollamaProvider) {
    toggleProvider(ollamaProvider)
  } else {
    await handleAssociateOllama()
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

function capabilitiesForCustomModel(caps: Record<ModelCapability, boolean>): ModelCapability[] {
  const selected = (Object.keys(caps) as ModelCapability[]).filter((cap) => caps[cap])
  if (selected.length === 0) return ['text']
  // 纯 embedding 模型（仅用于知识库）不含 text，由 isChatModel 区分
  if (selected.includes('embedding') && selected.length === 1) return ['embedding']
  // 混合时保证 text
  if (selected.includes('embedding') && !selected.includes('text') && selected.length > 1) {
    return [...new Set([...selected, 'text' as ModelCapability])] as ModelCapability[]
  }
  return [...new Set(selected)] as ModelCapability[]
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
  const limitError = inputLimitError(newModelId.value, 'Model ID', INPUT_LIMITS.identifier)
  if (limitError) { toast.error(limitError); return false }
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
  const caps = capabilitiesForCustomModel(newModelCapability.value)
  const embeddingOnly = caps.length === 1 && caps[0] === 'embedding'
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
  if (decision.classification !== 'ambiguous') return ''
  if (provider.localitySource === 'user' && provider.confirmedEndpointHost === decision.host) {
    return provider.locality === 'local' ? 'local' : 'cloud'
  }
  // 自动预选仅投影当前识别结果，不把展示状态写成用户确认或访问授权。
  return effectiveProviderLocality(provider)
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
  delete testProviderResult.value[provider.id]
  autoSave()
}

async function confirmDeleteModel() {
  const target = pendingDeleteModel.value
  if (!target) return

  try {
    const llm = settingsStore.config?.llm
    const provider = llm?.providers.find((p) => p.id === target.providerId)
    if (!llm || !provider) return
    const modelIndex = provider.models.findIndex((candidate) => candidate.id === target.modelId)
    const model = provider.models[modelIndex]
    if (!model || !isProviderModelRemovable(provider, model)) return

    const previousSelectedModelId = provider.selectedModelId
    const previousDefaultProviderId = llm.defaultProviderId
    const previousDefaultModel = llm.defaultModel
    const providerInstanceId = provider.providerInstanceId
    const exclusionScope = providerModelExclusionScope(provider)
    const previouslyExcluded = catalogStore.getExcludedModelIds(exclusionScope).has(target.modelId)
    if (!catalogStore.excludeModel(exclusionScope, target.modelId)) {
      if (!previouslyExcluded) catalogStore.clearModelExclusion(exclusionScope, target.modelId)
      toast.error(t('settings.llm.deleteModelFailed', '删除模型失败，请重试'))
      return
    }
    if (!previouslyExcluded) modelExclusionDraftUndos.push({ scope: exclusionScope, modelId: target.modelId })
    removeModel(provider, target.modelId)
    const removedSelectedModelId = settingsStore.config?.llm.providers.find((p) => p.id === provider.id)?.selectedModelId
    const removedDefaultProviderId = settingsStore.config?.llm.defaultProviderId
    const removedDefaultModel = settingsStore.config?.llm.defaultModel
    try {
      await flushAutoSave({ force: true })
    } catch (e) {
      if (!previouslyExcluded) catalogStore.clearModelExclusion(exclusionScope, target.modelId)
      const currentLlm = settingsStore.config?.llm
      const currentProvider = currentLlm?.providers.find((p) =>
        p.id === provider.id && p.providerInstanceId === providerInstanceId,
      )
      if (currentLlm && currentProvider) {
        // 只补回本次删除的模型，保留保存期间其它模型的编辑。
        const models = [...currentProvider.models]
        if (!models.some((candidate) => candidate.id === target.modelId)) {
          models.splice(Math.min(modelIndex, models.length), 0, model)
        }
        const updates: Partial<ProviderConfig> = { models }
        if (currentProvider.selectedModelId === removedSelectedModelId) {
          updates.selectedModelId = previousSelectedModelId
        }
        const currentDefaultProviderId = currentLlm.defaultProviderId
        const currentDefaultModel = currentLlm.defaultModel
        const restoreDefault = (
          previousDefaultProviderId !== removedDefaultProviderId || previousDefaultModel !== removedDefaultModel
        ) && currentDefaultProviderId === removedDefaultProviderId && currentDefaultModel === removedDefaultModel
        settingsStore.updateProvider(currentProvider.id, updates)
        // 更新 Provider 会协调默认选择；仅恢复仍属于本次删除的绑定。
        currentLlm.defaultProviderId = restoreDefault ? previousDefaultProviderId : currentDefaultProviderId
        currentLlm.defaultModel = restoreDefault ? previousDefaultModel : currentDefaultModel
        reconcileDefaultSelection(currentLlm)
      }
      logger.error('[Settings] 删除模型持久化失败:', e)
      toast.error(t('settings.llm.deleteModelFailed', '删除模型失败，请重试'))
    }
  } finally {
    // 旧请求结束时不能关闭后来选择的另一个删除目标。
    if (pendingDeleteModel.value === target) pendingDeleteModel.value = null
  }
}

/** 保存编辑的模型 */
function saveEditModel() {
  if (!editingModel.value) return
  const { providerId, idx } = editingModel.value
  const provider = settingsStore.config?.llm.providers.find((p) => p.id === providerId)
  if (!provider) return
  const original = provider.models[idx]
  const limitError = inputLimitError(editModelForm.value.id, 'Model ID', INPUT_LIMITS.identifier, { original: original?.id }) ||
    inputLimitError(editModelForm.value.name, 'Model name', INPUT_LIMITS.title, { original: original?.name })
  if (limitError) { toast.error(limitError); return }
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
  delete testProviderResult.value[providerId]
  autoSave()
}

// ─── Provider 连接测试 ────────────────────────────────
const testingProviderIds = ref(new Set<string>())
const providerTestGenerations = new Map<string, number>()
const testProviderResult = ref<
  Record<string, { ok: boolean; msg: string; locality?: 'local' | 'cloud'; receiptBacked?: boolean }>
>({})

/** 眼睛显示后的明文 API Key（仅独立展示层、内存短驻，关闭眼睛即清除，不写入表单保存值） */
const revealedApiKeys = ref<Record<string, string>>({})

function restoreProviderApiKeyFocus(provider: ProviderConfig) {
  const input = document.getElementById(`provider-${provider.id}-api-key`)
  if (input instanceof HTMLInputElement) {
    input.focus()
    if (
      /AppleWebKit/i.test(navigator.userAgent) &&
      !/(Chrome|Chromium|CriOS)/i.test(navigator.userAgent)
    ) {
      input.select()
    }
  }
}

function clearProviderProbeState(provider: ProviderConfig) {
  const original = settingsStore.runtimeProviders?.find((candidate) =>
    candidate.id === provider.id || Boolean(provider.providerInstanceId && candidate.providerInstanceId === provider.providerInstanceId),
  )
  invalidateChangedProviderNativeReasoning(original, provider)
  providerTestGenerations.set(provider.id, (providerTestGenerations.get(provider.id) ?? 0) + 1)
  provider.probeReceipt = undefined
  delete testProviderResult.value[provider.id]
}

function providerConnectionResult(provider: ProviderConfig) {
  const transient = testProviderResult.value[provider.id]
  if (transient) return transient
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
  return undefined
}

/** 请求错误详情可以临时显示，但不能替代服务端连接事实。 */
function providerConnectionError(provider: ProviderConfig) {
  const transient = testProviderResult.value[provider.id]
  if (transient && !transient.ok) return transient
  const result = providerConnectionResult(provider)
  return result && !result.ok ? result : undefined
}

function parseProviderProbeTime(value: string | number | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

async function providerWithStableIdentity(provider: ProviderConfig): Promise<ProviderConfig> {
  // 测试是独立运行操作，不保存或重载模型草稿。
  return provider
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
  const rawApiKey = provider.apiKey || ''
  if (!rawApiKey) return ''
  if (isMaskedApiKey(rawApiKey) && provider.providerInstanceId) return ''
  return rawApiKey
}

/** 方案 B（2026-08-19 批准，业界标准）：眼睛仅切换展示层，永不改写表单保存值 provider.apiKey。
 * 显示：新输入明文直接展示；脱敏值经一次性明文回读接口获取，只写入展示 ref（内存短驻）。
 * 隐藏：恢复 password 并清除展示明文。回读失败 toast 且 type/值均不变。 */
async function toggleApiKeyVisibility(provider: ProviderConfig) {
  if (!shownApiKeys.value[provider.id]) {
    const current = provider.apiKey?.trim() ?? ''
    if (!isMaskedApiKey(current)) {
      // 新输入明文（含空）：直接切换展示，不调用回读接口
      shownApiKeys.value[provider.id] = true
      await nextTick()
      restoreProviderApiKeyFocus(provider)
      return
    }
    try {
      const plain = await readProviderApiKey(
        provider.backendKey || provider.providerInstanceId || provider.id,
      )
      if (!plain) {
        toast.error(t('settings.llm.apiKeyRevealFailed', '暂时无法读取已保存的 API Key'))
        return
      }
      revealedApiKeys.value[provider.id] = plain
      shownApiKeys.value[provider.id] = true
      await nextTick()
      restoreProviderApiKeyFocus(provider)
    } catch {
      toast.error(t('settings.llm.apiKeyRevealFailed', '暂时无法读取已保存的 API Key'))
    }
    return
  }
  shownApiKeys.value[provider.id] = false
  delete revealedApiKeys.value[provider.id]
  await nextTick()
  restoreProviderApiKeyFocus(provider)
}

/** 输入框展示值：眼睛显示中且有展示明文 → 明文；掩码态 → 空（等长圆点走 placeholder，GitHub 同款，
 * 避免掩码串进入 value 被用户编辑带入保存值）；否则恒为表单保存值（新输入明文/空）。
 * 表单值 provider.apiKey 掩码态恒 '********'（preserve 语义与 isMaskedApiKey 判定不破坏）。 */
function apiKeyDisplayValue(provider: ProviderConfig): string {
  const revealed = revealedApiKeys.value[provider.id]
  if (shownApiKeys.value[provider.id] && revealed !== undefined) return revealed
  if (isMaskedApiKey(provider.apiKey)) return ''
  return provider.apiKey ?? ''
}

/** 掩码态 placeholder：有长度元数据时按真实 Key 长度等长圆点，否则固定 '********'。 */
function apiKeyInputPlaceholder(provider: ProviderConfig): string {
  if (isMaskedApiKey(provider.apiKey) && provider.apiKeyLength && provider.apiKeyLength > 0) {
    return '•'.repeat(provider.apiKeyLength)
  }
  return PROVIDER_PRESETS[provider.type]?.placeholder || 'API Key'
}

/** 用户输入接管：展示层失效，明文写入表单保存值（replace 保存语义）。 */
function onProviderApiKeyTyped(provider: ProviderConfig, event: Event) {
  delete revealedApiKeys.value[provider.id]
  provider.apiKey = (event.target as HTMLInputElement).value
  provider.apiKeyMutation = provider.apiKey.trim() ? 'replace' : 'delete'
  clearProviderProbeState(provider)
  autoSave()
  scheduleAutoTest(provider)
}

async function testProvider(provider: ProviderConfig) {
  if (testingProviderIds.value.has(provider.id)) return
  const limitError = providerInputError(provider)
  if (limitError) { testProviderResult.value[provider.id] = { ok: false, msg: limitError }; return }
  testingProviderIds.value.add(provider.id)
  delete testProviderResult.value[provider.id]

  // 优先测试聊天模型；仅有 Embedding 时测试向量接口，不改变聊天默认模型。
  const preferred =
    provider.models?.find(
      (model) => model.id === provider.selectedModelId && isChatModelOption(model),
    ) || provider.models?.find(isChatModelOption) ||
    provider.models?.find((model) => model.capabilities?.includes('embedding'))
  const selectedModelId = (preferred?.id || '').trim()
  if (!selectedModelId) {
    testProviderResult.value[provider.id] = {
      ok: false,
      msg: t('settings.llm.testNeedsModel'),
    }
    testingProviderIds.value.delete(provider.id)
    return
  }

  const needsApiKey = provider.type !== 'ollama'

  let activeProvider: ProviderConfig
  try {
    activeProvider = await providerWithStableIdentity(provider)
  } catch (error) {
    // 保存或身份恢复失败属于本次连接测试结果，不能逃出事件触发整页错误边界。
    testProviderResult.value[provider.id] = {
      ok: false,
      msg: messageFromUnknownError(error),
    }
    testingProviderIds.value.delete(provider.id)
    return
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
    testingProviderIds.value.delete(provider.id)
    return
  }

  let currentTestProvider: (() => ProviderConfig | undefined) | undefined
  let refreshTestReceipt: (() => Promise<ProviderConfig | undefined>) | undefined
  try {
    const activePreferred =
      activeProvider.models?.find(
        (model) => model.id === activeProvider.selectedModelId && isChatModelOption(model),
      ) || activeProvider.models?.find(isChatModelOption) ||
      activeProvider.models?.find((model) => model.capabilities?.includes('embedding'))
    const activeModelId = (activePreferred?.id || selectedModelId).trim()
    const preset = PROVIDER_PRESETS[activeProvider.type]
    const testedScope = backendScopeKey()
    const testedFingerprint = providerProbeConnectivityFingerprint(activeProvider)
    const testedInstanceId = activeProvider.providerInstanceId
    const testedGeneration = providerTestGenerations.get(activeProvider.id) ?? 0
    currentTestProvider = () => {
      const currentProvider = config.value?.llm.providers.find(
        (candidate) => testedInstanceId ? candidate.providerInstanceId === testedInstanceId : candidate.id === activeProvider.id,
      )
      return currentProvider &&
        backendScopeKey() === testedScope &&
        (providerTestGenerations.get(currentProvider.id) ?? 0) === testedGeneration &&
        providerProbeConnectivityFingerprint(currentProvider) === testedFingerprint
        ? currentProvider
        : undefined
    }
    refreshTestReceipt = async () => {
      if (!testedInstanceId) return currentTestProvider?.()
      const snapshot = await getLLMConfig()
      const currentProvider = currentTestProvider?.()
      if (!currentProvider) return undefined
      const restoredProvider = backendToProviders(snapshot, [currentProvider]).find(
        (candidate) => candidate.providerInstanceId === testedInstanceId,
      )
      currentProvider.probeReceipt = restoredProvider &&
        providerProbeConnectivityFingerprint(restoredProvider) === testedFingerprint
        ? restoredProvider.probeReceipt
        : undefined
      return currentProvider
    }
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
        httpAuthorization: activeProvider.httpAuthorization,
      },
    )
    const currentProvider = currentTestProvider()
    if (!currentProvider) return
    const testedAt = parseProviderProbeTime(result.tested_at)

    // 成功与失败都以持久回执为准，页面卸载不能丢失最近一次连接结论。
    if (result.persisted && testedAt !== undefined && testedInstanceId) {
      currentProvider.probeReceipt = {
        providerInstanceId: testedInstanceId,
        outcome: result.ok ? 'passed' : 'failed',
        locality: effectiveProviderLocality(currentProvider),
        latencyMs: result.latency_ms ?? 0,
        testedAt,
        ...(result.error_code ? { errorCode: result.error_code } : {}),
        ...(!result.ok
          ? {
              errorMessage:
                result.error_message || result.message || t('settings.llm.connectionFailed'),
            }
          : {}),
      }
      delete testProviderResult.value[currentProvider.id]
      delete testProviderResult.value[provider.id]
    } else {
      // 未保存 Provider 的独立测试仅保留本次回执，不伪造服务端持久化事实。
      delete testProviderResult.value[provider.id]
        testProviderResult.value[currentProvider.id] = {
          ok: result.ok,
          msg: result.error_message || result.message || (result.ok ? 'Connection test passed.' : t('settings.llm.connectionFailed')),
          receiptBacked: false,
        }
    }
    // 同次连接请求已由服务端保存模型能力回执；这里只读恢复，不再次调用模型。
    // 回读仅更新匹配连接的回执，不能用整份快照覆盖请求期间的新编辑。
    try {
      await refreshTestReceipt()
    } catch (error) {
      logger.warn('[Settings] Provider receipt readback failed:', error)
    }
    // 连接成功后自动拉取远程模型列表（Ollama 由 syncOllamaModels 处理）
    const providerAfterReadback = currentTestProvider()
    if (result.ok && providerAfterReadback && providerAfterReadback.type !== 'ollama') {
      syncRemoteModels(providerAfterReadback)
    }
  } catch (e) {
    // 请求结果未知时仅查询回执，不重发；配置已变化的旧错误不能覆盖当前卡片。
    const currentProvider = currentTestProvider?.()
    if (!currentProvider) return
    logger.warn('[Settings] Provider connection test request failed:', e)
    delete testProviderResult.value[provider.id]
    testProviderResult.value[currentProvider.id] = {
      ok: false,
      msg: messageFromUnknownError(e),
      receiptBacked: false,
    }
    try {
      await refreshTestReceipt?.()
    } catch (error) {
      logger.warn('[Settings] Provider receipt readback failed:', error)
    }
  } finally {
    testingProviderIds.value.delete(provider.id)
  }
}

/** 连接成功后，从 Provider 动态拉取可用模型目录 */
async function syncRemoteModels(
  provider: ProviderConfig,
  { waitForPersistence = false }: { waitForPersistence?: boolean } = {},
): Promise<boolean> {
  const limitError = providerInputError(provider)
  if (limitError) { toast.error(limitError); return false }
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
      httpAuthorization: provider.httpAuthorization,
    })
    if (!remoteModels.length) throw new Error('empty model catalog')
    const currentProvider = config.value?.llm.providers.find(
      (candidate) => candidate.id === provider.id,
    )
    if (!currentProvider) return false
    const currentPreset = PROVIDER_PRESETS[currentProvider.type]
    const currentBaseUrl = currentProvider.baseUrl || currentPreset?.defaultBaseUrl || ''
    if (!syncLease.isCurrent(currentProvider, currentBaseUrl)) return false
    // 目录层：全量 + 元数据存本地缓存；Provider 卡片只呈现已配置子集。
    catalogStore.setCatalog(currentProvider.id, remoteModels, currentProvider)
    const result = reconcileProviderCatalog(
      currentProvider,
      remoteModels,
      currentPreset?.defaultModels ?? [],
      catalogStore.getExcludedModelIds(providerModelExclusionScope(currentProvider)),
    )
    if (result.changed) {
      delete testProviderResult.value[currentProvider.id]
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

// 卡片预览上限独立于目录自动启用阈值，不截断配置和模型管理器的完整列表。
const PROVIDER_MODEL_PREVIEW_LIMIT = 10

function providerModelPreview(provider: ProviderConfig): ModelOption[] {
  return provider.models.slice(0, PROVIDER_MODEL_PREVIEW_LIMIT)
}

function providerCatalogCount(providerId: string): number {
  return catalogStore.getCatalog(providerId)?.models.length ?? 0
}

/** 目录超过阈值时使用“摘要 + 管理器”，避免把聚合商全量目录铺进 Provider 卡片。 */
function isManagedCatalog(providerId: string): boolean {
  const catalogCount = providerCatalogCount(providerId)
  if (catalogCount > AUTO_ENABLE_CATALOG_LIMIT) return true
  const provider = config.value?.llm.providers.find((candidate) => candidate.id === providerId)
  if (!provider || provider.models.length === 0) return false
  return (
    provider.models.length < catalogCount &&
    provider.models.every((model) => {
      const catalog = catalogStore.getCatalog(providerId)
      return catalog?.models.some((catalogModel) => catalogModel.id === model.id)
    })
  )
}

/** 非 Ollama 的兼容服务共用目录管理器，不按端点物理位置隐藏入口。 */
function canManageProviderCatalog(provider: ProviderConfig): boolean {
  return provider.type !== 'ollama'
}

function providerHasNewModels(providerId: string): boolean {
  return (catalogStore.getCatalog(providerId)?.newIds.length ?? 0) > 0
}

function openModelManager(providerId: string, event: MouseEvent) {
  modelManagerSession += 1
  managerSyncing.value = false
  modelManagerReturnFocus = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  modelManagerProviderId.value = providerId
}

function closeModelManager() {
  modelManagerSession += 1
  managerSyncing.value = false
  modelManagerProviderId.value = null
  const returnFocus = modelManagerReturnFocus
  modelManagerReturnFocus = null
  nextTick(() => {
    if (returnFocus?.isConnected) returnFocus.focus()
  })
}

function handleManagerModelsChange() {
  const provider = modelManagerProvider.value
  // 列表变化后清除临时校验结果，持久连接回执由配置存储按连接指纹失效。
  if (provider) delete testProviderResult.value[provider.id]
  autoSave()
}

async function handleManagerResync() {
  const provider = modelManagerProvider.value
  if (!provider || managerSyncing.value) return
  managerSyncing.value = true
  const session = modelManagerSession
  const isCurrent = () => session === modelManagerSession && modelManagerProviderId.value === provider.id
  try {
    const ok = await syncRemoteModels(provider, { waitForPersistence: true })
    if (!ok && isCurrent()) {
      toast.error(t('settings.llm.syncModelsFailed', '同步模型列表失败，请检查连接'))
    }
  } finally {
    if (isCurrent()) managerSyncing.value = false
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
  // 控件只更新模型草稿与差异；保存行为由工具栏唯一入口触发。
  markAutoSavePending()
  if (autoSaveTimer) clearTimeout(autoSaveTimer)
  autoSaveTimer = null
}

function selectProviderModel(provider: ProviderConfig, modelId: string) {
  provider.selectedModelId = modelId
  handleProviderModelChange(provider)
}

async function onToolbarReset() {
  if (!settingsStore.config || !modelBaseline.value || settingsPersisting.value) return
  // 显式重置开始新编辑会话，正常保存的快照替换不改变会话身份。
  settingsOwnerSession += 1
  ignoreModelReceiptsThrough = settingsStore.modelPersistenceStarted
  toolbarSaveSession += 1
  saved.value = false
  saveFailed.value = false
  try {
    settingsStore.config.llm = JSON.parse(JSON.stringify(modelBaseline.value)) as AppConfig['llm']
    revertModelExclusionDraft()
    ollamaCardRef.value?.resetTarget()
    shownApiKeys.value = {}
    revealedApiKeys.value = {}
    testProviderResult.value = {}
    newModelId.value = ''
    resetPendingModelDraft()
    refreshAutoSaveDirtyState()
    saved.value = false
  } catch (e) {
    logger.error('[HexClaw] Reset failed:', e)
    toast.error(t('settings.toolbar.resetFailed', '重置失败，请重试'))
  }
}

async function saveConfig() {
  const ownerSession = settingsOwnerSession
  const scope = backendScopeKey()
  const session = ++toolbarSaveSession
  const isCurrentSession = () => ownerSession === settingsOwnerSession && backendScopeKey() === scope && session === toolbarSaveSession
  saveFailed.value = false
  try {
    await flushAutoSave({
      force: true,
      explicitSubmit: true,
      showSavedFeedback: true,
      refreshRuntimeInfo: activeSection.value === 'system',
    })
  } catch (e) {
    logger.error('保存配置失败:', e)
    if (!isCurrentSession()) return
    // 保存失败不能静默：清成功态 + 置失败态，按钮显示「保存失败，请重试」（4s 后复位）
    saved.value = false
    saveFailed.value = true
    setTimeout(() => {
      if (isCurrentSession()) saveFailed.value = false
    }, 4000)
  }
}

</script>

<template>
  <div
    class="hc-settings"
    :inert="showAddProvider || customModelDialogProviderId || modelManagerProviderId || showWechatFollow ? true : undefined"
  >
    <PageToolbar>
      <template #tabs>
        <SegmentedControl
          v-model="activeSection"
          :segments="sections.map((s) => ({ key: s.key, label: s.label }))"
        />
      </template>
      <template #actions>
        <button v-if="activeSection === 'llm' || hasUnsavedChanges()" class="hc-btn hc-btn-ghost" :disabled="!hasUnsavedChanges() || settingsPersisting" @click="onToolbarReset">
          <RotateCcw :size="14" />
          {{ activeSection === 'llm' ? '撤销未保存修改' : '撤销模型修改' }}
        </button>
        <button
          v-if="activeSection === 'llm' || hasUnsavedChanges()"
          class="hc-btn hc-btn-primary"
          :class="{ 'hc-settings__btn--saved': saved, 'hc-settings__btn--failed': saveFailed }"
          :disabled="settingsPersisting || !hasUnsavedChanges()"
          @click="saveConfig"
        >
          <Loader2 v-if="settingsPersisting" :size="14" class="animate-spin" />
          <CheckCircle v-else-if="saved" :size="14" />
          {{
            saved
              ? t('common.saved')
              : saveFailed
                ? t('settings.toolbar.saveFailed', '保存失败，请重试')
                : activeSection === 'llm' ? '保存配置' : '保存模型配置'
          }}
          <span class="hc-settings__dirty" :class="{ 'hc-settings__dirty--on': isDirty }"
            >· 未保存</span
          >
        </button>
      </template>
    </PageToolbar>

    <div class="hc-settings__body">
      <div ref="settingsContentRef" class="hc-settings__content">
        <LoadingState v-if="settingsStore.loading && !config" />

        <template v-if="config">
          <!-- LLM Providers -->
          <div v-show="activeSection === 'llm'" class="hc-settings__section hc-settings__section--llm">
            <div v-if="taskReturn" class="hc-settings__task-return" data-task-return>
              <div>
                <span>{{ returnModelReady ? '默认模型已选好，可以继续原任务。' : '配置模型后继续原任务，已填写的内容会保留。' }}</span>
                <button class="hc-btn" :class="{ 'hc-btn-primary': returnModelReady }" :disabled="returningToTask" @click="resumeConfiguredTask">{{ returnModelReady ? '继续原任务' : '返回原任务' }}</button>
              </div>
            </div>
            <!-- 主区先于辅助区；切 Tab 保留同一模型草稿与运行回执。 -->
            <div class="hc-settings__task-layout">
              <main class="hc-settings__task-main">
            <!-- ── 服务商 ── -->
            <div class="hc-settings__sep">
              <span class="hc-settings__sep-label">服务商</span>
              <span class="hc-settings__sep-line"></span>
              <button
                class="hc-btn hc-btn-sm hc-settings__sep-action"
                @click="openAddProvider"
              >
                <Plus :size="14" />
                {{ t('settings.llm.addProvider') }}
              </button>
            </div>

            <!-- 本地 LLM (Ollama) 卡片 -->
            <OllamaCard
              ref="ollamaCardRef"
              @target-dirty="ollamaTargetDirty = $event; autoSave()"
              @associate="handleAssociateOllama"
              @toggle-provider="handleToggleOllamaProvider"
            />

            <!-- Provider 列表（本地 Ollama 常驻，故不再额外渲染「尚未添加服务商」空态；对齐原型） -->
            <div ref="providerListRef" class="hc-provider__list">
              <span id="provider-order-hint" class="hc-provider__sr-only">拖动卡头非交互区域排序；也可在排序柄上按 Alt + ↑ / ↓。排序仅调整显示，不影响模型路由。</span>
              <span class="hc-provider__sr-only" aria-live="polite">{{ providerOrderFeedback }}</span>
              <div
                v-for="provider in nonOllamaProviders"
                :key="provider.id"
                class="hc-provider__card"
                :class="{
                  'hc-provider__card--disabled': !provider.enabled,
                  'hc-provider__card--dragging': draggingProviderId === providerOrderId(provider),
                  'hc-provider__drop-before': providerDropTarget?.id === providerOrderId(provider) && !providerDropTarget.after,
                  'hc-provider__drop-after': providerDropTarget?.id === providerOrderId(provider) && providerDropTarget.after,
                }"
                :data-provider-type="provider.type"
                :data-provider-order-id="providerOrderId(provider)"
              >
                <!-- Provider 头部 -->
                <div class="hc-provider__card-head" @pointerdown="startProviderPointer($event, provider)" @click="toggleEditingProvider(provider.id)">
                  <button type="button" class="hc-provider__drag-handle" :aria-label="`排序 ${provider.name}`" aria-describedby="provider-order-hint" title="拖动卡头排序；Alt + ↑ / ↓ 调整顺序。仅影响显示，不改变模型路由。" @click.stop @keydown="handleProviderSortKeydown($event, provider)"><GripVertical :size="18" /></button>
                  <div class="hc-provider__card-info">
                    <div class="hc-provider__logo">
                      <img
                        :src="PROVIDER_LOGOS[provider.type] || PROVIDER_LOGOS.custom"
                        :alt="provider.type"
                      />
                    </div>
                    <div class="hc-provider__card-identity">
                      <div class="hc-provider__card-name">{{ provider.name }}</div>
                      <div class="hc-provider__card-meta">
                        {{ providerBaseUrl(provider) }} ·
                        <span class="hc-provider__model-count">{{ provider.models.length }}</span>
                        {{ t('settings.llm.enabledUnit', '个模型') }}
                      </div>
                    </div>
                  </div>
                  <div class="hc-provider__card-actions">
                    <span
                      class="hc-provider__connection-status"
                      :class="{
                        'hc-provider__connection-status--testing': testingProviderIds.has(
                          provider.id,
                        ),
                        'hc-provider__connection-status--ok':
                          !testingProviderIds.has(provider.id) &&
                          providerConnectionResult(provider)?.ok,
                        'hc-provider__connection-status--error':
                          !testingProviderIds.has(provider.id) &&
                          providerConnectionResult(provider) &&
                          !providerConnectionResult(provider)!.ok,
                      }"
                      aria-live="polite"
                      title="上次连接测试结果，非实时健康状态"
                      :aria-label="
                        providerConnectionResult(provider)?.ok
                          ? t('settings.llm.testSuccess', '成功')
                          : undefined
                      "
                    >
                      <Loader2
                        v-if="testingProviderIds.has(provider.id)"
                        :size="12"
                        class="animate-spin"
                      />
                      <span v-else class="hc-provider__connection-dot" aria-hidden="true" />
                      {{
                        testingProviderIds.has(provider.id)
                          ? t('settings.llm.testing', '测试中…')
                          : providerConnectionResult(provider)?.ok
                            ? t('settings.llm.testSuccess', '成功')
                            : providerConnectionResult(provider)
                              ? t('settings.llm.testFailed', '失败')
                              : t('settings.llm.untested', '未测试')
                      }}
                    </span>
                    <button
                      type="button"
                      class="hc-btn hc-btn-sm hc-provider__test-btn"
                      :title="t('settings.llm.testConnection', '测试连接')"
                      :disabled="
                        testingProviderIds.has(provider.id) ||
                        providerEndpointDecision(provider).classification === 'blocked'
                      "
                      @click.stop="testProvider(provider)"
                    >
                      {{ t('settings.llm.testAction', '测试') }}
                    </button>
                    <button
                      type="button"
                      class="hc-provider__toggle"
                      :class="{ 'hc-provider__toggle--on': provider.enabled }"
                      :title="
                        provider.enabled ? t('settings.llm.enabled') : t('settings.llm.disabled')
                      "
                      :aria-label="
                        provider.enabled ? t('settings.llm.enabled') : t('settings.llm.disabled')
                      "
                      @click.stop="toggleProvider(provider)"
                    >
                      <span class="hc-provider__toggle-knob" aria-hidden="true" />
                    </button>
                    <button type="button" class="hc-provider__expand" :aria-expanded="editingProviderId === provider.id" :aria-controls="`provider-details-${provider.id}`" :aria-label="`${editingProviderId === provider.id ? '收起' : '展开'} ${provider.name}`" @click.stop="toggleEditingProvider(provider.id, true)"><ChevronDown :size="16" :class="{ 'is-expanded': editingProviderId === provider.id }" /></button>
                  </div>
                </div>

                <!-- Provider 编辑面板 -->
                <HcCollapsePanel :open="editingProviderId === provider.id" :gap="12" :body-id="`provider-details-${provider.id}`">
                <div class="hc-provider__edit">
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

                    <div class="hc-settings__field hc-provider__config-url">
                      <label class="hc-settings__label" :for="`provider-${provider.id}-base-url`"
                        >{{ t('settings.llm.baseUrl') }}
                        <span class="hc-settings__required">*</span></label
                      >
                      <HcClearableField :trailing="10">
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

                    <div class="hc-settings__field hc-provider__config-key">
                      <label class="hc-settings__label" :for="`provider-${provider.id}-api-key`"
                        >{{ t('settings.llm.apiKey') }}
                        <span class="hc-settings__required">*</span></label
                      >
                      <div class="hc-settings__input-group">
                        <HcClearableField :trailing="40">
                          <input
                            :id="`provider-${provider.id}-api-key`"
                            :value="apiKeyDisplayValue(provider)"
                            data-provider-field="api-key"
                            :type="shownApiKeys[provider.id] ? 'text' : 'password'"
                            class="hc-input"
                            :placeholder="apiKeyInputPlaceholder(provider)"
                            @input="onProviderApiKeyTyped(provider, $event)"
                          />
                        </HcClearableField>
                        <button
                          type="button"
                          class="hc-settings__eye-btn"
                          :aria-label="shownApiKeys[provider.id] ? '隐藏 API Key' : '显示 API Key'"
                          :title="shownApiKeys[provider.id] ? '隐藏 API Key' : '显示 API Key'"
                          @click="toggleApiKeyVisibility(provider)"
                        >
                          <Eye :size="15" />
                        </button>
                      </div>
                    </div>
                  </div>

                  <p
                    v-if="providerConnectionError(provider)"
                    class="hc-provider__connection-detail"
                  >
                    {{ providerConnectionError(provider)!.msg }}
                  </p>

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
                      <template v-for="model in providerModelPreview(provider)" :key="model.id">
                        <!-- 非对话模型不参与当前模型选择，也不暴露聊天/tool-call 探测。 -->
                        <div
                          v-if="!isChatModelOption(model)"
                          class="hc-model-chip hc-model-chip--non-chat"
                          :data-model-name="model.name || model.id"
                          tabindex="0"
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
                          :data-model-name="model.name || model.id"
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
                          :data-model-name="model.name || model.id"
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
                  <div class="hc-provider__management-actions">
                    <button type="button" class="hc-provider__delete-btn" @click="openDeleteProviderConfirm(provider.id)">{{ t('settings.llm.deleteAction', '删除') }}</button>
                  </div>
                </div>
                </HcCollapsePanel>
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
              </main>
              <aside class="hc-settings__task-aside">
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
                <ModelSelector
                  v-model="selectedDefaultModelValue"
                  data-testid="llm-default-model-select"
                  class="hc-settings__select"
                  :empty-label="t('settings.llm.noEnabledModels')"
                  disable-when-empty
                />
              </div>
            </div>

            <div class="hc-settings__row">
              <span class="hc-settings__row-label">
                {{ t('chat.reasoning.defaultStrategy') }}
                <span class="hc-settings__info" :data-info="t('chat.reasoning.defaultStrategyHint')"
                  >?</span
                >
              </span>
              <div class="hc-settings__row-right">
                <ReasoningPolicySelect
                  v-model="defaultReasoningPolicyValue"
                  data-testid="llm-default-reasoning-policy"
                  class="hc-settings__select"
                  scope="global"
                  :support="selectedDefaultReasoningModel?.reasoningSupport ?? 'unknown'"
                  :control="selectedDefaultReasoningModel?.reasoningControl"
                  :native-support="selectedDefaultReasoningModel?.effectiveNativeReasoningSupport ?? selectedDefaultReasoningModel?.nativeReasoningSupport"
                  :aria-label="t('chat.reasoning.defaultStrategy')"
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
                    <button class="hc-settings__step-button" @click="stepMaxTools(-1)">−</button>
                    <input :value="maxToolsDisplay" readonly />
                    <button class="hc-settings__step-button" @click="stepMaxTools(1)">+</button>
                  </div>
                </div>
              </div>
            </div>

              </aside>
            </div>
          </div>

          <!-- Automation permissions（治理入口：级别/待处理/审计/矩阵） -->
          <div
            v-show="activeSection === 'automation'"
            class="hc-settings__section hc-settings__section--automation"
          >
            <AutomationPermissionsPanel />
          </div>

          <!-- System (merged: appearance + storage) -->
          <div v-show="activeSection === 'system'" class="hc-settings__section">
            <p class="hc-settings__immediate-note">Changes apply immediately. No additional save is required.</p>
            <!-- 系统偏好即时生效；服务、信息与品牌入口属于辅助列。 -->
            <div class="hc-settings__task-layout">
              <main class="hc-settings__task-main">
            <div class="hc-settings__form hc-settings__form--system">
              <div class="hc-settings__sep">
                <span class="hc-settings__sep-label">{{ t('settings.appearance.title') }}</span>
                <span class="hc-settings__sep-line"></span>
              </div>
              <div
                class="hc-settings__theme-row"
              >
                <span class="hc-settings__row-label">明暗模式</span>
                <div class="hc-settings__theme-segmented"
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
                  @change="saveImmediateSetting('memory')"
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
                  @change="saveImmediateSetting('sandbox')"
                />
              </label>
            </div>

              </main>
              <aside class="hc-settings__task-aside">
                <BackendServiceCard />
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
              <p class="hc-settings__about-intro">钳得住活，守得住数据，长得出本事。<br />一只 AI 螃蟹，可在本机运行，也可部署到云端。</p>
              <!-- 官网标准锚点交给全局外链控制器，鼠标和键盘均只有一次分发。 -->
              <nav class="hc-settings__about-links" aria-label="关于河蟹">
                <button type="button" class="hc-settings__about-link" @click="openAbout">关于</button>
                <a class="hc-settings__about-link" href="https://hexclaw.net/" target="_blank" rel="noopener noreferrer">访问官网 ↗</a>
                <button type="button" class="hc-settings__about-link" @click="showWechatFollow = true">关注公众号</button>
              </nav>
            </div>              </aside>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>

  <HcModal :open="showWechatFollow" title="关注公众号" :width="320" @close="showWechatFollow = false"><WechatFollowContent /></HcModal>
  <HcModal :open="showAddProvider" :title="t('settings.llm.addProvider')" :busy="addingProvider" initial-focus=".hc-provider-select__trigger" @close="closeAddProvider">
    <form class="hc-provider__add-form" :inert="addingProvider ? true : undefined" @submit.prevent="handleAddProvider">
      <div class="hc-provider__add-field"><label>{{ t('settings.llm.serviceProvider', 'Provider') }}</label><ProviderSelect v-model="addProviderType" :include-custom="true" /></div>
      <div v-if="addProviderType === 'custom'" class="hc-provider__add-field"><label for="add-provider-name">名称</label><HcClearableField><input id="add-provider-name" v-model="addProviderDraft.name" class="hc-input" autocomplete="off" placeholder="服务商名称" /></HcClearableField></div>
      <div class="hc-provider__add-field"><label for="add-provider-url">Base URL</label><HcClearableField><input id="add-provider-url" v-model="addProviderDraft.baseUrl" class="hc-input" autocomplete="off" spellcheck="false" /></HcClearableField></div>
      <div class="hc-provider__add-field"><label for="add-provider-key">API Key</label><div class="hc-settings__input-group"><HcClearableField :trailing="38"><input id="add-provider-key" v-model="addProviderDraft.apiKey" class="hc-input" :type="showAddProviderKey ? 'text' : 'password'" :placeholder="PROVIDER_PRESETS[addProviderType].placeholder || 'API Key'" autocomplete="off" spellcheck="false" /></HcClearableField><button type="button" class="hc-settings__eye-btn" :aria-label="showAddProviderKey ? '隐藏 API Key' : '显示 API Key'" @click="showAddProviderKey = !showAddProviderKey"><Eye :size="15" /></button></div></div>
    </form>
    <template #footer><button type="button" class="hc-btn" :disabled="addingProvider" @click="closeAddProvider">{{ t('common.cancel') }}</button><button type="button" class="hc-btn hc-btn-primary" :disabled="addingProvider" @click="handleAddProvider"><Loader2 v-if="addingProvider" :size="14" class="animate-spin" />{{ t('common.add', '添加') }}</button></template>
  </HcModal>

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
              <legend>核心能力（可多选，仅系统自动识别）</legend>
              <div class="hc-edit-model__caps">
                <label
                  v-for="cap in [
                    'text',
                    'vision',
                    'code',
                    'image_generation',
                    'video_generation',
                    'embedding',
                  ] as ModelCapability[]"
                  :key="cap"
                  class="hc-edit-model__cap-item"
                >
                  <input
                    v-model="newModelCapability[cap]"
                    type="checkbox"
                    :data-testid="`custom-model-cap-${cap}`"
                  />
                  <span class="hc-edit-model__cap-icon">{{
                    MODEL_CAPABILITY_DISPLAY[cap].icon
                  }}</span>
                  <span>{{ MODEL_CAPABILITY_DISPLAY[cap].label }}</span>
                </label>
              </div>
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
      pendingDeleteModel ? `${pendingDeleteModel.providerId}:${pendingDeleteModel.modelId}` : null
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
    :key="modelManagerProvider.id"
    :open="!!modelManagerProvider"
    :provider="modelManagerProvider"
    :syncing="managerSyncing"
    @close="closeModelManager"
    @change="handleManagerModelsChange"
    @resync="handleManagerResync"
  />
</template>

<style scoped>
/* 模型服务的长控件共用右侧 360px 轨道；短开关与计数器沿同一右边界。 */
.hc-settings__section.hc-settings__section--llm{container-name:model-settings settings-content}
.hc-settings__section--llm .hc-settings__row{min-height:48px}
.hc-settings__section--llm .hc-settings__row-label{font-size:14px;min-width:0;flex-shrink:1}
.hc-settings__section--llm .hc-settings__row-right{width:360px;min-width:0;gap:12px;justify-content:flex-end}
.hc-settings__section--llm .hc-settings__select{width:100%;min-width:0}
.hc-settings__section--llm [data-testid="llm-routing-strategy-select"] :deep(.hc-select__trigger),.hc-settings__section--llm [data-testid="llm-agent-mode-select"] :deep(.hc-select__trigger){height:34px;min-height:34px;font-size:13px;line-height:normal}
.hc-settings__section--llm .hc-settings__row-right:has(.hc-toggle) .hc-settings__select{width:314px}
.hc-settings__section--llm .hc-settings__row-right>.hc-toggle{margin:0;flex:0 0 34px}
.hc-settings__section--llm .hc-settings__sub{position:relative;padding-left:0;border-left:0;margin-left:0;margin-top:0}
.hc-settings__section--llm .hc-settings__sub::before{content:'';position:absolute;left:4px;top:4px;bottom:4px;width:1px;background:var(--hc-border-hl)}
.hc-settings__section--llm .hc-settings__sub .hc-settings__row{min-height:48px}
.hc-settings__section--llm .hc-settings__sub .hc-settings__row-label{padding-left:16px;font-size:12px}
.hc-settings__section--llm .hc-settings__sep{margin-top:28px}
.hc-settings__section--llm>.hc-settings__sep:first-child{margin-top:0}
.hc-settings__section--llm .hc-settings__sep-label{font-size:14px;font-weight:600;letter-spacing:0;text-transform:none;color:var(--hc-text-secondary)}
.hc-settings__section--llm .hc-provider__card{backdrop-filter:saturate(160%) blur(16px);-webkit-backdrop-filter:saturate(160%) blur(16px)}
.hc-settings__section--llm .hc-settings__sep-action{padding:7px 10px;border:1px solid var(--hc-border);border-radius:8px;background:var(--hc-bg-input);font-size:13px;font-weight:500;line-height:1.5;min-height:0}
:global([data-theme="light"] .hc-settings__section--llm .hc-settings__sep-action){color:#2879b9}
.hc-provider__add-form{display:grid;gap:16px}
.hc-provider__add-field{display:grid;gap:7px;min-width:0}
.hc-provider__add-field>label{font-size:12px;font-weight:600;line-height:18px;color:var(--hc-text-secondary)}
.hc-provider__add-field .hc-input{width:100%;font:inherit;font-size:13px;line-height:1.5}
.hc-provider__add-field .hc-settings__input-group .hc-input{padding-right:70px}
.hc-provider__management-actions{display:flex;justify-content:flex-end;padding-top:12px;margin-top:8px;border-top:1px solid var(--hc-border)}
.hc-provider__drag-handle{grid-column:1;display:grid;place-items:center;width:28px;height:32px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--hc-text-muted);opacity:.45;cursor:grab;touch-action:none;user-select:none}
.hc-provider__card:hover .hc-provider__drag-handle,.hc-provider__drag-handle:focus-visible{opacity:1}
.hc-provider__drag-handle:focus-visible,.hc-provider__expand:focus-visible{outline:2px solid var(--hc-accent);outline-offset:2px}
.hc-provider__drag-handle:active,.hc-provider__card-head:active{cursor:grabbing}
.hc-provider__expand{grid-column:7;display:grid;place-items:center;width:24px;height:32px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--hc-text-muted);cursor:pointer}
.hc-provider__expand:hover{background:var(--hc-bg-hover);color:var(--hc-accent)}
.hc-provider__expand svg{transition:transform 180ms var(--hc-ease-out,ease-out)}
.hc-provider__expand svg.is-expanded{transform:rotate(180deg)}
@media(prefers-reduced-motion:reduce){.hc-provider__expand svg{transition:none}}
.hc-provider__card.hc-provider__card--dragging{opacity:.45}
.hc-provider__drop-before::before,.hc-provider__drop-after::after{content:'';position:absolute;left:0;right:0;height:2px;background:var(--hc-accent);border-radius:2px;pointer-events:none}
.hc-provider__drop-before::before{top:-5px}.hc-provider__drop-after::after{bottom:-5px}
.hc-provider__sr-only{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
:global([data-theme="dark"] .hc-settings__section--llm .hc-model-chip--manage),:global([data-theme="dark"] .hc-settings__section--llm .hc-model-chip--add){color:#a8b3c2}
:global([data-theme="light"] .hc-settings__section--llm .hc-provider__connection-detail),:global([data-theme="light"] .hc-settings__section--llm .hc-provider__delete-btn){color:#c62828}
:global([data-theme="light"] .hc-settings__section--llm .hc-provider__connection-status--ok){color:#1b7e3c}
:global([data-theme="light"] .hc-settings__section--llm .hc-provider__connection-status--error){color:#c62828}
:global([data-theme="dark"] .hc-settings__section--llm .hc-provider__connection-status:not(.hc-provider__connection-status--testing):not(.hc-provider__connection-status--ok):not(.hc-provider__connection-status--error)){color:#a8b3c2}
@container model-settings (max-width:620px){
  .hc-settings__section--llm .hc-provider__card-head{grid-template-columns:28px 34px minmax(0,1fr) 34px 24px;gap:8px 12px}
  .hc-settings__section--llm .hc-provider__drag-handle{grid-column:1;grid-row:1/3;align-self:start}
  .hc-settings__section--llm .hc-provider__logo{grid-column:2;grid-row:1}
  .hc-settings__section--llm .hc-provider__card-identity{grid-column:3;grid-row:1}
  .hc-settings__section--llm .hc-provider__toggle{grid-column:4;grid-row:1}
  .hc-settings__section--llm .hc-provider__expand{grid-column:5;grid-row:1}
  .hc-settings__section--llm .hc-provider__connection-status{grid-column:2/4;grid-row:2;justify-content:flex-start}
  .hc-settings__section--llm .hc-provider__test-btn{grid-column:4/6;grid-row:2;justify-self:end}
}
@container model-settings (max-width:500px){
  .hc-settings__section--llm .hc-settings__row{gap:8px;min-height:48px;padding:6px 0}
  .hc-settings__section--llm .hc-settings__row-right{width:auto}
  .hc-settings__section--llm .hc-settings__row:has(.hc-settings__select){display:grid;grid-template-columns:minmax(0,1fr);min-height:60px}
  .hc-settings__section--llm .hc-settings__row:has(.hc-settings__select)>.hc-settings__row-label{grid-column:1/-1}
  .hc-settings__section--llm .hc-settings__row:has(.hc-settings__select)>.hc-settings__row-right{width:100%;grid-column:1/-1}
  .hc-settings__section--llm .hc-settings__row-right:has(.hc-toggle) .hc-settings__select{width:auto;flex:1;min-width:0}
}
@media(prefers-reduced-motion:reduce){.hc-settings__section.hc-settings__section--llm,.hc-settings__section--llm .hc-provider__connection-status--ok{animation:none}}

.hc-settings__task-return {
  margin-bottom: 16px;
  border: 0.5px solid var(--hc-border);
  border-radius: 12px;
  background: var(--hc-bg-card);
  padding: 11px 13px;
  font-size: 12.5px;
  color: var(--hc-text-secondary);
  line-height: 1.55;
}
.hc-settings__task-return > div {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}
.hc-settings__task-return span {
  flex: 1;
  min-width: 180px;
}
.hc-settings__task-return button {
  border-radius: 10px;
}
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
  max-width: none;
  width: 100%;
  min-height: 100%;
  display: flex;
  flex-direction: column;
  container-type: inline-size;
  container-name: settings-content;
  animation: hc-fade-in 0.25s ease-out;
}

.hc-settings__section--storage {
  max-width: 760px;
  margin: 0;
  padding-right: 4px;
}

/* 三个设置分区沿同一内容宽度，不因标签切换改变共同边界。 */
.hc-settings__section--automation {
  max-width: none;
}

/* 主辅列以设置正文可用宽度判断；单列顺序保持任务主区在前。 */
.hc-settings__task-layout{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:28px;width:100%;align-items:start}
.hc-settings__task-main,.hc-settings__task-aside{min-width:0}
.hc-settings__task-aside{padding-left:24px;border-left:1px solid var(--hc-border);box-sizing:border-box}
.hc-settings__task-aside .hc-settings__row{flex-direction:column;align-items:stretch;gap:8px}
.hc-settings__task-aside .hc-settings__row-right{width:100%;max-width:100%}
.hc-settings__task-aside .hc-settings__select{width:100%;max-width:100%}
.hc-settings__task-aside .hc-settings__info-grid{grid-template-columns:1fr}
.hc-settings__task-aside .hc-settings__sep:first-child{margin-top:0}
.hc-settings__theme-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--hc-border)}
.hc-settings__theme-row .hc-settings__theme-segmented{width:360px;max-width:100%;height:36px;min-height:36px;margin:0;flex-shrink:1}
.hc-settings__section--llm .hc-settings__task-aside .hc-settings__row-right:has(.hc-toggle) .hc-settings__select{flex:1;width:0;min-width:0}
.hc-settings__task-aside .hc-settings__row-label{font-size:12.5px}
.hc-settings__task-main .hc-provider__card{padding:12px;border-radius:10px}
.hc-settings__task-main .hc-settings__sep:first-child{margin-top:0}
.hc-settings__about{padding:14px;border:1px solid var(--hc-border);border-radius:var(--hc-radius-md);background:var(--hc-bg-card)}
.hc-settings__about-links{display:flex;align-items:center;flex-wrap:wrap;gap:14px}
.hc-settings__about-links .hc-settings__about-link{padding:0;text-decoration:none;font-size:12.5px}
@container settings-content (max-width:1039px){.hc-settings__task-layout{grid-template-columns:minmax(0,1fr)}.hc-settings__task-aside{padding-left:0;border-left:0}.hc-settings__task-aside .hc-settings__row{flex-direction:row;align-items:center}.hc-settings__task-aside .hc-settings__row-right{width:360px;max-width:60%}}
@container settings-content (max-width:560px){.hc-settings__theme-row{flex-direction:column;align-items:flex-start;gap:8px}.hc-settings__task-aside .hc-settings__row{flex-direction:column;align-items:stretch}.hc-settings__task-aside .hc-settings__row-right{width:100%;max-width:100%}}

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
  max-width: 780px;
  container-type: inline-size;
  container-name: system-settings-form;
}
.hc-settings__immediate-note{margin:0 0 16px;max-width:72ch;font-size:12px;line-height:1.5;color:var(--hc-text-secondary)}
.hc-settings__form--system > .hc-settings__toggle-row{padding:12px 0;border-bottom:1px solid var(--hc-divider,var(--hc-border))}
.hc-settings__form--system > .hc-settings__toggle-row:last-child{border-bottom:0}

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
  border-radius: 999px;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  display: grid;
  align-items: center;
  transition: color 0.15s;
}

.hc-settings__eye-btn:hover {
  background: color-mix(in srgb, var(--hc-text-muted) 14%, transparent);
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

.hc-settings__select :deep(.hc-select__trigger) {
  height: 37px;
  padding: 7px 11px;
  font-size: 14px;
  gap: 10px;
}

.hc-settings__select :deep(.hc-select__arrow) {
  position: static;
  width: 13px;
  height: 13px;
  margin-left: auto;
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
  box-shadow:
    var(--hc-shadow-sm),
    inset 0 0 0 0.5px var(--hc-border);
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
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
  margin-top: 8px;
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
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-sizing: border-box;
  padding: 16px 20px;
  border-radius: 16px;
  background: var(--hc-bg-card);
  border: 0.5px solid var(--hc-border);
  overflow: visible;
  container-type: inline-size;
  transition: border-color 0.15s;
}

.hc-provider__card:hover {
  border-color: var(--hc-border-hl);
}

.hc-provider__card--disabled {
  opacity: 0.6;
}

.hc-provider__card-head {
  display: grid;
  grid-template-columns: 28px 34px minmax(0, 1fr) 128px 64px 34px 24px;
  align-items: center;
  gap: 12px;
  min-width: 0;
  min-height: 44px;
  margin: 0;
  cursor: grab;
}

.hc-provider__card-info {
  display: contents;
}

.hc-provider__card-info::after {
  display: none;
}

.hc-provider__logo {
  grid-column: 2;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  overflow: hidden;
  flex: 0 0 34px;
  color: #3f5f7b;
}

.hc-provider__card[data-provider-type='custom'] .hc-provider__logo {
  background: var(--hc-bg-input);
}

.hc-provider__logo img {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  object-fit: contain;
}

.hc-provider__card-identity {
  grid-column: 3;
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
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
  font-size: 16px;
  line-height: 1.4;
  font-weight: 600;
  color: var(--hc-text-primary);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: none;
}

.hc-provider__card-meta {
  overflow: hidden;
  color: var(--hc-text-secondary);
  margin-top: 3px;
  font-size: 13px;
  line-height: 1.5;
  min-height: 0;
  white-space: nowrap;
  text-overflow: ellipsis;
  cursor: text;
  user-select: text;
}

.hc-provider__card-actions {
  display: contents;
  margin-left: auto;
  margin-right: 0;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 0 0 auto;
}

.hc-provider__connection-status {
  display: flex;
  align-items: center;
  grid-column: 4;
  justify-content: flex-start;
  width: 128px;
  gap: 7px;
  min-height: 26px;
  box-sizing: border-box;
  padding: 0;
  border-radius: 0;
  color: var(--hc-text-muted);
  background: transparent;
  font-size: 13px;
  font-weight: 500;
  cursor: text;
  user-select: text;
  white-space: nowrap;
  transition:
    color 0.18s,
    background 0.18s;
  flex: 0 0 auto;
}

.hc-provider__connection-status--testing {
  color: var(--hc-accent);
  background: transparent;
}

.hc-provider__connection-status--ok {
  color: var(--hc-success);
  background: transparent;
  animation: hc-provider-status-pop 0.22s ease-out;
}

.hc-provider__connection-status--error {
  color: var(--hc-error);
  background: transparent;
}

.hc-provider__connection-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  opacity: 1;
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
  grid-column: 5;
  width: 64px;
  height: 34px;
  flex: 0 0 auto;
  justify-content: center;
  gap: 6px;
  padding: 7px 10px;
  border-color: rgba(95, 179, 234, 0.5);
  background: transparent;
  color: #3f8fd4;
  font-size: 13px;
  white-space: nowrap;
}

.hc-provider__connection-detail {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  color: var(--hc-error);
  background: color-mix(in srgb, var(--hc-error) 8%, transparent);
  font-size: 11.5px;
  line-height: 1.45;
  word-break: break-word;
}

.hc-provider__connection-status {
  min-width: 128px;
  background: transparent;
}

.hc-provider__connection-status--testing {
  background: transparent;
}

.hc-provider__connection-status--ok {
  background: transparent;
}

.hc-provider__connection-status--error {
  background: transparent;
}

.hc-provider__config-grid--builtin {
  margin: 0;
  padding: 3px 0 5px;
}

.hc-provider__config-grid--builtin .hc-input {
  display: inline-block;
}

.hc-provider__config-grid .hc-settings__field {
  gap: 5px;
}

.hc-provider__config-grid .hc-settings__label {
  color: var(--hc-text-primary);
  font-size: 12px;
  font-weight: 650;
}

.hc-provider__config-grid--builtin .hc-provider__config-url .hc-input {
  padding-right: 40px;
}

.hc-provider__config-grid--builtin .hc-provider__config-key .hc-input {
  padding-right: 70px;
}

.hc-provider__toggle {
  grid-column: 6;
  position: relative;
  width: 34px;
  height: 20px;
  flex: 0 0 34px;
  padding: 2px;
  /* 固定 34px 轨道不叠加原生 checkbox 外边距。 */
  margin: 0;
  border: none;
  border-radius: 999px;
  background: var(--hc-text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  transition: background 0.15s ease;
}

.hc-provider__toggle--on {
  background: var(--hc-accent);
}

.hc-provider__toggle-knob {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  transition: transform 0.15s ease;
}

.hc-provider__toggle--on .hc-provider__toggle-knob {
  transform: translateX(14px);
}

.hc-provider__chevron {
  width: 15px;
  height: 15px;
  color: var(--hc-text-muted);
  flex: 0 0 auto;
}

.hc-provider__edit {
  padding: 0;
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  container-type: inline-size;
}

.hc-provider__config-grid {
  /* 服务商地址和令牌各占整行，自定义名称独占首行。 */
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px 12px;
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
  display: block;
  flex: 0 0 auto;
  height: 30px;
  padding: 0 7px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--hc-error);
  font-size: 11.5px;
  line-height: 17.25px;
  cursor: pointer;
  transition: background 0.15s;
  white-space: nowrap;
}

.hc-provider__delete-btn:hover {
  background: rgba(255, 69, 58, 0.1);
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
  grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr));
  gap: 7px;
}

.hc-model-chips > .hc-model-chip {
  position: relative;
  height: 38px;
  padding: 6px 11px;
  gap: 5px;
  border-radius: 999px;
}

/* 完整名称提示脱离文档流，悬停和聚焦均不改变网格尺寸。 */
.hc-model-chip[data-model-name]::after {
  content: attr(data-model-name);
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  box-sizing: border-box;
  width: max-content;
  max-width: 100%;
  padding: 8px 12px;
  border-radius: var(--hc-radius-md);
  background: var(--hc-text-primary);
  color: var(--hc-text-inverse, #fff);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.5;
  white-space: normal;
  overflow-wrap: anywhere;
  text-align: left;
  pointer-events: none;
  visibility: hidden;
  z-index: 100;
}

.hc-model-chip[data-model-name]:hover::after,
.hc-model-chip[data-model-name]:focus-visible::after,
.hc-model-chip[data-model-name]:has(:focus-visible)::after {
  visibility: visible;
}

html[data-hc-window-active='false'] .hc-model-chip[data-model-name]::after {
  visibility: hidden;
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
  font-weight: 550;
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
  gap: 5px;
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
  flex: none;
  margin-left: 0;
  width: 18px;
  height: 18px;
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
  flex: none;
  margin-left: 0;
  width: 18px;
  height: 18px;
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

.hc-model-chip__cap--text,
.hc-model-chip__cap--thinking {
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
    padding: 16px 24px;
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
/* 系统长控件遵从局部表单宽度；末尾响应规则不被通用行和240px下拉基础样式覆盖。 */
.hc-settings__form--system > .hc-settings__row .hc-settings__row-right{width:360px;max-width:100%;min-width:0}
.hc-settings__form--system > .hc-settings__row .hc-settings__select{width:100%;max-width:100%}
@container system-settings-form (max-width:560px){
  .hc-settings__form--system > .hc-settings__row:has(.hc-settings__select){flex-direction:column;align-items:flex-start;gap:8px;padding:6px 0;min-height:60px;box-sizing:border-box}
  .hc-settings__form--system .hc-settings__theme-row{flex-direction:column;align-items:flex-start;gap:8px;padding:8px 0}
}
</style>
