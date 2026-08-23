<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useKnowledgeUploadsStore } from '@/stores/knowledge-uploads'
import { useI18n } from 'vue-i18n'
import {
  BookOpen,
  Upload,
  Search,
  X,
  FileUp,
  RefreshCw,
  AlertTriangle,
  Settings2,
} from 'lucide-vue-next'
import {
  getDocuments,
  getDocumentContent,
  addDocument,
  deleteDocument,
  searchKnowledge,
  uploadDocument,
  reindexDocument,
  retryKnowledgeDocument,
  getKnowledgeConfig,
  getKnowledgeEmbeddingStatus,
  putKnowledgeConfig,
  MAX_KNOWLEDGE_UPLOAD_BATCH_BYTES,
  listKnowledgeOperations,
} from '@/api/knowledge'
import type { KnowledgeSourceCount } from '@/api/knowledge'
import type {
  KnowledgeEmbeddingStatus,
  KnowledgeSearchFilter,
  KnowledgeConfig,
} from '@/api/knowledge'
import { cancelKnowledgeJob, getKnowledgeJob } from '@/api/knowledge-index'
import type { KnowledgeUploadEntry } from '@/stores/knowledge-uploads'
// DB cache layer removed — data fetched directly from backend API
import type {
  KnowledgeDoc,
  KnowledgeJobProjection,
  KnowledgeSearchResult,
  KnowledgeStructuredProjection,
} from '@/types'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import SearchInput from '@/components/common/SearchInput.vue'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import UnderlineTabs from '@/components/common/UnderlineTabs.vue'
import HcDateRangePicker from '@/components/common/HcDateRangePicker.vue'
import HcSelect from '@/components/common/HcSelect.vue'
import HcSettingsDisclosure from '@/components/common/HcSettingsDisclosure.vue'
import SemanticIndexCard from '@/components/knowledge/SemanticIndexCard.vue'
import { logger } from '@/utils/logger'
import { formatRelative } from '@/utils/time'

// 图片格式走后端多模态入库（视觉模型转写 → 文本 RAG，source_type=image）。
// 后端 /knowledge/documents multipart 显式支持这些扩展，桌面也须放行，
// 否则多模态入库能力在桌面端无入口。所有格式都只走后端持久化异步摄取，
// 上传失败时不在桌面端再解析/add，避免同一用户意图产生两条状态机和重复文档。
const IMAGE_TYPES = ['.png', '.jpg', '.jpeg', '.webp', '.gif']
const DOCUMENT_TYPES = ['.pdf', '.txt', '.md', '.docx', '.doc', '.pptx', '.csv', '.json']
const ACCEPTED_TYPES = [...DOCUMENT_TYPES, ...IMAGE_TYPES]

// 图片入库由后端视觉模型（VLM）转写为文本后再走 RAG 管线。若用户配的模型不具备视觉能力，
// 后端返回的错误带「视觉模型 / 图像转写」标记（见 knowledge/multimodal.go）。据此把底层技术
// 细节翻译成本地化、可操作的引导。标记为后端中文文案，与 UI 语言无关，故可跨语言可靠匹配。
function isVisionModelError(message: string): boolean {
  const m = message.toLowerCase()
  return (
    message.includes('视觉模型') ||
    message.includes('图像转写') ||
    m.includes('vision model') ||
    m.includes('does not support image')
  )
}

function isDefinitiveKnowledgeUploadRejection(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const status =
    (error as { status?: number; statusCode?: number }).status ??
    (error as { status?: number; statusCode?: number }).statusCode
  return (
    typeof status === 'number' && status >= 400 && status < 500 && ![408, 425, 429].includes(status)
  )
}
const props = withDefaults(
  defineProps<{
    knowledgeEnabled?: boolean
    documentSearch?: string
  }>(),
  {
    knowledgeEnabled: true,
    documentSearch: '',
  },
)
const knowledgeEnabled = computed(() => props.knowledgeEnabled)

const { t, locale } = useI18n()
const appRouter = getCurrentInstance()?.appContext.config.globalProperties.$router as
  | { push?: (location: string) => unknown }
  | undefined

const docs = ref<KnowledgeDoc[]>([])
const totalDocs = ref(0)
const loading = ref(true)
const errorMsg = ref('')
const errorSeverity = ref<'error' | 'warning' | null>(null)
const revalidating = ref(false)
// CACHE_TTL_MS removed — DB cache layer eliminated
const activeTab = ref<'documents' | 'search'>('documents')

// 二级 tab（统一 UnderlineTabs）：全部 (N) / 检索测试
const knowledgeTabs = computed(() => [
  { key: 'documents', label: `${t('knowledge.allTab', '全部')} (${docs.value.length})` },
  { key: 'search', label: t('knowledge.searchTest', '检索测试') },
])

const showAddDialog = ref(false)
const newTitle = ref('')
const newContent = ref('')
const newSource = ref('')
const newTitleInput = ref<HTMLInputElement | null>(null)
const adding = ref(false)
const embeddingStatus = ref<KnowledgeEmbeddingStatus | null>(null)

const showDeleteConfirm = ref(false)
const deletingDoc = ref<KnowledgeDoc | null>(null)

const searchQuery = ref('')
const searchResults = ref<KnowledgeSearchResult[]>([])
const searching = ref(false)
let searchRequestGen = 0

// 检索测试的元数据过滤（source_type 多选 chip + 创建日期区间）
// image：多模态入库的图片文档（source_type=image，后端 Filter 支持按此维度过滤）。
const SOURCE_TYPES = ['manual', 'upload', 'url', 'file', 'agent', 'image'] as const
const selectedTypes = ref<string[]>([])
const filterAfter = ref('')
const filterBefore = ref('')
const hasActiveFilter = computed(
  () => selectedTypes.value.length > 0 || !!filterAfter.value || !!filterBefore.value,
)
function toggleType(tp: string) {
  selectedTypes.value = selectedTypes.value.includes(tp)
    ? selectedTypes.value.filter((t) => t !== tp)
    : [...selectedTypes.value, tp]
}
function clearFilters() {
  selectedTypes.value = []
  filterAfter.value = ''
  filterBefore.value = ''
}
function buildSearchFilter(): KnowledgeSearchFilter | undefined {
  const filter: KnowledgeSearchFilter = {}
  if (selectedTypes.value.length) filter.sourceTypes = [...selectedTypes.value]
  if (filterAfter.value) filter.createdAfter = filterAfter.value
  if (filterBefore.value) filter.createdBefore = filterBefore.value
  return Object.keys(filter).length ? filter : undefined
}

// ── 检索质量参数（高级）：全局持久化（写 yaml + 热更新 KB Manager），功能默认开启、面板默认展开 ──
// 即时生效：rerank/query_expand/contextual 开关、min_score、candidate_k；rerank_model 换模型需重启 sidecar。
const RAG_DEFAULTS: KnowledgeConfig = {
  rerank: true,
  rerank_model: '',
  query_expand: true,
  contextual: true,
  min_score: 0.55,
  candidate_k: 50,
}
// 常见 cross-encoder 重排模型（'' = 自动：SiliconFlow 自动启用 / 否则 LLM 重排）。
const RERANK_MODEL_PRESETS = [
  '',
  'BAAI/bge-reranker-v2-m3',
  'Qwen/Qwen3-Reranker-0.6B',
  'Qwen/Qwen3-Reranker-4B',
  'Qwen/Qwen3-Reranker-8B',
]
const CANDIDATE_K_PRESETS = [20, 30, 50, 80, 100]
const ragConfig = ref<KnowledgeConfig | null>(null)
const ragLoadState = ref<'loading' | 'ready' | 'error'>('loading')
const ragPanelOpen = ref(true) // 默认展开
const ragSaving = ref(false)
const ragRestartHint = ref(false) // rerank_model 变更需重启提示
// 当前 rerank_model 不在预设里时，把它并入下拉（保留手填/历史值，避免下拉重置丢值）。
const rerankModelOptions = computed(() => {
  const m = ragConfig.value?.rerank_model ?? ''
  return m && !RERANK_MODEL_PRESETS.includes(m)
    ? [m, ...RERANK_MODEL_PRESETS]
    : RERANK_MODEL_PRESETS
})
// 同理 candidate_k：手改 yaml / 后端默认变更导致的非预设值也要能回显，否则一改就被吸附到预设。
const candidateKOptions = computed(() => {
  const k = ragConfig.value?.candidate_k ?? 0
  return k > 0 && !CANDIDATE_K_PRESETS.includes(k)
    ? [k, ...CANDIDATE_K_PRESETS]
    : CANDIDATE_K_PRESETS
})

async function loadRagConfig() {
  if (!knowledgeEnabled.value) return
  ragLoadState.value = 'loading'
  ragConfig.value = null
  try {
    const cfg = await getKnowledgeConfig()
    ragConfig.value = { ...cfg }
    ragLoadState.value = 'ready'
  } catch (e) {
    ragLoadState.value = 'error'
    logger.warn('[Knowledge] 检索参数读取失败', e)
  }
}

async function loadEmbeddingStatus() {
  if (!knowledgeEnabled.value) return
  try {
    embeddingStatus.value = await getKnowledgeEmbeddingStatus()
  } catch (error) {
    embeddingStatus.value = null
    logger.warn('[Knowledge] embedding status read failed', error)
  }
}

function embeddingProviderLabel(provider: string | undefined): string {
  if (provider === 'openai_compatible' || provider === 'openai') return 'OpenAI 兼容'
  return provider || '自动选择'
}

const addDocumentIndexNotice = computed(() => {
  const status = embeddingStatus.value
  if (!status) return null
  if (!status.enabled || !status.configured) {
    return {
      title: t('knowledge.indexUnconfiguredTitle', '当前索引：未配置'),
      detail: t(
        'knowledge.indexBackgroundHint',
        '文本索引仍可先就绪；配置语义索引后会在后台增强，索引模型可在知识库页统一修改。',
      ),
    }
  }
  const executor = [embeddingProviderLabel(status.provider), status.model].filter(Boolean).join(' · ')
  return {
    title: t('knowledge.indexAutoTitle', '当前索引：自动（推荐）'),
    detail: `${t('knowledge.indexActualPrefix', '实际执行：')}${executor || '自动选择'}；${t('knowledge.indexBackgroundHint', '文本索引先就绪，语义索引在后台增强。索引模型可在知识库页统一修改。')}`,
  }
})

// 全量保存（即时生效 + 落盘）。在写入前夹紧到合法区间，与后端校验对齐。
async function saveRagConfig() {
  if (!knowledgeEnabled.value || !ragConfig.value) return
  const c = ragConfig.value
  c.min_score = Math.min(1, Math.max(0, Number(c.min_score) || 0))
  if (!(c.candidate_k > 0)) c.candidate_k = RAG_DEFAULTS.candidate_k
  ragSaving.value = true
  try {
    const res = await putKnowledgeConfig({ ...c })
    ragRestartHint.value = !!res.rerank_model_restart_required
    ragConfig.value = {
      rerank: res.rerank,
      rerank_model: res.rerank_model,
      query_expand: res.query_expand,
      contextual: res.contextual,
      min_score: res.min_score,
      candidate_k: res.candidate_k,
    }
    ragLoadState.value = 'ready'
  } catch (e) {
    errorMsg.value =
      e instanceof Error ? e.message : t('knowledge.ragSaveFailed', '保存检索参数失败')
    errorSeverity.value = 'error'
  } finally {
    ragSaving.value = false
  }
}

function toggleRagBool(key: 'rerank' | 'query_expand' | 'contextual') {
  if (!ragConfig.value) return
  ragConfig.value[key] = !ragConfig.value[key]
  void saveRagConfig()
}
function onMinScoreChange(e: Event) {
  if (!ragConfig.value) return
  ragConfig.value.min_score = Number((e.target as HTMLInputElement).value)
  void saveRagConfig()
}
function onCandidateKPick(v: string) {
  if (!ragConfig.value) return
  ragConfig.value.candidate_k = Number(v) || RAG_DEFAULTS.candidate_k
  void saveRagConfig()
}
function onRerankModelPick(v: string) {
  if (!ragConfig.value) return
  ragConfig.value.rerank_model = v
  void saveRagConfig()
}
// HcSelect 选项（取代原生 <select>/<option>：品牌一致弹层、Teleport 自渲染，
// 避开 macOS WKWebView 原生 <select> 弹层字号巨大/不受 CSS 控制的老问题，同 HcSelect 设计初衷）。
const rerankModelSelectOptions = computed(() =>
  rerankModelOptions.value.map((m) => ({
    value: m,
    label: m === '' ? t('knowledge.ragRerankAuto') : m,
  })),
)
const candidateKSelectOptions = computed(() =>
  candidateKOptions.value.map((k) => ({ value: String(k), label: String(k) })),
)
function resetRagConfig() {
  if (!ragConfig.value) return
  ragConfig.value = { ...RAG_DEFAULTS }
  void saveRagConfig()
}
const selectedDoc = ref<KnowledgeDoc | null>(null)
const showDocDetail = ref(false)
const reindexingDocIds = ref<Set<string>>(new Set())
const cancellingVectorJobIds = ref<Set<string>>(new Set())
const normalizedDocumentSearch = computed(() => props.documentSearch.trim().toLowerCase())

