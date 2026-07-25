<!--
  K12 作品面板（PRD §3.10）· 学习档案「作品」对象 Tab。
  语文写作 / 美术作品统一承载成长版本；保存作品或修改稿后由服务端自动生成点评。
  只给证据化点评，不打分、不代写、不排名（INV-011）。
  自包含：直连 /api/k12/creative-works*，本地状态，按 agentId 隔离拉取。
-->
<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import {
  k12ListCreativeWorks,
  k12CreateCreativeWork,
  k12GenerateWorkFeedback,
  k12SubmitWorkRevision,
  k12UploadAsset,
  k12CreateImageTask,
  k12GetImageTask,
  k12RetryImageTask,
  k12ConfirmImageTask,
  k12CancelImageTask,
  k12AssetURL,
  type CreativeWorkDTO,
  type ImageTaskCreativeProjectionDTO,
  type ImageTaskDispatchDTO,
  type WorkFeedbackDTO,
  type WorkVersionDTO,
  type WorkType,
} from '@/api/k12'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'

const props = withDefaults(defineProps<{ agentId: string; showAddButton?: boolean }>(), {
  showAddButton: true,
})
const emit = defineEmits<{
  (e: 'count', count: number): void
}>()
const { t } = useI18n()
const toast = useToast()

const works = ref<CreativeWorkDTO[]>([])
watch(
  () => works.value.length,
  (count) => emit('count', count),
  { immediate: true },
)
const loading = ref(false)
const error = ref('')
let loadGeneration = 0
const busyId = ref('')
const typeFilter = ref<'' | WorkType>('')
const expandedId = ref('')
const detailDialogs = ref<HTMLElement[]>([])
let detailOpener: HTMLElement | null = null
const previewImageSrc = ref('')
const previewImageAlt = ref('')
const previewDialog = ref<HTMLElement | null>(null)
let previewOpener: HTMLElement | null = null
// 修改稿行内输入：按 record_id 存草稿文本。
const revisionDraft = ref<Record<string, string>>({})
const feedbackRegeneratingId = ref('')
const feedbackRegenerateError = ref<Record<string, string>>({})
let feedbackGeneration = 0
let feedbackAbort: AbortController | null = null

const filtered = computed(() =>
  typeFilter.value ? works.value.filter((w) => w.work_type === typeFilter.value) : works.value,
)

