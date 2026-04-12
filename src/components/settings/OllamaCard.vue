<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'

// 模型目录：name + 预估 RAM（GB，基于 Q4_K_M 量化）
interface ModelEntry { name: string; ram: number }

const OLLAMA_MODEL_CATALOG: ModelEntry[] = [
  // Qwen3.5（阿里最新，支持图文，全面取代 Qwen3/2.5）
  { name: 'qwen3.5:0.8b', ram: 1 }, { name: 'qwen3.5:2b', ram: 2 }, { name: 'qwen3.5:4b', ram: 3 }, { name: 'qwen3.5:9b', ram: 6 },
  { name: 'qwen3.5:27b', ram: 17 }, { name: 'qwen3.5:35b', ram: 22 }, { name: 'qwen3.5:122b', ram: 75 },
  // Qwen3 专项（Qwen3.5 暂无对应替代）
  { name: 'qwen3-coder:4b', ram: 3 }, { name: 'qwen3-coder:8b', ram: 5 }, { name: 'qwen3-coder:14b', ram: 9 }, { name: 'qwen3-coder:30b', ram: 19 },
  { name: 'qwen3-vl:4b', ram: 3 }, { name: 'qwen3-vl:8b', ram: 6 }, { name: 'qwen3-vl:30b', ram: 20 },
  // DeepSeek
  { name: 'deepseek-r1:1.5b', ram: 1.5 }, { name: 'deepseek-r1:7b', ram: 5 }, { name: 'deepseek-r1:8b', ram: 5 },
  { name: 'deepseek-r1:14b', ram: 9 }, { name: 'deepseek-r1:32b', ram: 20 }, { name: 'deepseek-r1:70b', ram: 43 },
  { name: 'deepseek-v3', ram: 400 }, { name: 'deepseek-v3:671b', ram: 400 }, { name: 'deepseek-r1', ram: 400 },
  // Gemma 4（Google 最新，多模态，MoE）
  { name: 'gemma4:e2b', ram: 4 }, { name: 'gemma4:e4b', ram: 6 }, { name: 'gemma4:26b', ram: 10 }, { name: 'gemma4:31b', ram: 12 },
  // Gemma 3
  { name: 'gemma3:1b', ram: 1 }, { name: 'gemma3:4b', ram: 3 }, { name: 'gemma3:12b', ram: 8 }, { name: 'gemma3:27b', ram: 17 },
  // Llama（3.2 有独特小尺寸，3.3 是 70B 旗舰）
  { name: 'llama3.2:1b', ram: 1 }, { name: 'llama3.2:3b', ram: 2 }, { name: 'llama3.3', ram: 43 }, { name: 'llama3.3:70b', ram: 43 },
  // Phi 4（微软）
  { name: 'phi4-mini', ram: 3 }, { name: 'phi4', ram: 9 }, { name: 'phi4-reasoning', ram: 9 },
  // Mistral / Devstral
  { name: 'devstral', ram: 15 }, { name: 'mistral', ram: 5 }, { name: 'mistral-nemo', ram: 8 }, { name: 'mistral-small', ram: 14 },
  // 其他
  { name: 'command-r', ram: 21 }, { name: 'command-r-plus', ram: 63 }, { name: 'smollm2', ram: 1 }, { name: 'starcoder2', ram: 2 },
  // Embedding
  { name: 'nomic-embed-text', ram: 0.3 }, { name: 'mxbai-embed-large', ram: 0.7 },
]

// 兼容层：纯名称列表
const OLLAMA_MODEL_LIST = OLLAMA_MODEL_CATALOG.map(m => m.name)

// RAM 查找表
const MODEL_RAM_MAP = new Map(OLLAMA_MODEL_CATALOG.map(m => [m.name, m.ram]))

// 空输入时展示的精选列表
// 排序原则：大众电脑（8-16GB 内存）能跑的优先，同尺寸选质量最高的
const OLLAMA_FEATURED = [
  'qwen3.5:9b',        // 6GB — 最新最强，16GB 轻松跑
  'gemma4:e4b',        // 6GB — Google 多模态，vision+tools+thinking
  'gemma4:26b',        // 10GB — Google MoE，3.8B 激活，速度快质量高
  'deepseek-r1:14b',   // 9GB — 推理/数学最强
  'phi4',               // 9GB — 微软，小模型之王
  'qwen3.5:27b',       // 17GB — 质量天花板，32GB 舒适
  'gemma4:31b',        // 12GB — Google Dense 旗舰
  'deepseek-r1:32b',   // 20GB — 32GB 内存推理最优
  'devstral',           // 15GB — Mistral 编码专项，SWE-bench 68%
  'qwen3-coder:8b',    // 5GB — 阿里编码专项，16GB 轻松跑
]

// 本机总内存（GB）
const systemMemoryGB = ref(0)
async function detectSystemMemory() {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke<{ os: string; arch: string }>('get_platform_info')
    // Tauri 没有直接获取内存的 API，从 navigator 获取（Chrome/WebView 支持）
    if ('deviceMemory' in navigator) {
      systemMemoryGB.value = (navigator as unknown as { deviceMemory: number }).deviceMemory
    }
  } catch { /* ignore */ }
  // fallback：如果 deviceMemory 不可用，默认 8GB 保守估计
  if (!systemMemoryGB.value) systemMemoryGB.value = 8
}

function getModelRamHint(name: string): string {
  const ram = MODEL_RAM_MAP.get(name)
  if (!ram) return ''
  return `~${ram >= 1 ? ram + ' GB' : Math.round(ram * 1024) + ' MB'}`
}

function isModelRecommended(name: string): boolean {
  const ram = MODEL_RAM_MAP.get(name)
  if (!ram) return false
  // 推荐条件：模型所需 RAM ≤ 系统内存的 80%（留空间给系统和上下文）
  return ram <= systemMemoryGB.value * 0.8
}

