<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useKnowledgeUploadsStore } from '@/stores/knowledge-uploads'
import { useI18n } from 'vue-i18n'
import {
  BookOpen,
  Upload,
  Trash2,
  Search,
  X,
  FileUp,
  RefreshCw,
  AlertTriangle,
  ChevronDown,
} from 'lucide-vue-next'
import {
  getDocuments,
  getDocumentContent,
  addDocument,
  deleteDocument,
  searchKnowledge,
  uploadDocument,
  reindexDocument,
  isKnowledgeUploadEndpointMissing,
  isKnowledgeUploadUnsupportedFormat,
  getKnowledgeConfig,
  putKnowledgeConfig,
} from '@/api/knowledge'
import type { KnowledgeSourceCount } from '@/api/knowledge'
import type { KnowledgeSearchFilter, KnowledgeConfig } from '@/api/knowledge'
// DB cache layer removed — data fetched directly from backend API
import type { KnowledgeDoc, KnowledgeSearchResult } from '@/types'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import SearchInput from '@/components/common/SearchInput.vue'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import UnderlineTabs from '@/components/common/UnderlineTabs.vue'
import HcDateRangePicker from '@/components/common/HcDateRangePicker.vue'
import HcSelect from '@/components/common/HcSelect.vue'
import SemanticIndexCard from '@/components/knowledge/SemanticIndexCard.vue'
import { parseDocument } from '@/utils/file-parser'
import { logger } from '@/utils/logger'

// 图片格式走后端多模态入库（视觉模型转写 → 文本 RAG，source_type=image）。
// 后端 /knowledge/upload 显式支持这些扩展（见 api/handler_knowledge.go），桌面也须放行，
// 否则多模态入库能力在桌面端无入口。注意：图片无法本地解析（parseDocument 会把二进制当
// 纯文本读成乱码），故上传失败时绝不回退到本地解析（见 processFiles）。
const IMAGE_TYPES = ['.png', '.jpg', '.jpeg', '.webp', '.gif']
const DOCUMENT_TYPES = ['.pdf', '.txt', '.md', '.docx', '.doc', '.pptx', '.xlsx', '.xls', '.csv', '.json']
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
  { key: 'documents', label: t('knowledge.allTab', '全部'), count: docs.value.length },
  { key: 'search', label: t('knowledge.searchTest', '检索测试') },
])

const showAddDialog = ref(false)
const newTitle = ref('')
const newContent = ref('')
const newSource = ref('')
const adding = ref(false)

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
const ragConfig = ref<KnowledgeConfig>({ ...RAG_DEFAULTS })
const ragLoaded = ref(false)
const ragPanelOpen = ref(true) // 默认展开
const ragSaving = ref(false)
const ragRestartHint = ref(false) // rerank_model 变更需重启提示
// 当前 rerank_model 不在预设里时，把它并入下拉（保留手填/历史值，避免下拉重置丢值）。
const rerankModelOptions = computed(() => {
  const m = ragConfig.value.rerank_model
  return m && !RERANK_MODEL_PRESETS.includes(m) ? [m, ...RERANK_MODEL_PRESETS] : RERANK_MODEL_PRESETS
})
// 同理 candidate_k：手改 yaml / 后端默认变更导致的非预设值也要能回显，否则一改就被吸附到预设。
const candidateKOptions = computed(() => {
  const k = ragConfig.value.candidate_k
  return k > 0 && !CANDIDATE_K_PRESETS.includes(k) ? [k, ...CANDIDATE_K_PRESETS] : CANDIDATE_K_PRESETS
})

async function loadRagConfig() {
  if (!knowledgeEnabled.value) return
  try {
    const cfg = await getKnowledgeConfig()
    ragConfig.value = { ...RAG_DEFAULTS, ...cfg }
    ragLoaded.value = true
  } catch (e) {
    // 知识库未启用 / 旧后端无端点：面板退化为默认值，不打扰用户。
    logger.warn('[Knowledge] 检索参数读取失败', e)
  }
}