// 按 source 分组/过滤 + 渲染窗口（#5）：定时任务快照会按时间序累积上千条，
// 既要能按来源折叠筛选，也要避免一次性把全部卡片塞进 DOM 拖垮列表页。
const selectedSource = ref<string | null>(null)
const DOC_PAGE_SIZE = 50
const visibleDocCount = ref(DOC_PAGE_SIZE)
const sourceFacetFromApi = ref<KnowledgeSourceCount[]>([])
let documentRequestGeneration = 0

// 来源 facet：每个 source 一颗 chip，附该来源的文档数。
const sourceFacet = computed(() => {
  if (sourceFacetFromApi.value.length) return sourceFacetFromApi.value
  const counts = new Map<string, number>()
  for (const d of docs.value) {
    if (!d.source) continue
    counts.set(d.source, (counts.get(d.source) ?? 0) + 1)
  }
  return [...counts.entries()].map(([source, count]) => ({ source, count }))
})

const filteredDocs = computed(() => {
  const query = normalizedDocumentSearch.value
  const src = selectedSource.value
  return docs.value.filter((doc) => {
    if (src && doc.source !== src) return false
    if (!query) return true
    const searchable = [
      doc.title,
      doc.source,
      doc.content,
      doc.status,
      doc.error_message,
      doc.vector_error,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return searchable.includes(query)
  })
})

// 当前页（窗口）内的文档；其余通过「加载更多」逐步追加。
const windowedDocs = computed(() => filteredDocs.value.slice(0, visibleDocCount.value))
const hasMoreDocs = computed(() => {
  if (filteredDocs.value.length > visibleDocCount.value) return true
  return !normalizedDocumentSearch.value && docs.value.length < totalDocs.value
})
const displayedTotalDocs = computed(() =>
  normalizedDocumentSearch.value ? filteredDocs.value.length : totalDocs.value,
)
async function loadMoreDocs() {
  // 兼容旧后端/测试一次返回超过一页的响应：先只扩 DOM 窗口，不重复请求。
  if (filteredDocs.value.length > visibleDocCount.value) {
    visibleDocCount.value += DOC_PAGE_SIZE
    return
  }
  if (normalizedDocumentSearch.value || docs.value.length >= totalDocs.value) return
  await revalidateFromApi(true, { append: true })
  visibleDocCount.value += DOC_PAGE_SIZE
}
function selectSource(src: string | null) {
  selectedSource.value = selectedSource.value === src ? null : src
  visibleDocCount.value = DOC_PAGE_SIZE
  void revalidateFromApi(docs.value.length > 0)
}
// 搜索词变化时把窗口重置回第一页，避免停留在被过滤掉的尾页。
watch(normalizedDocumentSearch, (query, previousQuery) => {
  visibleDocCount.value = DOC_PAGE_SIZE
  // 列表端点暂不支持 q：有搜索词时省略 limit 拉取当前 source 全量，保证客户端搜索不漏页；
  // 清空后立即恢复 50 条服务端分页，避免常态传输数千条快照。
  // 非空搜索词之间切换时本地全量已齐，只需重新过滤，不重复打 API。
  if (Boolean(query) !== Boolean(previousQuery)) {
    void revalidateFromApi(docs.value.length > 0)
  }
})

// File upload state
const isDragging = ref(false)
// BUG-20260710：上传/索引进度提升为 store——上传→索引是跨页面生命周期的后台过程，
// 组件本地 ref 在切页卸载时必丢（上传 100% 后切走再回来条目消失，用户以为上传丢了）。
const uploadsStore = useKnowledgeUploadsStore()
const uploadingFiles = computed(() => uploadsStore.items)
const fileInputRef = ref<HTMLInputElement>()
const uploadAbortControllers = new Map<KnowledgeUploadEntry, AbortController>()

// done 条目在文档落地（出现在 getDocuments 结果）前保留；挂载期间轻量轮询直到全部落地。
let indexPollTimer: ReturnType<typeof setInterval> | null = null
let indexPollInFlight = false
let isMounted = false

const POLLABLE_VECTOR_JOB_STATES = new Set(['queued', 'running', 'retry_wait'])
type KnowledgePolledJob = Awaited<ReturnType<typeof getKnowledgeJob>> & KnowledgeJobProjection

function hasPollableVectorJob(doc: KnowledgeDoc): boolean {
  return (
    Boolean(doc.vector_job_id) &&
    POLLABLE_VECTOR_JOB_STATES.has(doc.vector_job_state ?? '') &&
    ['pending', 'building', 'retry_wait'].includes(doc.vector_index_state ?? '')
  )
}

function hasPollableVectorJobs(): boolean {
  return docs.value.some(hasPollableVectorJob)
}

// Job 回读只覆盖实际返回的结构化字段，避免短投影把已有事实清空。
function mergeKnowledgeProjection(
  doc: KnowledgeDoc,
  projection: Partial<KnowledgeStructuredProjection>,
): KnowledgeDoc {
  const next = { ...doc }
  if (projection.text_index_state !== undefined) next.text_index_state = projection.text_index_state
  if (projection.ingestion_state !== undefined) next.ingestion_state = projection.ingestion_state
  if (projection.failure_code !== undefined) next.failure_code = projection.failure_code
  if (projection.affected_pages !== undefined) next.affected_pages = projection.affected_pages
  if (projection.frozen_vision_provider !== undefined) {
    next.frozen_vision_provider = projection.frozen_vision_provider
  }
  if (projection.frozen_vision_model !== undefined) {
    next.frozen_vision_model = projection.frozen_vision_model
  }
  if (projection.preflight_state !== undefined) next.preflight_state = projection.preflight_state
  if (projection.model_calls !== undefined) next.model_calls = projection.model_calls
  if (projection.available_actions !== undefined) {
    next.available_actions = projection.available_actions
  }
  if (projection.ingestion !== undefined) {
    if (projection.ingestion === null) {
      next.ingestion = null
    } else {
      const currentIngestion = doc.ingestion ?? {}
      const incomingIngestion = projection.ingestion
      const mergedIngestion = { ...currentIngestion, ...incomingIngestion }
      next.ingestion = mergedIngestion
      if (incomingIngestion.frozen_vision === undefined && currentIngestion.frozen_vision !== undefined) {
        mergedIngestion.frozen_vision = currentIngestion.frozen_vision
      }
      if (incomingIngestion.preflight === undefined && currentIngestion.preflight !== undefined) {
        mergedIngestion.preflight = currentIngestion.preflight
      }
    }
  }
  return next
}

// 只替换当前已加载的同一文档，避免重建第 51 条后的条目时用首页回读覆盖分页窗口。
async function refreshDocumentProjection(docID: string) {
  const { getDocument } = await import('@/api/knowledge')
  const projection = await getDocument(docID)
  if (!projection || projection.id !== docID) return
  const index = docs.value.findIndex((doc) => doc.id === docID)
  if (index < 0) return
  docs.value = docs.value.map((doc) => (doc.id === docID ? projection : doc))
  if (isMounted && hasPollableVectorJobs()) ensureIndexPolling()
}

function updateVectorJobProjection(job: Awaited<ReturnType<typeof getKnowledgeJob>>) {
  const projection = job as KnowledgePolledJob
  docs.value = docs.value.map((doc) => {
    if (doc.vector_job_id !== job.job_id) return doc
    const vectorState: KnowledgeDoc['vector_index_state'] =
      job.state === 'queued'
        ? 'pending'
        : job.state === 'running'
          ? 'building'
          : job.state === 'retry_wait'
            ? 'retry_wait'
            : job.state === 'succeeded'
              ? 'ready'
              : job.state
    return mergeKnowledgeProjection(
      {
        ...doc,
      vector_index_state: vectorState,
      vector_job_state: job.state,
      vector_job_stage: job.stage,
      vector_chunks_done: job.chunks_done ?? doc.vector_chunks_done,
      vector_chunks_total: job.chunks_total ?? doc.vector_chunks_total,
      vector_error: job.state === 'failed' ? job.last_error || doc.vector_error : undefined,
      },
      projection,
    )
  })
}

async function pollKnowledgeUploadJobs() {
  if (!isMounted || indexPollInFlight) return
  indexPollInFlight = true
  try {
    let uploadProjectionChanged = false
    const terminalDocumentIDs = new Set<string>()
    const polledJobs = new Map<string, Awaited<ReturnType<typeof getKnowledgeJob>>>()
    const running = uploadsStore.items.filter(
      (entry) => entry.status === 'processing' && Boolean(entry.jobId),
    )
    for (const entry of running) {
      try {
        const job = await getKnowledgeJob(entry.jobId!)
        polledJobs.set(job.job_id, job)
        if (entry.documentId) {
          docs.value = docs.value.map((doc) =>
            doc.id === entry.documentId
              ? mergeKnowledgeProjection(doc, job as KnowledgePolledJob)
              : doc,
          )
        }
        entry.stage = job.stage
        if (job.state === 'succeeded') {
          uploadsStore.markSucceeded(entry)
        } else if (job.state === 'failed') {
          uploadsStore.markFailed(entry, job.last_error || t('knowledge.uploadFailed'))
          uploadProjectionChanged = true
        } else if (job.state === 'cancelled') {
          uploadsStore.markCancelled(entry)
          uploadProjectionChanged = true
        }
      } catch (error) {
        // A transient status read must not turn a durable server job into a local failure.
        logger.warn('[Knowledge] upload job status read failed', error)
      }
    }

    const vectorDocuments = docs.value.filter(
      (doc) =>
        Boolean(doc.vector_job_id) &&
        POLLABLE_VECTOR_JOB_STATES.has(doc.vector_job_state ?? ''),
    )
    const vectorJobIDs = new Set(
      vectorDocuments.map((doc) => doc.vector_job_id!),
    )
    for (const jobID of vectorJobIDs) {
      try {
        const job = polledJobs.get(jobID) ?? (await getKnowledgeJob(jobID))
        updateVectorJobProjection(job)
        if (['succeeded', 'failed', 'cancelled'].includes(job.state)) {
          for (const doc of vectorDocuments) {
            if (doc.vector_job_id === jobID) terminalDocumentIDs.add(doc.id)
          }
        }
      } catch (error) {
        // 单个 Job 的短暂读取失败不能把持久状态改成本地失败。
        logger.warn('[Knowledge] document embedding job status read failed', error)
      }
    }
    if (isMounted && terminalDocumentIDs.size > 0) {
      for (const documentID of terminalDocumentIDs) {
        try {
          await refreshDocumentProjection(documentID)
        } catch (error) {
          logger.warn('[Knowledge] document terminal projection read failed', error)
        }
      }
    } else if (
      isMounted &&
      (uploadProjectionChanged || uploadsStore.items.some((entry) => entry.status === 'done'))
    ) {
      await revalidateFromApi(true)
    }
  } finally {
    indexPollInFlight = false
    if (!uploadsStore.hasAwaitingIndex() && !hasPollableVectorJobs() && indexPollTimer) {
      clearInterval(indexPollTimer)
      indexPollTimer = null
    }
  }
}

function ensureIndexPolling() {
  if (!isMounted || indexPollTimer) return
  indexPollTimer = setInterval(() => {
    if (!uploadsStore.hasAwaitingIndex() && !hasPollableVectorJobs()) {
      if (indexPollTimer) clearInterval(indexPollTimer)
      indexPollTimer = null
      return
    }
    void pollKnowledgeUploadJobs()
  }, 4000)
}

async function cancelUploadJob(entry: KnowledgeUploadEntry) {
  if (entry.status === 'uploading') {
    const controller = uploadAbortControllers.get(entry)
    if (!controller || entry.cancelling) return
    entry.cancelling = true
    controller.abort()
    uploadAbortControllers.delete(entry)
    uploadsStore.markCancelled(entry)
    return
  }
  if (!entry.jobId || entry.status !== 'processing' || entry.cancelling) return
  entry.cancelling = true
  try {
    const job = await cancelKnowledgeJob(entry.jobId)
    if (job.state === 'cancelled') {
      uploadsStore.markCancelled(entry)
    } else if (job.state === 'succeeded') {
      // Text publication may win the narrow race with cancellation. The
      // backend still cascades cancel_requested to unfinished embedding
      // children, while the already-ready FTS document remains successful.
      uploadsStore.markSucceeded(entry)
      await revalidateFromApi(true)
    } else {
      entry.cancelling = false
    }
  } catch (error) {
    entry.cancelling = false
    errorMsg.value = error instanceof Error ? error.message : t('knowledge.uploadFailed')
    errorSeverity.value = 'error'
  }
}

function canCancelUpload(entry: KnowledgeUploadEntry): boolean {
  return (
    (entry.status === 'uploading' && uploadAbortControllers.has(entry)) ||
    (entry.status === 'processing' && Boolean(entry.jobId))
  )
}
onUnmounted(() => {
  isMounted = false
  if (indexPollTimer) clearInterval(indexPollTimer)
  indexPollTimer = null
})

onMounted(async () => {
  isMounted = true
  try {
    uploadsStore.reconcileRecoverableOperations(await listKnowledgeOperations())
  } catch (error) {
    logger.warn('[Knowledge] durable upload recovery failed', error)
  }
  await loadDocs()
  void loadEmbeddingStatus()
  void loadRagConfig()
  // 切页回来时若仍有「索引中」条目，恢复轮询直到落地（BUG-20260710）
  if (uploadsStore.hasAwaitingIndex() || hasPollableVectorJobs()) ensureIndexPolling()
})

watch(activeTab, () => {
  errorMsg.value = ''
})

/**
 * 从后端 API 直接加载文档列表（DB 缓存层已移除）
 */
async function loadDocs() {
  errorMsg.value = ''
  errorSeverity.value = null
  loading.value = true
  await revalidateFromApi(false)
}

async function revalidateFromApi(
  hadCache = docs.value.length > 0,
  options: { append?: boolean } = {},
) {
  const requestGeneration = ++documentRequestGeneration
  revalidating.value = true
  try {
    const query = selectedSource.value ? { source: selectedSource.value } : {}
    const res = await getDocuments(
      normalizedDocumentSearch.value
        ? query
        : { ...query, limit: DOC_PAGE_SIZE, offset: options.append ? docs.value.length : 0 },
    )
    if (requestGeneration !== documentRequestGeneration) return
    const freshDocs = res.documents || []
    if (options.append) {
      const byID = new Map(docs.value.map((doc) => [doc.id, doc]))
      for (const doc of freshDocs) byID.set(doc.id, doc)
      docs.value = [...byID.values()]
    } else {
      docs.value = freshDocs
    }
    totalDocs.value = typeof res.total === 'number' ? res.total : docs.value.length
    if (Array.isArray(res.sources)) sourceFacetFromApi.value = res.sources
    errorMsg.value = ''
    errorSeverity.value = null
    // 上传条目结算：已在列表落地的 done 条目移除（挂载/轮询/手动刷新都会走到这里）
    uploadsStore.settleAgainstDocs(docs.value)
    if (isMounted && (uploadsStore.hasAwaitingIndex() || hasPollableVectorJobs())) {
      ensureIndexPolling()
    }

    // DB cache layer removed — no local cache to update
  } catch (e) {
    if (hadCache) {
      // 有缓存兜底：软提示
      errorMsg.value = t('knowledge.syncFailed')
      errorSeverity.value = 'warning'
    } else {
      // 无缓存：硬错误
      errorMsg.value = e instanceof Error ? e.message : t('knowledge.loadFailed')
      errorSeverity.value = 'error'
    }
    logger.warn('[Knowledge] API revalidation failed', e)
  } finally {
    if (requestGeneration === documentRequestGeneration) {
      loading.value = false
      revalidating.value = false
    }
  }
}

function ensureKnowledgeEnabled() {
  if (knowledgeEnabled.value) return true
  errorMsg.value = t('knowledge.backendDisabled')
  return false
}

async function handleAdd() {
  if (!ensureKnowledgeEnabled()) return
  if (!newTitle.value.trim() || !newContent.value.trim()) {
    openFilePicker()
    return
  }
  adding.value = true
  errorMsg.value = ''
  try {
    await addDocument(
      newTitle.value.trim(),
      newContent.value.trim(),
      newSource.value.trim() || undefined,
    )
    closeAddDialog()
    await loadDocs()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('knowledge.addFailed')
    logger.error('[Knowledge] add failed:', e)
  } finally {
    adding.value = false
  }
}

function confirmDelete(doc: KnowledgeDoc) {
  deletingDoc.value = doc
  showDeleteConfirm.value = true
}

async function handleDelete() {
  if (!deletingDoc.value) return
  const doc = deletingDoc.value
  errorMsg.value = ''
  try {
    await deleteDocument(doc.id)
    docs.value = docs.value.filter((d) => d.id !== doc.id)
    totalDocs.value = Math.max(0, totalDocs.value - 1)
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('knowledge.deleteFailed')
    logger.error('[Knowledge] delete failed:', e)
  } finally {
    showDeleteConfirm.value = false
    deletingDoc.value = null
  }
}

function closeDeleteConfirm() {
  showDeleteConfirm.value = false
  deletingDoc.value = null
}

async function handleSearch() {
  if (!ensureKnowledgeEnabled()) return
  const requestGen = ++searchRequestGen
  if (!searchQuery.value.trim()) {
    searchResults.value = []
    return
  }
  searching.value = true
  errorMsg.value = ''
  try {
    const res = await searchKnowledge(searchQuery.value, 5, buildSearchFilter())
    if (requestGen !== searchRequestGen) return
    searchResults.value = res.result || []
  } catch (e) {
    if (requestGen !== searchRequestGen) return
    errorMsg.value = e instanceof Error ? e.message : t('knowledge.searchFailed')
    logger.error('[Knowledge] search failed:', e)
  } finally {
    if (requestGen === searchRequestGen) {
      searching.value = false
    }
  }
}

function formatScore(score: number): string {
  const clamped = Math.max(0, Math.min(1, score))
  return `${(clamped * 100).toFixed(1)}%`
}

function getTextIndexState(doc: KnowledgeDoc): string | undefined {
  return typeof doc.text_index_state === 'string' && doc.text_index_state
    ? doc.text_index_state
    : undefined
}

function getIngestionState(doc: KnowledgeDoc): string | undefined {
  const state =
    doc.ingestion_state ??
    doc.ingestion?.ingestion_state ??
    doc.ingestion?.state ??
    doc.ingestion?.failure_code ??
    doc.failure_code
  return typeof state === 'string' && state ? state : undefined
}

function getFailureCode(doc: KnowledgeDoc): string | undefined {
  const code = doc.failure_code ?? doc.ingestion?.failure_code
  return typeof code === 'string' && code ? code : undefined
}

function getAffectedPages(doc: KnowledgeDoc): number | number[] | undefined {
  const pages = doc.affected_pages ?? doc.ingestion?.affected_pages
  if (typeof pages === 'number' && Number.isFinite(pages)) return pages
  if (!Array.isArray(pages) || pages.some((page) => typeof page !== 'number')) return undefined
  return pages
}

function formatAffectedPages(pages: number | number[] | undefined): string | undefined {
  if (typeof pages === 'number') return String(pages)
  if (Array.isArray(pages)) return pages.length ? pages.join(',') : 'none'
  return undefined
}

function getFrozenVisionProvider(doc: KnowledgeDoc): string | undefined {
  const provider =
    doc.frozen_vision_provider ??
    doc.ingestion?.frozen_vision_provider ??
    doc.ingestion?.frozen_vision?.provider
  return typeof provider === 'string' && provider ? provider : undefined
}

function getFrozenVisionModel(doc: KnowledgeDoc): string | undefined {
  const model =
    doc.frozen_vision_model ?? doc.ingestion?.frozen_vision_model ?? doc.ingestion?.frozen_vision?.model
  return typeof model === 'string' && model ? model : undefined
}

function getPreflightState(doc: KnowledgeDoc): string | undefined {
  const state = doc.preflight_state ?? doc.ingestion?.preflight_state
  if (typeof state === 'string' && state) return state
  const preflight = doc.ingestion?.preflight
  if (typeof preflight === 'string' && preflight) return preflight
  if (preflight && typeof preflight === 'object') {
    if (preflight.state) return preflight.state
    if (preflight.blocked === true) return 'blocked'
  }
  return undefined
}

function getModelCalls(doc: KnowledgeDoc): number | undefined {
  const calls = doc.model_calls ?? doc.ingestion?.model_calls
  return typeof calls === 'number' ? calls : undefined
}

function getAvailableActions(doc: KnowledgeDoc): string[] | undefined {
  const actions = doc.available_actions ?? doc.ingestion?.available_actions
  if (!Array.isArray(actions)) return undefined
  return actions.filter((action): action is string => typeof action === 'string')
}

function getStructuredDocumentFacts(doc: KnowledgeDoc): string[] {
  if (getDocStatus(doc) !== 'failed') return []
  const facts: string[] = []
  const textIndexState = getTextIndexState(doc)
  const ingestionState = getIngestionState(doc)
  const failureCode = getFailureCode(doc)
  const affectedPages = getAffectedPages(doc)
  const provider = getFrozenVisionProvider(doc)
  const model = getFrozenVisionModel(doc)
  const preflightState = getPreflightState(doc)
  const modelCalls = getModelCalls(doc)

  if (textIndexState) {
    const extracted = textIndexState === 'ready' ? ' · 文本页已提取 · 文档仍保留' : ''
    facts.push(`text_index_state=${textIndexState}${extracted}`)
  }
  if (ingestionState || failureCode || affectedPages !== undefined) {
    facts.push(
      `ingestion=${ingestionState ?? 'unknown'} · failure_code=${failureCode ?? 'unknown'} · affected_pages=${formatAffectedPages(affectedPages) ?? 'unknown'}`,
    )
  }
  if (preflightState || provider || model || modelCalls !== undefined) {
    facts.push(
      `preflight=${preflightState ?? 'unknown'} · frozen vision provider/model=${[provider, model].filter(Boolean).join(' / ') || 'unknown'} · model_calls=${modelCalls ?? 0}`,
    )
  }
  return facts
}

function hasKnowledgeAvailableAction(doc: KnowledgeDoc, names: string[]): boolean | undefined {
  const actions = getAvailableActions(doc)
  if (!actions) return undefined
  const expected = new Set(names)
  return actions.some((action) =>
    expected.has(action.trim().toLowerCase().replace(/[\s-]+/g, '_')),
  )
}

function shouldShowKnowledgeSettingsAction(doc: KnowledgeDoc): boolean {
  if (getDocStatus(doc) !== 'failed') return false
  const available = hasKnowledgeAvailableAction(doc, [
    'settings',
    'open_settings',
    'provider_settings',
    'open_provider_settings',
    'configure_provider',
    'configure_vision',
  ])
  if (available !== undefined) return available
  const failureCode = getFailureCode(doc)?.toLowerCase() ?? ''
  return (
    failureCode.includes('vision') ||
    Boolean(getFrozenVisionProvider(doc) || getFrozenVisionModel(doc)) ||
    getPreflightState(doc) === 'blocked'
  )
}

function openKnowledgeSettings() {
  if (appRouter?.push) {
    void appRouter.push('/settings')
    return
  }
  if (typeof window !== 'undefined') window.location.assign('/settings')
}

function getDocStatus(doc: KnowledgeDoc): 'processing' | 'indexed' | 'failed' {
  if (doc.status) return doc.status
  if (doc.text_index_state === 'failed' || getIngestionState(doc) === 'failed' || getFailureCode(doc)) {
    return 'failed'
  }
  if (doc.error_message) return 'failed'
  return 'indexed'
}

function getDocStatusLabel(doc: KnowledgeDoc): string {
  switch (getDocStatus(doc)) {
    case 'processing':
      return t('knowledge.statusProcessing')
    case 'failed':
      return t('knowledge.statusFailed')
    default:
      return t('knowledge.statusIndexed')
  }
}

function getDocStatusStyle(doc: KnowledgeDoc) {
  switch (getDocStatus(doc)) {
    case 'processing':
      return { background: '#f59e0b15', color: '#b45309' }
    case 'failed':
      return { background: '#ef444415', color: '#dc2626' }
    default:
      return { background: '#22c55e15', color: '#15803d' }
  }
}

function isDurableUploadedDocument(doc: KnowledgeDoc): boolean {
  return (
    doc.source_type === 'upload' ||
    doc.source_type === 'image' ||
    doc.source?.startsWith('upload:') === true ||
    doc.source?.startsWith('image:upload:') === true
  )
}

function hasRetryableVectorFailure(doc: KnowledgeDoc): boolean {
  return (
    doc.vector_index_state === 'failed' &&
    doc.vector_job_state === 'failed' &&
    doc.vector_outcome_unknown !== true
  )
}

function canReindexDocument(doc: KnowledgeDoc): boolean {
  if (getDocStatus(doc) === 'failed' || hasRetryableVectorFailure(doc)) return true
  const sourceType = doc.source_type?.trim().toLowerCase()
  if (sourceType) return ['manual', 'upload', 'image'].includes(sourceType)
  return !isDurableUploadedDocument(doc)
}

function canCancelVectorJob(doc: KnowledgeDoc): boolean {
  return (
    Boolean(doc.vector_job_id) &&
    (POLLABLE_VECTOR_JOB_STATES.has(doc.vector_job_state ?? '') ||
      doc.vector_outcome_unknown === true)
  )
}

function getVectorStatusLabel(doc: KnowledgeDoc): string {
  if (doc.vector_outcome_unknown) {
    return t('knowledge.vectorOutcomeUnknown', '语义增强结果待核实')
  }
  switch (doc.vector_index_state) {
    case 'pending':
      return t('knowledge.vectorPending', '语义增强等待中')
    case 'building':
      return t('knowledge.vectorBuilding', '语义增强中')
    case 'retry_wait':
      return t('knowledge.vectorRetryWait', '语义增强等待重试')
    case 'failed':
      return t('knowledge.vectorFailed', '语义增强失败')
    case 'cancelled':
      return ''
    default:
      return ''
  }
}

function getVectorProgress(doc: KnowledgeDoc): string {
  if (typeof doc.vector_chunks_total !== 'number' || doc.vector_chunks_total <= 0) return ''
  return `${doc.vector_chunks_done ?? 0}/${doc.vector_chunks_total}`
}

function documentExtension(name: string): string {
  const extension = name.split('.').pop()?.trim().toUpperCase()
  return extension && extension !== name.trim().toUpperCase() ? extension.slice(0, 6) : 'DOC'
}

function isReadingDocumentProjection(doc: KnowledgeDoc): boolean {
  return reindexingDocIds.value.has(doc.id)
}

function getDocumentRowStatus(doc: KnowledgeDoc): string {
  if (isReadingDocumentProjection(doc)) return t('knowledge.authorityReading')
  const structuredFacts = getStructuredDocumentFacts(doc)
  if (structuredFacts.length > 0) return structuredFacts.join('\n')
  if (doc.error_message) return doc.error_message
  if (
    getDocStatus(doc) === 'processing' &&
    doc.source_type?.trim().toLowerCase() === 'connector' &&
    doc.vector_index_state === 'building'
  ) {
    return t(
      'knowledge.connectorIndexing',
      '已上传 · 后端正在解析并建索引（扫描件/大文件较慢，请稍候）',
    )
  }
  const vectorStatus = getVectorStatusLabel(doc)
  if (vectorStatus) {
    const progress = getVectorProgress(doc)
    return [vectorStatus, progress, doc.vector_error].filter(Boolean).join(' · ')
  }
  const chunks = `${doc.chunk_count} ${t('knowledge.chunkUnit', '个 chunk')}`
  if (getDocStatus(doc) === 'indexed' && doc.vector_index_state === 'ready') {
    const details = [chunks]
    if (doc.source_type?.trim().toLowerCase() === 'chat') {
      details.push(formatRelative(doc.created_at, Date.now()))
    } else if (doc.source_type?.trim().toLowerCase() === 'upload' && ragConfig.value?.contextual) {
      details.push(t('knowledge.contextualReady', 'Contextual 已写入'))
    }
    return `文本 + 语义已就绪 · ${details.join(' · ')}`
  }
  return `${getDocStatusLabel(doc)} · ${chunks}`
}

function getDocumentBadgeLabel(doc: KnowledgeDoc): string {
  if (isReadingDocumentProjection(doc)) return t('knowledge.syncingStatus')
  if (['pending', 'building', 'retry_wait'].includes(doc.vector_index_state ?? '')) {
    return t('knowledge.semanticIndex.enhancing')
  }
  if (doc.vector_index_state === 'ready') return '混合检索'
  if (doc.vector_index_state === 'failed' || getDocStatus(doc) === 'failed') {
    return t('knowledge.processingFailed')
  }
  if (getDocStatus(doc) === 'processing') return getDocStatusLabel(doc)
  return ''
}

function getDocumentBadgeStyle(doc: KnowledgeDoc) {
  if (isReadingDocumentProjection(doc)) {
    return { background: 'rgba(240, 180, 41, 0.14)', color: 'var(--hc-warning)' }
  }
  if (['pending', 'building', 'retry_wait'].includes(doc.vector_index_state ?? '')) {
    return { background: 'rgba(240, 180, 41, 0.14)', color: 'var(--hc-warning)' }
  }
  if (doc.vector_index_state === 'ready') return { background: '#22c55e15', color: '#15803d' }
  return getDocStatusStyle(doc)
}

function getUploadRowStatus(entry: KnowledgeUploadEntry): string {
  switch (entry.status) {
    case 'uploading':
      return `${t('knowledge.uploading')} ${entry.progress}%`
    case 'processing':
      return t('knowledge.processing')
    case 'pending-response':
      return (
        entry.error ||
        t('knowledge.uploadAwaitingAcceptance', '等待服务器确认；可重新选择同一文件恢复')
      )
    case 'error':
      return entry.error || t('knowledge.uploadFailed')
    case 'done':
      return entry.warning || t('knowledge.indexing')
    case 'cancelled':
      return ''
  }
}

function getUploadBadgeLabel(entry: KnowledgeUploadEntry): string {
  if (entry.status === 'processing') return t('knowledge.semanticIndex.enhancing')
  if (entry.status === 'error') return t('knowledge.statusFailed')
  return ''
}

function getUploadBadgeStyle(entry: KnowledgeUploadEntry) {
  if (entry.status === 'processing') {
    return { background: 'rgba(240, 180, 41, 0.14)', color: 'var(--hc-warning)' }
  }
  if (entry.status === 'error') return { background: '#ef444415', color: '#dc2626' }
  return { background: 'var(--hc-bg-hover)', color: 'var(--hc-text-secondary)' }
}

const loadingDocContent = ref(false)
const docContentError = ref('')
let docContentRequestGen = 0

async function loadDocContent(doc: KnowledgeDoc) {
  const requestGen = ++docContentRequestGen
  loadingDocContent.value = true
  docContentError.value = ''
  try {
    const content = await getDocumentContent(doc)
    if (requestGen === docContentRequestGen && selectedDoc.value?.id === doc.id) {
      selectedDoc.value = { ...doc, content }
      // 同步更新列表中的文档对象，避免非空正文下次打开时重复请求。
      const idx = docs.value.findIndex((d) => d.id === doc.id)
      if (idx >= 0) docs.value[idx] = selectedDoc.value
    }
  } catch (error) {
    if (requestGen === docContentRequestGen && selectedDoc.value?.id === doc.id) {
      docContentError.value = t('knowledge.docContentLoadFailed')
      logger.warn('[Knowledge] document content read failed', error)
    }
  } finally {
    if (requestGen === docContentRequestGen) {
      loadingDocContent.value = false
    }
  }
}

async function openDocDetail(doc: KnowledgeDoc) {
  ++docContentRequestGen
  selectedDoc.value = doc
  showDocDetail.value = true
  loadingDocContent.value = false
  docContentError.value = ''

  // 如果列表接口未返回正文，主动获取内容。
  if (!doc.content?.trim()) await loadDocContent(doc)
}

async function retryDocContent() {
  if (!selectedDoc.value || loadingDocContent.value) return
  await loadDocContent(selectedDoc.value)
}

async function handleReindex(doc: KnowledgeDoc) {
  if (!ensureKnowledgeEnabled()) return
  if (reindexingDocIds.value.has(doc.id) || hasPollableVectorJob(doc)) return
  const next = new Set(reindexingDocIds.value)
  next.add(doc.id)
  reindexingDocIds.value = next
  errorMsg.value = ''

  try {
    const retryingText = getDocStatus(doc) === 'failed'
    const retryingVector = hasRetryableVectorFailure(doc)
    if (retryingText || retryingVector) {
      const accepted = await retryKnowledgeDocument(doc.id)
      docs.value = docs.value.map((item) =>
        item.id === doc.id
          ? retryingVector
            ? {
                ...item,
                vector_index_state: accepted.vector_index_state,
                vector_job_id: accepted.job_id,
                vector_job_state:
                  accepted.vector_index_state === 'ready'
                    ? 'succeeded'
                    : accepted.vector_index_state === 'failed'
                      ? 'failed'
                      : 'queued',
                vector_job_stage: 'embedding',
                vector_chunks_done: 0,
                vector_error: undefined,
                vector_outcome_unknown: false,
                updated_at: new Date().toISOString(),
              }
            : {
                ...item,
                status:
                  accepted.text_index_state === 'ready'
                    ? 'indexed'
                    : accepted.text_index_state === 'failed'
                      ? 'failed'
                      : 'processing',
                error_message: undefined,
                updated_at: new Date().toISOString(),
              }
          : item,
      )
      if (retryingText) {
        const tracked = uploadsStore.items.find((entry) => entry.jobId === accepted.job_id)
        if (!tracked) {
          uploadsStore.track({
            name: doc.title,
            progress: 100,
            status: 'processing',
            operationId: accepted.operation_id,
            documentId: accepted.document_id,
            jobId: accepted.job_id,
            stage: accepted.text_index_state === 'ready' ? 'embedding' : 'extracting',
          })
        }
      }
      ensureIndexPolling()
      return
    }
    await reindexDocument(doc.id)
    await refreshDocumentProjection(doc.id)
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('knowledge.reindexUnavailable')
  } finally {
    const current = new Set(reindexingDocIds.value)
    current.delete(doc.id)
    reindexingDocIds.value = current
  }
}

async function cancelDocumentVectorJob(doc: KnowledgeDoc) {
  const jobID = doc.vector_job_id
  if (!jobID || !canCancelVectorJob(doc) || cancellingVectorJobIds.value.has(jobID)) return
  const next = new Set(cancellingVectorJobIds.value)
  next.add(jobID)
  cancellingVectorJobIds.value = next
  errorMsg.value = ''
  try {
    const job = await cancelKnowledgeJob(jobID)
    updateVectorJobProjection(job)
    await refreshDocumentProjection(doc.id)
  } catch (error) {
    errorMsg.value =
      error instanceof Error ? error.message : t('knowledge.vectorCancelFailed', '取消语义增强失败')
    errorSeverity.value = 'error'
  } finally {
    const current = new Set(cancellingVectorJobIds.value)
    current.delete(jobID)
    cancellingVectorJobIds.value = current
  }
}

function resultTitle(result: KnowledgeSearchResult): string {
  return result.doc_title || result.source || t('knowledge.searchResult')
}

function resultMeta(result: KnowledgeSearchResult): string {
  const parts: string[] = []
  if (result.source) parts.push(result.source)
  if (typeof result.chunk_index === 'number') {
    const total = typeof result.chunk_count === 'number' ? `/${result.chunk_count}` : ''
    parts.push(`${t('knowledge.chunk')} ${result.chunk_index + 1}${total}`)
  }
  return parts.join(' · ')
}

// --- File Upload ---

function handleDragOver(e: DragEvent) {
  e.preventDefault()
  if (!knowledgeEnabled.value) return
  isDragging.value = true
}

function handleDragLeave() {
  isDragging.value = false
}

function handleDrop(e: DragEvent) {
  e.preventDefault()
  if (!ensureKnowledgeEnabled()) return
  isDragging.value = false
  const files = e.dataTransfer?.files
  if (files) processFiles(files)
}

function handleFileSelect(e: Event) {
  if (!ensureKnowledgeEnabled()) return
  const input = e.target as HTMLInputElement
  if (input.files && input.files.length > 0) {
    showAddDialog.value = false
    processFiles(input.files)
  }
  input.value = ''
}

function openFilePicker() {
  if (!ensureKnowledgeEnabled()) return
  fileInputRef.value?.click()
}

const MAX_FILE_SIZE = 200 * 1024 * 1024 // 200 MiB, aligned with the durable ingest service.

async function processFiles(files: FileList) {
  if (!ensureKnowledgeEnabled()) return
  uploadsStore.clearErrors() // 新一轮上传前清掉旧错误条目
  const selectedFiles = Array.from(files)
  const batchBytes = selectedFiles.reduce((total, file) => total + file.size, 0)
  if (batchBytes > MAX_KNOWLEDGE_UPLOAD_BATCH_BYTES) {
    const firstName = selectedFiles[0]?.name || t('knowledge.title')
    uploadsStore.track({
      name: selectedFiles.length > 1 ? `${firstName} +${selectedFiles.length - 1}` : firstName,
      progress: 0,
      status: 'error',
      error: t('knowledge.uploadBatchTooLarge', { max: '512 MB' }),
    })
    return
  }
  const uploadTasks: Promise<void>[] = []
  let uploadedAny = false

  for (const file of selectedFiles) {
    if (file.size === 0) {
      uploadsStore.track({
        name: file.name,
        progress: 0,
        status: 'error',
        error: t('knowledge.fileEmpty', '文件为空'),
      })
      continue
    }

    if (file.size > MAX_FILE_SIZE) {
      uploadsStore.track({
        name: file.name,
        progress: 0,
        status: 'error',
        error: t('knowledge.fileTooLarge', { max: '200 MB' }),
      })
      continue
    }

    const ext = '.' + file.name.split('.').pop()?.toLowerCase()
    if (!ACCEPTED_TYPES.includes(ext)) {
      uploadsStore.track({
        name: file.name,
        progress: 0,
        status: 'error',
        error: t('knowledge.unsupportedFileType', { types: ACCEPTED_TYPES.join(', ') }),
      })
      continue
    }

    // store.track 返回响应式 entry——上传任务改 entry.progress/status 即驱动 UI，
    // 且条目挂在 store 上，跨组件卸载/重挂载存活（BUG-20260710）。
    let entry = uploadsStore.track({ name: file.name, progress: 0, status: 'uploading' })
    const uploadController = new AbortController()
    uploadAbortControllers.set(entry, uploadController)

    uploadTasks.push(
      (async () => {
        const updateProgress = (pct: number) => {
          entry.progress = pct
          // 字节已传完但尚未拿到 202/Job：这是可恢复的 response-unknown 窗口，
          // 不能冒充已有 Job 的 processing 相，否则刷新后无 jobId 可轮询。
          if (pct >= 100) uploadsStore.markPendingResponse(entry)
        }

        try {
          const accepted = await uploadDocument(
            file,
            updateProgress,
            (intent) => {
              const previousEntry = entry
              entry = uploadsStore.bindIntent(entry, intent)
              if (entry !== previousEntry) {
                uploadAbortControllers.delete(previousEntry)
                uploadAbortControllers.set(entry, uploadController)
              }
            },
            { signal: uploadController.signal },
          )
          uploadsStore.attachJob(
            entry,
            accepted.document_id,
            accepted.job_id,
            accepted.operation_id,
          )
          uploadedAny = true
        } catch (e) {
          if (uploadController.signal.aborted) {
            uploadsStore.markCancelled(entry)
            return
          }
          const isImage = IMAGE_TYPES.includes(ext)
          const rawMessage = e instanceof Error ? e.message : ''
          // 图片入库失败且根因是「缺少视觉模型」时，给出本地化、可操作的引导，
          // 不把后端的底层技术细节（如 "model does not support image input"）甩给用户。
          const message =
            isImage && isVisionModelError(rawMessage)
              ? t('knowledge.imageVisionRequired')
              : rawMessage || t('knowledge.uploadFailed')
          if (entry.intentKey && !isDefinitiveKnowledgeUploadRejection(e)) {
            uploadsStore.markPendingResponse(
              entry,
              `${message}；${t('knowledge.uploadReselectToRecover', '请重新选择同一文件恢复')}`,
            )
          } else {
            entry.status = 'error'
            entry.error = message
          }
        } finally {
          if (uploadAbortControllers.get(entry) === uploadController) {
            uploadAbortControllers.delete(entry)
          }
        }
      })(),
    )
  }

  await Promise.all(uploadTasks)

  if (uploadedAny) {
    // revalidateFromApi 成功后会 settleAgainstDocs：已落地的 done 条目移除；
    // 索引未完成的保留并开启轻量轮询，直到文档真正出现在列表里（BUG-20260710）。
    await loadDocs()
    ensureIndexPolling()
  }
}

// Global drag prevention
function preventDefaultDrag(e: DragEvent) {
  e.preventDefault()
}
onMounted(() => {
  document.addEventListener('dragover', preventDefaultDrag)
  document.addEventListener('drop', preventDefaultDrag)
})
onUnmounted(() => {
  document.removeEventListener('dragover', preventDefaultDrag)
  document.removeEventListener('drop', preventDefaultDrag)
})

async function rebuildAll() {
  if (!ensureKnowledgeEnabled()) return
  // 串行重建，避免并发轰炸 embedding API 和 SQLite 写锁
  for (const doc of docs.value) {
    await handleReindex(doc)
  }
}

function resetAddDialogForm() {
  newTitle.value = ''
  newContent.value = ''
  newSource.value = ''
}

function closeAddDialog() {
  showAddDialog.value = false
  errorMsg.value = ''
  resetAddDialogForm()
}

function openUpload() {
  if (!ensureKnowledgeEnabled()) return
  closeAddDialog()
  showAddDialog.value = true
  void nextTick(() => newTitleInput.value?.focus())
}

defineExpose({ rebuildAll, openUpload, openFilePicker, docs, loadDocs })
</script>

<template>
  <div class="knowledge-page h-full flex flex-col overflow-hidden">
    <input
      ref="fileInputRef"
      type="file"
      :accept="ACCEPTED_TYPES.join(',')"
      multiple
      class="hidden"
      @change="handleFileSelect"
    />

    <!-- 错误/警告提示 -->
    <div
      v-if="errorMsg"
      class="mx-6 mt-2 px-4 py-2 rounded-lg text-sm flex items-center justify-between"
      :style="{
        background: errorSeverity === 'warning' ? '#f59e0b20' : '#ef444420',
        color: errorSeverity === 'warning' ? '#d97706' : '#ef4444',
      }"
    >
      <span class="flex items-center gap-2">
        <AlertTriangle v-if="errorSeverity === 'warning'" :size="14" />
        {{ errorMsg }}
      </span>
      <span class="flex items-center gap-2">
        <button
          v-if="errorSeverity === 'error'"
          class="text-xs underline"
          @click="revalidateFromApi(false)"
        >
          {{ t('knowledge.retrySync') }}
        </button>
        <button class="text-xs underline" @click="errorMsg = ''">{{ t('common.close') }}</button>
      </span>
    </div>

    <div
      v-if="!knowledgeEnabled"
      class="mx-6 mt-2 px-4 py-3 rounded-xl text-sm"
      :style="{
        background: 'var(--hc-warning-soft, #f59e0b15)',
        color: 'var(--hc-warning-text, #b45309)',
      }"
    >
      <div class="font-medium">{{ t('knowledge.backendDisabled') }}</div>
      <div class="mt-1 text-xs" :style="{ color: 'var(--hc-text-secondary)' }">
        {{ t('knowledge.backendDisabledDesc') }}
      </div>
    </div>

    <div
      class="knowledge-page__scroll flex-1 overflow-y-auto relative"
      @dragover="handleDragOver"
      @dragleave="handleDragLeave"
      @drop="handleDrop"
    >
      <!-- Drag overlay -->
      <Transition name="modal">
        <div
          v-if="isDragging"
          class="absolute inset-0 z-30 flex items-center justify-center bg-black/20 backdrop-blur-sm rounded-xl pointer-events-none"
        >
          <div
            class="flex flex-col items-center gap-3 p-8 rounded-2xl border-2 border-dashed"
            :style="{ borderColor: 'var(--hc-accent)', background: 'var(--hc-bg-elevated)' }"
          >
            <FileUp :size="40" :style="{ color: 'var(--hc-accent)' }" />
            <span class="text-sm font-medium" :style="{ color: 'var(--hc-accent)' }">{{
              t('knowledge.dropHint')
            }}</span>
          </div>
        </div>
      </Transition>

      <div class="knowledge-page__content">
        <div class="knowledge-page__tab-stack">
          <!-- 标签页（统一 UnderlineTabs，滑动下划线） -->
          <UnderlineTabs
            :tabs="knowledgeTabs"
            :model-value="activeTab"
            @update:model-value="activeTab = $event as 'documents' | 'search'"
          />

          <div class="knowledge-page__active-panel">
            <!-- 仅“全部”面板的第一项：健康态默认折叠；切换回来时重新按默认态挂载。 -->
            <SemanticIndexCard v-if="activeTab === 'documents' && knowledgeEnabled" />

            <!-- Upload progress list -->
            <div v-if="uploadingFiles.length > 0" class="knowledge-page__temporary-list mb-4 space-y-2">
              <div
                v-for="(uf, idx) in uploadingFiles"
                :key="idx"
                data-testid="knowledge-upload-job"
                class="knowledge-page__resource-row knowledge-page__temporary-row"
                :class="{ 'knowledge-page__resource-row--error': uf.status === 'error' }"
              >
                <span class="knowledge-page__resource-file">
                  <span
                    data-testid="knowledge-document-extension"
                    class="knowledge-page__resource-extension"
                  >
                    {{ documentExtension(uf.name) }}
                  </span>
                </span>
                <span class="knowledge-page__document-main flex-1 min-w-0">
                  <span
                    class="knowledge-page__resource-title"
                    :style="{ color: 'var(--hc-text-primary)' }"
                  >
                    {{ uf.name }}
                  </span>
                  <span
                    v-if="getUploadRowStatus(uf)"
                    class="knowledge-page__resource-status"
                    :class="{ 'animate-pulse': uf.status === 'processing' }"
                    :data-testid="
                      uf.status === 'processing'
                        ? 'upload-processing'
                        : uf.status === 'pending-response'
                          ? 'knowledge-upload-pending-response'
                          : undefined
                    "
                  >
                    {{ getUploadRowStatus(uf) }}
                  </span>
                </span>
                <span
                  v-if="getUploadBadgeLabel(uf)"
                  class="knowledge-page__resource-badge"
                  :style="getUploadBadgeStyle(uf)"
                >
                  {{ getUploadBadgeLabel(uf) }}
                </span>
                <button
                  v-if="canCancelUpload(uf)"
                  type="button"
                  class="knowledge-page__resource-action"
                  :disabled="uf.cancelling"
                  data-testid="knowledge-upload-cancel"
                  @click="cancelUploadJob(uf)"
                >
                  {{ t('common.cancel') }}
                </button>
              </div>
            </div>

            <LoadingState v-if="loading" />

            <!-- 文档标签 -->
            <template v-else-if="activeTab === 'documents'">
              <EmptyState
                v-if="docs.length === 0"
                :icon="BookOpen"
                :title="t('knowledge.noDocs')"
                :description="t('knowledge.noDocsDesc')"
              >
                <p
                  v-if="knowledgeEnabled"
                  class="text-xs mt-2 mb-2"
                  :style="{ color: 'var(--hc-text-secondary)' }"
                >
                  {{ t('knowledge.modeHint') }}
                </p>
                <p class="text-xs mt-2 mb-4" :style="{ color: 'var(--hc-text-muted)' }">
                  {{ t('knowledge.dragHint') }}
                </p>
              </EmptyState>

              <template v-else>
                <div
                  v-if="revalidating"
                  class="max-w-2xl mb-3 flex items-center gap-1.5 text-xs"
                  :style="{ color: 'var(--hc-text-muted)' }"
                >
                  <RefreshCw :size="12" class="animate-spin" />
                  <span>{{ t('knowledge.syncing') }}</span>
                </div>

                <!-- 来源分组过滤：每个 source 一颗 chip（#5），快照按来源折叠筛选 -->
                <div
                  v-if="sourceFacet.length > 1"
                  data-testid="knowledge-source-filters"
                  class="knowledge-page__source-filters flex flex-wrap items-center gap-[6px] mb-3"
                >
                  <button
                    type="button"
                    data-testid="kb-source-chip-all"
                    :aria-pressed="selectedSource === null"
                    class="knowledge-page__source-chip text-xs rounded-[9px] border transition-colors"
                    :style="
                      selectedSource === null
                        ? {
                            background: 'var(--hc-accent-subtle)',
                            borderColor: 'var(--hc-border-hl)',
                            color: 'var(--hc-accent)',
                          }
                        : {
                            background: 'var(--hc-bg-card)',
                            borderColor: 'var(--hc-border)',
                            color: 'var(--hc-text-secondary)',
                          }
                    "
                    @click="selectSource(null)"
                  >
                    {{ t('knowledge.allSources') }}
                  </button>
                  <button
                    v-for="f in sourceFacet"
                    :key="f.source"
                    type="button"
                    :data-testid="`kb-source-chip-${f.source}`"
                    :aria-pressed="selectedSource === f.source"
                    class="knowledge-page__source-chip text-xs rounded-[9px] border transition-colors max-w-[14rem] truncate"
                    :style="
                      selectedSource === f.source
                        ? {
                            background: 'var(--hc-accent-subtle)',
                            borderColor: 'var(--hc-border-hl)',
                            color: 'var(--hc-accent)',
                          }
                        : {
                            background: 'var(--hc-bg-card)',
                            borderColor: 'var(--hc-border)',
                            color: 'var(--hc-text-secondary)',
                          }
                    "
                    :title="f.source"
                    @click="selectSource(f.source)"
                  >
                    {{ f.source }} ({{ f.count }})
                  </button>
                </div>

                <!-- 文档列表 -->
                <div
                  data-testid="knowledge-doc-list"
                  class="knowledge-page__document-list space-y-2"
                >
                  <template v-if="filteredDocs.length > 0">
                    <div
                      v-for="doc in windowedDocs"
                      :key="doc.id"
                      data-testid="knowledge-doc-card"
                      :data-text-index-state="getTextIndexState(doc)"
                      :data-ingestion-failure-code="getFailureCode(doc)"
                      :data-affected-pages="formatAffectedPages(getAffectedPages(doc))"
                      :data-frozen-vision-provider="getFrozenVisionProvider(doc)"
                      :data-frozen-vision-model="getFrozenVisionModel(doc)"
                      :data-preflight-state="getPreflightState(doc)"
                      :data-preflight="getPreflightState(doc)"
                      :data-model-calls="getModelCalls(doc)"
                      :class="{
                        'knowledge-page__document-card--structured-failure':
                          getStructuredDocumentFacts(doc).length > 0,
                      }"
                      class="knowledge-page__resource-row knowledge-page__document-card flex items-center"
                    >
                      <span class="knowledge-page__resource-file">
                        <span
                          data-testid="knowledge-document-extension"
                          class="knowledge-page__resource-extension"
                        >
                          {{ documentExtension(doc.title) }}
                        </span>
                      </span>
                      <span class="knowledge-page__document-main flex-1 min-w-0">
                        <span
                          class="knowledge-page__resource-title"
                          :style="{ color: 'var(--hc-text-primary)' }"
                        >
                          {{ doc.title }}
                        </span>
                        <span
                          data-testid="knowledge-vector-status"
                          class="knowledge-page__resource-status"
                          :title="getDocumentRowStatus(doc)"
                        >
                          {{ getDocumentRowStatus(doc) }}
                        </span>
                      </span>
                      <span
                        v-if="getDocumentBadgeLabel(doc)"
                        data-testid="knowledge-document-badge"
                        class="knowledge-page__resource-badge"
                        :style="getDocumentBadgeStyle(doc)"
                      >
                        {{ getDocumentBadgeLabel(doc) }}
                      </span>
                      <div
                        data-testid="knowledge-doc-actions"
                        class="knowledge-page__document-actions shrink-0 flex items-center gap-1"
                      >
                        <button
                          v-if="getStructuredDocumentFacts(doc).length === 0 && getDocStatus(doc) !== 'processing'"
                          type="button"
                          class="knowledge-page__resource-action"
                          @click="openDocDetail(doc)"
                        >
                          详情
                        </button>
                        <button
                          v-if="canReindexDocument(doc)"
                          :data-testid="
                            hasRetryableVectorFailure(doc) ? 'knowledge-vector-retry' : undefined
                          "
                          type="button"
                          class="knowledge-page__resource-action"
                          :disabled="
                            !knowledgeEnabled ||
                            reindexingDocIds.has(doc.id) ||
                            hasPollableVectorJob(doc) ||
                            getDocStatus(doc) === 'processing'
                          "
                          :aria-busy="reindexingDocIds.has(doc.id) ? 'true' : undefined"
                          @click="handleReindex(doc)"
                        >
                          {{
                            getDocStatus(doc) === 'failed' || hasRetryableVectorFailure(doc)
                              ? t('knowledge.retryDocument')
                              : '重建'
                          }}
                        </button>
                        <button
                          v-if="shouldShowKnowledgeSettingsAction(doc)"
                          type="button"
                          data-testid="knowledge-settings-action"
                          class="knowledge-page__resource-action"
                          @click="openKnowledgeSettings"
                        >
                          {{ t('knowledge.settingsAction') }}
                        </button>
                        <button
                          v-if="canCancelVectorJob(doc)"
                          type="button"
                          data-testid="knowledge-vector-cancel"
                          class="knowledge-page__resource-action knowledge-page__resource-action--warning"
                          :title="t('knowledge.vectorCancel', '取消语义增强')"
                          :disabled="
                            !knowledgeEnabled || cancellingVectorJobIds.has(doc.vector_job_id || '')
                          "
                          @click="cancelDocumentVectorJob(doc)"
                        >
                          {{ t('knowledge.vectorCancelShort', '取消') }}
                        </button>
                        <button
                          v-if="getStructuredDocumentFacts(doc).length === 0 && getDocStatus(doc) !== 'processing'"
                          type="button"
                          class="knowledge-page__resource-action knowledge-page__resource-action--danger"
                          :disabled="!knowledgeEnabled"
                          @click="confirmDelete(doc)"
                        >
                          {{ t('common.delete') }}
                        </button>
                        <span
                          v-if="getStructuredDocumentFacts(doc).length > 0"
                          class="knowledge-page__structured-failure-mark"
                          aria-label="需要处理"
                          title="需要处理"
                        >
                          ✗
                        </span>
                      </div>
                    </div>
                  </template>
                  <EmptyState
                    v-else
                    :icon="Search"
                    :title="t('knowledge.noResults')"
                    :description="t('knowledge.noResultsDesc')"
                  />
                </div>

                <!-- 分页：渲染窗口未覆盖全部时显示「加载更多」(#5) -->
                <div
                  v-if="hasMoreDocs"
                  data-testid="knowledge-load-more"
                  class="knowledge-page__load-more mt-3 flex items-center justify-center gap-3 text-xs"
                >
                  <button
                    type="button"
                    class="px-3 py-1.5 rounded-lg border transition-colors"
                    :style="{
                      borderColor: 'var(--hc-border)',
                      color: 'var(--hc-text-secondary)',
                      background: 'var(--hc-bg-card)',
                    }"
                    @click="loadMoreDocs"
                  >
                    {{ t('knowledge.loadMore') }}
                  </button>
                  <span :style="{ color: 'var(--hc-text-muted)' }">
                    {{
                      t('knowledge.shownOfTotal', {
                        shown: windowedDocs.length,
                        total: displayedTotalDocs,
                      })
                    }}
                  </span>
                </div>
              </template>
            </template>

            <!-- 检索测试标签 -->
            <template v-else>
              <div class="knowledge-page__search">
                <p class="text-sm mb-4" :style="{ color: 'var(--hc-text-secondary)' }">
                  {{ t('knowledge.searchDesc') }}
                </p>

                <!-- 检索质量参数（高级）：折叠面板（默认展开），全局持久化（写 yaml + 热更新 KB Manager）。
               即时生效：rerank/查询扩展/情境增强 开关、min_score、candidate_k；换 rerank 模型需重启 sidecar。 -->
                <HcSettingsDisclosure
                  v-model="ragPanelOpen"
                  body-id="kb-rag-body"
                  trigger-test-id="kb-rag-toggle"
                  panel-test-id="kb-rag-body"
                  data-testid="kb-rag-panel"
                  class="knowledge-page__rag-disclosure mb-5"
                >
                  <template #icon><Settings2 :size="13" /></template>
                  <template #title>{{ t('knowledge.ragTitle') }}</template>
                  <template #actions>
                    <button
                      type="button"
                      data-testid="kb-rag-reset"
                      class="knowledge-page__rag-reset"
                      :disabled="!knowledgeEnabled || !ragConfig || ragSaving"
                      @click="resetRagConfig"
                    >
                      {{ t('knowledge.ragReset') }}
                    </button>
                  </template>

                  <div class="knowledge-page__rag-body">
                    <template v-if="ragConfig">
                      <!-- 重排 cross-encoder + 模型下拉 -->
                      <div class="flex items-center gap-2.5 flex-wrap">
                        <span
                          class="text-[13px] flex-1 min-w-0"
                          :style="{ color: 'var(--hc-text-primary)' }"
                        >
                          {{ t('knowledge.ragRerank') }}
                        </span>
                        <input
                          type="checkbox"
                          data-testid="kb-rag-rerank"
                          class="hc-toggle"
                          :checked="ragConfig.rerank"
                          :disabled="!knowledgeEnabled || ragSaving"
                          :aria-label="t('knowledge.ragRerank')"
                          @change="toggleRagBool('rerank')"
                        />
                        <div class="w-[208px] shrink-0">
                          <HcSelect
                            data-testid="kb-rag-rerank-model"
                            :model-value="ragConfig.rerank_model"
                            :options="rerankModelSelectOptions"
                            :disabled="!knowledgeEnabled || !ragConfig.rerank || ragSaving"
                            @update:model-value="onRerankModelPick"
                          />
                        </div>
                      </div>

                      <!-- 查询扩展 -->
                      <div class="flex items-center gap-2.5">
                        <span
                          class="text-[13px] flex-1"
                          :style="{ color: 'var(--hc-text-primary)' }"
                        >
                          {{ t('knowledge.ragQueryExpand') }}
                        </span>
                        <input
                          type="checkbox"
                          data-testid="kb-rag-query-expand"
                          class="hc-toggle"
                          :checked="ragConfig.query_expand"
                          :disabled="!knowledgeEnabled || ragSaving"
                          :aria-label="t('knowledge.ragQueryExpand')"
                          @change="toggleRagBool('query_expand')"
                        />
                      </div>

                      <!-- 入库情境增强 Contextual（改后需重建索引） -->
                      <div class="flex items-center gap-2.5">
                        <span
                          class="text-[13px] flex-1"
                          :style="{ color: 'var(--hc-text-primary)' }"
                        >
                          {{ t('knowledge.ragContextual') }}
                          <span
                            class="text-[11px] ml-1"
                            :style="{ color: 'var(--hc-text-muted)' }"
                            :title="t('knowledge.ragNeedRebuild')"
                          >
                            ⓘ {{ t('knowledge.ragNeedRebuild') }}
                          </span>
                        </span>
                        <input
                          type="checkbox"
                          data-testid="kb-rag-contextual"
                          class="hc-toggle"
                          :checked="ragConfig.contextual"
                          :disabled="!knowledgeEnabled || ragSaving"
                          :aria-label="t('knowledge.ragContextual')"
                          @change="toggleRagBool('contextual')"
                        />
                      </div>

                      <!-- 相关度地板 min_score -->
                      <div class="flex items-center gap-2.5">
                        <span
                          class="text-[13px] flex-1"
                          :style="{ color: 'var(--hc-text-primary)' }"
                        >
                          {{ t('knowledge.ragMinScore') }}
                        </span>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.01"
                          data-testid="kb-rag-min-score"
                          :value="ragConfig.min_score"
                          :disabled="!knowledgeEnabled || ragSaving"
                          style="width: 170px; accent-color: var(--hc-accent)"
                          :aria-label="t('knowledge.ragMinScore')"
                          @input="
                            ragConfig.min_score = Number(($event.target as HTMLInputElement).value)
                          "
                          @change="onMinScoreChange"
                        />
                        <span
                          class="text-xs tabular-nums w-9 text-right"
                          :style="{ color: 'var(--hc-text-secondary)' }"
                        >
                          {{ Number(ragConfig.min_score).toFixed(2) }}
                        </span>
                      </div>

                      <!-- 宽召回候选池 candidate_k -->
                      <div class="flex items-center gap-2.5">
                        <span
                          class="text-[13px] flex-1"
                          :style="{ color: 'var(--hc-text-primary)' }"
                        >
                          {{ t('knowledge.ragCandidateK') }}
                        </span>
                        <div class="w-[88px] shrink-0">
                          <HcSelect
                            data-testid="kb-rag-candidate-k"
                            :model-value="String(ragConfig.candidate_k)"
                            :options="candidateKSelectOptions"
                            :disabled="!knowledgeEnabled || ragSaving"
                            @update:model-value="onCandidateKPick"
                          />
                        </div>
                      </div>

                      <p
                        class="text-[11px] border-t pt-2.5 m-0"
                        :style="{ color: 'var(--hc-text-muted)', borderColor: 'var(--hc-border)' }"
                      >
                        {{ t('knowledge.ragFootnote') }}
                      </p>
                      <p
                        v-if="ragRestartHint"
                        data-testid="kb-rag-restart-hint"
                        class="text-[11px] m-0"
                        style="color: #f59e0b"
                      >
                        {{ t('knowledge.ragRestartHint') }}
                      </p>
                    </template>
                    <div
                      v-else-if="ragLoadState === 'error'"
                      data-testid="kb-rag-load-error"
                      class="text-xs flex items-center justify-between gap-3"
                      style="color: #b45309"
                      role="alert"
                    >
                      <span>{{ t('knowledge.ragLoadFailed') }}</span>
                      <button type="button" class="underline shrink-0" @click="loadRagConfig">
                        {{ t('common.retry', '重试') }}
                      </button>
                    </div>
                    <div
                      v-else
                      data-testid="kb-rag-loading"
                      class="text-xs"
                      :style="{ color: 'var(--hc-text-muted)' }"
                      role="status"
                    >
                      {{ t('common.loading', '加载中…') }}
                    </div>
                  </div>
                </HcSettingsDisclosure>

                <div class="flex gap-2 mb-3">
                  <SearchInput
                    v-model="searchQuery"
                    class="flex-1"
                    :fluid="true"
                    :disabled="!knowledgeEnabled"
                    :placeholder="t('knowledge.searchPlaceholder')"
                    @submit="handleSearch"
                  />
                  <button
                    class="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
                    :style="{ background: 'var(--hc-accent)' }"
                    :disabled="!knowledgeEnabled || searching || !searchQuery.trim()"
                    @click="handleSearch"
                  >
                    <Search :size="14" />
                    {{ searching ? t('knowledge.searching') : t('common.search') }}
                  </button>
                </div>

                <!-- 元数据过滤：源类型 chip（多选）+ 创建日期区间 -->
                <div
                  data-testid="knowledge-search-filters"
                  class="flex flex-wrap items-center gap-2 mb-6"
                >
                  <span class="text-xs shrink-0" :style="{ color: 'var(--hc-text-muted)' }">{{
                    t('knowledge.filterType')
                  }}</span>
                  <button
                    v-for="tp in SOURCE_TYPES"
                    :key="tp"
                    type="button"
                    :data-testid="`kb-type-chip-${tp}`"
                    :aria-pressed="selectedTypes.includes(tp)"
                    class="text-xs px-2.5 py-1 rounded-full border transition-colors"
                    :style="
                      selectedTypes.includes(tp)
                        ? {
                            background: 'var(--hc-accent)',
                            borderColor: 'var(--hc-accent)',
                            color: '#fff',
                          }
                        : {
                            background: 'var(--hc-bg-card)',
                            borderColor: 'var(--hc-border)',
                            color: 'var(--hc-text-secondary)',
                          }
                    "
                    :disabled="!knowledgeEnabled"
                    @click="toggleType(tp)"
                  >
                    {{ t(`knowledge.sourceType.${tp}`) }}
                  </button>

                  <span
                    class="w-px h-4 mx-1 shrink-0"
                    :style="{ background: 'var(--hc-border)' }"
                  />

                  <label class="text-xs shrink-0" :style="{ color: 'var(--hc-text-muted)' }">{{
                    t('knowledge.filterDate')
                  }}</label>
                  <HcDateRangePicker
                    v-model:from="filterAfter"
                    v-model:to="filterBefore"
                    :disabled="!knowledgeEnabled"
                    :from-label="t('knowledge.filterDateFrom')"
                    :to-label="t('knowledge.filterDateTo')"
                    from-testid="kb-filter-after"
                    to-testid="kb-filter-before"
                  />

                  <button
                    v-if="hasActiveFilter"
                    type="button"
                    data-testid="kb-filter-clear"
                    class="text-xs underline shrink-0"
                    :style="{ color: 'var(--hc-text-muted)' }"
                    @click="clearFilters"
                  >
                    {{ t('knowledge.clearFilter') }}
                  </button>
                </div>

                <div v-if="searchResults.length > 0" class="space-y-3">
                  <div
                    v-for="(result, idx) in searchResults"
                    :key="idx"
                    class="rounded-xl border p-4"
                    :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
                  >
                    <div class="flex items-center justify-between mb-2">
                      <div class="min-w-0">
                        <div
                          class="text-sm font-medium truncate"
                          :style="{ color: 'var(--hc-text-primary)' }"
                        >
                          {{ resultTitle(result) }}
                        </div>
                        <div
                          v-if="resultMeta(result)"
                          class="text-[11px] mt-1"
                          :style="{ color: 'var(--hc-text-muted)' }"
                        >
                          {{ resultMeta(result) }}
                        </div>
                      </div>
                      <span class="text-xs tabular-nums" :style="{ color: 'var(--hc-text-muted)' }">
                        {{ t('knowledge.similarity', { score: formatScore(result.score) }) }}
                      </span>
                    </div>
                    <p class="text-sm leading-relaxed" :style="{ color: 'var(--hc-text-primary)' }">
                      {{ result.content }}
                    </p>
                  </div>
                </div>

                <EmptyState
                  v-else-if="!searching && searchQuery"
                  :icon="Search"
                  :title="t('knowledge.noResults')"
                  :description="t('knowledge.noResultsDesc')"
                />
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- 添加文档对话框 -->
    <Teleport to="body">
      <Transition name="modal">
        <div
          v-if="showAddDialog"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-sm"
          data-testid="knowledge-add-document-modal"
          @click.self="closeAddDialog"
        >
          <div
            class="knowledge-add-document-modal rounded-2xl border overflow-hidden"
            :style="{ background: 'var(--hc-bg-elevated)', borderColor: 'var(--hc-border)' }"
          >
            <div
              class="knowledge-add-document-modal__header flex items-center justify-between px-5 py-4 border-b"
              :style="{ borderColor: 'var(--hc-border)' }"
            >
              <h2
                class="text-[15px] font-semibold m-0"
                :style="{ color: 'var(--hc-text-primary)' }"
              >
                {{ t('knowledge.addDocTitle') }}
              </h2>
              <button
                class="p-1 rounded-md hover:bg-white/5"
                :style="{ color: 'var(--hc-text-muted)' }"
                :aria-label="t('knowledge.closeDialog')"
                @click="closeAddDialog"
              >
                <X :size="17" />
              </button>
            </div>
            <div class="knowledge-add-document-modal__body">
              <!-- 文件上传区 -->
              <div
                class="knowledge-add-document-modal__drop flex items-center gap-3 p-3 rounded-lg border border-dashed cursor-pointer hover:border-solid transition-colors"
                data-testid="knowledge-upload-drop"
                :style="{ borderColor: 'var(--hc-border)' }"
                @click="openFilePicker"
              >
                <div class="knowledge-add-document-modal__drop-icon" aria-hidden="true">📄</div>
                <div class="knowledge-add-document-modal__drop-copy">
                  <div class="text-sm font-medium" :style="{ color: 'var(--hc-text-primary)' }">
                    {{ t('knowledge.uploadFile', '上传文件') }}
                  </div>
                  <div class="text-xs" :style="{ color: 'var(--hc-text-secondary)' }">
                    {{ t('knowledge.uploadFileHint') }}
                  </div>
                </div>
              </div>
              <div
                v-if="addDocumentIndexNotice"
                class="knowledge-page__index-notice"
                data-testid="knowledge-index-notice"
              >
                <strong>{{ addDocumentIndexNotice.title }}</strong>
                <span>{{ addDocumentIndexNotice.detail }}</span>
              </div>
              <div
                class="knowledge-add-document-modal__manual-divider text-xs"
                :style="{ color: 'var(--hc-text-muted)' }"
              >
                {{ t('knowledge.orManualInput', '— 或手动输入 —') }}
              </div>
              <div class="knowledge-add-document-modal__field knowledge-add-document-modal__field--title flex flex-col gap-1.5">
                <label
                  class="text-[13px] font-medium"
                  :style="{ color: 'var(--hc-text-secondary)' }"
                  >{{ t('knowledge.docTitle') }}</label
                >
                <HcClearableField>
                  <input
                    ref="newTitleInput"
                    autofocus
                    v-model="newTitle"
                    type="text"
                    class="w-full min-w-0 rounded-lg border px-3 py-2 text-sm outline-none"
                    :style="{
                      background: 'var(--hc-bg-input)',
                      borderColor: 'var(--hc-border)',
                      color: 'var(--hc-text-primary)',
                    }"
                    :placeholder="t('knowledge.docTitlePlaceholder')"
                  />
                </HcClearableField>
              </div>
              <div class="knowledge-add-document-modal__field knowledge-add-document-modal__field--content flex flex-col gap-1.5">
                <label
                  class="text-[13px] font-medium"
                  :style="{ color: 'var(--hc-text-secondary)' }"
                  >{{ t('knowledge.docContent') }}</label
                >
                <HcClearableField>
                  <textarea
                    v-model="newContent"
                    rows="6"
                    class="w-full min-w-0 rounded-lg border px-3 py-2 text-sm outline-none"
                    :style="{
                      background: 'var(--hc-bg-input)',
                      borderColor: 'var(--hc-border)',
                      color: 'var(--hc-text-primary)',
                    }"
                    :placeholder="t('knowledge.docContentPlaceholder')"
                  />
                </HcClearableField>
              </div>
              <div class="knowledge-add-document-modal__field knowledge-add-document-modal__field--source flex flex-col gap-1.5">
                <label
                  class="text-[13px] font-medium"
                  :style="{ color: 'var(--hc-text-secondary)' }"
                  >{{ t('knowledge.docSource') }}</label
                >
                <HcClearableField>
                  <input
                    v-model="newSource"
                    type="text"
                    class="w-full min-w-0 rounded-lg border px-3 py-2 text-sm outline-none"
                    :style="{
                      background: 'var(--hc-bg-input)',
                      borderColor: 'var(--hc-border)',
                      color: 'var(--hc-text-primary)',
                    }"
                    :placeholder="t('knowledge.docSourcePlaceholder')"
                  />
                </HcClearableField>
              </div>
            </div>
            <div
              class="knowledge-add-document-modal__footer flex items-center justify-end gap-2 px-5 py-3.5 border-t"
              :style="{ borderColor: 'var(--hc-border)' }"
            >
              <button
                class="px-3 py-1.5 rounded-lg text-sm font-medium"
                :style="{ color: 'var(--hc-text-primary)', background: 'var(--hc-bg-input)' }"
                @click="closeAddDialog"
              >
                {{ t('common.cancel') }}
              </button>
              <button
                data-testid="knowledge-upload-submit"
                class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white"
                :style="{
                  opacity:
                    !knowledgeEnabled || adding ? 0.4 : 1,
                }"
                :disabled="!knowledgeEnabled || adding"
                @click="handleAdd"
              >
                {{ adding ? t('knowledge.adding') : t('common.upload') }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 删除确认 -->
    <ConfirmDialog
      :open="showDeleteConfirm"
      :confirmation-key="deletingDoc?.id"
      :title="t('knowledge.deleteConfirmTitle')"
      :message="t('knowledge.deleteConfirmMessage')"
      :confirm-text="t('common.delete')"
      @confirm="handleDelete"
      @cancel="closeDeleteConfirm"
    />

    <Teleport to="body">
      <Transition name="modal">
        <div
          v-if="showDocDetail && selectedDoc"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-sm"
          @click.self="showDocDetail = false"
        >
          <div
            class="w-full max-w-3xl max-h-[80vh] rounded-2xl border flex flex-col overflow-hidden"
            :style="{ background: 'var(--hc-bg-elevated)', borderColor: 'var(--hc-border)' }"
          >
            <div
              class="flex items-center justify-between px-5 py-4 border-b"
              :style="{ borderColor: 'var(--hc-border)' }"
            >
              <div class="min-w-0">
                <h2
                  class="text-[15px] font-semibold truncate"
                  :style="{ color: 'var(--hc-text-primary)' }"
                >
                  {{ selectedDoc.title }}
                </h2>
                <p class="text-xs mt-1" :style="{ color: 'var(--hc-text-secondary)' }">
                  {{ getDocStatusLabel(selectedDoc) }}
                  <span v-if="selectedDoc.source"> · {{ selectedDoc.source }}</span>
                </p>
              </div>
              <button
                class="p-1 rounded-md hover:bg-white/5"
                :style="{ color: 'var(--hc-text-muted)' }"
                @click="showDocDetail = false"
              >
                <X :size="17" />
              </button>
            </div>
            <div class="p-5 overflow-y-auto space-y-4">
              <div
                class="grid grid-cols-2 gap-4 text-xs"
                :style="{ color: 'var(--hc-text-secondary)' }"
              >
                <div>
                  {{ t('knowledge.docCount', { count: 1 }) }} ·
                  {{ selectedDoc.chunk_count }} chunk{{ selectedDoc.chunk_count === 1 ? '' : 's' }}
                </div>
                <div>
                  {{ t('knowledge.updatedAt') }}:
                  {{
                    new Date(selectedDoc.updated_at || selectedDoc.created_at).toLocaleString(
                      locale,
                    )
                  }}
                </div>
              </div>
              <div
                v-if="selectedDoc.error_message"
                class="rounded-lg px-3 py-2 text-sm"
                style="background: #ef444415; color: #dc2626"
              >
                {{ selectedDoc.error_message }}
              </div>
              <div
                class="rounded-xl border p-4 text-sm leading-6"
                :style="{
                  background: 'var(--hc-bg-main)',
                  borderColor: 'var(--hc-border)',
                  color: loadingDocContent ? 'var(--hc-text-muted)' : 'var(--hc-text-primary)',
                }"
              >
                <template v-if="loadingDocContent">{{ t('common.loading', '加载中...') }}</template>
                <div
                  v-else-if="docContentError"
                  data-testid="knowledge-doc-content-error"
                  role="alert"
                  class="flex items-center justify-between gap-3"
                  style="color: #dc2626"
                >
                  <span class="flex items-center gap-2">
                    <AlertTriangle :size="14" />
                    {{ docContentError }}
                  </span>
                  <button
                    type="button"
                    data-testid="knowledge-doc-content-retry"
                    class="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium"
                    style="background: #ef444415; color: #dc2626"
                    @click="retryDocContent"
                  >
                    <RefreshCw :size="12" />
                    {{ t('knowledge.retryDocContent') }}
                  </button>
                </div>
                <MarkdownRenderer v-else-if="selectedDoc.content" :content="selectedDoc.content" />
                <template v-else>{{ t('knowledge.emptyContentDetail') }}</template>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.knowledge-add-document-modal {
  display: grid;
  width: min(478px, calc(100vw - 32px));
  height: min(686px, calc(100vh - 24px));
  min-width: 0;
  max-height: min(686px, calc(100vh - 24px));
  grid-template-rows: 61px minmax(0, 1fr) 65px;
  border-radius: 16px;
  box-shadow:
    0 8px 24px rgba(95, 179, 234, 0.14),
    0 24px 56px rgba(95, 179, 234, 0.18),
    0 0 0 0.5px rgba(63, 143, 212, 0.08);
  transform: translateY(-8px);
  font-feature-settings: normal;
  text-rendering: auto;
}