function isModelTooLarge(name: string): boolean {
  const ram = MODEL_RAM_MAP.get(name)
  if (!ram) return false
  return ram > systemMemoryGB.value
}
import { useI18n } from 'vue-i18n'
import {
  Server,
  Loader2,
  CheckCircle,
  RefreshCw,
  AlertCircle,
  Circle,
  Download,
  ExternalLink,
  Power,
  MessageSquare,
} from 'lucide-vue-next'
import {
  getOllamaStatus, pullOllamaModel, getOllamaRunning,
  loadOllamaModel, unloadOllamaModel, deleteOllamaModel, restartOllama,
  type OllamaStatus, type OllamaRunningModel,
} from '@/api/ollama'
import { logger } from '@/utils/logger'
import { useSettingsStore } from '@/stores/settings'
import { useRouter } from 'vue-router'
import { waitForOllamaModelVisibility } from '@/utils/ollama-visibility'

const settingsStore = useSettingsStore()
const router = useRouter()

/** 跳转到对话页并预选指定模型 */
async function goChat(modelName: string) {
  await refreshModels()
  router.push({ path: '/chat', query: { model: modelName } })
}

const POLL_INTERVAL = 3000
const PULL_DONE = '__pull_done__' // 内部状态标记，模板中比对用
const POST_PULL_REFRESH_INTERVAL = 1000
const POST_PULL_REFRESH_RETRIES = 4

const { t } = useI18n()

const status = ref<OllamaStatus | null>(null)
const detecting = ref(false)
const error = ref('')
const waitingInstall = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null
let postPullVisibilityAbort: AbortController | null = null

type CardState =
  | 'detecting'
  | 'not_running'
  | 'waiting_install'
  | 'associated'
  | 'error'

/** 仅统计已启用的 Ollama 行；禁用时不算「已关联」，否则会跳过自动关联且会话页无模型 */
const hasOllamaProvider = computed(() =>
  settingsStore.config?.llm.providers.some(
    p =>
      p.enabled &&
      (p.type === 'ollama' ||
        p.backendKey?.toLowerCase().includes('ollama') ||
        p.name?.toLowerCase().includes('ollama')),
  ) ?? false,
)

const state = computed<CardState>(() => {
  if (detecting.value && !waitingInstall.value) return 'detecting'
  if (waitingInstall.value) return 'waiting_install'
  if (error.value) return 'error'
  if (!status.value || !status.value.running) return 'not_running'
  // Ollama 运行中 → 直接视为已关联（后端默认已创建 Provider，无需手动关联步骤）
  return 'associated'
})

const stateLabel = computed(() => {
  switch (state.value) {
    case 'detecting':
      return t('settings.ollama.detecting', '检测中…')
    case 'not_running':
      return t('settings.ollama.notRunning', '未运行')
    case 'waiting_install':
      return t('settings.ollama.waitingInstall', '等待安装…')
    case 'associated':
      return hasOllamaProvider.value
        ? t('settings.ollama.associated', '已连接')
        : t('settings.llm.disabled', '已禁用')
    case 'error':
      return t('settings.ollama.error', '检测失败')
  }
  return ''
})

async function detect() {
  if (detecting.value && !waitingInstall.value) return
  detecting.value = true
  error.value = ''
  try {
    status.value = await getOllamaStatus()
    if (status.value?.running) {
      await refreshRunning()
      // Ollama 运行中 → 自动确保 Provider 存在并同步模型列表
      if (!hasOllamaProvider.value) {
        emit('associate')
      }
      await settingsStore.syncOllamaModels()

      // 自动预热：默认 provider 是 Ollama + 运行中 + 有已下载模型 + 无模型在跑 → 自动加载
      const dpId = settingsStore.config?.llm.defaultProviderId
      const dp = settingsStore.config?.llm.providers.find(p => p.id === dpId)
      const isOllamaDefault = dp && (
        dp.type === 'ollama' ||
        dp.backendKey?.toLowerCase().includes('ollama') ||
        dp.name?.toLowerCase().includes('ollama')
      )
      if (isOllamaDefault && runningModels.value.length === 0 && status.value?.models?.length) {
        const downloadedNames = status.value.models.map(m => m.name)
        // 优先：默认模型在已下载列表中 → 加载它
        const defaultModel = settingsStore.config?.llm.defaultModel
        const defaultInLocal = defaultModel && downloadedNames.includes(defaultModel)
        // 回退：加载第一个已下载的模型
        const modelToLoad = defaultInLocal ? defaultModel : downloadedNames[0]
        if (modelToLoad) {
          try {
            await loadOllamaModel(modelToLoad)
            await refreshRunning()
          } catch (e) {
            logger.warn('[OllamaCard] 预热失败:', e)
          }
        }
      }
    }
    // If Ollama is now running, stop polling
    if (status.value?.running && waitingInstall.value) {
      stopPolling()
    }
  } catch (e) {
    // During install polling, don't show errors — just keep waiting
    if (!waitingInstall.value) {
      error.value = e instanceof Error ? e.message : 'Unknown error'
      status.value = null
    }
  } finally {
    detecting.value = false
  }
}

function startInstall() {
  waitingInstall.value = true
  error.value = ''
  startPolling()
}

function cancelWaiting() {
  stopPolling()
}

function startPolling() {
  clearPollTimer()
  pollTimer = setInterval(() => detect(), POLL_INTERVAL)
}

function stopPolling() {
  clearPollTimer()
  waitingInstall.value = false
}

function clearPollTimer() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function cancelPostPullRefresh() {
  if (postPullVisibilityAbort) {
    postPullVisibilityAbort.abort()
    postPullVisibilityAbort = null
  }
}

function hasDetectedModel(name: string): boolean {
  // Ollama 模型名可能带 :latest 后缀（用户输入 "qwen3" → 存为 "qwen3:latest"）
  return status.value?.models?.some(model =>
    model.name === name ||
    model.name === `${name}:latest` ||
    model.name.replace(/:latest$/, '') === name,
  ) ?? false
}