// 全量保存（即时生效 + 落盘）。在写入前夹紧到合法区间，与后端校验对齐。
async function saveRagConfig() {
  if (!knowledgeEnabled.value) return
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
    ragLoaded.value = true
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('knowledge.ragSaveFailed', '保存检索参数失败')
    errorSeverity.value = 'error'
  } finally {
    ragSaving.value = false
  }
}

function toggleRagBool(key: 'rerank' | 'query_expand' | 'contextual') {
  ragConfig.value[key] = !ragConfig.value[key]
  void saveRagConfig()
}
function onMinScoreChange(e: Event) {
  ragConfig.value.min_score = Number((e.target as HTMLInputElement).value)
  void saveRagConfig()
}
function onCandidateKPick(v: string) {
  ragConfig.value.candidate_k = Number(v) || RAG_DEFAULTS.candidate_k
  void saveRagConfig()
}
function onRerankModelPick(v: string) {
  ragConfig.value.rerank_model = v
  void saveRagConfig()
}
// HcSelect 选项（取代原生 <select>/<option>：品牌一致弹层、Teleport 自渲染，
// 避开 macOS WKWebView 原生 <select> 弹层字号巨大/不受 CSS 控制的老问题，同 HcSelect 设计初衷）。
const rerankModelSelectOptions = computed(() =>
  rerankModelOptions.value.map((m) => ({ value: m, label: m === '' ? t('knowledge.ragRerankAuto') : m })),
)
const candidateKSelectOptions = computed(() =>
  candidateKOptions.value.map((k) => ({ value: String(k), label: String(k) })),
)
function resetRagConfig() {
  ragConfig.value = { ...RAG_DEFAULTS }
  void saveRagConfig()
}
const selectedDoc = ref<KnowledgeDoc | null>(null)
const showDocDetail = ref(false)
const reindexingDocIds = ref<Set<string>>(new Set())
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
    const searchable = [doc.title, doc.source, doc.content, doc.status, doc.error_message]
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

// done 条目在文档落地（出现在 getDocuments 结果）前保留；挂载期间轻量轮询直到全部落地。
let indexPollTimer: ReturnType<typeof setInterval> | null = null
let isMounted = false
function ensureIndexPolling() {
  if (!isMounted || indexPollTimer) return
  indexPollTimer = setInterval(() => {
    if (!uploadsStore.hasAwaitingIndex()) {
      if (indexPollTimer) clearInterval(indexPollTimer)
      indexPollTimer = null
      return
    }
    void revalidateFromApi(true)
  }, 4000)
}
onUnmounted(() => {
  isMounted = false
  if (indexPollTimer) clearInterval(indexPollTimer)
  indexPollTimer = null
})