.knowledge-add-document-modal__header {
  box-sizing: border-box;
  min-height: 61px;
  padding: 18px;
}

.knowledge-add-document-modal__body {
  display: block;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 18px;
  overflow: auto;
}

.knowledge-add-document-modal__drop {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  height: 170px;
  min-height: 170px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0;
  padding: 36px;
  border-radius: 12px;
  background: transparent !important;
  color: var(--hc-text-muted);
  text-align: center;
}

.knowledge-add-document-modal__drop-icon {
  flex: 0 0 auto;
  height: 30px;
  margin-bottom: 8px;
  color: var(--hc-text-tertiary);
  font-size: 30px;
  line-height: 30px;
}

.knowledge-add-document-modal__drop-copy > div:first-child {
  font-size: 14px;
  font-weight: 600;
  line-height: 21px;
}

.knowledge-add-document-modal__drop-copy > div:last-child {
  margin-top: 4px;
  font-size: 12px;
  line-height: 18px;
}

.knowledge-add-document-modal__manual-divider {
  margin: 12px 0 8px;
  font-size: 12px;
  line-height: 18px;
}

.knowledge-add-document-modal .knowledge-page__index-notice {
  display: block;
  margin-top: 12px;
  gap: normal;
  background: rgba(255, 254, 249, 0.9);
}