async function refreshModelsUntilDetected(name: string) {
  cancelPostPullRefresh()
  postPullVisibilityAbort = new AbortController()
  return waitForOllamaModelVisibility({
    sync: refreshModels,
    isVisible: () => hasDetectedModel(name),
    intervalMs: POST_PULL_REFRESH_INTERVAL,
    maxRetries: POST_PULL_REFRESH_RETRIES,
    signal: postPullVisibilityAbort.signal,
  })
}

async function finalizePulledModel(model: string) {
  const visible = await refreshModelsUntilDetected(model)
  if (!visible) {
    pullStatus.value = ''
    pullProgress.value = 0
    pullDetail.value = ''
    lastDownloaded.value = ''
    pullError.value = t(
      'settings.ollama.modelNotDetected',
      '下载流已结束，但本地未检测到模型。请重试，或检查磁盘空间 / Ollama 日志。',
    )
    return
  }

  pullStatus.value = PULL_DONE
  pullDetail.value = ''
  lastDownloaded.value = model
  pullModelName.value = ''
}

// ─── 运行状态管理 ───────────────────────────
const runningModels = ref<OllamaRunningModel[]>([])
const unloadingModel = ref('')
const deletingModel = ref('')

function isModelRunning(name: string): boolean {
  return runningModels.value.some(m => m.name === name)
}

async function refreshRunning() {
  try {
    runningModels.value = await getOllamaRunning()
  } catch { /* ignore */ }
}

async function handleUnload(name: string) {
  unloadingModel.value = name
  try {
    await unloadOllamaModel(name)
    await refreshRunning()
  } catch { /* ignore */ }
  unloadingModel.value = ''
}

const deleteError = ref('')

async function handleDelete(name: string) {
  deletingModel.value = name
  deleteError.value = ''
  try {
    // 运行中的模型先 unload，再删除
    if (isModelRunning(name)) {
      await unloadOllamaModel(name)
      await refreshRunning()
    }
    await deleteOllamaModel(name)
    await refreshModels()
  } catch (e) {
    deleteError.value = e instanceof Error ? e.message : t('settings.ollama.deleteFailed', '删除失败')
    // 3 秒后自动清除错误提示
    setTimeout(() => { deleteError.value = '' }, 3000)
  }
  deletingModel.value = ''
}

/** 刷新模型列表 + 同步 Provider（不触发 detecting 状态切换） */
async function refreshModels() {
  try {
    const s = await getOllamaStatus()
    if (s) {
      status.value = s
      if (s.running) {
        await settingsStore.syncOllamaModels()
      }
    }
  } catch { /* ignore */ }
}

// ─── Ollama 重启 ───────────────────────────
const restarting = ref(false)

/** 重启 Ollama — 优先 Tauri 命令（直接管理进程），回退到 sidecar API */
async function handleRestart() {
  restarting.value = true
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('restart_ollama')
    await detect()
  } catch {
    // 非 Tauri 环境或 Tauri 命令失败 → 回退到 sidecar API
    try {
      await restartOllama()
      await detect()
    } catch { /* ignore */ }
  }
  restarting.value = false
}

/** 重启内嵌 Ollama 引擎（Tauri 命令，主体按钮用） */
async function handleRestartEngine() {
  restarting.value = true
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('restart_ollama')
  } catch { /* 非 Tauri 环境或命令失败 */ }
  await detect()
  restarting.value = false
}