// ── KPI（原型 2570-2576）：从列表计算，不另拉端点 ─────────────
// 「已点评」只看当前最新版本；提交修改稿后，新版本的自动点评完成前仍是待点评。
function isReviewed(w: CreativeWorkDTO): boolean {
  const version = latestVersion(w)
  return !!(version?.feedback || version?.structured_feedback)
}
function latestVersion(w: CreativeWorkDTO): WorkVersionDTO | undefined {
  return w.versions[w.versions.length - 1]
}
function structuredFeedbackIsPolluted(feedback: WorkFeedbackDTO): boolean {
  const atoms = [
    ...(feedback.observations ?? []).map((observation) => observation.evidence),
    ...(feedback.suggestions ?? []),
    feedback.limitations ?? '',
  ]
  return atoms.some((atom) => /[\r\n]|\*\*|__|(?:^|\s)#{1,6}\s/.test(atom))
}
function structuredFeedbackProjection(version: WorkVersionDTO): string {
  return version.structured_feedback?.projection_markdown?.trim() || version.feedback?.trim() || ''
}
function currentVersionReviewed(w: CreativeWorkDTO): boolean {
  return isReviewed(w)
}
function cardSummary(w: CreativeWorkDTO): string {
  const version = latestVersion(w)
  if (version?.structured_feedback && structuredFeedbackIsPolluted(version.structured_feedback)) {
    return (w.task || w.intent || `${w.versions.length} ${t('k12.works.versionCount')}`).trim()
  }
  return (
    version?.structured_feedback?.suggestions[0] ||
    version?.feedback ||
    version?.content_markdown ||
    w.task ||
    ''
  ).trim()
}
function cardEvidence(w: CreativeWorkDTO): string[] {
  const feedback = latestVersion(w)?.structured_feedback
  const observations =
    feedback && !structuredFeedbackIsPolluted(feedback) ? feedback.observations : []
  if (observations.length > 0) {
    return observations
      .slice(0, 3)
      .map(
        (observation) =>
          `${feedbackDimensionLabel(observation.dimension)}：${observation.evidence}`,
      )
  }
  return [w.task, w.intent || '', `${w.versions.length} ${t('k12.works.versionCount')}`].filter(
    Boolean,
  )
}
function detailTitle(w: CreativeWorkDTO): string {
  return t('k12.works.detailTitle', { title: w.title })
}
function activeDetailDialog(): HTMLElement | null {
  return detailDialogs.value.find((dialog) => dialog.dataset.workId === expandedId.value) ?? null
}
function openDetails(w: CreativeWorkDTO, event?: Event) {
  const trigger = event?.currentTarget
  detailOpener = trigger instanceof HTMLElement ? trigger : null
  expandedId.value = w.record_id
  void nextTick(() => activeDetailDialog()?.focus())
}
function closeDetails(restoreFocus = true) {
  if (!expandedId.value) return
  const recordId = expandedId.value
  expandedId.value = ''
  resetRevisionPhoto(recordId)
  const opener = detailOpener
  detailOpener = null
  void nextTick(() => {
    if (restoreFocus && opener?.isConnected) opener.focus()
  })
}
function openImagePreview(src: string, alt: string, event?: Event) {
  if (!src) return
  const trigger = event?.currentTarget
  previewOpener = trigger instanceof HTMLElement ? trigger : null
  previewImageSrc.value = src
  previewImageAlt.value = alt
  void nextTick(() => previewDialog.value?.focus())
}
function closeImagePreview(restoreFocus = true) {
  if (!previewImageSrc.value) return
  previewImageSrc.value = ''
  previewImageAlt.value = ''
  const opener = previewOpener
  previewOpener = null
  void nextTick(() => {
    if (restoreFocus && opener?.isConnected) opener.focus()
  })
}
function toggleDetails(w: CreativeWorkDTO, event?: Event) {
  if (expandedId.value === w.record_id) closeDetails()
  else openDetails(w, event)
}
function trapDetailFocus(event: KeyboardEvent) {
  const dialog = activeDetailDialog()
  if (!dialog || event.key !== 'Tab') return
  const selector =
    'button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'
  const focusable = [...dialog.querySelectorAll<HTMLElement>(selector)].filter(
    (element) => !element.hidden,
  )
  if (focusable.length === 0) {
    event.preventDefault()
    dialog.focus()
    return
  }
  const first = focusable[0]!
  const last = focusable[focusable.length - 1]!
  if (
    event.shiftKey &&
    (document.activeElement === first || !dialog.contains(document.activeElement))
  ) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function feedbackDimensionLabel(
  dimension: WorkFeedbackDTO['observations'][number]['dimension'],
): string {
  const labels: Record<typeof dimension, string> = {
    task_alignment: t('k12.works.feedbackDimensionTask'),
    structure: t('k12.works.feedbackDimensionStructure'),
    expression: t('k12.works.feedbackDimensionExpression'),
    language_detail: t('k12.works.feedbackDimensionLanguage'),
    composition: t('k12.works.feedbackDimensionComposition'),
    color: t('k12.works.feedbackDimensionColor'),
    line: t('k12.works.feedbackDimensionLine'),
    visible_detail: t('k12.works.feedbackDimensionVisible'),
  }
  return labels[dimension]
}

const kpiTotal = computed(() => works.value.length)
const kpiReviewed = computed(() => works.value.filter(isReviewed).length)
const kpiPending = computed(() => kpiTotal.value - kpiReviewed.value)

// ── 添加作品弹窗（原型 5326-5361）─────────────
const addOpen = ref(false)
const addType = ref<WorkType>('writing')
const addTitle = ref('')
const addTask = ref('')
const addDraft = ref('') // 语文写作：原稿文字
const addIntent = ref('') // 美术作品：创作意图（可留空）
const addBusy = ref(false)
const addDialog = ref<HTMLElement | null>(null)
let addOpener: HTMLElement | null = null

// ── 作品照片真实上传（任务1：最小资产服务 POST /assets）─────────────
// 选图即传：预览缩略 + 真实进度 + 失败提示/重试；成功得 asset://<agent>/<sha256>.<ext>，
// 保存作品时写入 source_asset_id。照片仅保存在本机（§3.12 桌面直传隐私口径）。
const photoInput = ref<HTMLInputElement | null>(null)
// AP-027 IME 守卫：拖拽区是 role="button" 键盘激活出口，组字中的回车（isComposing）不应打开选图。
const onPhotoKey = (e: KeyboardEvent) => {
  if (e.isComposing || e.keyCode === 229) return
  photoInput.value?.click()
}
const photoAssetId = ref('')
const photoPreview = ref('') // objectURL 本地预览（与上传解耦，失败也能看到选了什么）
const photoPct = ref(-1) // -1=未上传；0-99=上传中；100=完成
const photoError = ref('')
let photoFile: File | null = null
let photoGeneration = 0
let photoAbort: AbortController | null = null

// DD-013/DD-030：可见交互保持不变；带图作品在内部统一走 ImageTaskDispatch。
// 这里的本地 view 只是兼容既有模板状态，不是旧 public OCR resource。
type CreativePhotoJobStatus =
  | 'pending'
  | 'processing'
  | 'awaiting_confirmation'
  | 'failed'
  | 'confirmed'

interface CreativePhotoJobView {
  dispatch_id: string
  source_asset_id: string
  status: CreativePhotoJobStatus
  ocr_raw?: string
  error_message?: string
  confirmed_version?: number
  confirmed_content?: string
}

const photoImageTask = ref<ImageTaskDispatchDTO | null>(null)
const photoOCRJob = ref<CreativePhotoJobView | null>(null)
const photoOCRBusy = ref(false)
const photoOCRRequestError = ref('')
let photoOCRGeneration = 0
let photoOCRRequestId = ''
const manualCreativePollIntervalMS = 250
const manualCreativePollLimit = 960

function newOCRRequestId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `cwocr-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
}

function creativeProjection(
  dispatch: ImageTaskDispatchDTO | null | undefined,
): ImageTaskCreativeProjectionDTO | undefined {
  if (!dispatch) return undefined
  const projection = dispatch.target_projection
  return projection?.kind === 'creative' ? projection : undefined
}

function manualCreativeTaskSettled(dispatch: ImageTaskDispatchDTO): boolean {
  if (dispatch.status === 'failed' || dispatch.status === 'cancelled') return true
  const status = creativeProjection(dispatch)?.status
  return (
    status === 'awaiting_confirmation' ||
    status === 'ready' ||
    status === 'promoted' ||
    status === 'failed' ||
    status === 'cancelled'
  )
}

function photoJobView(dispatch: ImageTaskDispatchDTO, sourceAssetId: string): CreativePhotoJobView {
  const projection = creativeProjection(dispatch)
  let status: CreativePhotoJobStatus = 'processing'
  if (
    dispatch.status === 'failed' ||
    dispatch.status === 'cancelled' ||
    projection?.status === 'failed' ||
    projection?.status === 'cancelled'
  ) {
    status = 'failed'
  } else if (projection?.status === 'awaiting_confirmation') {
    status = 'awaiting_confirmation'
  } else if (projection?.status === 'ready' || projection?.status === 'promoted') {
    status = 'confirmed'
  }
  return {
    dispatch_id: dispatch.dispatch_id,
    source_asset_id: sourceAssetId,
    status,
    ocr_raw: projection?.canonical_content,
    confirmed_version: status === 'confirmed' ? projection?.canonical_version : undefined,
    confirmed_content: status === 'confirmed' ? projection?.canonical_content : undefined,
  }
}

async function pollManualCreativeTask(
  initial: ImageTaskDispatchDTO,
  active: () => boolean,
  apply: (dispatch: ImageTaskDispatchDTO) => void,
): Promise<ImageTaskDispatchDTO> {
  let current = initial
  apply(current)
  for (let index = 0; index < manualCreativePollLimit; index += 1) {
    if (!active() || manualCreativeTaskSettled(current)) return current
    await new Promise<void>((resolve) => window.setTimeout(resolve, manualCreativePollIntervalMS))
    if (!active()) return current
    current = (await k12GetImageTask(props.agentId, current.dispatch_id)).dispatch
    apply(current)
  }
  throw new Error(t('k12.works.ocrFailed'))
}

function cancelManualCreativeTask(dispatch: ImageTaskDispatchDTO | null) {
  if (!dispatch || creativeProjection(dispatch)?.status === 'promoted') return
  void k12CancelImageTask(dispatch.dispatch_id, {
    agent: props.agentId,
    version: dispatch.version,
  }).catch(() => {
    // 关闭/换图只做 best-effort 取消；旧 intake 已有 owner/identity 约束，不能污染新任务。
  })
}

function resetPhotoOCR(clearDraft = false, cancelTask = true) {
  photoOCRGeneration += 1
  const dispatch = photoImageTask.value
  photoImageTask.value = null
  photoOCRJob.value = null
  photoOCRBusy.value = false
  photoOCRRequestError.value = ''
  photoOCRRequestId = ''
  if (clearDraft) addDraft.value = ''
  if (cancelTask) cancelManualCreativeTask(dispatch)
}

function applyPhotoImageTask(dispatch: ImageTaskDispatchDTO, assetId: string) {
  photoImageTask.value = dispatch
  const job = photoJobView(dispatch, assetId)
  photoOCRJob.value = job
  photoOCRRequestError.value = ''
  if (job.status === 'awaiting_confirmation' && job.ocr_raw) {
    addDraft.value = job.ocr_raw
  } else if (job.status === 'confirmed' && job.confirmed_content) {
    addDraft.value = job.confirmed_content
  }
}

async function startPhotoOCR() {
  const assetId = photoAssetId.value
  if (!assetId) return
  if (!photoOCRRequestId) photoOCRRequestId = newOCRRequestId()
  const generation = ++photoOCRGeneration
  const selectedType = addType.value
  photoOCRBusy.value = true
  photoOCRRequestError.value = ''
  photoOCRJob.value = null
  try {
    const response = await k12CreateImageTask({
      agent: props.agentId,
      source_session: `creative-works:${props.agentId}`,
      source_kind: 'desktop',
      source_ref: photoOCRRequestId,
      source_asset_refs: [assetId],
      attempt_generation: 1,
      route_request: { selection_source: 'auto' },
      creative_entry: {
        kind: 'new_work',
        task_intent: selectedType === 'writing' ? 'writing' : 'artwork',
      },
    })
    if (
      generation !== photoOCRGeneration ||
      assetId !== photoAssetId.value ||
      selectedType !== addType.value
    )
      return
    await pollManualCreativeTask(
      response.dispatch,
      () =>
        generation === photoOCRGeneration &&
        assetId === photoAssetId.value &&
        selectedType === addType.value,
      (dispatch) => applyPhotoImageTask(dispatch, assetId),
    )
  } catch (e) {
    if (generation !== photoOCRGeneration) return
    photoOCRRequestError.value = (e as Error).message || t('k12.works.ocrFailed')
  } finally {
    if (generation === photoOCRGeneration) photoOCRBusy.value = false
  }
}

async function retryPhotoOCR() {
  const dispatch = photoImageTask.value
  if (!dispatch || photoOCRBusy.value) {
    if (!dispatch && photoAssetId.value) await startPhotoOCR()
    return
  }
  const assetId = photoAssetId.value
  const generation = ++photoOCRGeneration
  photoOCRBusy.value = true
  photoOCRRequestError.value = ''
  try {
    const response = await k12RetryImageTask(dispatch.dispatch_id, {
      agent: props.agentId,
      version: dispatch.version,
    })
    if (generation !== photoOCRGeneration || assetId !== photoAssetId.value) return
    await pollManualCreativeTask(
      response.dispatch,
      () => generation === photoOCRGeneration && assetId === photoAssetId.value,
      (updated) => applyPhotoImageTask(updated, assetId),
    )
  } catch (e) {
    if (generation !== photoOCRGeneration) return
    photoOCRRequestError.value = (e as Error).message || t('k12.works.ocrFailed')
  } finally {
    if (generation === photoOCRGeneration) photoOCRBusy.value = false
  }
}

async function confirmPhotoOCR() {
  const job = photoOCRJob.value
  const dispatch = photoImageTask.value
  const content = addDraft.value.trim()
  if (!job || !dispatch || !content || photoOCRBusy.value) return
  const generation = ++photoOCRGeneration
  photoOCRBusy.value = true
  photoOCRRequestError.value = ''
  try {
    const response = await k12ConfirmImageTask(dispatch.dispatch_id, {
      agent: props.agentId,
      version: dispatch.version,
      creative: {
        action: 'freeze_ocr',
        canonical_version: creativeProjection(dispatch)?.canonical_version ?? 1,
        canonical_content: content,
      },
    })
    if (generation !== photoOCRGeneration || job.source_asset_id !== photoAssetId.value) return
    applyPhotoImageTask(response.dispatch, job.source_asset_id)
  } catch (e) {
    if (generation !== photoOCRGeneration) return
    photoOCRRequestError.value = (e as Error).message || t('k12.works.ocrConfirmFailed')
  } finally {
    if (generation === photoOCRGeneration) photoOCRBusy.value = false
  }
}

const photoUploading = computed(
  () => photoPct.value >= 0 && photoPct.value < 100 && !photoError.value,
)

function resetPhoto(cancelTask = true) {
  photoGeneration += 1
  photoAbort?.abort()
  photoAbort = null
  if (photoPreview.value) URL.revokeObjectURL(photoPreview.value)
  photoAssetId.value = ''
  photoPreview.value = ''
  photoPct.value = -1
  photoError.value = ''
  photoFile = null
  resetPhotoOCR(false, cancelTask)
  if (photoInput.value) photoInput.value.value = ''
}

function onPhotoPick(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (file) acceptPhotoFile(file)
}

// 点击选择与拖放共用一条管线（20260718 控件统一，原型 creativeWorkDropzone）：
// 校验类型/体积 → 本地预览 → 立即真实上传。
function acceptPhotoFile(file: File) {
  if (!file.type.startsWith('image/')) {
    toast.error(t('k12.works.photoNotImage'))
    return
  }
  if (file.size > 10 * 1024 * 1024) {
    toast.error(t('k12.works.photoTooLarge'))
    return
  }
  if (photoPreview.value) URL.revokeObjectURL(photoPreview.value)
  resetPhotoOCR(addType.value === 'writing')
  photoOCRRequestId = newOCRRequestId()
  photoFile = file
  // 新选择立即作废旧资产；否则 B 上传失败时会把 A 的 asset_id 串进新作品。
  photoAssetId.value = ''
  photoError.value = ''
  photoPreview.value = URL.createObjectURL(file)
  void uploadPhoto()
}

// 拖放态：dragover 描边转实线示可投放；drop 取首个文件走同一管线。
const photoDragOver = ref(false)
function onPhotoDrop(e: DragEvent) {
  photoDragOver.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) acceptPhotoFile(file)
}

async function uploadPhoto() {
  if (!photoFile) return
  const file = photoFile
  const generation = ++photoGeneration
  photoAbort?.abort()
  const controller = new AbortController()
  photoAbort = controller
  photoAssetId.value = ''
  photoError.value = ''
  photoPct.value = 0
  try {
    const resp = await k12UploadAsset(
      props.agentId,
      file,
      (p) => {
        if (generation !== photoGeneration) return
        photoPct.value = Math.min(p, 99) // 100 留给服务端确认返回
      },
      controller.signal,
    )
    if (generation !== photoGeneration) return
    photoAssetId.value = resp.asset_id
    photoPct.value = 100
    void startPhotoOCR()
  } catch (e) {
    if (generation !== photoGeneration || (e as Error).name === 'AbortError') return
    photoError.value = (e as Error).message || t('k12.works.photoFailed')
    photoPct.value = -1
  } finally {
    if (generation === photoGeneration) photoAbort = null
  }
}

// 必填：名称 + 题目/任务；语文写作另需原稿（原型 mockAddCreativeWork 同口径）。
// 原图可选；一旦出现本地预览，本次上传必须成功拿到 asset_id 才能保存。
// 上传中/失败均阻断，移除预览后恢复纯文本保存（DD-026B）。
const photoReady = computed(
  () =>
    !photoPreview.value ||
    (!!photoAssetId.value &&
      !photoUploading.value &&
      !photoError.value &&
      creativeProjection(photoImageTask.value)?.status === 'ready'),
)
const photoOCRConfirmed = computed(() => {
  const job = photoOCRJob.value
  return (
    !!job &&
    job.status === 'confirmed' &&
    job.source_asset_id === photoAssetId.value &&
    !!job.confirmed_version &&
    job.confirmed_content === addDraft.value.trim()
  )
})
const addValid = computed(
  () =>
    !!addTitle.value.trim() &&
    !!addTask.value.trim() &&
    (addType.value === 'art' || !!addDraft.value.trim()) &&
    photoReady.value &&
    (addType.value === 'art' || !photoPreview.value || photoOCRConfirmed.value),
)

watch(addType, () => {
  if (photoAssetId.value) {
    resetPhotoOCR(false)
    photoOCRRequestId = newOCRRequestId()
    void startPhotoOCR()
  }
})
function openAdd() {
  closeDetails(false)
  const active = document.activeElement
  addOpener = active instanceof HTMLElement ? active : null
  addType.value = 'writing'
  addTitle.value = ''
  addTask.value = ''
  addDraft.value = ''
  addIntent.value = ''
  resetPhoto()
  addOpen.value = true
  void nextTick(() => {
    addDialog.value?.querySelector<HTMLElement>('button:not([disabled])')?.focus()
  })
}
function closeAdd() {
  if (!addOpen.value) return
  addOpen.value = false
  resetPhoto()
  const opener = addOpener
  addOpener = null
  void nextTick(() => {
    if (opener?.isConnected) opener.focus()
  })
}
function onAddKeydown(event: KeyboardEvent) {
  if (previewImageSrc.value && event.key === 'Escape') {
    event.preventDefault()
    closeImagePreview()
    return
  }
  if (addOpen.value && event.key === 'Escape') {
    event.preventDefault()
    closeAdd()
    return
  }
  if (!expandedId.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    closeDetails()
    return
  }
  trapDetailFocus(event)
}
async function submitAdd() {
  if (!addValid.value || addBusy.value) return
  addBusy.value = true
  try {
    if (photoAssetId.value) {
      const dispatch = photoImageTask.value
      if (!dispatch || creativeProjection(dispatch)?.status !== 'ready') return
      const response = await k12ConfirmImageTask(dispatch.dispatch_id, {
        agent: props.agentId,
        version: dispatch.version,
        creative: {
          action: 'commit',
          work_title: addTitle.value.trim(),
          task_requirement: addTask.value.trim(),
          intent: addType.value === 'art' ? addIntent.value.trim() || undefined : undefined,
          content_markdown: addType.value === 'writing' ? addDraft.value.trim() : undefined,
        },
      })
      photoImageTask.value = response.dispatch
      if (creativeProjection(response.dispatch)?.status !== 'promoted') {
        throw new Error(t('k12.works.ocrFailed'))
      }
      // A promoted explicit commit is terminal and must not be cancelled by modal cleanup.
      photoImageTask.value = null
    } else {
      await k12CreateCreativeWork({
        agent: props.agentId,
        work_type: addType.value,
        title: addTitle.value.trim(),
        task: addTask.value.trim(),
        intent: addType.value === 'art' ? addIntent.value.trim() || undefined : undefined,
        content_markdown: addType.value === 'writing' ? addDraft.value.trim() : undefined,
      })
    }
    toast.success(t('k12.works.created'))
    closeAdd()
    await load()
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    addBusy.value = false
  }
}

// ── 作品缩略图（任务1：美术卡片显缩略）────────────────────────
// 取最新携带 asset:// 资产的版本回图；data URL / 本地路径老载体不出缩略（GET 端点只认资产）。
function workThumbURL(w: CreativeWorkDTO): string {
  for (let i = w.versions.length - 1; i >= 0; i--) {
    const v = w.versions[i]
    if (!v) continue
    const id = v.source_asset_id || ''
    if (id.startsWith('asset://')) return k12AssetURL(props.agentId, id)
  }
  return ''
}

async function load() {
  if (!props.agentId) return
  const agent = props.agentId
  const generation = ++loadGeneration
  loading.value = true
  error.value = ''
  try {
    const resp = await k12ListCreativeWorks(agent)
    if (generation !== loadGeneration || agent !== props.agentId) return
    works.value = resp.items ?? []
  } catch (e) {
    if (generation !== loadGeneration || agent !== props.agentId) return
    error.value = (e as Error).message || t('k12.works.loadError')
  } finally {
    if (generation === loadGeneration) loading.value = false
  }
}

onMounted(() => {
  document.addEventListener('keydown', onAddKeydown)
  void load()
})
watch(
  () => props.agentId,
  () => {
    loadGeneration += 1
    feedbackGeneration += 1
    feedbackAbort?.abort()
    feedbackAbort = null
    feedbackRegeneratingId.value = ''
    feedbackRegenerateError.value = {}
    closeDetails(false)
    closeImagePreview(false)
    closeAdd()
    resetPhoto()
    resetAllRevisionPhotos()
    void load()
  },
)
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onAddKeydown)
  loadGeneration += 1
  feedbackGeneration += 1
  feedbackAbort?.abort()
  feedbackAbort = null
  closeDetails(false)
  closeImagePreview(false)
  resetPhoto()
  resetAllRevisionPhotos()
})

function statusTone(s: string): string {
  if (s === 'draft') return 'todo'
  if (s === 'feedback_ready') return 'got'
  if (s === 'revised') return 'done'
  return 'muted'
}

function newFeedbackCommandId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `feedback-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
}

async function regenerateFeedback(w: CreativeWorkDTO) {
  if (feedbackRegeneratingId.value || w.status === 'archived' || !currentVersionReviewed(w)) return
  const agent = props.agentId
  const generation = ++feedbackGeneration
  feedbackAbort?.abort()
  const controller = new AbortController()
  feedbackAbort = controller
  feedbackRegeneratingId.value = w.record_id
  feedbackRegenerateError.value[w.record_id] = ''
  try {
    const updated = await k12GenerateWorkFeedback(
      agent,
      w.record_id,
      newFeedbackCommandId(),
      controller.signal,
    )
    if (generation !== feedbackGeneration || agent !== props.agentId) return
    const index = works.value.findIndex((item) => item.record_id === w.record_id)
    if (index >= 0) works.value.splice(index, 1, updated)
    toast.success(t('k12.works.feedbackRegenerated'))
  } catch (e) {
    if (
      generation !== feedbackGeneration ||
      agent !== props.agentId ||
      (e as Error).name === 'AbortError'
    )
      return
    feedbackRegenerateError.value[w.record_id] = t('k12.works.feedbackRegenerateFailed')
  } finally {
    if (generation === feedbackGeneration) {
      feedbackRegeneratingId.value = ''
      if (feedbackAbort === controller) feedbackAbort = null
    }
  }
}

interface RevisionPhotoState {
  assetId: string
  preview: string
  pct: number
  error: string
  dispatch: ImageTaskDispatchDTO | null
  ocrJob: CreativePhotoJobView | null
  ocrBusy: boolean
  ocrError: string
  ocrRequestId: string
  ocrGeneration: number
}
const revisionPhotos = ref<Record<string, RevisionPhotoState>>({})
const revisionPhotoFiles = new Map<string, File>()
const revisionPhotoGenerations = new Map<string, number>()
const revisionPhotoAborts = new Map<string, AbortController>()

function revisionPhotoUploading(recordId: string): boolean {
  const state = revisionPhotos.value[recordId]
  return !!state && state.pct >= 0 && state.pct < 100 && !state.error
}

function canSubmitRevision(w: CreativeWorkDTO): boolean {
  const state = revisionPhotos.value[w.record_id]
  if (
    state &&
    (revisionPhotoUploading(w.record_id) || !!state.error || (!!state.preview && !state.assetId))
  ) {
    return false
  }
  if (state?.assetId && creativeProjection(state.dispatch)?.status !== 'ready') return false
  if (w.work_type === 'writing' && state?.assetId && !revisionOCRConfirmed(w)) return false
  return !!(revisionDraft.value[w.record_id] || '').trim() || !!state?.assetId
}

function revisionOCRConfirmed(w: CreativeWorkDTO): boolean {
  const state = revisionPhotos.value[w.record_id]
  const job = state?.ocrJob
  if (w.work_type !== 'writing' || !state?.assetId) return true
  return (
    !!job &&
    job.status === 'confirmed' &&
    job.source_asset_id === state.assetId &&
    !!job.confirmed_version &&
    job.confirmed_content === (revisionDraft.value[w.record_id] || '').trim()
  )
}

function applyRevisionImageTask(
  recordId: string,
  state: RevisionPhotoState,
  dispatch: ImageTaskDispatchDTO,
) {
  if (revisionPhotos.value[recordId] !== state) return
  state.dispatch = dispatch
  const job = photoJobView(dispatch, state.assetId)
  state.ocrJob = job
  state.ocrError = ''
  if (job.status === 'awaiting_confirmation' && job.ocr_raw) {
    revisionDraft.value[recordId] = job.ocr_raw
  } else if (job.status === 'confirmed' && job.confirmed_content) {
    revisionDraft.value[recordId] = job.confirmed_content
  }
}

async function startRevisionOCR(recordId: string) {
  const state = revisionPhotos.value[recordId]
  const work = works.value.find((item) => item.record_id === recordId)
  const baseVersion = work ? latestVersion(work) : undefined
  if (!state?.assetId || !work || !baseVersion) return
  const assetId = state.assetId
  const generation = ++state.ocrGeneration
  state.ocrBusy = true
  state.ocrError = ''
  state.ocrJob = null
  try {
    const response = await k12CreateImageTask({
      agent: props.agentId,
      source_session: `creative-works:${props.agentId}`,
      source_kind: 'desktop',
      source_ref: state.ocrRequestId,
      source_asset_refs: [assetId],
      attempt_generation: 1,
      route_request: { selection_source: 'auto' },
      creative_entry: {
        kind: 'revision',
        task_intent: work.work_type === 'writing' ? 'writing' : 'artwork',
        work_id: work.record_id,
        base_version_id: baseVersion.version_id,
      },
    })
    if (revisionPhotos.value[recordId] !== state || generation !== state.ocrGeneration) return
    await pollManualCreativeTask(
      response.dispatch,
      () =>
        revisionPhotos.value[recordId] === state &&
        generation === state.ocrGeneration &&
        state.assetId === assetId,
      (dispatch) => applyRevisionImageTask(recordId, state, dispatch),
    )
  } catch (e) {
    if (revisionPhotos.value[recordId] !== state || generation !== state.ocrGeneration) return
    state.ocrError = (e as Error).message || t('k12.works.ocrFailed')
  } finally {
    if (revisionPhotos.value[recordId] === state && generation === state.ocrGeneration) {
      state.ocrBusy = false
    }
  }
}

async function retryRevisionOCR(recordId: string) {
  const state = revisionPhotos.value[recordId]
  if (!state || state.ocrBusy) return
  const dispatch = state.dispatch
  if (!dispatch) {
    await startRevisionOCR(recordId)
    return
  }
  const generation = ++state.ocrGeneration
  state.ocrBusy = true
  state.ocrError = ''
  try {
    const response = await k12RetryImageTask(dispatch.dispatch_id, {
      agent: props.agentId,
      version: dispatch.version,
    })
    if (revisionPhotos.value[recordId] !== state || generation !== state.ocrGeneration) return
    await pollManualCreativeTask(
      response.dispatch,
      () => revisionPhotos.value[recordId] === state && generation === state.ocrGeneration,
      (updated) => applyRevisionImageTask(recordId, state, updated),
    )
  } catch (e) {
    if (revisionPhotos.value[recordId] !== state || generation !== state.ocrGeneration) return
    state.ocrError = (e as Error).message || t('k12.works.ocrFailed')
  } finally {
    if (revisionPhotos.value[recordId] === state && generation === state.ocrGeneration) {
      state.ocrBusy = false
    }
  }
}

async function confirmRevisionOCR(recordId: string) {
  const state = revisionPhotos.value[recordId]
  const job = state?.ocrJob
  const dispatch = state?.dispatch
  const content = (revisionDraft.value[recordId] || '').trim()
  if (!state || !job || !dispatch || !content || state.ocrBusy) return
  const generation = ++state.ocrGeneration
  state.ocrBusy = true
  state.ocrError = ''
  try {
    const response = await k12ConfirmImageTask(dispatch.dispatch_id, {
      agent: props.agentId,
      version: dispatch.version,
      creative: {
        action: 'freeze_ocr',
        canonical_version: creativeProjection(dispatch)?.canonical_version ?? 1,
        canonical_content: content,
      },
    })
    if (revisionPhotos.value[recordId] !== state || generation !== state.ocrGeneration) return
    applyRevisionImageTask(recordId, state, response.dispatch)
  } catch (e) {
    if (revisionPhotos.value[recordId] !== state || generation !== state.ocrGeneration) return
    state.ocrError = (e as Error).message || t('k12.works.ocrConfirmFailed')
  } finally {
    if (revisionPhotos.value[recordId] === state && generation === state.ocrGeneration) {
      state.ocrBusy = false
    }
  }
}

function onRevisionPhotoPick(w: CreativeWorkDTO, e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  // 允许用户选择同一个文件再次触发 change（例如上传失败后原文件重试）。
  input.value = ''
  if (!file) return
  if (!file.type.startsWith('image/')) {
    toast.error(t('k12.works.photoNotImage'))
    return
  }
  if (file.size > 10 * 1024 * 1024) {
    toast.error(t('k12.works.photoTooLarge'))
    return
  }
  const previous = revisionPhotos.value[w.record_id]
  if (previous) {
    previous.ocrGeneration += 1
    cancelManualCreativeTask(previous.dispatch)
    if (previous.preview) URL.revokeObjectURL(previous.preview)
  }
  revisionPhotoFiles.set(w.record_id, file)
  revisionPhotos.value[w.record_id] = {
    assetId: '',
    preview: URL.createObjectURL(file),
    pct: 0,
    error: '',
    dispatch: null,
    ocrJob: null,
    ocrBusy: false,
    ocrError: '',
    ocrRequestId: newOCRRequestId(),
    ocrGeneration: 0,
  }
  void uploadRevisionPhoto(w.record_id)
}

async function uploadRevisionPhoto(recordId: string) {
  const file = revisionPhotoFiles.get(recordId)
  const state = revisionPhotos.value[recordId]
  if (!file || !state) return
  const generation = (revisionPhotoGenerations.get(recordId) ?? 0) + 1
  revisionPhotoGenerations.set(recordId, generation)
  revisionPhotoAborts.get(recordId)?.abort()
  const controller = new AbortController()
  revisionPhotoAborts.set(recordId, controller)
  state.assetId = ''
  state.error = ''
  state.pct = 0
  try {
    const resp = await k12UploadAsset(
      props.agentId,
      file,
      (p) => {
        if (revisionPhotoGenerations.get(recordId) !== generation) return
        state.pct = Math.min(p, 99)
      },
      controller.signal,
    )
    if (revisionPhotoGenerations.get(recordId) !== generation) return
    state.assetId = resp.asset_id
    state.pct = 100
    const work = works.value.find((item) => item.record_id === recordId)
    if (work) void startRevisionOCR(recordId)
  } catch (e) {
    if (revisionPhotoGenerations.get(recordId) !== generation || (e as Error).name === 'AbortError')
      return
    state.error = (e as Error).message || t('k12.works.photoFailed')
    state.pct = -1
  } finally {
    if (revisionPhotoGenerations.get(recordId) === generation) {
      revisionPhotoAborts.delete(recordId)
    }
  }
}

function resetRevisionPhoto(recordId: string) {
  revisionPhotoGenerations.set(recordId, (revisionPhotoGenerations.get(recordId) ?? 0) + 1)
  revisionPhotoAborts.get(recordId)?.abort()
  revisionPhotoAborts.delete(recordId)
  revisionPhotoFiles.delete(recordId)
  const state = revisionPhotos.value[recordId]
  if (state) state.ocrGeneration += 1
  if (state) cancelManualCreativeTask(state.dispatch)
  if (state?.preview) URL.revokeObjectURL(state.preview)
  delete revisionPhotos.value[recordId]
}

function resetAllRevisionPhotos() {
  for (const recordId of Object.keys(revisionPhotos.value)) resetRevisionPhoto(recordId)
}

async function submitRevision(w: CreativeWorkDTO) {
  const content = (revisionDraft.value[w.record_id] || '').trim()
  const photoState = revisionPhotos.value[w.record_id]
  const assetId = photoState?.assetId || ''
  if (!canSubmitRevision(w)) return
  busyId.value = w.record_id
  try {
    if (assetId) {
      const dispatch = photoState?.dispatch
      if (!dispatch || creativeProjection(dispatch)?.status !== 'ready') return
      const response = await k12ConfirmImageTask(dispatch.dispatch_id, {
        agent: props.agentId,
        version: dispatch.version,
        creative: {
          action: 'commit',
          content_markdown: content || undefined,
        },
      })
      if (creativeProjection(response.dispatch)?.status !== 'promoted') {
        throw new Error(t('k12.works.ocrFailed'))
      }
      if (photoState) photoState.dispatch = null
    } else {
      await k12SubmitWorkRevision(props.agentId, w.record_id, content)
    }
    revisionDraft.value[w.record_id] = ''
    resetRevisionPhoto(w.record_id)
    toast.success(t('k12.works.submitRevision'))
    await load()
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busyId.value = ''
  }
}

defineExpose({ load, openAdd })
</script>

<template>
  <section class="k12cw">
    <div class="k12cw__overview">
      <p class="k12cw__desc" style="margin: 0">{{ t('k12.works.desc') }}</p>
      <button
        v-if="showAddButton"
        class="k12cw__btn k12cw__btn--primary"
        data-testid="cw-add-open"
        @click="openAdd"
      >
        {{ t('k12.works.addWork') }}
      </button>
      <!-- KPI 行（原型 2570-2576）：与说明同一 overview，不另起三张大卡 -->
      <div class="k12cw__kpis" data-testid="cw-kpis">
        <div class="k12cw__kpi">
          <b>{{ kpiTotal }}</b
          >{{ t('k12.works.kpiTotal') }}
        </div>
        <div class="k12cw__kpi">
          <b>{{ kpiReviewed }}</b
          >{{ t('k12.works.kpiReviewed') }}
        </div>
        <div class="k12cw__kpi">
          <b>{{ kpiPending }}</b
          >{{ t('k12.works.kpiPending') }}
        </div>
      </div>
    </div>

    <div class="k12cw__filter" :aria-label="t('k12.works.filterLabel')">
      <span class="k12cw__filter-label">{{ t('k12.works.filterTypeLabel') }}</span>
      <button
        type="button"
        :class="{ on: typeFilter === '' }"
        :aria-pressed="typeFilter === ''"
        @click="typeFilter = ''"
      >
        {{ t('k12.works.filterAll') }}
      </button>
      <button
        type="button"
        :class="{ on: typeFilter === 'writing' }"
        :aria-pressed="typeFilter === 'writing'"
        @click="typeFilter = 'writing'"
      >
        {{ t('k12.works.writing') }}
      </button>
      <button
        type="button"
        :class="{ on: typeFilter === 'art' }"
        :aria-pressed="typeFilter === 'art'"
        @click="typeFilter = 'art'"
      >
        {{ t('k12.works.art') }}
      </button>
    </div>

    <!-- 点评规则说明（原型 2582）：证据化点评边界，不打分不代写 -->
    <div class="k12cw__rules" data-testid="cw-rules">
      <b>{{ t('k12.works.rulesTitle') }}</b>
      {{ t('k12.works.rulesBody') }}
    </div>

    <div v-if="error" class="k12cw__err" data-testid="cw-error">
      <span>{{ error }}</span>
      <button
        class="k12cw__btn k12cw__btn--ghost"
        data-testid="cw-load-retry"
        :disabled="loading"
        @click="load"
      >
        {{ t('k12.works.retry') }}
      </button>
    </div>
    <div
      v-else-if="loading && works.length === 0"
      class="k12cw__loading"
      data-testid="cw-loading"
      role="status"
      aria-live="polite"
    >
      {{ t('k12.works.loading') }}
    </div>
    <div v-else-if="filtered.length === 0" class="k12cw__empty" data-testid="cw-empty">
      <b data-testid="cw-empty-title">{{
        works.length === 0 ? t('k12.works.emptyTitle') : t('k12.works.filterEmptyTitle')
      }}</b
      ><br />
      {{ works.length === 0 ? t('k12.works.emptyValue') : t('k12.works.filterEmptyValue') }}
    </div>

    <ul v-else class="k12cw__list" data-testid="cw-list">
      <li
        v-for="w in filtered"
        :key="w.record_id"
        class="k12cw__card"
        :data-review-state="currentVersionReviewed(w) ? 'reviewed' : 'pending'"
      >
        <div class="k12cw__preview" :class="`k12cw__preview--${w.work_type}`">
          <img
            v-if="workThumbURL(w)"
            :src="workThumbURL(w)"
            class="k12cw__thumb"
            :alt="w.title"
            data-testid="cw-thumb"
            loading="lazy"
            role="button"
            tabindex="0"
            :aria-label="`预览${w.title}`"
            @click="openImagePreview(workThumbURL(w), w.title, $event)"
            @keydown.enter.prevent="
              !$event.isComposing &&
              $event.keyCode !== 229 &&
              openImagePreview(workThumbURL(w), w.title, $event)
            "
            @keydown.space.prevent="openImagePreview(workThumbURL(w), w.title, $event)"
          />
          <span v-else class="k12cw__preview-placeholder" aria-hidden="true" />
        </div>
        <div class="k12cw__copy">
          <header class="k12cw__head">
            <span class="k12cw__kind" :class="`k12cw__kind--${w.work_type}`">
              {{ w.work_type === 'writing' ? t('k12.works.writingKind') : t('k12.works.art') }}
            </span>
            <span :class="`k12cw__pill k12cw__pill--${statusTone(w.status)}`">{{
              w.status_label
            }}</span>
          </header>
          <h3 class="k12cw__title">{{ w.title }}</h3>
          <div class="k12cw__evidence">
            <span v-for="evidence in cardEvidence(w)" :key="evidence">{{ evidence }}</span>
          </div>
          <p class="k12cw__summary">{{ cardSummary(w) }}</p>
          <button
            class="k12cw__detail-toggle"
            data-testid="cw-detail-toggle"
            aria-haspopup="dialog"
            :aria-expanded="expandedId === w.record_id"
            :aria-controls="`cw-detail-${w.record_id}`"
            @click="toggleDetails(w, $event)"
          >
            {{ t('k12.works.viewDetails') }}
          </button>

          <Teleport to="body">
            <div
              class="k12cw-detail-overlay"
              :class="{ 'is-open': expandedId === w.record_id }"
              :aria-hidden="expandedId !== w.record_id"
              :data-testid="expandedId === w.record_id ? 'cw-detail-overlay' : undefined"
              @click.self="closeDetails()"
            >
              <div
                :id="`cw-detail-${w.record_id}`"
                ref="detailDialogs"
                class="k12cw-detail-modal"
                :data-work-id="w.record_id"
                :data-testid="expandedId === w.record_id ? 'cw-detail-modal' : undefined"
                role="dialog"
                aria-modal="true"
                :aria-labelledby="`cw-detail-title-${w.record_id}`"
                tabindex="-1"
              >
                <header class="k12cw-detail-modal__head">
                  <b :id="`cw-detail-title-${w.record_id}`">{{ detailTitle(w) }}</b>
                  <button
                    type="button"
                    class="k12cw-detail-modal__x"
                    :data-testid="expandedId === w.record_id ? 'cw-detail-close' : undefined"
                    :aria-label="t('k12.works.detailClose')"
                    @click="closeDetails()"
                  >
                    ✕
                  </button>
                </header>
                <div class="k12cw-detail-modal__body">
                  <div class="k12cw__details">
                    <!-- 版本时间线：原稿 + 每次修改稿 + 各自点评 -->
                    <ol class="k12cw__versions">
                      <li v-for="ver in w.versions" :key="ver.version_id" class="k12cw__ver">
                        <span class="k12cw__vid">{{ ver.version_id }}</span>
                        <div class="k12cw__vbody">
                          <MarkdownRenderer
                            v-if="ver.content_markdown"
                            class="k12cw__vcontent"
                            data-testid="cw-version-content"
                            :content="ver.content_markdown"
                          />
                          <div
                            v-if="ver.structured_feedback"
                            class="k12cw__vfeedback k12cw__vfeedback--structured"
                            data-testid="cw-structured-feedback"
                          >
                            <span aria-hidden="true">💬</span>
                            <template v-if="structuredFeedbackIsPolluted(ver.structured_feedback)">
                              <MarkdownRenderer
                                v-if="structuredFeedbackProjection(ver)"
                                data-testid="cw-structured-feedback-projection"
                                :content="structuredFeedbackProjection(ver)"
                                :show-artifacts="false"
                              />
                            </template>
                            <div v-else class="k12cw__feedback-facts">
                              <b>{{ t('k12.works.feedbackObservations') }}</b>
                              <ul class="k12cw__feedback-list">
                                <li
                                  v-for="(observation, index) in ver.structured_feedback
                                    .observations"
                                  :key="`${observation.dimension}-${index}`"
                                >
                                  <span class="k12cw__feedback-dimension">{{
                                    feedbackDimensionLabel(observation.dimension)
                                  }}</span>
                                  <MarkdownRenderer
                                    :content="observation.evidence"
                                    :show-artifacts="false"
                                  />
                                </li>
                              </ul>
                              <b>{{ t('k12.works.feedbackSuggestions') }}</b>
                              <ol class="k12cw__feedback-list">
                                <li
                                  v-for="suggestion in ver.structured_feedback.suggestions"
                                  :key="suggestion"
                                >
                                  <MarkdownRenderer :content="suggestion" :show-artifacts="false" />
                                </li>
                              </ol>
                              <p class="k12cw__feedback-limit">
                                <b>{{ t('k12.works.feedbackLimitations') }}</b>
                                {{ ver.structured_feedback.limitations }}
                              </p>
                            </div>
                            <small class="k12cw__provenance" data-testid="cw-feedback-provenance">
                              {{
                                ver.structured_feedback.source_snapshot.source === 'ai'
                                  ? t('k12.works.feedbackSourceAI')
                                  : t('k12.works.feedbackSourceParent')
                              }}
                              · {{ ver.structured_feedback.source_snapshot.method_ref }}
                            </small>
                          </div>
                          <div v-else-if="ver.feedback" class="k12cw__vfeedback">
                            <span aria-hidden="true">💬</span>
                            <MarkdownRenderer
                              data-testid="cw-version-feedback"
                              :content="ver.feedback"
                              :show-artifacts="false"
                            />
                            <small
                              v-if="ver.feedback_source || ver.feedback_skill"
                              class="k12cw__provenance"
                              data-testid="cw-feedback-provenance"
                            >
                              {{
                                ver.feedback_source === 'ai'
                                  ? t('k12.works.feedbackSourceAI')
                                  : t('k12.works.feedbackSourceParent')
                              }}
                              <template v-if="ver.feedback_skill">
                                · {{ ver.feedback_skill }}</template
                              >
                            </small>
                          </div>
                        </div>
                      </li>
                    </ol>

                    <p
                      v-if="!currentVersionReviewed(w) && w.status !== 'archived'"
                      class="k12cw__ainote"
                      data-testid="cw-feedback-auto-pending"
                      role="status"
                      aria-live="polite"
                    >
                      {{ t('k12.works.feedbackAutoPending') }}
                    </p>

                    <!-- 当前唯一后续动作：上传修改稿；保存后由服务端自动点评。 -->
                    <div v-if="w.status !== 'archived'" class="k12cw__act">
                      <HcClearableField>
                        <textarea
                          v-model="revisionDraft[w.record_id]"
                          class="k12cw__input"
                          :aria-label="t('k12.works.submitRevision')"
                          :placeholder="t('k12.works.submitRevision')"
                          rows="2"
                          data-testid="cw-revision-input"
                        ></textarea>
                      </HcClearableField>
                      <div class="k12cw__revision-photo">
                        <label class="k12cw__btn k12cw__btn--ghost">
                          {{ t('k12.works.revisionPhotoChoose') }}
                          <input
                            type="file"
                            accept="image/*"
                            class="k12cw__file"
                            data-testid="cw-revision-photo-input"
                            @change="onRevisionPhotoPick(w, $event)"
                          />
                        </label>
                        <template v-if="revisionPhotos[w.record_id]">
                          <img
                            :src="revisionPhotos[w.record_id]!.preview"
                            class="k12cw__revision-thumb"
                            alt=""
                          />
                          <span v-if="revisionPhotoUploading(w.record_id)" class="k12cw__ainote">
                            {{ t('k12.works.photoUploading') }}
                            {{ revisionPhotos[w.record_id]!.pct }}%
                          </span>
                          <span
                            v-else-if="revisionPhotos[w.record_id]!.error"
                            class="k12cw__inlineerr"
                            data-testid="cw-revision-photo-error"
                            >{{ revisionPhotos[w.record_id]!.error }}</span
                          >
                          <span
                            v-else-if="revisionPhotos[w.record_id]!.assetId"
                            class="k12cw__ainote"
                          >
                            {{ t('k12.works.photoUploaded') }}
                          </span>
                          <button
                            v-if="revisionPhotos[w.record_id]!.error"
                            class="k12cw__btn k12cw__btn--ghost"
                            type="button"
                            @click="uploadRevisionPhoto(w.record_id)"
                          >
                            {{ t('k12.works.photoRetry') }}
                          </button>
                          <button
                            class="k12cw__btn k12cw__btn--ghost"
                            type="button"
                            @click="resetRevisionPhoto(w.record_id)"
                          >
                            {{ t('k12.works.photoRemove') }}
                          </button>
                          <div
                            v-if="w.work_type === 'writing' && revisionPhotos[w.record_id]!.assetId"
                            class="k12cw__ocr k12cw__revision-ocr"
                            aria-live="polite"
                            data-testid="cw-revision-ocr-state"
                          >
                            <p
                              v-if="revisionPhotos[w.record_id]!.ocrBusy"
                              class="k12cw__ainote"
                              data-testid="cw-revision-ocr-processing"
                            >
                              {{ t('k12.works.ocrProcessing') }}
                            </p>
                            <div
                              v-else-if="
                                revisionPhotos[w.record_id]!.ocrError ||
                                revisionPhotos[w.record_id]!.ocrJob?.status === 'failed'
                              "
                              class="k12cw__inlineerr"
                              data-testid="cw-revision-ocr-error"
                            >
                              <p>
                                {{
                                  revisionPhotos[w.record_id]!.ocrError ||
                                  revisionPhotos[w.record_id]!.ocrJob?.error_message ||
                                  t('k12.works.ocrFailed')
                                }}
                              </p>
                              <button
                                type="button"
                                class="k12cw__btn k12cw__btn--ghost"
                                data-testid="cw-revision-ocr-retry"
                                @click="retryRevisionOCR(w.record_id)"
                              >
                                {{ t('k12.works.ocrRetry') }}
                              </button>
                              <p class="k12cw__ainote">{{ t('k12.works.ocrManualHint') }}</p>
                            </div>
                            <p
                              v-else-if="revisionOCRConfirmed(w)"
                              class="k12cw__ainote k12cw__ocrok"
                              data-testid="cw-revision-ocr-confirmed"
                            >
                              {{ t('k12.works.ocrConfirmed') }}
                            </p>
                            <p
                              v-else-if="
                                revisionPhotos[w.record_id]!.ocrJob?.status ===
                                  'awaiting_confirmation' ||
                                revisionPhotos[w.record_id]!.ocrJob?.status === 'confirmed'
                              "
                              class="k12cw__ainote"
                              data-testid="cw-revision-ocr-awaiting"
                            >
                              {{ t('k12.works.ocrAwaiting') }}
                            </p>
                            <button
                              v-if="revisionPhotos[w.record_id]!.ocrJob && !revisionOCRConfirmed(w)"
                              type="button"
                              class="k12cw__btn k12cw__btn--ghost"
                              :disabled="
                                revisionPhotos[w.record_id]!.ocrBusy ||
                                !(revisionDraft[w.record_id] || '').trim()
                              "
                              data-testid="cw-revision-ocr-confirm"
                              @click="confirmRevisionOCR(w.record_id)"
                            >
                              {{ t('k12.works.ocrConfirm') }}
                            </button>
                          </div>
                        </template>
                      </div>
                      <button
                        class="k12cw__btn k12cw__btn--primary"
                        :disabled="busyId === w.record_id || !canSubmitRevision(w)"
                        data-testid="cw-revision-submit"
                        @click="submitRevision(w)"
                      >
                        {{ t('k12.works.submitRevision') }}
                      </button>
                      <button
                        v-if="currentVersionReviewed(w)"
                        class="k12cw__btn k12cw__btn--ghost"
                        :disabled="!!feedbackRegeneratingId"
                        :aria-busy="feedbackRegeneratingId === w.record_id"
                        data-testid="cw-feedback-regenerate"
                        @click="regenerateFeedback(w)"
                      >
                        {{
                          feedbackRegeneratingId === w.record_id
                            ? t('k12.works.feedbackRegenerating')
                            : t('k12.works.feedbackRegenerate')
                        }}
                      </button>
                      <p
                        v-if="feedbackRegenerateError[w.record_id]"
                        class="k12cw__inlineerr"
                        data-testid="cw-feedback-regenerate-error"
                        role="alert"
                      >
                        {{ feedbackRegenerateError[w.record_id] }}
                      </p>
                    </div>
                  </div>
                </div>
                <footer class="k12cw-detail-modal__foot">
                  <button type="button" class="k12cw__btn" @click="closeDetails()">
                    {{ t('k12.works.detailClose') }}
                  </button>
                </footer>
              </div>
            </div>
          </Teleport>
        </div>
      </li>
    </ul>

    <Teleport to="body">
      <div
        v-if="previewImageSrc"
        ref="previewDialog"
        class="k12cw-image-preview"
        data-testid="cw-image-preview"
        role="dialog"
        aria-modal="true"
        :aria-label="`预览${previewImageAlt}`"
        tabindex="-1"
        @click.self="closeImagePreview()"
        @keydown.esc.prevent="closeImagePreview()"
      >
        <img :src="previewImageSrc" :alt="previewImageAlt" />
        <button
          type="button"
          class="k12cw-image-preview__close"
          aria-label="关闭预览"
          @click="closeImagePreview()"
        >
          ✕
        </button>
      </div>
    </Teleport>

    <!-- 添加作品弹窗（原型 5326-5361）。挂到 body，避免档案容器的布局上下文裁切/拉伸 fixed 弹层。 -->
    <Teleport to="body">
      <div v-if="addOpen" class="k12cw-overlay" data-testid="cw-add-modal" @click.self="closeAdd">
        <div
          ref="addDialog"
          class="k12cw-modal"
          role="dialog"
          aria-modal="true"
          :aria-label="t('k12.works.addModalTitle')"
        >
          <div class="k12cw-modal__head">
            <b>{{ t('k12.works.addModalTitle') }}</b>
            <button class="k12cw-modal__x" :aria-label="t('k12.works.cancel')" @click="closeAdd">
              ✕
            </button>
          </div>
          <div class="k12cw-modal__body">
            <label class="k12cw-modal__field">
              <span>{{ t('k12.works.typeLabel') }}</span>
              <div class="k12cw__seg" role="radiogroup" :aria-label="t('k12.works.typeLabel')">
                <button
                  type="button"
                  :class="{ on: addType === 'writing' }"
                  :aria-pressed="addType === 'writing'"
                  data-testid="cw-add-type-writing"
                  @click="addType = 'writing'"
                >
                  {{ t('k12.works.writing') }}
                </button>
                <button
                  type="button"
                  :class="{ on: addType === 'art' }"
                  :aria-pressed="addType === 'art'"
                  data-testid="cw-add-type-art"
                  @click="addType = 'art'"
                >
                  {{ t('k12.works.art') }}
                </button>
              </div>
            </label>
            <!-- 作品照片（20260718 布局定案：英雄字段置首）：hc-drop 同款拖放区，拖放或点击选择；
               选图即真实上传（POST /assets），预览缩略 + 真实进度 + 失败重试。 -->
            <div class="k12cw-modal__field">
              <span>{{ t('k12.works.photoLabel') }}</span>
              <input
                ref="photoInput"
                type="file"
                accept="image/*"
                class="k12cw__file"
                data-testid="cw-add-photo-input"
                @change="onPhotoPick"
              />
              <div
                v-if="!photoPreview"
                class="k12cw__drop"
                :class="{ 'k12cw__drop--over': photoDragOver }"
                role="button"
                tabindex="0"
                data-testid="cw-add-photo"
                @click="photoInput?.click()"
                @keydown.enter.prevent="onPhotoKey($event)"
                @keydown.space.prevent="photoInput?.click()"
                @dragover.prevent="photoDragOver = true"
                @dragleave="photoDragOver = false"
                @drop.prevent="onPhotoDrop"
              >
                <span class="k12cw__dropicon" aria-hidden="true">📷</span>
                <b>{{ t('k12.works.photoChoose') }}</b>
              </div>
              <div v-else class="k12cw__photoprev" data-testid="cw-photo-preview">
                <img :src="photoPreview" alt="" />
                <div class="k12cw__photostate">
                  <span v-if="photoUploading" data-testid="cw-photo-progress">
                    {{ t('k12.works.photoUploading') }} {{ photoPct }}%
                  </span>
                  <span
                    v-else-if="photoError"
                    class="k12cw__photoerr"
                    data-testid="cw-photo-error"
                    >{{ photoError }}</span
                  >
                  <span v-else-if="photoAssetId" data-testid="cw-photo-ok">{{
                    t('k12.works.photoUploaded')
                  }}</span>
                  <button
                    v-if="photoError"
                    type="button"
                    class="k12cw__btn k12cw__btn--ghost"
                    data-testid="cw-photo-retry"
                    @click="uploadPhoto"
                  >
                    {{ t('k12.works.photoRetry') }}
                  </button>
                  <button
                    type="button"
                    class="k12cw__btn k12cw__btn--ghost"
                    data-testid="cw-photo-remove"
                    @click="resetPhoto()"
                  >
                    {{ t('k12.works.photoRemove') }}
                  </button>
                </div>
              </div>
              <p class="k12cw__ainote">{{ t('k12.works.photoHint') }}</p>
              <div
                v-if="addType === 'writing' && photoPreview"
                class="k12cw__ocr"
                aria-live="polite"
                data-testid="cw-ocr-state"
              >
                <p v-if="photoOCRBusy" class="k12cw__ainote" data-testid="cw-ocr-processing">
                  {{ t('k12.works.ocrProcessing') }}
                </p>
                <div
                  v-else-if="photoOCRRequestError || photoOCRJob?.status === 'failed'"
                  class="k12cw__inlineerr"
                  data-testid="cw-ocr-error"
                >
                  <p>
                    {{
                      photoOCRRequestError || photoOCRJob?.error_message || t('k12.works.ocrFailed')
                    }}
                  </p>
                  <div class="k12cw__linkbtns">
                    <button
                      type="button"
                      class="k12cw__btn k12cw__btn--ghost"
                      data-testid="cw-ocr-retry"
                      @click="retryPhotoOCR"
                    >
                      {{ t('k12.works.ocrRetry') }}
                    </button>
                  </div>
                  <p class="k12cw__ainote">{{ t('k12.works.ocrManualHint') }}</p>
                </div>
                <p
                  v-else-if="photoOCRConfirmed"
                  class="k12cw__ainote k12cw__ocrok"
                  data-testid="cw-ocr-confirmed"
                >
                  {{ t('k12.works.ocrConfirmed') }}
                </p>
                <p
                  v-else-if="
                    photoOCRJob?.status === 'awaiting_confirmation' ||
                    photoOCRJob?.status === 'confirmed'
                  "
                  class="k12cw__ainote"
                  data-testid="cw-ocr-awaiting"
                >
                  {{ t('k12.works.ocrAwaiting') }}
                </p>
              </div>
            </div>
            <div class="k12cw-modal__row">
              <label class="k12cw-modal__field">
                <span>{{ t('k12.works.nameLabel') }}</span>
                <HcClearableField>
                  <input
                    v-model="addTitle"
                    class="k12cw__input"
                    :placeholder="t('k12.works.namePlaceholder')"
                    data-testid="cw-add-title"
                  />
                </HcClearableField>
              </label>
              <label class="k12cw-modal__field">
                <span>{{
                  addType === 'writing'
                    ? t('k12.works.taskLabelWriting')
                    : t('k12.works.taskLabelArt')
                }}</span>
                <HcClearableField>
                  <input
                    v-model="addTask"
                    class="k12cw__input"
                    :placeholder="t('k12.works.taskPlaceholder')"
                    data-testid="cw-add-task"
                  />
                </HcClearableField>
              </label>
            </div>
            <label v-if="addType === 'writing'" class="k12cw-modal__field">
              <span>{{ t('k12.works.draftLabel') }}</span>
              <HcClearableField>
                <textarea
                  v-model="addDraft"
                  class="k12cw__input"
                  rows="4"
                  :placeholder="t('k12.works.draftPlaceholder')"
                  data-testid="cw-add-draft"
                ></textarea>
              </HcClearableField>
              <button
                v-if="photoPreview && photoOCRJob && !photoOCRConfirmed"
                type="button"
                class="k12cw__btn k12cw__btn--ghost"
                :disabled="photoOCRBusy || !addDraft.trim()"
                data-testid="cw-ocr-confirm"
                @click="confirmPhotoOCR"
              >
                {{ t('k12.works.ocrConfirm') }}
              </button>
            </label>
            <label v-else class="k12cw-modal__field">
              <span>{{ t('k12.works.intentLabel') }}</span>
              <HcClearableField>
                <textarea
                  v-model="addIntent"
                  class="k12cw__input"
                  rows="3"
                  :placeholder="t('k12.works.intentPlaceholder')"
                  data-testid="cw-add-intent"
                ></textarea>
              </HcClearableField>
            </label>
          </div>
          <div class="k12cw-modal__foot">
            <button class="k12cw__btn k12cw__btn--ghost" @click="closeAdd">
              {{ t('k12.works.cancel') }}
            </button>
            <button
              class="k12cw__btn k12cw__btn--primary"
              :disabled="!addValid || addBusy"
              data-testid="cw-add-submit"
              @click="submitAdd"
            >
              {{ t('k12.works.save') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.k12cw__desc {
  flex: 1;
  color: var(--hc-text-muted);
  font-size: 12px;
  line-height: 1.6;
}
.k12cw__overview {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.k12cw__overview > .k12cw__btn {
  order: 3;
  flex-shrink: 0;
}
.k12cw__kpis {
  display: flex;
  gap: 7px;
  margin-left: auto;
  flex-shrink: 0;
}
.k12cw__kpi {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  white-space: nowrap;
  border: 0.5px solid var(--hc-border);
  border-radius: 10px;
  background: var(--hc-bg-card);
  padding: 7px 12px;
  font-size: 11px;
  color: var(--hc-text-muted);
}
.k12cw__kpi b {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--hc-text-primary);
  font-variant-numeric: tabular-nums;
}
.k12cw__rules {
  position: relative;
  border: 0.5px solid var(--hc-border);
  border-radius: 12px;
  background: var(--hc-bg-card);
  padding: 11px 13px 11px 17px;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--hc-text-secondary);
  margin-bottom: 12px;
}
.k12cw__rules::before {
  content: '';
  position: absolute;
  left: 0;
  top: 11px;
  bottom: 11px;
  width: 3px;
  border-radius: 2px;
  background: var(--hc-accent);
}
.k12cw__rules b {
  display: block;
  color: var(--hc-text-primary);
  margin-bottom: 2px;
}
.k12cw__ainote {
  margin: 0;
  font-size: 10.5px;
  color: var(--hc-text-muted);
  line-height: 1.5;
}
.k12cw__linkbtns {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
}
.k12cw__linkbtns .k12cw__btn--ghost {
  border-color: var(--hc-border);
}
.k12cw__seg {
  display: flex;
  gap: 4px;
}
.k12cw__seg button {
  flex: 1;
  font: inherit;
  font-size: 12px;
  padding: 7px 0;
  border-radius: var(--hc-radius-md);
  border: 0.5px solid var(--hc-border);
  background: var(--hc-bg-input);
  color: var(--hc-text-secondary);
  cursor: pointer;
}
.k12cw__seg button.on {
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  font-weight: 650;
  border-color: var(--hc-accent);
}
/* hc-drop 同款拖放区（20260718 控件统一，原型 creativeWorkDropzone）：
   虚线待选 → hover/dragover 描边转 accent；drop 与点击共用上传管线。 */
.k12cw__drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 16px 12px;
  text-align: center;
  width: 100%;
  box-sizing: border-box;
  border: 1px dashed var(--hc-border);
  border-radius: 12px;
  background: var(--hc-bg-input);
  color: var(--hc-text-muted);
  cursor: pointer;
}
.k12cw__drop b {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--hc-text-primary);
}
.k12cw__drop:hover {
  border-color: var(--hc-accent);
}
.k12cw__drop--over {
  border-style: solid;
  border-color: color-mix(in srgb, var(--hc-accent) 45%, transparent);
  background: var(--hc-accent-subtle);
}
.k12cw__dropicon {
  font-size: 24px;
  line-height: 1;
}
.k12cw__file {
  display: none;
}
.k12cw__photoprev {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.k12cw__photoprev img {
  width: 92px;
  height: 92px;
  object-fit: cover;
  border-radius: var(--hc-radius-md);
  border: 0.5px solid var(--hc-border);
  flex-shrink: 0;
}
.k12cw__photostate {
  display: grid;
  gap: 6px;
  font-size: 11.5px;
  color: var(--hc-text-secondary);
  justify-items: start;
}
.k12cw__photoerr {
  color: var(--hc-error);
}
.k12cw__thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  cursor: zoom-in;
}
.k12cw__thumb:focus-visible {
  outline: 2px solid var(--hc-accent);
  outline-offset: -3px;
}
.k12cw-image-preview {
  position: fixed;
  top: var(--hc-titlebar-height);
  right: 0;
  bottom: 0;
  left: 0;
  z-index: var(--hc-z-modal);
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(8, 18, 32, 0.58);
  backdrop-filter: blur(4px) saturate(120%);
  -webkit-backdrop-filter: blur(4px) saturate(120%);
}
.k12cw-image-preview > img {
  max-width: min(920px, calc(100vw - 48px));
  max-height: calc(100vh - var(--hc-titlebar-height) - 48px);
  object-fit: contain;
  border-radius: 14px;
  box-shadow: var(--hc-shadow-float);
}
.k12cw-image-preview__close {
  position: absolute;
  top: 18px;
  right: 18px;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.92);
  color: var(--hc-text-primary);
  cursor: pointer;
}
.k12cw-detail-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--hc-z-modal);
  display: none;
  align-items: flex-start;
  justify-content: center;
  box-sizing: border-box;
  padding: 11vh 12px 12px;
  overflow-y: auto;
  background: rgba(8, 18, 32, 0.4);
  backdrop-filter: blur(3px) saturate(120%);
  -webkit-backdrop-filter: blur(3px) saturate(120%);
}
.k12cw-detail-overlay.is-open {
  display: flex;
  animation: k12cw-fade 0.2s var(--hc-ease-out);
}
.k12cw-detail-modal {
  width: 478px;
  max-width: 92vw;
  overflow: hidden;
  background: var(--hc-bg-elevated);
  border: 0.5px solid var(--hc-border);
  border-radius: 16px;
  box-shadow: var(--hc-shadow-float);
  outline: none;
  animation: k12cw-pop 0.32s var(--hc-ease-out);
}
.k12cw-detail-modal__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 18px;
  border-bottom: 0.5px solid var(--hc-border);
}
.k12cw-detail-modal__head b {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
  font-weight: 600;
}
.k12cw-detail-modal__x {
  display: grid;
  place-items: center;
  flex: none;
  width: 28px;
  height: 28px;
  margin-left: auto;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
}
.k12cw-detail-modal__x:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}
.k12cw-detail-modal__body {
  max-height: 62vh;
  overflow: auto;
  padding: 18px;
}
.k12cw-detail-modal__foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 18px;
  border-top: 0.5px solid var(--hc-border);
}
@keyframes k12cw-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes k12cw-pop {
  from {
    opacity: 0;
    transform: scale(0.96) translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.k12cw-overlay {
  /* modal 层（9100）令牌，与 K12BackupModal 一致；须低于 popover（BUG-20260708） */
  position: fixed;
  inset: 0;
  z-index: var(--hc-z-modal);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  box-sizing: border-box;
  padding: 11vh 12px 12px;
  overflow-y: auto;
  background: rgba(8, 18, 32, 0.4);
  backdrop-filter: blur(3px) saturate(120%);
  -webkit-backdrop-filter: blur(3px) saturate(120%);
}
.k12cw-modal {
  width: 478px;
  max-width: 92vw;
  max-height: min(720px, calc(100vh - 24px));
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  background: var(--hc-bg-elevated);
  border: 0.5px solid var(--hc-border);
  border-radius: 16px;
  box-shadow: var(--hc-shadow-float);
}
.k12cw-modal__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 18px;
  border-bottom: 0.5px solid var(--hc-border);
  font-size: 15px;
  color: var(--hc-text-primary);
}
.k12cw-modal__x {
  margin-left: auto;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
}
.k12cw-modal__x:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}
.k12cw-modal__body {
  width: 100%;
  min-height: 0;
  min-width: 0;
  box-sizing: border-box;
  padding: 18px;
  display: grid;
  gap: 13px;
  overflow: auto;
}
.k12cw-modal__row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  min-width: 0;
}
.k12cw-modal__field {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.k12cw-modal__field > span {
  font-size: 12.5px;
  color: var(--hc-text-primary);
}
.k12cw-modal__foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 18px;
  border-top: 0.5px solid var(--hc-border);
}
.k12cw__filter {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  margin-bottom: 12px;
  padding: 12px 14px;
  border: 0.5px solid var(--hc-border);
  border-radius: 14px;
  background: var(--hc-bg-card);
}
.k12cw__filter-label {
  width: 38px;
  flex: none;
  font-size: 10.5px;
  font-weight: 700;
  color: var(--hc-text-muted);
}
.k12cw__filter button {
  font: inherit;
  font-size: 12px;
  border: 0.5px solid var(--hc-border);
  background: var(--hc-bg-input);
  color: var(--hc-text-secondary);
  padding: 5px 8px;
  border-radius: 9px;
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.15s;
}
.k12cw__filter button:hover {
  border-color: var(--hc-border-hl);
}
.k12cw__filter button.on {
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  font-weight: 600;
  border-color: color-mix(in srgb, var(--hc-accent) 35%, var(--hc-border));
}
.k12cw__err {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--hc-error);
  font-size: 13px;
  padding: 10px 0;
}
.k12cw__inlineerr {
  margin: 0;
  color: var(--hc-error);
  font-size: 11.5px;
  line-height: 1.5;
}
.k12cw__revision-photo {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}
.k12cw__revision-photo > label {
  cursor: pointer;
}
.k12cw__revision-thumb {
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: var(--hc-radius-md);
  border: 0.5px solid var(--hc-border);
}
.k12cw__ocr {
  display: grid;
  gap: 6px;
  padding: 8px 10px;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input);
}
.k12cw__ocr p {
  margin: 0;
}
.k12cw__ocrok {
  color: var(--hc-success);
}
.k12cw__revision-ocr {
  flex: 1 0 100%;
}
.k12cw__empty,
.k12cw__loading {
  border: 0.5px solid var(--hc-border);
  border-radius: 12px;
  background: var(--hc-bg-card);
  color: var(--hc-text-secondary);
  font-size: 12.5px;
  padding: 11px 13px;
  line-height: 1.55;
}
.k12cw__empty b {
  color: var(--hc-text-primary);
}
.k12cw__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  align-items: start;
}
.k12cw__card {
  display: grid;
  grid-template-columns: 112px minmax(0, 1fr);
  gap: 13px;
  align-items: start;
  border: 0.5px solid var(--hc-border);
  border-radius: 16px;
  background: var(--hc-bg-card);
  box-shadow: var(--hc-shadow-sm);
  padding: 14px;
  transition:
    box-shadow 0.2s,
    transform 0.15s,
    border-color 0.15s;
}
.k12cw__card:hover {
  transform: translateY(-1px);
  box-shadow: var(--hc-shadow-md);
  border-color: var(--hc-border-hl);
}
.k12cw__preview {
  height: 112px;
  min-height: 112px;
  border-radius: 12px;
  overflow: hidden;
  position: relative;
  background: linear-gradient(180deg, #a9c9e6 0 54%, #8fbb7d 54% 76%, #729a63 76%);
}
.k12cw__preview--writing {
  background: linear-gradient(135deg, #fffdf7, #f4ead5);
  border: 1px solid color-mix(in srgb, #b88945 22%, var(--hc-border));
}
.k12cw__preview-placeholder {
  position: absolute;
  inset: 0;
}
.k12cw__preview--writing .k12cw__preview-placeholder::before {
  content: '春天的校园\A\A柳枝像绿色的丝带……';
  white-space: pre-wrap;
  position: absolute;
  inset: 13px;
  color: #685b48;
  font-family: ui-serif, STSong, serif;
  font-size: 10px;
  line-height: 1.7;
  background: repeating-linear-gradient(transparent 0 16px, rgba(104, 91, 72, 0.13) 16px 17px);
}
.k12cw__preview--art .k12cw__preview-placeholder::before {
  content: '';
  position: absolute;
  top: 12px;
  left: 16px;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: #f6e08b;
  box-shadow: 0 0 0 6px rgba(246, 224, 139, 0.35);
}
.k12cw__copy {
  min-width: 0;
}
.k12cw__head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.k12cw__kind {
  font-size: 10.5px;
  font-weight: 650;
  color: var(--hc-accent);
  background: var(--hc-accent-subtle);
  border-radius: 4px;
  padding: 2px 7px;
  white-space: nowrap;
}
.k12cw__kind--writing {
  background: color-mix(in srgb, #e8590c 12%, transparent);
  color: #e8590c;
}
.k12cw__kind--art {
  background: color-mix(in srgb, #c2255c 10%, transparent);
  color: #c2255c;
}
.k12cw__title {
  font-size: 13.5px;
  color: var(--hc-text-primary);
  margin: 1px 0 5px;
}
.k12cw__pill {
  font-size: 10.5px;
  font-weight: 700;
  border-radius: 999px;
  padding: 2px 9px;
}
.k12cw__pill--todo {
  color: var(--hc-error);
  background: color-mix(in srgb, var(--hc-error) 10%, transparent);
}
.k12cw__pill--got {
  color: var(--hc-success);
  background: color-mix(in srgb, var(--hc-success) 10%, transparent);
}
.k12cw__pill--done {
  color: var(--hc-warning);
  background: color-mix(in srgb, var(--hc-warning) 12%, transparent);
}
.k12cw__pill--muted {
  color: var(--hc-text-muted);
  background: var(--hc-bg-input);
}
.k12cw__vers {
  color: var(--hc-text-muted);
  font-size: 11px;
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
.k12cw__task {
  display: none;
}
.k12cw__evidence {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  margin: 7px 0;
}
.k12cw__evidence span {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--hc-bg-input);
  color: var(--hc-text-secondary);
}
.k12cw__summary {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  margin: 6px 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--hc-text-muted);
}
.k12cw__detail-toggle {
  border: none;
  background: transparent;
  padding: 6px 0;
  border-radius: 8px;
  color: var(--hc-text-primary);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.k12cw__card[data-review-state='pending'] .k12cw__detail-toggle {
  background: var(--hc-bg-card);
  border: 0.5px solid var(--hc-border);
  padding: 6px 12px;
  box-shadow: var(--hc-shadow-sm);
}
.k12cw__details {
  min-width: 0;
}
.k12cw__versions {
  list-style: none;
  margin: 0 0 10px;
  padding: 0;
  display: grid;
  gap: 7px;
}
.k12cw__ver {
  display: flex;
  gap: 9px;
  padding: 9px 11px;
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input);
}
.k12cw__vid {
  font-size: 10.5px;
  font-weight: 800;
  color: var(--hc-accent);
  flex-shrink: 0;
}
.k12cw__vbody {
  min-width: 0;
}
.k12cw__vcontent {
  font-size: 11.5px;
  color: var(--hc-text-primary);
  line-height: 1.6;
  margin: 0;
}
.k12cw__vfeedback {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px;
  font-size: 11px;
  color: var(--hc-text-secondary);
  line-height: 1.6;
  margin: 5px 0 0;
}
.k12cw__provenance {
  grid-column: 2;
  color: var(--hc-text-muted);
}
.k12cw__vcontent :deep(p),
.k12cw__vfeedback :deep(p) {
  margin: 0;
}
.k12cw__feedback-facts {
  display: grid;
  gap: 5px;
  min-width: 0;
}
.k12cw__feedback-list {
  display: grid;
  gap: 4px;
  margin: 0;
  padding-inline-start: 18px;
}
.k12cw__feedback-list li {
  min-width: 0;
}
.k12cw__feedback-dimension {
  display: inline-flex;
  margin-inline-end: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  color: var(--hc-primary);
  background: color-mix(in srgb, var(--hc-primary) 10%, transparent);
}
.k12cw__feedback-limit {
  color: var(--hc-text-muted);
}
.k12cw__act {
  display: grid;
  gap: 7px;
  margin-bottom: 8px;
}
.k12cw__input {
  display: block;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  font: inherit;
  font-size: 12px;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
  padding: 8px 11px;
  resize: vertical;
  outline: none;
}
.k12cw__input:focus {
  border-color: var(--hc-accent);
}
.k12cw__btn {
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  border-radius: var(--hc-radius-md);
  padding: 6px 13px;
  border: 0.5px solid var(--hc-border);
  background: var(--hc-bg-card);
  color: var(--hc-text-primary);
  cursor: pointer;
  justify-self: end;
  transition:
    background 0.15s,
    opacity 0.15s,
    filter 0.15s;
}
.k12cw__btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.k12cw__btn--primary {
  background: linear-gradient(180deg, #5fb3ea 0%, #4a9de0 100%);
  color: #fff;
  border-color: transparent;
}
.k12cw__btn--primary:hover:not(:disabled) {
  filter: brightness(1.04);
}
.k12cw__btn--ghost {
  background: transparent;
  border-color: transparent;
  color: var(--hc-text-secondary);
}
.k12cw__btn--ghost:hover:not(:disabled) {
  background: var(--hc-bg-hover);
}
@media (max-width: 860px) {
  .k12cw__overview {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .k12cw__kpis {
    margin-left: 0;
  }
  .k12cw__list {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 560px) {
  .k12cw-modal__row {
    grid-template-columns: minmax(0, 1fr);
  }
  .k12cw__card {
    grid-template-columns: 88px minmax(0, 1fr);
  }
  .k12cw__kpis {
    width: 100%;
    overflow-x: auto;
  }
}
</style>