onMounted(async () => {
  isMounted = true
  await loadDocs()
  void loadRagConfig()
  // 切页回来时若仍有「索引中」条目，恢复轮询直到落地（BUG-20260710）
  if (uploadsStore.hasAwaitingIndex()) ensureIndexPolling()
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
  if (!newTitle.value.trim() || !newContent.value.trim()) return
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

function getDocStatus(doc: KnowledgeDoc): 'processing' | 'indexed' | 'failed' {
  if (doc.status) return doc.status
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

const loadingDocContent = ref(false)
let docContentRequestGen = 0

async function openDocDetail(doc: KnowledgeDoc) {
  const requestGen = ++docContentRequestGen
  selectedDoc.value = doc
  showDocDetail.value = true
  loadingDocContent.value = false

  // 如果列表接口未返回正文，主动获取内容
  if (!doc.content?.trim()) {
    loadingDocContent.value = true
    try {
      const content = await getDocumentContent(doc)
      if (content && requestGen === docContentRequestGen && selectedDoc.value?.id === doc.id) {
        selectedDoc.value = { ...doc, content }
        // 同步更新列表中的文档对象，避免下次打开重复请求
        const idx = docs.value.findIndex((d) => d.id === doc.id)
        if (idx >= 0) docs.value[idx] = selectedDoc.value
      }
    } catch {
      // 获取失败保持原提示
    } finally {
      if (requestGen === docContentRequestGen) {
        loadingDocContent.value = false
      }
    }
  }
}

async function handleReindex(doc: KnowledgeDoc) {
  if (!ensureKnowledgeEnabled()) return
  if (reindexingDocIds.value.has(doc.id)) return
  const next = new Set(reindexingDocIds.value)
  next.add(doc.id)
  reindexingDocIds.value = next
  errorMsg.value = ''

  try {
    const result = await reindexDocument(doc.id)
    // 用后端返回的真实状态更新（reindex 是同步的，返回时已完成）
    docs.value = docs.value.map((item) =>
      item.id === doc.id
        ? {
            ...item,
            status: (result.status as KnowledgeDoc['status']) || 'indexed',
            chunk_count: result.chunk_count ?? item.chunk_count,
            error_message: undefined,
            updated_at: result.updated_at || new Date().toISOString(),
          }
        : item,
    )
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('knowledge.reindexUnavailable')
  } finally {
    const current = new Set(reindexingDocIds.value)
    current.delete(doc.id)
    reindexingDocIds.value = current
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

async function uploadDocumentThroughLegacyFallback(file: File, onProgress?: (pct: number) => void) {
  onProgress?.(10)
  const parsed = await parseDocument(file)
  const content = parsed.text.trim()

  if (!content) {
    throw new Error(t('knowledge.parsedContentEmpty'))
  }

  onProgress?.(75)
  await addDocument(parsed.fileName, content, file.name)
  onProgress?.(100)
}

const MAX_FILE_SIZE = 50 * 1024 * 1024 // 50 MB

async function processFiles(files: FileList) {
  if (!ensureKnowledgeEnabled()) return
  uploadsStore.clearErrors() // 新一轮上传前清掉旧错误条目
  const uploadTasks: Promise<void>[] = []
  let uploadedAny = false

  for (const file of Array.from(files)) {
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
        error: t('knowledge.fileTooLarge', { max: '50 MB' }),
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
    const entry = uploadsStore.track({ name: file.name, progress: 0, status: 'uploading' })

    uploadTasks.push(
      (async () => {
        const updateProgress = (pct: number) => {
          entry.progress = pct
          // 字节传完(100%)后端仍在解析+嵌入：切「处理中」相，别让用户对着 100% 以为卡死（#8）
          if (pct >= 100) uploadsStore.markProcessing(entry)
        }

        try {
          const uploaded = await uploadDocument(file, updateProgress)
          entry.status = 'done'
          entry.progress = 100
          entry.warning = uploaded.warnings?.join('；')
          uploadedAny = true
        } catch (e) {
          let uploadError = e
          // 图片只能由后端视觉模型转写，绝不本地解析回退（否则二进制会被当纯文本读成乱码入库）。
          const isImage = IMAGE_TYPES.includes(ext)
          if (!isImage && (isKnowledgeUploadEndpointMissing(e) || isKnowledgeUploadUnsupportedFormat(e))) {
            try {
              await uploadDocumentThroughLegacyFallback(file, updateProgress)
              entry.status = 'done'
              entry.progress = 100
              uploadedAny = true
              return
            } catch (fallbackError) {
              uploadError = fallbackError
            }
          }

          entry.status = 'error'
          const rawMessage = uploadError instanceof Error ? uploadError.message : ''
          // 图片入库失败且根因是「缺少视觉模型」时，给出本地化、可操作的引导，
          // 不把后端的底层技术细节（如 "model does not support image input"）甩给用户。
          entry.error =
            isImage && isVisionModelError(rawMessage)
              ? t('knowledge.imageVisionRequired')
              : rawMessage || t('knowledge.uploadFailed')
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
}

defineExpose({ rebuildAll, openUpload, openFilePicker, docs, loadDocs })
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
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
      :style="{ background: 'var(--hc-warning-soft, #f59e0b15)', color: 'var(--hc-warning-text, #b45309)' }"
    >
      <div class="font-medium">{{ t('knowledge.backendDisabled') }}</div>
      <div class="mt-1 text-xs" :style="{ color: 'var(--hc-text-secondary)' }">
        {{ t('knowledge.backendDisabledDesc') }}
      </div>
    </div>

    <!-- 标签页（统一 UnderlineTabs，滑动下划线） -->
    <div class="px-6 pt-3">
      <UnderlineTabs
        :tabs="knowledgeTabs"
        :model-value="activeTab"
        @update:model-value="activeTab = $event as 'documents' | 'search'"
      />
    </div>

    <div
      class="flex-1 overflow-y-auto p-6 relative"
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

      <!-- 核心能力与运行状态：健康态默认折叠；旧 sidecar 自动退化为原安装恢复横幅。 -->
      <SemanticIndexCard v-if="activeTab === 'documents' && knowledgeEnabled" />

      <!-- Upload progress list -->
      <div v-if="uploadingFiles.length > 0" class="mb-4 space-y-2 max-w-2xl">
        <div
          v-for="(uf, idx) in uploadingFiles"
          :key="idx"
          class="flex items-center gap-3 px-4 py-2.5 rounded-lg border"
          :style="{
            background: 'var(--hc-bg-card)',
            borderColor:
              uf.status === 'error'
                ? '#ef4444'
                : uf.status === 'done'
                  ? '#10b981'
                  : 'var(--hc-border)',
          }"
        >
          <Upload
            :size="14"
            :class="{ 'animate-pulse': uf.status === 'uploading' || uf.status === 'processing' }"
            :style="{
              color:
                uf.status === 'error'
                  ? '#ef4444'
                  : uf.status === 'done'
                    ? '#10b981'
                    : 'var(--hc-accent)',
            }"
          />
          <div class="flex-1 min-w-0">
            <div class="text-xs font-medium truncate" :style="{ color: 'var(--hc-text-primary)' }">
              {{ uf.name }}
            </div>
            <div
              v-if="uf.status === 'uploading'"
              class="mt-1 h-1 rounded-full overflow-hidden"
              :style="{ background: 'var(--hc-bg-hover)' }"
            >
              <div
                class="h-full rounded-full transition-[width]"
                :style="{ width: uf.progress + '%', background: 'var(--hc-accent)' }"
              />
            </div>
            <div
              v-else-if="uf.status === 'processing'"
              class="text-xs mt-0.5 animate-pulse"
              :style="{ color: 'var(--hc-accent)' }"
              data-testid="upload-processing"
            >
              {{ t('knowledge.processing') }}
            </div>
            <div v-else-if="uf.status === 'error'" class="text-xs mt-0.5" style="color: #ef4444">
              {{ uf.error }}
            </div>
            <div v-else-if="uf.warning" class="text-xs mt-0.5" style="color: #f59e0b">
              {{ uf.warning }}
            </div>
            <div v-else-if="uf.status === 'done'" class="text-xs mt-0.5" :style="{ color: 'var(--hc-text-muted)' }">
              {{ t('knowledge.indexing') }}
            </div>
          </div>
          <span class="text-xs tabular-nums" :style="{ color: 'var(--hc-text-muted)' }">
            {{
              uf.status === 'uploading'
                ? uf.progress + '%'
                : uf.status === 'processing'
                  ? '⋯'
                  : uf.status === 'done'
                    ? '✓'
                    : '✗'
            }}
          </span>
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
            class="max-w-2xl flex flex-wrap items-center gap-2 mb-3"
          >
            <button
              type="button"
              data-testid="kb-source-chip-all"
              :aria-pressed="selectedSource === null"
              class="text-xs px-2.5 py-1 rounded-full border transition-colors"
              :style="
                selectedSource === null
                  ? { background: 'var(--hc-accent)', borderColor: 'var(--hc-accent)', color: '#fff' }
                  : { background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-secondary)' }
              "
              @click="selectSource(null)"
            >
              {{ t('knowledge.allSources') }} ({{ sourceFacet.reduce((sum, item) => sum + item.count, 0) || totalDocs }})
            </button>
            <button
              v-for="f in sourceFacet"
              :key="f.source"
              type="button"
              :data-testid="`kb-source-chip-${f.source}`"
              :aria-pressed="selectedSource === f.source"
              class="text-xs px-2.5 py-1 rounded-full border transition-colors max-w-[14rem] truncate"
              :style="
                selectedSource === f.source
                  ? { background: 'var(--hc-accent)', borderColor: 'var(--hc-accent)', color: '#fff' }
                  : { background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-secondary)' }
              "
              :title="f.source"
              @click="selectSource(f.source)"
            >
              {{ f.source }} ({{ f.count }})
            </button>
          </div>

          <!-- 文档列表 -->
          <div data-testid="knowledge-doc-list" class="space-y-3 max-w-2xl">
            <template v-if="filteredDocs.length > 0">
              <div
                v-for="doc in windowedDocs"
                :key="doc.id"
                data-testid="knowledge-doc-card"
                class="hc-card-interactive group flex items-center gap-3 rounded-2xl border px-4 py-3.5"
                :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
              >
                <button class="flex-1 min-w-0 text-left py-0.5" @click="openDocDetail(doc)">
                  <div class="flex items-center gap-2">
                    <span
                      class="text-sm font-medium truncate"
                      :style="{ color: 'var(--hc-text-primary)' }"
                    >
                      {{ doc.title }}
                    </span>
                    <span
                      class="text-[10px] px-2 py-0.5 rounded-full"
                      :style="getDocStatusStyle(doc)"
                    >
                      {{ getDocStatusLabel(doc) }}
                    </span>
                  </div>
                  <div
                    class="flex items-center gap-3 mt-1 text-xs"
                    :style="{ color: 'var(--hc-text-muted)' }"
                  >
                    <span>{{ doc.chunk_count }} chunk{{ doc.chunk_count === 1 ? '' : 's' }}</span>
                    <span v-if="doc.source">{{ t('knowledge.source') }}: {{ doc.source }}</span>
                    <span>{{
                      new Date(doc.updated_at || doc.created_at).toLocaleString(locale)
                    }}</span>
                  </div>
                  <p v-if="doc.error_message" class="text-[11px] mt-2" style="color: #dc2626">
                    {{ doc.error_message }}
                  </p>
                </button>
                <div data-testid="knowledge-doc-actions" class="shrink-0 flex items-center gap-1">
                  <button
                    class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors"
                    :style="{ color: 'var(--hc-text-secondary)', background: 'var(--hc-bg-hover)' }"
                    :disabled="!knowledgeEnabled || reindexingDocIds.has(doc.id)"
                    @click="handleReindex(doc)"
                  >
                    <RefreshCw :size="12" :class="{ 'animate-spin': reindexingDocIds.has(doc.id) }" />
                    {{
                      getDocStatus(doc) === 'failed'
                        ? t('knowledge.retryIndex')
                        : t('knowledge.reindex')
                    }}
                  </button>
                  <button
                    class="p-1.5 rounded-lg transition-colors"
                    :style="{ color: 'var(--hc-error)', background: 'color-mix(in srgb, var(--hc-error) 8%, transparent)' }"
                    :title="t('common.delete')"
                    :disabled="!knowledgeEnabled"
                    @click="confirmDelete(doc)"
                  >
                    <Trash2 :size="16" />
                  </button>
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
            class="max-w-2xl mt-3 flex items-center justify-center gap-3 text-xs"
          >
            <button
              type="button"
              class="px-3 py-1.5 rounded-lg border transition-colors"
              :style="{ borderColor: 'var(--hc-border)', color: 'var(--hc-text-secondary)', background: 'var(--hc-bg-card)' }"
              @click="loadMoreDocs"
            >
              {{ t('knowledge.loadMore') }}
            </button>
            <span :style="{ color: 'var(--hc-text-muted)' }">
              {{ t('knowledge.shownOfTotal', { shown: windowedDocs.length, total: displayedTotalDocs }) }}
            </span>
          </div>
        </template>
      </template>

      <!-- 检索测试标签 -->
      <template v-else>
        <div class="max-w-2xl">
          <p class="text-sm mb-4" :style="{ color: 'var(--hc-text-secondary)' }">
            {{ t('knowledge.searchDesc') }}
          </p>

          <!-- 检索质量参数（高级）：折叠面板（默认展开），全局持久化（写 yaml + 热更新 KB Manager）。
               即时生效：rerank/查询扩展/情境增强 开关、min_score、candidate_k；换 rerank 模型需重启 sidecar。 -->
          <div
            data-testid="kb-rag-panel"
            class="mb-5 rounded-xl border"
            :style="{ borderColor: 'var(--hc-border)', background: 'var(--hc-bg-card)' }"
          >
            <div
              data-testid="kb-rag-toggle"
              class="flex items-center justify-between px-3.5 py-2.5 cursor-pointer select-none"
              @click="ragPanelOpen = !ragPanelOpen"
            >
              <span class="text-[13px] font-semibold" :style="{ color: 'var(--hc-text-primary)' }">
                {{ t('knowledge.ragTitle') }}
              </span>
              <span class="flex items-center gap-3.5">
                <button
                  type="button"
                  data-testid="kb-rag-reset"
                  class="text-xs"
                  :style="{ color: 'var(--hc-text-muted)' }"
                  :disabled="!knowledgeEnabled || ragSaving"
                  @click.stop="resetRagConfig"
                >
                  {{ t('knowledge.ragReset') }}
                </button>
                <ChevronDown
                  :size="15"
                  :style="{
                    color: 'var(--hc-text-muted)',
                    transform: ragPanelOpen ? 'rotate(180deg)' : 'none',
                    transition: 'transform .15s',
                  }"
                />
              </span>
            </div>

            <div
              v-show="ragPanelOpen"
              class="px-4 pb-3.5 flex flex-col gap-3 border-t"
              :style="{ borderColor: 'var(--hc-border)' }"
            >
              <!-- 重排 cross-encoder + 模型下拉 -->
              <div class="flex items-center gap-2.5 pt-3 flex-wrap">
                <span class="text-[13px] flex-1 min-w-0" :style="{ color: 'var(--hc-text-primary)' }">
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
                <span class="text-[13px] flex-1" :style="{ color: 'var(--hc-text-primary)' }">
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
                <span class="text-[13px] flex-1" :style="{ color: 'var(--hc-text-primary)' }">
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
                <span class="text-[13px] flex-1" :style="{ color: 'var(--hc-text-primary)' }">
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
                  @input="ragConfig.min_score = Number(($event.target as HTMLInputElement).value)"
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
                <span class="text-[13px] flex-1" :style="{ color: 'var(--hc-text-primary)' }">
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
            </div>
          </div>

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
          <div data-testid="knowledge-search-filters" class="flex flex-wrap items-center gap-2 mb-6">
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
                  ? { background: 'var(--hc-accent)', borderColor: 'var(--hc-accent)', color: '#fff' }
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

            <span class="w-px h-4 mx-1 shrink-0" :style="{ background: 'var(--hc-border)' }" />

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

    <!-- 添加文档对话框 -->
    <Teleport to="body">
      <Transition name="modal">
        <div
          v-if="showAddDialog"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-sm"
          @click.self="closeAddDialog"
        >
          <div
            class="w-full max-w-lg rounded-2xl border flex flex-col overflow-hidden"
            :style="{ background: 'var(--hc-bg-elevated)', borderColor: 'var(--hc-border)' }"
          >
            <div
              class="flex items-center justify-between px-5 py-4 border-b"
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
                @click="closeAddDialog"
              >
                <X :size="17" />
              </button>
            </div>
            <div class="p-5 flex flex-col gap-3.5">
              <!-- 文件上传区 -->
              <div
                class="flex items-center gap-3 p-3 rounded-lg border border-dashed cursor-pointer hover:border-solid transition-colors"
                :style="{ borderColor: 'var(--hc-border)', background: 'var(--hc-bg-secondary)' }"
                @click="openFilePicker"
              >
                <Upload :size="20" style="color: var(--hc-accent)" />
                <div>
                  <div class="text-sm font-medium" :style="{ color: 'var(--hc-text-primary)' }">
                    {{ t('knowledge.uploadFile', '上传文件') }}
                  </div>
                  <div class="text-xs" :style="{ color: 'var(--hc-text-secondary)' }">
                    PDF / Word / TXT / Markdown / CSV / Excel
                  </div>
                </div>
              </div>
              <div class="text-center text-xs" :style="{ color: 'var(--hc-text-tertiary)' }">
                {{ t('knowledge.orManualInput', '— 或手动输入 —') }}
              </div>
              <div class="flex flex-col gap-1.5">
                <label
                  class="text-[13px] font-medium"
                  :style="{ color: 'var(--hc-text-secondary)' }"
                  >{{ t('knowledge.docTitle') }}</label
                >
                <HcClearableField>
                  <input
                  v-model="newTitle"
                  type="text"
                  class="rounded-lg border px-3 py-2 text-sm outline-none"
                  :style="{
                    background: 'var(--hc-bg-input)',
                    borderColor: 'var(--hc-border)',
                    color: 'var(--hc-text-primary)',
                  }"
                  :placeholder="t('knowledge.docTitlePlaceholder')"
                />
                </HcClearableField>
              </div>
              <div class="flex flex-col gap-1.5">
                <label
                  class="text-[13px] font-medium"
                  :style="{ color: 'var(--hc-text-secondary)' }"
                  >{{ t('knowledge.docContent') }}</label
                >
                <HcClearableField>
                  <textarea
                  v-model="newContent"
                  rows="6"
                  class="rounded-lg border px-3 py-2 text-sm outline-none resize-none"
                  :style="{
                    background: 'var(--hc-bg-input)',
                    borderColor: 'var(--hc-border)',
                    color: 'var(--hc-text-primary)',
                  }"
                  :placeholder="t('knowledge.docContentPlaceholder')"
                />
                </HcClearableField>
              </div>
              <div class="flex flex-col gap-1.5">
                <label
                  class="text-[13px] font-medium"
                  :style="{ color: 'var(--hc-text-secondary)' }"
                  >{{ t('knowledge.docSource') }}</label
                >
                <HcClearableField>
                  <input
                  v-model="newSource"
                  type="text"
                  class="rounded-lg border px-3 py-2 text-sm outline-none"
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
              class="flex items-center justify-end gap-2 px-5 py-3.5 border-t"
              :style="{ borderColor: 'var(--hc-border)' }"
            >
              <button
                class="px-3 py-1.5 rounded-lg text-sm font-medium"
                :style="{ color: 'var(--hc-text-secondary)', background: 'var(--hc-bg-hover)' }"
                @click="closeAddDialog"
              >
                {{ t('common.cancel') }}
              </button>
              <button
                class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white"
                :style="{
                  background: 'var(--hc-accent)',
                  opacity:
                    !knowledgeEnabled || !newTitle.trim() || !newContent.trim() || adding ? 0.4 : 1,
                }"
                :disabled="!knowledgeEnabled || !newTitle.trim() || !newContent.trim() || adding"
                @click="handleAdd"
              >
                <Upload :size="14" />
                {{ adding ? t('knowledge.adding') : t('knowledge.add') }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 删除确认 -->
    <ConfirmDialog
      :open="showDeleteConfirm"
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
                  {{ t('knowledge.docCount', { count: 1 }) }} · {{ selectedDoc.chunk_count }} chunk{{ selectedDoc.chunk_count === 1 ? '' : 's' }}
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
                <MarkdownRenderer v-else-if="selectedDoc.content" :content="selectedDoc.content" />
                <template v-else>{{ t('knowledge.noContentDetail') }}</template>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
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
</style>