function formatSize(bytes: number): string {
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(0)} MB`
  return `${(bytes / 1e9).toFixed(1)} GB`
}

// ─── 模型下载 ───────────────────────────────
const pullModelName = ref('')
const pulling = ref(false)
const pullStatus = ref('')
const pullProgress = ref(0) // 0-100
const pullDetail = ref('') // "1.2 GB / 4.7 GB · 15.3 MB/s"
const pullError = ref('')
const pullInputError = ref(false)
const lastDownloaded = ref('') // 最近下载完成的模型名
let lastCompleted = 0
let lastSpeedTime = 0
let stallTimer: ReturnType<typeof setTimeout> | null = null
let pullAbort: AbortController | null = null

// ─── 模型下拉建议 ───────────────────────────
const showModelDropdown = ref(false)
const dropdownIndex = ref(-1)
const pullFieldWrapRef = ref<HTMLElement | null>(null)
const dropdownStyle = ref<Record<string, string>>({})

function updateDropdownPosition() {
  if (!pullFieldWrapRef.value) return
  const rect = pullFieldWrapRef.value.getBoundingClientRect()
  const maxDropdown = 240
  const spaceBelow = window.innerHeight - rect.bottom - 8
  const spaceAbove = rect.top - 8
  if (spaceBelow >= 120 || spaceBelow >= spaceAbove) {
    dropdownStyle.value = {
      position: 'fixed',
      top: `${rect.bottom + 4}px`,
      left: `${rect.left}px`,
      width: `${rect.width}px`,
      maxHeight: `${Math.min(maxDropdown, spaceBelow)}px`,
    }
  } else {
    dropdownStyle.value = {
      position: 'fixed',
      bottom: `${window.innerHeight - rect.top + 4}px`,
      left: `${rect.left}px`,
      width: `${rect.width}px`,
      maxHeight: `${Math.min(maxDropdown, spaceAbove)}px`,
    }
  }
}

watch(showModelDropdown, (show) => {
  if (show) updateDropdownPosition()
})

const filteredModels = computed(() => {
  const q = pullModelName.value.trim().toLowerCase()
  if (!q) return OLLAMA_FEATURED
  return OLLAMA_MODEL_LIST.filter(m => m.toLowerCase().includes(q)).slice(0, 10)
})

function selectModel(name: string) {
  pullModelName.value = name
  showModelDropdown.value = false
  dropdownIndex.value = -1
}

async function selectAndPull(name: string) {
  pullModelName.value = name
  showModelDropdown.value = false
  dropdownIndex.value = -1
  await startPull()
}

function onPullKeydown(e: KeyboardEvent) {
  if (!showModelDropdown.value || !filteredModels.value.length) {
    if (e.key === 'Enter') startPull()
    return
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    dropdownIndex.value = Math.min(dropdownIndex.value + 1, filteredModels.value.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    dropdownIndex.value = Math.max(dropdownIndex.value - 1, -1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (dropdownIndex.value >= 0) {
      selectModel(filteredModels.value[dropdownIndex.value]!)
    } else {
      startPull()
    }
  } else if (e.key === 'Escape') {
    showModelDropdown.value = false
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(0)} KB`
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`
  return `${(bytes / 1e9).toFixed(2)} GB`
}

function resetStallTimer() {
  if (stallTimer) clearTimeout(stallTimer)
  stallTimer = setTimeout(() => {
    if (pulling.value && pullProgress.value < 100) {
      pullDetail.value += ` (${t('settings.ollama.stalling', '等待中...')})`
    }
  }, 15000) // 15 秒无进度则提示
}

async function startPull() {
  const model = pullModelName.value.trim()
  if (pulling.value) return
  if (!model) {
    pullInputError.value = true
    setTimeout(() => { pullInputError.value = false }, 2000)
    return
  }
  pullInputError.value = false
  pullStatus.value = ''
  lastDownloaded.value = ''
  pulling.value = true
  pullStatus.value = t('settings.ollama.connecting', '正在连接...')
  pullProgress.value = 0
  pullDetail.value = ''
  pullError.value = ''
  lastCompleted = 0
  lastSpeedTime = Date.now()
  cancelPostPullRefresh()
  resetStallTimer()
  pullAbort = new AbortController()
  try {
    await pullOllamaModel(model, (p) => {
      pullStatus.value = p.status || ''
      if (p.total && p.total > 0 && p.completed !== undefined) {
        pullProgress.value = Math.round((p.completed / p.total) * 100)
        // Layer 切换检测：completed 重置时同步重置基准值
        if (p.completed < lastCompleted) {
          lastCompleted = 0
          lastSpeedTime = Date.now()
        }
        // 计算速度
        const now = Date.now()
        const elapsed = (now - lastSpeedTime) / 1000
        if (elapsed >= 1) {
          const speed = Math.max(0, (p.completed - lastCompleted) / elapsed)
          pullDetail.value = `${formatBytes(p.completed)} / ${formatBytes(p.total)} · ${formatBytes(speed)}/s`
          lastCompleted = p.completed
          lastSpeedTime = now
        }
        resetStallTimer()
      }
      if (p.status === 'success') {
        pullProgress.value = 100
        pullDetail.value = t('common.done', '完成')
      }
      if (p.error) {
        pullError.value = p.error
      }
    }, pullAbort?.signal)
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null }
    if (!pullError.value) {
      pullProgress.value = 100
      pullStatus.value = t('settings.ollama.verifying', '校验中...')
      pullDetail.value = ''
      lastDownloaded.value = ''
      // 只有模型真正出现在本地列表后才进入“下载完成”，否则报错，避免假成功。
      void finalizePulledModel(model)
    }
  } catch (e) {
    pullError.value = e instanceof Error ? e.message : t('settings.ollama.downloadFailed', '下载失败')
    pullInputError.value = true
    setTimeout(() => { pullInputError.value = false }, 3000)
  } finally {
    pulling.value = false
    pullAbort = null
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null }
  }
}

onMounted(() => { detect(); detectSystemMemory() })
onBeforeUnmount(() => {
  clearPollTimer()
  cancelPostPullRefresh()
  if (stallTimer) { clearTimeout(stallTimer); stallTimer = null }
  showModelDropdown.value = false
  if (pullAbort) { pullAbort.abort(); pullAbort = null }
})

const emit = defineEmits<{
  associate: []
  toggleProvider: []
}>()

function toggleOllamaProvider() {
  emit('toggleProvider')
}

defineExpose({ state, waitingInstall, startInstall, cancelWaiting, detect })
</script>

<template>
  <div class="ollama-card" :class="`ollama-card--${state}`">
    <!-- Header -->
    <div class="ollama-card__header">
      <div class="ollama-card__header-left">
        <Server :size="16" class="ollama-card__icon" />
        <div class="ollama-card__header-info">
          <a
            href="https://ollama.com"
            target="_blank"
            rel="noopener noreferrer"
            class="ollama-card__title"
            title="ollama.com"
            @click.stop
          >{{ t('settings.ollama.title', '本地模型 (Ollama)') }}<ExternalLink :size="10" class="ollama-card__title-link" /></a>
          <div v-if="status?.version" class="ollama-card__meta">
            {{ t('settings.ollama.brand', 'Ollama') }} {{ status.version }} · {{ status.model_count }} {{ t('settings.ollama.modelsDownloaded', 'models downloaded') }}
          </div>
        </div>
      </div>

      <div class="ollama-card__header-right">
        <span class="ollama-card__badge" :class="state === 'associated' && !hasOllamaProvider ? 'ollama-card__badge--not_running' : `ollama-card__badge--${state}`">
          <Loader2
            v-if="state === 'detecting' || state === 'waiting_install'"
            :size="11"
            class="ollama-card__spin"
          />
          <CheckCircle v-else-if="state === 'associated'" :size="11" />
          <AlertCircle v-else-if="state === 'error'" :size="11" />
          <Circle v-else :size="11" />
          {{ stateLabel }}
        </span>
        <span class="ollama-card__header-divider"></span>
        <!-- 重启：仅异常/未运行时显示 -->
        <button
          v-if="state === 'not_running' || state === 'error'"
          class="ollama-card__refresh"
          :disabled="restarting"
          :title="t('settings.ollama.restartEngine', '启动引擎')"
          @click="handleRestart"
        >
          <Loader2 v-if="restarting" :size="13" class="ollama-card__spin" />
          <Power v-else :size="13" />
        </button>
        <!-- 启用/禁用 Provider -->
        <button
          v-if="state === 'associated'"
          class="ollama-card__refresh"
          :title="hasOllamaProvider ? t('settings.llm.enabled', '已启用') : t('settings.llm.disabled', '已禁用')"
          @click.stop="toggleOllamaProvider"
        >
          <Power :size="13" :class="hasOllamaProvider ? 'ollama-card__power--on' : 'ollama-card__power--off'" />
        </button>
        <!-- 刷新：始终可用，正常时低调 -->
        <button
          class="ollama-card__refresh"
          :class="{
            'ollama-card__refresh--spinning': detecting,
          }"
          :disabled="detecting || waitingInstall"
          :title="t('common.refresh', '刷新')"
          @click="detect"
        >
          <RefreshCw :size="13" />
        </button>
      </div>
    </div>

    <!-- Body -->
    <Transition name="ollama-body" mode="out-in">
      <!-- Detecting -->
      <div v-if="state === 'detecting'" key="detecting" class="ollama-card__body">
        <div class="ollama-card__detect-placeholder">
          <div class="ollama-card__pulse-bar" />
          <div class="ollama-card__pulse-bar ollama-card__pulse-bar--short" />
        </div>
      </div>

      <!-- Not running -->
      <div v-else-if="state === 'not_running'" key="not_running" class="ollama-card__body">
        <p class="ollama-card__hint">
          {{ t('settings.ollama.notRunningHint') }}
        </p>
        <button
          class="ollama-card__action-btn ollama-card__action-btn--primary"
          :disabled="restarting"
          @click="handleRestartEngine"
        >
          <Loader2 v-if="restarting" :size="13" class="ollama-card__spin" />
          <RefreshCw v-else :size="13" />
          {{ restarting ? t('settings.ollama.restarting', '启动中…') : t('settings.ollama.restartEngine', '启动引擎') }}
        </button>
      </div>

      <!-- Waiting for install (保留兼容，实际不再触发) -->
      <div v-else-if="state === 'waiting_install'" key="waiting_install" class="ollama-card__body">
        <div class="ollama-card__waiting">
          <div class="ollama-card__waiting-indicator">
            <div class="ollama-card__waiting-dot" />
            <div class="ollama-card__waiting-dot" />
            <div class="ollama-card__waiting-dot" />
          </div>
          <p class="ollama-card__waiting-text">
            {{ t('settings.ollama.waitingInstallHint', '正在启动本地推理引擎…') }}
          </p>
        </div>
        <button class="ollama-card__action-btn ollama-card__action-btn--ghost" @click="cancelWaiting">
          {{ t('common.cancel', '取消') }}
        </button>
      </div>

      <!-- Associated -->
      <div v-else-if="state === 'associated' && status" key="associated" class="ollama-card__body">
        <div v-if="status.models?.length" class="ollama-card__models">
          <div v-for="m in status.models" :key="m.name" class="ollama-card__model">
            <div class="ollama-card__model-left">
              <span class="ollama-card__model-name">{{ m.name }}</span>
            </div>
            <div class="ollama-card__model-right">
              <span class="ollama-card__model-meta">
                {{ formatSize(m.size) }}
                <template v-if="m.parameter_size"> · {{ m.parameter_size }}</template>
              </span>
              <!-- 运行状态切换器：绿色=运行中可点击卸载，灰色=未加载 -->
              <button
                v-if="isModelRunning(m.name)"
                class="ollama-card__model-status ollama-card__model-status--running"
                :disabled="unloadingModel === m.name"
                :title="t('settings.ollama.loadedTitle', '已加载到内存，点击卸载释放资源')"
                @click="handleUnload(m.name)"
              >
                <span class="ollama-card__model-status-dot" />
                {{ unloadingModel === m.name ? t('settings.ollama.unloading', '卸载中...') : t('settings.ollama.running', '运行中') }}
              </button>
              <span
                v-else
                class="ollama-card__model-status ollama-card__model-status--idle"
                :title="t('settings.ollama.notLoadedTitle', '就绪，在对话中选择此模型即可自动加载')"
              >
                <span class="ollama-card__model-status-dot" />
                {{ t('settings.ollama.notLoaded', '就绪') }}
              </span>
              <div class="ollama-card__model-actions">
                <button
                  class="ollama-card__model-btn ollama-card__model-btn--chat"
                  :title="t('settings.ollama.chatWith', { name: m.name })"
                  @click="goChat(m.name)"
                >
                  <MessageSquare :size="10" />
                  {{ t('settings.ollama.chatAction', '对话') }}
                </button>
                <button
                  class="ollama-card__model-btn ollama-card__model-btn--danger"
                  :disabled="deletingModel === m.name"
                  :title="t('settings.ollama.deleteModel', { name: m.name })"
                  @click="handleDelete(m.name)"
                >
                  {{ deletingModel === m.name ? t('settings.ollama.deleting', '删除中...') : t('common.delete', '删除') }}
                </button>
              </div>
            </div>
          </div>
        </div>
        <p v-else class="ollama-card__hint">{{ t('settings.ollama.noModelsInline', '暂无已下载模型，在下方选择或输入模型名下载。') }}</p>

        <!-- 下载新模型 -->
        <div class="ollama-card__pull">
          <div class="ollama-card__pull-input">
            <div ref="pullFieldWrapRef" class="ollama-card__pull-field-wrap">
              <input
                v-model="pullModelName"
                type="text"
                class="ollama-card__pull-field"
                :class="{ 'ollama-card__pull-field--error': pullInputError }"
                :placeholder="pullInputError ? t('settings.ollama.pullPlaceholderError', '请输入模型名称') : t('settings.ollama.pullPlaceholder', '输入模型名，如 qwen3.5:9b、deepseek-r1:7b')"
                :disabled="pulling"
                autocomplete="off"
                @focus="showModelDropdown = true; dropdownIndex = -1; updateDropdownPosition()"
                @blur="showModelDropdown = false"
                @keydown="onPullKeydown"
                @input="pullInputError = false; pullError = ''; dropdownIndex = -1"
              />
              <Teleport to="body">
                <Transition name="ollama-dropdown">
                  <div
                    v-if="showModelDropdown && !pulling && filteredModels.length"
                    class="ollama-card__model-dropdown"
                    :style="dropdownStyle"
                    @wheel.stop
                  >
                    <div
                      v-for="(model, i) in filteredModels"
                      :key="model"
                      class="ollama-card__model-option"
                      :class="{
                        'ollama-card__model-option--active': i === dropdownIndex,
                        'ollama-card__model-option--too-large': isModelTooLarge(model),
                      }"
                      @mousedown.prevent="selectModel(model)"
                    >
                      <span class="ollama-card__model-option-name">{{ model }}</span>
                      <span v-if="getModelRamHint(model)" class="ollama-card__model-option-ram">{{ getModelRamHint(model) }}</span>
                      <span v-if="isModelRecommended(model)" class="ollama-card__model-option-badge ollama-card__model-option-badge--ok" :title="t('settings.ollama.fitsMemory', '适合本机运行')">✓</span>
                      <span v-else-if="isModelTooLarge(model)" class="ollama-card__model-option-badge ollama-card__model-option-badge--warn" :title="t('settings.ollama.exceedsMemory', '超出本机内存')">!</span>
                      <button
                        class="ollama-card__model-option-dl"
                        :title="t('settings.ollama.downloadDirect', '直接下载')"
                        @mousedown.prevent.stop="selectAndPull(model)"
                      >
                        <Download :size="12" />
                      </button>
                    </div>
                  </div>
                </Transition>
              </Teleport>
            </div>
            <button
              class="ollama-card__action-btn ollama-card__action-btn--primary"
              :disabled="!pullModelName.trim() || pulling"
              @click="startPull"
            >
              <Loader2 v-if="pulling" :size="13" class="ollama-card__spin" />
              <Download v-else :size="13" />
              {{ pulling ? t('settings.ollama.downloading', '下载中') : t('settings.ollama.downloadModel', '下载模型') }}
            </button>
          </div>
          <div v-if="pulling || pullStatus" class="ollama-card__pull-progress">
            <div class="ollama-card__pull-bar-bg">
              <div class="ollama-card__pull-bar" :style="{ width: pullProgress + '%' }" />
            </div>
            <div class="ollama-card__pull-info">
              <span class="ollama-card__pull-status">{{ pullStatus === PULL_DONE ? t('settings.ollama.downloadComplete', '下载完成') : pullStatus }}</span>
              <span v-if="pullDetail" class="ollama-card__pull-detail">{{ pullDetail }}</span>
              <span v-else-if="pullProgress > 0 && pullProgress < 100" class="ollama-card__pull-detail">{{ pullProgress }}%</span>
              <button
                v-if="pullStatus === PULL_DONE && lastDownloaded"
                class="ollama-card__pull-go-chat"
                @click="goChat(lastDownloaded)"
              >
                <MessageSquare :size="11" />
                {{ t('settings.ollama.goChat', '去对话') }}
              </button>
            </div>
          </div>
          <p v-if="pullError" class="ollama-card__error-msg">{{ pullError }}</p>
        </div>
      </div>

      <!-- Error -->
      <div v-else-if="state === 'error'" key="error" class="ollama-card__body">
        <p class="ollama-card__error-msg">{{ error }}</p>
      </div>
    </Transition>

    <!-- Footer -->
    <div class="ollama-card__footer">
      {{ t('settings.ollama.otherLocal') }}
    </div>
  </div>
</template>

<style scoped>
.ollama-card {
  border: 1px solid var(--hc-border);
  border-radius: var(--hc-radius-lg);
  background: var(--hc-bg-card);
  transition: border-color 0.3s;
  margin-bottom: 12px;
}

.ollama-card--associated {
  border-color: color-mix(in srgb, var(--hc-success) 25%, var(--hc-border));
}

.ollama-card--error {
  border-color: color-mix(in srgb, var(--hc-error) 20%, var(--hc-border));
}

.ollama-card--waiting_install {
  border-color: color-mix(in srgb, var(--hc-accent) 25%, var(--hc-border));
}

/* ─── Header ────────────────────────────────────────── */
.ollama-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
}

.ollama-card__header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ollama-card__icon {
  color: var(--hc-text-muted);
}

.ollama-card__title {
  display: inline-flex;
  align-items: center;
  font-weight: 600;
  font-size: 13px;
  color: var(--hc-text-primary);
  text-decoration: none;
  transition: color 0.15s;
}

.ollama-card__title:hover {
  color: var(--hc-accent);
}

.ollama-card__title-link {
  display: inline;
  margin-left: 3px;
  opacity: 0.4;
  vertical-align: -1px;
  transition: opacity 0.15s;
}

.ollama-card__title-link svg {
  vertical-align: -1px;
}

.ollama-card__title:hover .ollama-card__title-link {
  opacity: 0.8;
}

.ollama-card__header-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* ─── Badge ─────────────────────────────────────────── */
.ollama-card__badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 999px;
  transition: background 0.2s, color 0.2s;
}

.ollama-card__badge--detecting,
.ollama-card__badge--not_running {
  color: var(--hc-text-muted);
  background: var(--hc-bg-hover);
}

.ollama-card__badge--waiting_install {
  color: var(--hc-accent);
  background: var(--hc-accent-subtle);
}

.ollama-card__badge--associated {
  color: var(--hc-success);
  background: color-mix(in srgb, var(--hc-success) 10%, transparent);
}


.ollama-card__badge--error {
  color: var(--hc-error);
  background: color-mix(in srgb, var(--hc-error) 10%, transparent);
}

/* ─── Refresh ───────────────────────────────────────── */
.ollama-card__refresh {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  background: none;
  border: 1px solid transparent;
  cursor: pointer;
  border-radius: var(--hc-radius-sm);
  color: var(--hc-text-muted);
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.ollama-card__refresh:hover:not(:disabled) {
  background: var(--hc-bg-hover);
  color: var(--hc-text-secondary);
  border-color: var(--hc-border);
}

.ollama-card__refresh:active:not(:disabled) {
  background: var(--hc-bg-active);
}

.ollama-card__refresh:disabled {
  cursor: default;
  opacity: 0.5;
}

.ollama-card__refresh--spinning svg {
  animation: ollama-spin 0.8s linear infinite;
}

.ollama-card__power--on {
  color: var(--hc-success, #22c55e);
}

.ollama-card__power--off {
  color: var(--hc-text-muted, #999);
}

@keyframes ollama-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.ollama-card__spin {
  animation: ollama-spin 0.8s linear infinite;
}

/* ─── Body ──────────────────────────────────────────── */
.ollama-card__body {
  padding: 0 14px 12px;
}

.ollama-card__hint {
  font-size: 12px;
  color: var(--hc-text-secondary);
  line-height: 1.5;
  margin-bottom: 10px;
}


/* ─── Action Button ─────────────────────────────────── */
.ollama-card__action-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: var(--hc-radius-sm);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-hover);
  color: var(--hc-text-secondary);
  text-decoration: none;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.ollama-card__action-btn:hover {
  background: var(--hc-bg-active);
  color: var(--hc-text-primary);
  border-color: var(--hc-border);
}

.ollama-card__action-btn--primary {
  background: var(--hc-accent);
  color: var(--hc-text-inverse);
  border-color: var(--hc-accent);
}

.ollama-card__action-btn--primary:hover {
  background: var(--hc-accent-hover);
  border-color: var(--hc-accent-hover);
  color: var(--hc-text-inverse);
}

.ollama-card__action-btn--ghost {
  background: transparent;
  border-color: transparent;
  color: var(--hc-text-muted);
}

.ollama-card__action-btn--ghost:hover {
  color: var(--hc-text-secondary);
  background: var(--hc-bg-hover);
}

.ollama-card__external-icon {
  opacity: 0.6;
  margin-left: -2px;
}

/* ─── Waiting for install ───────────────────────────── */
.ollama-card__waiting {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: var(--hc-radius-sm);
  background: var(--hc-accent-subtle);
  margin-bottom: 10px;
}

.ollama-card__waiting-indicator {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.ollama-card__waiting-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--hc-accent);
  animation: ollama-bounce 1.4s ease-in-out infinite;
}

.ollama-card__waiting-dot:nth-child(2) {
  animation-delay: 0.16s;
}

.ollama-card__waiting-dot:nth-child(3) {
  animation-delay: 0.32s;
}

@keyframes ollama-bounce {
  0%,
  80%,
  100% {
    opacity: 0.3;
    transform: scale(0.8);
  }
  40% {
    opacity: 1;
    transform: scale(1);
  }
}

.ollama-card__waiting-text {
  font-size: 12px;
  color: var(--hc-accent);
  line-height: 1.4;
  margin: 0;
}

/* ─── Detect skeleton ───────────────────────────────── */
.ollama-card__detect-placeholder {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ollama-card__pulse-bar {
  height: 12px;
  width: 70%;
  border-radius: 6px;
  background: var(--hc-bg-hover);
  animation: ollama-pulse 1.5s ease-in-out infinite;
}

.ollama-card__pulse-bar--short {
  width: 40%;
}

@keyframes ollama-pulse {
  0%,
  100% {
    opacity: 0.4;
  }
  50% {
    opacity: 1;
  }
}

/* ─── Error ─────────────────────────────────────────── */
.ollama-card__error-msg {
  font-size: 12px;
  color: var(--hc-error);
  line-height: 1.5;
  margin-bottom: 10px;
  padding: 8px 10px;
  border-radius: var(--hc-radius-sm);
  background: color-mix(in srgb, var(--hc-error) 6%, transparent);
}

/* ─── Header info ──────────────────────────────────── */
.ollama-card__header-info { display: flex; flex-direction: column; min-width: 0; }
.ollama-card__meta { font-size: 11px; color: var(--hc-text-muted); margin-top: 1px; }
.ollama-card__header-divider { width: 1px; height: 14px; background: var(--hc-border-subtle, var(--hc-border)); margin: 0 2px; flex-shrink: 0; }

/* ─── Associated details ────────────────────────────── */

.ollama-card__model {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
  font-size: 12px;
  border-bottom: 1px solid var(--hc-border-subtle);
}

.ollama-card__model:last-child {
  border-bottom: none;
}

.ollama-card__model-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.ollama-card__model-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.ollama-card__model-name {
  font-family: 'SF Mono', ui-monospace, monospace;
  font-weight: 500;
  color: var(--hc-text-primary);
}

.ollama-card__model-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 999px;
  border: none;
  white-space: nowrap;
}

.ollama-card__model-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.ollama-card__model-status--running {
  color: var(--hc-success);
  background: color-mix(in srgb, var(--hc-success) 10%, transparent);
  cursor: pointer;
  transition: background 0.15s, opacity 0.15s;
}

.ollama-card__model-status--running .ollama-card__model-status-dot {
  background: var(--hc-success);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--hc-success) 25%, transparent);
}

.ollama-card__model-status--running:hover:not(:disabled) {
  background: color-mix(in srgb, var(--hc-success) 18%, transparent);
}

.ollama-card__model-status--running:disabled {
  opacity: 0.6;
  cursor: default;
}

.ollama-card__model-status--idle {
  color: var(--hc-text-muted);
  background: var(--hc-bg-hover);
  cursor: default;
}

.ollama-card__model-status--idle .ollama-card__model-status-dot {
  background: var(--hc-text-muted);
  opacity: 0.5;
}

.ollama-card__model-meta {
  color: var(--hc-text-muted);
  font-size: 11px;
}

.ollama-card__model-actions { display: flex; gap: 2px; opacity: 0; transition: opacity 0.12s; flex-shrink: 0; }
.ollama-card__model:hover .ollama-card__model-actions { opacity: 1; }

.ollama-card__model-btn {
  padding: 2px 8px;
  font-size: 11px;
  border: 1px solid var(--hc-border);
  border-radius: var(--hc-radius-sm);
  background: transparent;
  color: var(--hc-text-secondary);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.ollama-card__model-btn:hover:not(:disabled) {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}

.ollama-card__model-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.ollama-card__model-btn--chat {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.ollama-card__model-btn--chat:hover:not(:disabled) {
  background: color-mix(in srgb, var(--hc-accent) 8%, transparent);
  color: var(--hc-accent);
  border-color: color-mix(in srgb, var(--hc-accent) 30%, var(--hc-border));
}

.ollama-card__model-btn--danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--hc-error) 8%, transparent);
  color: var(--hc-error);
  border-color: color-mix(in srgb, var(--hc-error) 30%, var(--hc-border));
}

/* ─── Pull Model ───────────────────────────────────── */
.ollama-card__pull {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--hc-border-subtle);
}

.ollama-card__pull-input {
  display: flex;
  gap: 8px;
  align-items: center;
}

.ollama-card__pull-field {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--hc-border);
  border-radius: var(--hc-radius-sm);
  font-size: 12px;
  font-family: 'SF Mono', ui-monospace, monospace;
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
  outline: none;
  transition: border-color 0.15s;
}

.ollama-card__pull-field:focus {
  border-color: var(--hc-accent);
}

.ollama-card__pull-field--error {
  border-color: var(--hc-error);
  background: color-mix(in srgb, var(--hc-error) 4%, var(--hc-bg-input));
  animation: ollama-shake 0.3s ease;
}

.ollama-card__pull-field--error::placeholder {
  color: var(--hc-error);
}

@keyframes ollama-shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-4px); }
  75% { transform: translateX(4px); }
}

.ollama-card__pull-field::placeholder {
  color: var(--hc-text-muted);
  font-family: -apple-system, system-ui, sans-serif;
}

/* ─── Model dropdown ────────────────────────── */
.ollama-card__pull-field-wrap {
  position: relative;
  flex: 1;
}

.ollama-card__model-dropdown {
  background: var(--hc-bg-elevated);
  border: 1px solid var(--hc-border);
  border-radius: var(--hc-radius-sm);
  box-shadow: var(--hc-shadow-float);
  z-index: var(--hc-z-popover);
  overflow-y: auto;
  overscroll-behavior: contain;
}

.ollama-card__model-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  cursor: pointer;
  transition: background 0.1s;
}

.ollama-card__model-option:hover,
.ollama-card__model-option--active {
  background: var(--hc-bg-hover);
}

.ollama-card__model-option-name {
  font-size: 12px;
  font-family: 'SF Mono', ui-monospace, monospace;
  color: var(--hc-text-primary);
}

.ollama-card__model-option-dl {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--hc-text-muted);
  border-radius: var(--hc-radius-sm);
  flex-shrink: 0;
  transition: color 0.1s, background 0.1s;
}

.ollama-card__model-option-dl:hover {
  color: var(--hc-accent);
  background: var(--hc-accent-subtle);
}

.ollama-card__model-option-ram {
  font-size: 11px;
  color: var(--hc-text-muted, #999);
  margin-left: auto;
  margin-right: 4px;
  flex-shrink: 0;
}

.ollama-card__model-option-badge {
  font-size: 10px;
  font-weight: 700;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-right: 2px;
}

.ollama-card__model-option-badge--ok {
  background: var(--hc-success, #22c55e);
  color: #fff;
}

.ollama-card__model-option-badge--warn {
  background: var(--hc-warning, #f59e0b);
  color: #fff;
}

.ollama-card__model-option--too-large .ollama-card__model-option-name {
  opacity: 0.5;
}

.ollama-dropdown-enter-active,
.ollama-dropdown-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}

.ollama-dropdown-enter-from,
.ollama-dropdown-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.ollama-card__pull-progress {
  margin-top: 8px;
}

.ollama-card__pull-bar-bg {
  height: 4px;
  border-radius: 2px;
  background: var(--hc-bg-hover);
  overflow: hidden;
}

.ollama-card__pull-bar {
  height: 100%;
  border-radius: 2px;
  background: var(--hc-accent);
  transition: width 0.3s ease;
}

.ollama-card__pull-info {
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
}

.ollama-card__pull-status {
  font-size: 11px;
  color: var(--hc-text-muted);
}

.ollama-card__pull-detail {
  font-size: 11px;
  color: var(--hc-text-secondary);
  font-variant-numeric: tabular-nums;
}

.ollama-card__pull-go-chat {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  font-size: 11px;
  font-weight: 500;
  border: 1px solid var(--hc-accent);
  border-radius: var(--hc-radius-sm);
  background: var(--hc-accent);
  color: var(--hc-text-inverse);
  cursor: pointer;
  transition: background 0.15s;
  margin-left: auto;
}

.ollama-card__pull-go-chat:hover {
  background: var(--hc-accent-hover);
}

/* ─── Footer ────────────────────────────────────────── */
.ollama-card__footer {
  font-size: 11px;
  color: var(--hc-text-muted);
  border-top: 1px solid var(--hc-border-subtle);
  padding: 8px 14px;
  line-height: 1.5;
}

/* ─── Body transition ───────────────────────────────── */
.ollama-body-enter-active,
.ollama-body-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.ollama-body-enter-from {
  opacity: 0;
  transform: translateY(-4px);
}

.ollama-body-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