.knowledge-add-document-modal .knowledge-page__index-notice strong,
.knowledge-add-document-modal .knowledge-page__index-notice span {
  display: block;
}

.knowledge-add-document-modal__field {
  min-width: 0;
  margin: 0 0 15px;
  gap: 0 !important;
}

.knowledge-add-document-modal__field--content {
  margin-bottom: 15px;
}

.knowledge-add-document-modal__field:last-child {
  margin-bottom: 0;
}

.knowledge-add-document-modal__field > label {
  display: block;
  margin-bottom: 6px;
  color: var(--hc-text-primary) !important;
  font-size: 13px;
  line-height: 19.5px;
}

.knowledge-add-document-modal__field :deep(input),
.knowledge-add-document-modal__field :deep(textarea) {
  display: inline-block;
  width: 100%;
  height: 39.5px;
  min-height: 39.5px;
  box-sizing: border-box;
  padding: 9px 12px !important;
  border-radius: 10px;
  font-size: 13px !important;
  line-height: 19.5px !important;
}

.knowledge-add-document-modal__field :deep(textarea) {
  height: 84px;
  min-height: 84px;
  resize: vertical;
}

.knowledge-add-document-modal__field :deep(input:focus),
.knowledge-add-document-modal__field :deep(textarea:focus) {
  border-color: var(--hc-accent) !important;
  box-shadow: 0 0 0 3px var(--hc-accent-subtle);
}

.knowledge-add-document-modal__field :deep(.hc-clearable-field:has(.hc-clearable-field__button) input),
.knowledge-add-document-modal__field :deep(.hc-clearable-field:has(.hc-clearable-field__button) textarea) {
  padding-inline-end: 38px !important;
}

.knowledge-add-document-modal__footer {
  width: 100%;
  min-width: 0;
  min-height: 65px;
  box-sizing: border-box;
  gap: 10px;
  padding: 14px 18px;
}

.knowledge-add-document-modal__footer > button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 36px;
  box-sizing: border-box;
  padding: 8px 14px;
  font-size: 13px;
  line-height: 18px;
  border: 1px solid var(--hc-border);
  border-radius: 10px;
}

.knowledge-add-document-modal__footer > button:last-child {
  border-color: transparent;
  background: linear-gradient(180deg, #5fb3ea 0%, #4a9de0 100%);
  box-shadow: 0 6px 18px rgba(95, 179, 234, 0.28);
}

.knowledge-page__tab-stack {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.knowledge-page__scroll {
  padding: 16px 26px 48px;
}

.knowledge-page__active-panel {
  min-width: 0;
}

.knowledge-page__document-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.knowledge-page__document-list.space-y-2 > :not([hidden]) {
  margin-bottom: 0;
}

.knowledge-page__resource-row {
  display: flex;
  min-width: 0;
  min-height: 52px;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  padding: 9px 10px;
  border: 0.5px solid var(--hc-border);
  border-radius: 10px;
  background: var(--hc-bg-card);
  color: var(--hc-text-secondary);
  font-size: 12px;
}

.knowledge-page__resource-row--error {
  border-color: #ef4444;
}

.knowledge-page__document-card--structured-failure {
  height: 73px;
}

.knowledge-page__source-chip {
  min-height: 30px;
  box-sizing: border-box;
  padding: 5px 11px;
  line-height: 18px;
}

.knowledge-page__resource-file {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border: 0.5px solid var(--hc-border);
  border-radius: 9px;
  background: var(--hc-bg-input);
  color: var(--hc-text-secondary);
  font-size: 12px;
}

.knowledge-page__resource-extension {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px 4px;
  border-radius: 5px;
  background: var(--hc-accent);
  color: #fff;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  font-weight: 700;
  line-height: 15px;
}

.knowledge-page__document-main {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.knowledge-page__resource-title,
.knowledge-page__resource-status {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.knowledge-page__resource-title {
  flex: none;
  max-width: min(34%, 300px);
  font-weight: 700;
}

.knowledge-page__resource-status {
  flex: 1;
  color: var(--hc-text-secondary);
}

.knowledge-page__document-card--structured-failure .knowledge-page__resource-status {
  overflow: visible;
  text-overflow: clip;
  white-space: pre-line;
}

.knowledge-page__resource-badge {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 5px;
  min-height: 24px;
  padding: 3px 9px;
  border-radius: 7px;
  font-size: 12px;
  font-weight: 400;
  white-space: nowrap;
}

.knowledge-page__resource-badge::before {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  content: '';
}

.knowledge-page__document-actions {
  gap: 8px;
  flex-wrap: nowrap;
}

.knowledge-page__resource-action {
  display: inline-flex;
  flex: none;
  align-items: center;
  min-height: 32px;
  padding: 6px 8px;
  border: 0.5px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--hc-text-secondary);
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;
}

.knowledge-page__resource-action:hover:not(:disabled) {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}

.knowledge-page__resource-action:disabled {
  cursor: not-allowed;
  background: color-mix(in srgb, var(--hc-accent) 1.6%, transparent);
  color: var(--hc-text-primary);
  opacity: 0.45;
}

.knowledge-page__resource-action--warning {
  color: #b45309;
}

.knowledge-page__resource-action--danger {
  color: var(--hc-error);
}

.knowledge-page__structured-failure-mark {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  color: var(--hc-error);
  font-size: 16px;
  line-height: 18px;
}

@media (max-width: 900px) {
  .knowledge-page__resource-row {
    flex-wrap: wrap;
  }

  .knowledge-page__document-main {
    flex: 1 1 180px;
  }

  .knowledge-page__document-actions {
    width: 100%;
    justify-content: flex-end;
  }
}

.knowledge-page__rag-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.knowledge-page__rag-reset {
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: var(--hc-text-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.knowledge-page__rag-reset:hover:not(:disabled) {
  color: var(--hc-text-secondary);
}

.knowledge-page__rag-reset:disabled {
  cursor: default;
  opacity: 0.55;
}

.modal-enter-active {
  transition: opacity 0.2s ease-out;
}
.modal-leave-active {
  transition: opacity 0.15s ease-in;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
/* 添加文档时把真实索引执行策略放在上传入口之后，避免用户误以为上传只写文本索引。 */
.knowledge-page__index-notice {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 11px 13px 11px 17px;
  border: 0.5px solid var(--hc-border);
  border-radius: 12px;
  background: var(--hc-bg-card);
  color: var(--hc-text-secondary);
  font-size: 12.5px;
  line-height: 1.55;
}
.knowledge-page__index-notice::before {
  content: '';
  position: absolute;
  left: 0;
  top: 11px;
  bottom: 11px;
  width: 3px;
  border-radius: 2px;
  background: var(--hc-accent);
}
.knowledge-page__index-notice strong {
  color: var(--hc-text-primary);
}
.knowledge-page__index-notice span {
  color: var(--hc-text-secondary);
}
</style>
