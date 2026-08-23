<!--
  K12 独立作品面板（PRD §3.10 / DD-040 / DD-042）。
  每次保存都是一件新作品；初始点评由服务端 durable generation 自动完成。
  当前 UI 不投影 legacy 版本、修改稿、归档、手写点评或观察练习卡。
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  k12CancelImageTask,
  k12ConfirmImageTask,
  k12CreateCreativeWork,
  k12CreateImageTask,
  k12DeleteCreativeWork,
  k12GenerateWorkFeedback,
  k12GetImageTask,
  k12ListCreativeWorks,
  k12RetryImageTask,
  k12SendCreativeWork,
  k12UploadAsset,
  type CreativeWorkDTO,
  type ImageTaskCreativeProjectionDTO,
  type ImageTaskDispatchDTO,
  type WorkFeedbackDTO,
  type WorkType,
} from '@/api/k12'
import { k12GetAssetBlob } from '@/api/k12-asset-url'
import { setClipboard } from '@/api/desktop'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import CreativeWorkFeedbackRenderer from '../components/CreativeWorkFeedbackRenderer.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import { useToast } from '@/composables/useToast'
import { exportArchiveDocument } from '../export'
import { useK12DeliveryBatch } from '../useK12DeliveryBatch'

const props = withDefaults(defineProps<{ agentId: string; showAddButton?: boolean }>(), {
  showAddButton: true,
})
const emit = defineEmits<{
  (event: 'count', count: number): void
}>()

const { t, locale } = useI18n()
const toast = useToast()

function newCommandID(prefix: string): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
}

// ── List / status projection ─────────────────────────────────
const works = ref<CreativeWorkDTO[]>([])
const loading = ref(false)
const loadError = ref('')
const typeFilter = ref<'' | WorkType>('')
let loadGeneration = 0
const pendingReviewPollIntervalMS = 1_500
let pendingReviewTimer: number | null = null

const filtered = computed(() =>
  typeFilter.value
    ? works.value.filter((work) => work.work_type === typeFilter.value)
    : works.value,
)

watch(
  () => works.value.length,
  (count) => emit('count', count),
  { immediate: true },
)

type ReviewState = 'pending' | 'reviewed' | 'failed'
const initialRetryingID = ref('')

function latestFeedbackGeneration(work: CreativeWorkDTO) {
  const generation = work.latest_feedback
  if (generation?.status === 'succeeded' && generation.feedback) return generation
  if (work.initial_feedback.status === 'succeeded' && work.initial_feedback.feedback) {
    return work.initial_feedback
  }
  return undefined
}

function latestFeedback(work: CreativeWorkDTO): WorkFeedbackDTO | undefined {
  return latestFeedbackGeneration(work)?.feedback
}

function reviewState(work: CreativeWorkDTO): ReviewState {
  if (initialRetryingID.value === work.work_id) return 'pending'
  if (latestFeedback(work)) return 'reviewed'
  return work.initial_feedback.status === 'failed' ? 'failed' : 'pending'
}

const kpiTotal = computed(() => works.value.length)
const kpiReviewed = computed(
  () => works.value.filter((work) => reviewState(work) === 'reviewed').length,
)
const kpiPending = computed(() => kpiTotal.value - kpiReviewed.value)

function reviewStatusLabel(work: CreativeWorkDTO): string {
  if (reviewState(work) === 'reviewed') return t('k12.works.reviewed')
  if (reviewState(work) === 'failed') return t('k12.works.reviewFailed')
  return t('k12.works.reviewing')
}

function reviewCTA(work: CreativeWorkDTO): string {
  if (reviewState(work) === 'reviewed') return t('k12.works.viewFeedback')
  if (reviewState(work) === 'failed') return t('k12.works.initialReviewFailedCTA')
  return t('k12.works.initialReviewPendingCTA')
}

function workKindLabel(work: CreativeWorkDTO): string {
  return (
    work.display_kind?.trim() ||
    (work.work_type === 'writing' ? t('k12.works.writingKind') : t('k12.works.artKind'))
  )
}

function workPreviewVariant(work: CreativeWorkDTO): string {
  return work.preview_variant ?? (work.work_type === 'writing' ? 'writing' : 'default')
}

function cardEvidence(work: CreativeWorkDTO): string[] {
  const projected = work.display_evidence?.filter(Boolean).slice(0, 3) ?? []
  if (projected.length > 0) return projected
  const feedback = latestFeedback(work)
  const visible = feedback?.visible_evidence?.filter(Boolean).slice(0, 3) ?? []
  if (visible.length > 0) return visible
  return work.work_type === 'writing' ? [t('k12.works.contentSaved')] : [t('k12.works.imageSaved')]
}

function cardSummary(work: CreativeWorkDTO): string {
  if (reviewState(work) === 'reviewed') return t('k12.works.latestFeedbackSaved')
  if (reviewState(work) === 'failed') return t('k12.works.initialReviewFailed')
  return t('k12.works.initialReviewPending')
}

function cardTime(work: CreativeWorkDTO): {
  unixSeconds: number
  iso: string
  label: string
  source: 'latest_generation_at' | 'created_at'
} | null {
  const reviewed = reviewState(work) === 'reviewed'
  const source = reviewed ? 'latest_generation_at' : 'created_at'
  const unixSeconds = reviewed ? work.latest_generation_at : work.created_at
  if (!Number.isFinite(unixSeconds) || Number(unixSeconds) <= 0) return null
  const date = new Date(Number(unixSeconds) * 1000)
  if (!Number.isFinite(date.getTime())) return null
  return {
    unixSeconds: Number(unixSeconds),
    iso: date.toISOString(),
    label: new Intl.DateTimeFormat(locale.value, {
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date),
    source,
  }
}

// ── 缩略图：经认证客户端拉取资产转 blob URL ─────────────────
// `<img src>` 直连 /_hexclaw 资产路径没有 Bearer/IPC 通道（桌面 WebView
// 无该 HTTP 服务、dev 代理无 token），故复用 k12GetAssetBlob 走 api 客户端。
const thumbURLs = reactive(new Map<string, string>())
const thumbAborters = new Map<string, AbortController>()

function releaseThumb(workID: string) {
  thumbAborters.get(workID)?.abort()
  thumbAborters.delete(workID)
  const url = thumbURLs.get(workID)
  if (url) URL.revokeObjectURL(url)
  thumbURLs.delete(workID)
}

async function loadThumb(work: CreativeWorkDTO) {
  const assetID = work.source_asset_id?.trim() ?? ''
  if (!assetID.startsWith('asset://')) return
  if (thumbURLs.has(work.work_id) || thumbAborters.has(work.work_id)) return
  const controller = new AbortController()
  thumbAborters.set(work.work_id, controller)
  const blob = await k12GetAssetBlob(props.agentId, assetID, controller.signal)
  if (!controller.signal.aborted && blob) {
    thumbURLs.set(work.work_id, URL.createObjectURL(blob))
  }
  thumbAborters.delete(work.work_id)
}

watch(
  () => works.value.map((work) => work.work_id).join('\u0000'),
  (next, previous) => {
    const removed = previous ? previous.split('\u0000').filter((id) => !next.includes(id)) : []
    for (const id of removed) releaseThumb(id)
    for (const work of works.value) void loadThumb(work)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  for (const workID of thumbURLs.keys()) releaseThumb(workID)
})

function workThumbURL(work: CreativeWorkDTO): string {
  return thumbURLs.get(work.work_id) ?? ''
}

function stopPendingReviewPoll() {
  if (pendingReviewTimer !== null) window.clearTimeout(pendingReviewTimer)
  pendingReviewTimer = null
}

function schedulePendingReviewPoll() {
  stopPendingReviewPoll()
  if (!works.value.some((work) => ['queued', 'running'].includes(work.initial_feedback.status))) {
    return
  }
  const agent = props.agentId.trim()
  pendingReviewTimer = window.setTimeout(() => {
    pendingReviewTimer = null
    if (agent !== props.agentId.trim()) return
    void loadWorks(true)
  }, pendingReviewPollIntervalMS)
}

async function loadWorks(background: boolean) {
  const agent = props.agentId.trim()
  if (!agent) return
  stopPendingReviewPoll()
  const generation = ++loadGeneration
  if (!background) {
    loading.value = true
    loadError.value = ''
  }
  try {
    const response = await k12ListCreativeWorks(agent)
    if (generation !== loadGeneration || agent !== props.agentId.trim()) return
    works.value = response.items ?? []
    schedulePendingReviewPoll()
  } catch (error) {
    if (generation !== loadGeneration || agent !== props.agentId.trim()) return
    if (!background) loadError.value = (error as Error).message || t('k12.works.loadError')
  } finally {
    if (!background && generation === loadGeneration) loading.value = false
  }
}

async function load() {
  await loadWorks(false)
}

function replaceWork(updated: CreativeWorkDTO) {
  const index = works.value.findIndex((work) => work.work_id === updated.work_id)
  if (index >= 0) works.value.splice(index, 1, updated)
}

// ── Detail / image preview ───────────────────────────────────
const expandedID = ref('')
const detailDialog = ref<HTMLElement | null>(null)
const detailBody = ref<HTMLElement | null>(null)
let detailOpener: HTMLElement | null = null
const activeWork = computed(
  () => works.value.find((work) => work.work_id === expandedID.value) ?? null,
)

const previewImageSrc = ref('')
const previewImageAlt = ref('')
const previewDialog = ref<HTMLElement | null>(null)
let previewOpener: HTMLElement | null = null

const delivery = useK12DeliveryBatch({
  agent: () => props.agentId,
  idleLabel: t('k12.works.sendPhone'),
})

function openDetails(work: CreativeWorkDTO, event?: Event) {
  const trigger = event?.currentTarget
  detailOpener = trigger instanceof HTMLElement ? trigger : null
  delivery.reset()
  expandedID.value = work.work_id
  if (work.delivery_batch_id) void delivery.restore(work.delivery_batch_id)
  void nextTick(() => detailDialog.value?.focus())
}

function closeDetails(restoreFocus = true) {
  if (!expandedID.value) return
  expandedID.value = ''
  delivery.reset()
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

function trapDetailFocus(event: KeyboardEvent) {
  const dialog = detailDialog.value
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

function feedbackMarkdown(work: CreativeWorkDTO): string {
  return latestFeedback(work)?.projection_markdown?.trim() ?? ''
}

function workDocumentMarkdown(work: CreativeWorkDTO): string {
  const lines = [`# ${work.display_name}`]
  const imageURL = workThumbURL(work)
  if (imageURL) lines.push('', `![${work.display_name}](${imageURL})`)
  if (work.work_type === 'writing' && work.content_markdown?.trim()) {
    lines.push('', `## ${t('k12.works.contentLabel')}`, '', work.content_markdown.trim())
  }
  lines.push('', `## ${t('k12.works.latestFeedback')}`, '', feedbackMarkdown(work))
  return lines.join('\n').trim()
}

const copiedWorkID = ref('')
let copiedResetTimer: ReturnType<typeof setTimeout> | null = null

async function copyWork(work: CreativeWorkDTO) {
  const feedback = feedbackMarkdown(work)
  const content =
    work.work_type === 'writing'
      ? [work.content_markdown?.trim() ?? '', feedback].filter(Boolean).join('\n\n')
      : feedback
  if (!content) return
  try {
    await setClipboard(content)
    copiedWorkID.value = work.work_id
    if (copiedResetTimer) clearTimeout(copiedResetTimer)
    copiedResetTimer = setTimeout(() => {
      if (copiedWorkID.value === work.work_id) copiedWorkID.value = ''
    }, 1_500)
    toast.success(
      work.work_type === 'writing'
        ? t('k12.works.copiedWorkFeedback')
        : t('k12.works.copiedFeedback'),
    )
  } catch {
    toast.error(t('k12.works.copyFailed'))
  }
}

async function sendWork(work: CreativeWorkDTO) {
  await delivery.send(() => k12SendCreativeWork(props.agentId, work.work_id))
}

function safePDFName(name: string): string {
  return `${name.replace(/[\\/:*?"<>|]/g, '_').trim() || t('k12.works.title')}.pdf`
}

async function exportWorkPDF(work: CreativeWorkDTO) {
  try {
    await exportArchiveDocument({
      content: workDocumentMarkdown(work),
      format: 'pdf',
      title: `${work.display_name} · ${t('k12.works.latestFeedback')}`,
      filename: safePDFName(work.display_name),
    })
  } catch {
    toast.error(t('k12.works.exportFailed'))
  }
}

// ── Initial retry / later regeneration ───────────────────────
const feedbackRegeneratingID = ref('')
const feedbackRegenerateError = ref<Record<string, string>>({})
const regenerateCommands = new Map<string, string>()
let feedbackGeneration = 0
let feedbackAbort: AbortController | null = null

async function retryInitialFeedback(work: CreativeWorkDTO) {
  if (initialRetryingID.value || reviewState(work) !== 'failed') return
  const agent = props.agentId
  const generation = ++feedbackGeneration
  const controller = new AbortController()
  feedbackAbort?.abort()
  feedbackAbort = controller
  initialRetryingID.value = work.work_id
  try {
    const updated = await k12GenerateWorkFeedback(
      agent,
      work.work_id,
      work.initial_feedback.generation_id,
      controller.signal,
    )
    if (generation !== feedbackGeneration || agent !== props.agentId) return
    replaceWork(updated)
  } catch (error) {
    if (
      generation !== feedbackGeneration ||
      agent !== props.agentId ||
      (error as Error).name === 'AbortError'
    )
      return
    // Same work and generation stay visible; a later click reuses the same generation ID.
  } finally {
    if (generation === feedbackGeneration) {
      initialRetryingID.value = ''
      if (feedbackAbort === controller) feedbackAbort = null
    }
  }
}

async function regenerateFeedback(work: CreativeWorkDTO) {
  if (feedbackRegeneratingID.value || reviewState(work) !== 'reviewed') return
  const agent = props.agentId
  const generation = ++feedbackGeneration
  const controller = new AbortController()
  feedbackAbort?.abort()
  feedbackAbort = controller
  feedbackRegeneratingID.value = work.work_id
  feedbackRegenerateError.value[work.work_id] = ''
  const commandID =
    regenerateCommands.get(work.work_id) ?? newCommandID(`regenerate-${work.work_id}`)
  regenerateCommands.set(work.work_id, commandID)
  try {
    const updated = await k12GenerateWorkFeedback(agent, work.work_id, commandID, controller.signal)
    if (generation !== feedbackGeneration || agent !== props.agentId) return
    replaceWork(updated)
    regenerateCommands.delete(work.work_id)
    delivery.reset()
  } catch (error) {
    if (
      generation !== feedbackGeneration ||
      agent !== props.agentId ||
      (error as Error).name === 'AbortError'
    )
      return
    feedbackRegenerateError.value[work.work_id] = t('k12.works.feedbackRegenerateFailed')
  } finally {
    if (generation === feedbackGeneration) {
      feedbackRegeneratingID.value = ''
      if (feedbackAbort === controller) feedbackAbort = null
    }
  }
}

// ── Destructive delete ───────────────────────────────────────
const deleteTarget = ref<CreativeWorkDTO | null>(null)
const deleting = ref(false)
const deleteCommands = new Map<string, string>()
const deleteReturnState = ref<{ workID: string; scrollTop: number } | null>(null)
let deleteGeneration = 0

const detailDeleteConfirmActive = computed(
  () =>
    !!deleteTarget.value &&
    !!activeWork.value &&
    deleteTarget.value.work_id === activeWork.value.work_id,
)

const deleteMessage = computed(() => {
  const name = deleteTarget.value?.display_name ?? ''
  return t('k12.works.deleteMessage', { name })
})

function askDelete(work: CreativeWorkDTO) {
  if (deleting.value) return
  deleteReturnState.value = {
    workID: work.work_id,
    scrollTop: detailBody.value?.scrollTop ?? 0,
  }
  deleteTarget.value = work
}

function restoreDetailAfterDelete(workID: string) {
  const saved = deleteReturnState.value
  void nextTick(() => {
    if (!saved || saved.workID !== workID || expandedID.value !== workID || !activeWork.value) {
      if (deleteReturnState.value === saved) deleteReturnState.value = null
      return
    }
    if (detailBody.value) detailBody.value.scrollTop = saved.scrollTop
    detailDialog.value?.querySelector<HTMLElement>('[data-testid="cw-delete"]')?.focus()
    if (deleteReturnState.value === saved) deleteReturnState.value = null
  })
}

function cancelDelete() {
  if (deleting.value) return
  const workID = deleteTarget.value?.work_id ?? ''
  deleteTarget.value = null
  if (workID) restoreDetailAfterDelete(workID)
  else deleteReturnState.value = null
}

async function confirmDelete() {
  const work = deleteTarget.value
  if (!work || deleting.value) return
  const generation = ++deleteGeneration
  const agent = props.agentId
  deleting.value = true
  const commandID = deleteCommands.get(work.work_id) ?? newCommandID(`delete-${work.work_id}`)
  deleteCommands.set(work.work_id, commandID)
  try {
    await k12DeleteCreativeWork(props.agentId, work.work_id, work.row_version, commandID)
    if (generation !== deleteGeneration || agent !== props.agentId) return
    works.value = works.value.filter((item) => item.work_id !== work.work_id)
    deleteCommands.delete(work.work_id)
    deleteTarget.value = null
    deleteReturnState.value = null
    if (expandedID.value === work.work_id) closeDetails(false)
  } catch (error) {
    if (generation !== deleteGeneration || agent !== props.agentId) return
    deleteTarget.value = null
    restoreDetailAfterDelete(work.work_id)
    toast.error((error as Error).message || t('k12.works.deleteFailed'))
  } finally {
    if (generation === deleteGeneration) deleting.value = false
  }
}

// ── Add work + ImageTask intake ──────────────────────────────
const addOpen = ref(false)
const addType = ref<WorkType>('writing')
const addTitle = ref('')
const addDraft = ref('')
const addBusy = ref(false)
const addDialog = ref<HTMLElement | null>(null)
let addOpener: HTMLElement | null = null
let addCommandID = ''

const photoInput = ref<HTMLInputElement | null>(null)
const photoAssetID = ref('')
const photoPreview = ref('')
const photoPercent = ref(-1)
const photoError = ref('')
const photoDragOver = ref(false)
let photoFile: File | null = null
let photoGeneration = 0
let photoAbort: AbortController | null = null

type CreativePhotoJobStatus = 'processing' | 'awaiting_confirmation' | 'failed' | 'confirmed'

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
let photoOCRRequestID = ''
const manualCreativePollIntervalMS = 250
const manualCreativePollLimit = 960

function creativeProjection(
  dispatch: ImageTaskDispatchDTO | null | undefined,
): ImageTaskCreativeProjectionDTO | undefined {
  const projection = dispatch?.target_projection
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

function photoJobView(dispatch: ImageTaskDispatchDTO, sourceAssetID: string): CreativePhotoJobView {
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
    source_asset_id: sourceAssetID,
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
    // Closing/replacing an intake is best-effort; identity isolation prevents cross-use.
  })
}

function resetPhotoOCR(clearDraft = false, cancelTask = true) {
  photoOCRGeneration += 1
  const dispatch = photoImageTask.value
  photoImageTask.value = null
  photoOCRJob.value = null
  photoOCRBusy.value = false
  photoOCRRequestError.value = ''
  photoOCRRequestID = ''
  if (clearDraft) addDraft.value = ''
  if (cancelTask) cancelManualCreativeTask(dispatch)
}

function applyPhotoImageTask(dispatch: ImageTaskDispatchDTO, assetID: string) {
  photoImageTask.value = dispatch
  const job = photoJobView(dispatch, assetID)
  photoOCRJob.value = job
  photoOCRRequestError.value = ''
  if (job.status === 'awaiting_confirmation' && job.ocr_raw) {
    addDraft.value = job.ocr_raw
  } else if (job.status === 'confirmed' && job.confirmed_content) {
    addDraft.value = job.confirmed_content
  }
}

async function startPhotoOCR() {
  const assetID = photoAssetID.value
  if (!assetID) return
  if (!photoOCRRequestID) photoOCRRequestID = newCommandID('creative-intake')
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
      source_ref: photoOCRRequestID,
      source_asset_refs: [assetID],
      attempt_generation: 1,
      route_request: { selection_source: 'auto' },
      creative_entry: {
        kind: 'new_work',
        task_intent: selectedType === 'writing' ? 'writing' : 'artwork',
      },
    })
    if (
      generation !== photoOCRGeneration ||
      assetID !== photoAssetID.value ||
      selectedType !== addType.value
    )
      return
    await pollManualCreativeTask(
      response.dispatch,
      () =>
        generation === photoOCRGeneration &&
        assetID === photoAssetID.value &&
        selectedType === addType.value,
      (dispatch) => applyPhotoImageTask(dispatch, assetID),
    )
  } catch (error) {
    if (generation !== photoOCRGeneration) return
    photoOCRRequestError.value = (error as Error).message || t('k12.works.ocrFailed')
  } finally {
    if (generation === photoOCRGeneration) photoOCRBusy.value = false
  }
}

async function retryPhotoOCR() {
  const dispatch = photoImageTask.value
  if (!dispatch || photoOCRBusy.value) {
    if (!dispatch && photoAssetID.value) await startPhotoOCR()
    return
  }
  const assetID = photoAssetID.value
  const generation = ++photoOCRGeneration
  photoOCRBusy.value = true
  photoOCRRequestError.value = ''
  try {
    const response = await k12RetryImageTask(dispatch.dispatch_id, {
      agent: props.agentId,
      version: dispatch.version,
    })
    if (generation !== photoOCRGeneration || assetID !== photoAssetID.value) return
    await pollManualCreativeTask(
      response.dispatch,
      () => generation === photoOCRGeneration && assetID === photoAssetID.value,
      (updated) => applyPhotoImageTask(updated, assetID),
    )
  } catch (error) {
    if (generation !== photoOCRGeneration) return
    photoOCRRequestError.value = (error as Error).message || t('k12.works.ocrFailed')
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
    if (generation !== photoOCRGeneration || job.source_asset_id !== photoAssetID.value) return
    applyPhotoImageTask(response.dispatch, job.source_asset_id)
  } catch (error) {
    if (generation !== photoOCRGeneration) return
    photoOCRRequestError.value = (error as Error).message || t('k12.works.ocrConfirmFailed')
  } finally {
    if (generation === photoOCRGeneration) photoOCRBusy.value = false
  }
}

const photoUploading = computed(
  () => photoPercent.value >= 0 && photoPercent.value < 100 && !photoError.value,
)
const photoReady = computed(
  () =>
    !!photoAssetID.value &&
    !photoUploading.value &&
    !photoError.value &&
    creativeProjection(photoImageTask.value)?.status === 'ready',
)
const photoOCRConfirmed = computed(() => {
  const job = photoOCRJob.value
  return (
    !!job &&
    job.status === 'confirmed' &&
    job.source_asset_id === photoAssetID.value &&
    !!job.confirmed_version &&
    job.confirmed_content === addDraft.value.trim()
  )
})
const addValid = computed(() => {
  if (photoPreview.value && (!photoReady.value || photoError.value)) return false
  if (addType.value === 'art') return !!photoPreview.value && photoReady.value
  if (!photoPreview.value) return !!addDraft.value.trim()
  return !!addDraft.value.trim() && photoOCRConfirmed.value
})

function resetPhoto(cancelTask = true) {
  photoGeneration += 1
  photoAbort?.abort()
  photoAbort = null
  if (photoPreview.value) URL.revokeObjectURL(photoPreview.value)
  photoAssetID.value = ''
  photoPreview.value = ''
  photoPercent.value = -1
  photoError.value = ''
  photoFile = null
  resetPhotoOCR(false, cancelTask)
  if (photoInput.value) photoInput.value.value = ''
}

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
  photoOCRRequestID = newCommandID('creative-intake')
  photoFile = file
  photoAssetID.value = ''
  photoError.value = ''
  photoPreview.value = URL.createObjectURL(file)
  void uploadPhoto()
}

function onPhotoPick(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) acceptPhotoFile(file)
}

function onPhotoDrop(event: DragEvent) {
  photoDragOver.value = false
  const file = event.dataTransfer?.files?.[0]
  if (file) acceptPhotoFile(file)
}

function onPhotoKey(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  photoInput.value?.click()
}

async function uploadPhoto() {
  if (!photoFile) return
  const file = photoFile
  const generation = ++photoGeneration
  photoAbort?.abort()
  const controller = new AbortController()
  photoAbort = controller
  photoAssetID.value = ''
  photoError.value = ''
  photoPercent.value = 0
  try {
    const response = await k12UploadAsset(
      props.agentId,
      file,
      (progress) => {
        if (generation === photoGeneration) photoPercent.value = Math.min(progress, 99)
      },
      controller.signal,
    )
    if (generation !== photoGeneration) return
    photoAssetID.value = response.asset_id
    photoPercent.value = 100
    void startPhotoOCR()
  } catch (error) {
    if (generation !== photoGeneration || (error as Error).name === 'AbortError') return
    photoError.value = (error as Error).message || t('k12.works.photoFailed')
    photoPercent.value = -1
  } finally {
    if (generation === photoGeneration) photoAbort = null
  }
}

watch(addType, () => {
  if (addType.value === 'writing') addTitle.value = ''
  if (photoAssetID.value) {
    resetPhotoOCR(addType.value === 'writing')
    photoOCRRequestID = newCommandID('creative-intake')
    void startPhotoOCR()
  }
})

function openAdd() {
  closeDetails(false)
  const active = document.activeElement
  addOpener = active instanceof HTMLElement ? active : null
  addType.value = 'writing'
  addTitle.value = ''
  addDraft.value = ''
  addCommandID = newCommandID('create-writing')
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

async function submitAdd() {
  if (!addValid.value || addBusy.value) return
  addBusy.value = true
  try {
    if (photoPreview.value) {
      const dispatch = photoImageTask.value
      if (!dispatch || creativeProjection(dispatch)?.status !== 'ready') return
      const creative =
        addType.value === 'writing'
          ? {
              action: 'commit' as const,
              content_markdown: addDraft.value.trim() || undefined,
            }
          : {
              action: 'commit' as const,
              work_title: addTitle.value.trim() || undefined,
            }
      const response = await k12ConfirmImageTask(dispatch.dispatch_id, {
        agent: props.agentId,
        version: dispatch.version,
        creative,
      })
      photoImageTask.value = response.dispatch
      if (creativeProjection(response.dispatch)?.status !== 'promoted') {
        throw new Error(t('k12.works.saveFailed'))
      }
      photoImageTask.value = null
    } else {
      await k12CreateCreativeWork({
        agent: props.agentId,
        work_type: 'writing',
        content_markdown: addDraft.value.trim(),
        command_id: addCommandID,
      })
    }
    toast.success(t('k12.works.created'))
    closeAdd()
    await load()
  } catch (error) {
    toast.error((error as Error).message || t('k12.works.saveFailed'))
  } finally {
    addBusy.value = false
  }
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented) return
  // ConfirmDialog owns Escape while it is the sole visible modal. The detail is
  // intentionally still represented in state so cancel can restore it.
  if (deleteTarget.value) return
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
  if (!expandedID.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    closeDetails()
    return
  }
  trapDetailFocus(event)
}

function resetAgentState() {
  stopPendingReviewPoll()
  loadGeneration += 1
  feedbackGeneration += 1
  feedbackAbort?.abort()
  feedbackAbort = null
  initialRetryingID.value = ''
  feedbackRegeneratingID.value = ''
  feedbackRegenerateError.value = {}
  regenerateCommands.clear()
  deleteGeneration += 1
  deleting.value = false
  deleteTarget.value = null
  deleteReturnState.value = null
  closeDetails(false)
  closeImagePreview(false)
  closeAdd()
  resetPhoto()
}

onMounted(() => {
  document.addEventListener('keydown', handleDocumentKeydown)
  void load()
})

watch(
  () => props.agentId,
  () => {
    resetAgentState()
    void load()
  },
)

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleDocumentKeydown)
  stopPendingReviewPoll()
  resetAgentState()
  if (copiedResetTimer) clearTimeout(copiedResetTimer)
})

defineExpose({ load, openAdd })
</script>

<template>
  <section class="k12cw">
    <div class="k12cw__overview">
      <p class="k12cw__desc" :title="t('k12.works.desc')">{{ t('k12.works.desc') }}</p>
      <button
        v-if="showAddButton"
        type="button"
        class="hc-btn hc-btn-primary"
        data-testid="cw-add-open"
        @click="openAdd"
      >
        {{ t('k12.works.addWork') }}
      </button>
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
      <div class="k12cw__filter-row">
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
    </div>

    <div class="k12cw__rules" data-testid="cw-rules">
      <b>{{ t('k12.works.rulesTitle') }}</b>
      {{ t('k12.works.rulesBody') }}
    </div>

    <div v-if="loadError" class="k12cw__error" data-testid="cw-error">
      <span>{{ loadError }}</span>
      <button
        type="button"
        class="hc-btn hc-btn-ghost"
        data-testid="cw-load-retry"
        :disabled="loading"
        @click="load"
      >
        {{ t('k12.works.retry') }}
      </button>
    </div>
    <div
      v-else-if="loading"
      class="k12cw__loading"
      data-testid="cw-loading"
      role="status"
      aria-live="polite"
    >
      {{ t('k12.works.loading') }}
    </div>
    <div v-else-if="filtered.length === 0" class="k12cw__empty" data-testid="cw-empty">
      <b data-testid="cw-empty-title">
        {{ works.length === 0 ? t('k12.works.emptyTitle') : t('k12.works.filterEmptyTitle') }}
      </b>
      <br />
      {{ works.length === 0 ? t('k12.works.emptyValue') : t('k12.works.filterEmptyValue') }}
    </div>

    <ul v-else class="k12cw__list" data-testid="cw-list">
      <li
        v-for="work in filtered"
        :key="work.work_id"
        class="k12cw__card"
        :data-work-id="work.work_id"
        :data-review-state="reviewState(work)"
      >
        <div
          class="k12cw__preview"
          :class="[
            `k12cw__preview--${work.work_type}`,
            `k12cw__preview--${workPreviewVariant(work)}`,
          ]"
        >
          <img
            v-if="workThumbURL(work)"
            :src="workThumbURL(work)"
            class="k12cw__thumb"
            :alt="work.display_name"
            data-testid="cw-thumb"
            loading="lazy"
            role="button"
            tabindex="0"
            :aria-label="t('k12.works.previewWork', { name: work.display_name })"
            @click="openImagePreview(workThumbURL(work), work.display_name, $event)"
            @keydown.enter.prevent="
              !$event.isComposing &&
              $event.keyCode !== 229 &&
              openImagePreview(workThumbURL(work), work.display_name, $event)
            "
            @keydown.space.prevent="openImagePreview(workThumbURL(work), work.display_name, $event)"
          />
          <span v-else class="k12cw__preview-placeholder" aria-hidden="true" />
        </div>
        <div class="k12cw__copy">
          <header class="k12cw__head">
            <span class="k12cw__kind" :class="`k12cw__kind--${work.work_type}`">
              {{ workKindLabel(work) }}
            </span>
            <span class="k12cw__pill" :class="`k12cw__pill--${reviewState(work)}`">
              {{ reviewStatusLabel(work) }}
            </span>
          </header>
          <h3 class="k12cw__title">{{ work.display_name }}</h3>
          <div class="k12cw__evidence">
            <span v-for="evidence in cardEvidence(work)" :key="evidence">{{ evidence }}</span>
          </div>
          <p class="k12cw__summary">{{ cardSummary(work) }}</p>
          <div class="k12cw__foot">
            <time
              v-if="cardTime(work)"
              class="k12cw__time"
              data-testid="cw-card-time"
              :datetime="cardTime(work)!.iso"
              :data-time-source="cardTime(work)!.source"
            >
              {{ cardTime(work)!.label }}
            </time>
            <button
              type="button"
              class="hc-btn hc-btn-secondary k12cw__detail-toggle"
              data-testid="cw-detail-toggle"
              aria-haspopup="dialog"
              :aria-expanded="expandedID === work.work_id"
              :aria-controls="`cw-detail-${work.work_id}`"
              :disabled="reviewState(work) === 'pending'"
              @click="openDetails(work, $event)"
            >
              {{ reviewCTA(work) }}
            </button>
          </div>
        </div>
      </li>
    </ul>

    <Teleport to="body">
      <div
        v-if="activeWork && !detailDeleteConfirmActive"
        class="k12cw-detail-overlay is-open"
        data-testid="cw-detail-overlay"
        @click.self="closeDetails()"
      >
        <div
          :id="`cw-detail-${activeWork.work_id}`"
          ref="detailDialog"
          class="k12cw-detail-modal"
          :data-work-id="activeWork.work_id"
          data-testid="cw-detail-modal"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="`cw-detail-title-${activeWork.work_id}`"
          tabindex="-1"
        >
          <header class="k12cw-detail-modal__head">
            <b :id="`cw-detail-title-${activeWork.work_id}`">
              {{ t('k12.works.detailTitle', { title: activeWork.display_name }) }}
            </b>
            <button
              type="button"
              class="k12cw-detail-modal__x"
              data-testid="cw-detail-close"
              :aria-label="t('k12.works.detailClose')"
              @click="closeDetails()"
            >
              ✕
            </button>
          </header>

          <div ref="detailBody" class="k12cw-detail-modal__body">
            <div class="k12cw__source">
              <button
                v-if="workThumbURL(activeWork)"
                type="button"
                class="k12cw__source-image"
                :aria-label="t('k12.works.previewWork', { name: activeWork.display_name })"
                @click="openImagePreview(workThumbURL(activeWork), activeWork.display_name, $event)"
              >
                <img :src="workThumbURL(activeWork)" :alt="activeWork.display_name" />
              </button>
              <div
                v-if="activeWork.work_type === 'writing' && activeWork.content_markdown"
                class="k12cw__source-content"
              >
                <b>{{ t('k12.works.contentLabel') }}</b>
                <MarkdownRenderer
                  data-testid="cw-work-content"
                  :content="activeWork.content_markdown"
                  :show-artifacts="false"
                />
              </div>
            </div>

            <CreativeWorkFeedbackRenderer
              v-if="latestFeedback(activeWork)"
              data-testid="cw-latest-feedback"
              :generation-id="latestFeedbackGeneration(activeWork)!.generation_id"
              :feedback-id="latestFeedback(activeWork)!.feedback_id"
              :projection-markdown="feedbackMarkdown(activeWork)"
              :visible-evidence="latestFeedback(activeWork)!.visible_evidence"
              :affirmation="latestFeedback(activeWork)!.affirmation"
              :parent-guidance="latestFeedback(activeWork)!.parent_guidance"
              :next-step="latestFeedback(activeWork)!.next_step"
              :limitations="latestFeedback(activeWork)!.limitations"
            />
            <p
              v-else-if="reviewState(activeWork) === 'failed'"
              class="k12cw__notice k12cw__notice--error"
              data-testid="cw-initial-review-error"
              role="alert"
            >
              {{ t('k12.works.initialReviewFailed') }}
            </p>
            <p
              v-else
              class="k12cw__notice"
              data-testid="cw-feedback-auto-pending"
              role="status"
              aria-live="polite"
            >
              {{ t('k12.works.initialReviewPendingDetail') }}
            </p>

            <p
              v-if="feedbackRegenerateError[activeWork.work_id]"
              class="k12cw__notice k12cw__notice--error"
              data-testid="cw-feedback-regenerate-error"
              role="alert"
            >
              {{ feedbackRegenerateError[activeWork.work_id] }}
            </p>

            <div
              v-if="reviewState(activeWork) === 'reviewed'"
              class="k12cw__action-bar"
              data-testid="cw-action-bar"
            >
              <button
                type="button"
                class="hc-btn hc-btn-secondary"
                data-testid="cw-copy"
                @click="copyWork(activeWork)"
              >
                {{
                  copiedWorkID === activeWork.work_id
                    ? t('k12.works.copied')
                    : activeWork.work_type === 'writing'
                      ? t('k12.works.copyWorkFeedback')
                      : t('k12.works.copyFeedback')
                }}
              </button>
              <button
                type="button"
                class="hc-btn hc-btn-primary k12cw__send"
                data-testid="cw-send"
                :disabled="delivery.disabled.value"
                @click="sendWork(activeWork)"
              >
                {{ delivery.label.value }}
              </button>
              <button
                type="button"
                class="hc-btn hc-btn-secondary"
                data-testid="cw-export-pdf"
                @click="exportWorkPDF(activeWork)"
              >
                {{ t('k12.works.exportPDF') }}
              </button>
              <button
                type="button"
                class="hc-btn hc-btn-secondary"
                data-testid="cw-feedback-regenerate"
                :disabled="!!feedbackRegeneratingID"
                :aria-busy="feedbackRegeneratingID === activeWork.work_id"
                @click="regenerateFeedback(activeWork)"
              >
                {{
                  feedbackRegeneratingID === activeWork.work_id
                    ? t('k12.works.feedbackRegenerating')
                    : t('k12.works.feedbackRegenerate')
                }}
              </button>
              <button
                type="button"
                class="hc-btn hc-btn-ghost hc-btn-danger-ghost k12cw__danger"
                data-testid="cw-delete"
                @click="askDelete(activeWork)"
              >
                {{ t('k12.works.deleteWork') }}
              </button>
            </div>
            <div v-else class="k12cw__action-bar k12cw__action-bar--compact">
              <button
                v-if="reviewState(activeWork) === 'failed'"
                type="button"
                class="hc-btn hc-btn-primary"
                data-testid="cw-initial-review-retry"
                :disabled="initialRetryingID === activeWork.work_id"
                @click="retryInitialFeedback(activeWork)"
              >
                {{ t('k12.works.retryInitialReview') }}
              </button>
              <button
                type="button"
                class="hc-btn hc-btn-ghost hc-btn-danger-ghost k12cw__danger"
                data-testid="cw-delete"
                @click="askDelete(activeWork)"
              >
                {{ t('k12.works.deleteWork') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <Teleport to="body">
      <div
        v-if="previewImageSrc"
        ref="previewDialog"
        class="k12cw-image-preview"
        data-testid="cw-image-preview"
        role="dialog"
        aria-modal="true"
        :aria-label="t('k12.works.previewWork', { name: previewImageAlt })"
        tabindex="-1"
        @click.self="closeImagePreview()"
        @keydown.esc.prevent="closeImagePreview()"
      >
        <img :src="previewImageSrc" :alt="previewImageAlt" />
        <button
          type="button"
          class="k12cw-image-preview__close"
          :aria-label="t('k12.works.closePreview')"
          @click="closeImagePreview()"
        >
          ✕
        </button>
      </div>
    </Teleport>

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
            <button
              type="button"
              class="k12cw-modal__x"
              :aria-label="t('k12.works.cancel')"
              @click="closeAdd"
            >
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

            <div class="k12cw-modal__field">
              <span>
                {{
                  addType === 'writing'
                    ? t('k12.works.writingPhotoLabel')
                    : t('k12.works.artPhotoLabel')
                }}
              </span>
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
                <b>
                  {{
                    addType === 'writing'
                      ? t('k12.works.writingPhotoChoose')
                      : t('k12.works.artPhotoChoose')
                  }}
                </b>
              </div>
              <div v-else class="k12cw__photopreview" data-testid="cw-photo-preview">
                <img :src="photoPreview" alt="" />
                <div class="k12cw__photostate">
                  <span v-if="photoUploading" data-testid="cw-photo-progress">
                    {{ t('k12.works.photoUploading') }} {{ photoPercent }}%
                  </span>
                  <span
                    v-else-if="photoError"
                    class="k12cw__inline-error"
                    data-testid="cw-photo-error"
                  >
                    {{ photoError }}
                  </span>
                  <span v-else-if="photoAssetID" data-testid="cw-photo-ok">
                    {{ t('k12.works.photoUploaded') }}
                  </span>
                  <button
                    v-if="photoError"
                    type="button"
                    class="hc-btn hc-btn-secondary"
                    data-testid="cw-photo-retry"
                    @click="uploadPhoto"
                  >
                    {{ t('k12.works.photoRetry') }}
                  </button>
                  <button
                    type="button"
                    class="hc-btn hc-btn-ghost"
                    data-testid="cw-photo-remove"
                    @click="resetPhoto()"
                  >
                    {{ t('k12.works.photoRemove') }}
                  </button>
                </div>
              </div>

              <div
                v-if="addType === 'writing' && photoPreview"
                class="k12cw__ocr"
                aria-live="polite"
                data-testid="cw-ocr-state"
              >
                <p v-if="photoOCRBusy" data-testid="cw-ocr-processing">
                  {{ t('k12.works.ocrProcessing') }}
                </p>
                <div
                  v-else-if="photoOCRRequestError || photoOCRJob?.status === 'failed'"
                  class="k12cw__inline-error"
                  data-testid="cw-ocr-error"
                >
                  <p>
                    {{
                      photoOCRRequestError || photoOCRJob?.error_message || t('k12.works.ocrFailed')
                    }}
                  </p>
                  <button
                    type="button"
                    class="hc-btn hc-btn-secondary"
                    data-testid="cw-ocr-retry"
                    @click="retryPhotoOCR"
                  >
                    {{ t('k12.works.ocrRetry') }}
                  </button>
                </div>
                <p
                  v-else-if="photoOCRConfirmed"
                  class="k12cw__ocr-success"
                  data-testid="cw-ocr-confirmed"
                >
                  {{ t('k12.works.ocrConfirmed') }}
                </p>
                <p
                  v-else-if="
                    photoOCRJob?.status === 'awaiting_confirmation' ||
                    photoOCRJob?.status === 'confirmed'
                  "
                  data-testid="cw-ocr-awaiting"
                >
                  {{ t('k12.works.ocrAwaiting') }}
                </p>
              </div>
            </div>

            <label v-if="addType === 'writing'" class="k12cw-modal__field">
              <span>{{ t('k12.works.draftLabel') }}</span>
              <HcClearableField>
                <textarea
                  v-model="addDraft"
                  class="k12cw__input"
                  rows="5"
                  :placeholder="t('k12.works.draftPlaceholder')"
                  data-testid="cw-add-draft"
                ></textarea>
              </HcClearableField>
              <button
                v-if="photoPreview && photoOCRJob && !photoOCRConfirmed"
                type="button"
                class="hc-btn hc-btn-secondary k12cw__ocr-confirm"
                :disabled="photoOCRBusy || !addDraft.trim()"
                data-testid="cw-ocr-confirm"
                @click="confirmPhotoOCR"
              >
                {{ t('k12.works.ocrConfirm') }}
              </button>
              <small>{{ t('k12.works.writingRequirement') }}</small>
            </label>

            <label v-if="addType === 'art'" class="k12cw-modal__field">
              <span>{{ t('k12.works.nameLabel') }}</span>
              <HcClearableField>
                <input
                  v-model="addTitle"
                  class="k12cw__input"
                  :placeholder="t('k12.works.namePlaceholder')"
                  data-testid="cw-add-title"
                />
              </HcClearableField>
              <small>{{ t('k12.works.artRequirement') }}</small>
            </label>
          </div>
          <div class="k12cw-modal__foot">
            <button type="button" class="hc-btn hc-btn-ghost" @click="closeAdd">
              {{ t('k12.works.cancel') }}
            </button>
            <button
              type="button"
              class="hc-btn hc-btn-primary"
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

    <ConfirmDialog
      :open="!!deleteTarget"
      :title="t('k12.works.deleteTitle')"
      :message="deleteMessage"
      :confirm-text="t('k12.works.deleteConfirm')"
      :cancel-text="t('k12.works.cancel')"
      :danger="true"
      :confirmation-key="
        deleteTarget ? `${deleteTarget.work_id}:${deleteTarget.row_version}` : null
      "
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />
  </section>
</template>

<style scoped>
.k12cw__desc {
  flex: 1;
  min-width: 0;
  margin: 0;
  color: var(--hc-text-muted);
  font-size: 12px;
  line-height: 1.6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.k12cw__overview {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

/* WebKit 的作品概览需下移 3px，抵消实现与原型基线的 3px 几何差；不改变集合列与后续内容流。 */
@supports (font: -apple-system-body) {
  .k12cw__overview {
    position: relative;
    top: 1px;
  }
}

.k12cw__overview > .hc-btn {
  order: 3;
  flex-shrink: 0;
}

.k12cw__kpis {
  display: flex;
  gap: 6px;
  margin-left: auto;
  flex-shrink: 0;
}

.k12cw__kpi {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  white-space: nowrap;
  border: 0.5px solid var(--hc-border);
  border-radius: 10px;
  background: rgba(255, 254, 249, 0.9);
  padding: 7px 12px;
  font-size: 11px;
  color: var(--hc-text-muted);
}

.k12cw__kpi b {
  font-size: 15px;
  font-weight: 700;
  color: var(--hc-text-primary);
  font-variant-numeric: tabular-nums;
}

.k12cw__filter {
  display: grid;
  box-sizing: border-box;
  height: 55px;
  gap: 9px;
  margin-bottom: 12px;
  padding: 12px 14px;
  border: 0.5px solid var(--hc-border);
  border-radius: 14px;
  background: rgba(255, 254, 249, 0.9);
}

.k12cw__filter-row {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
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
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: Arial;
  font-size: 12px;
  line-height: normal;
  border: 0.5px solid var(--hc-border);
  background: var(--hc-bg-input);
  color: var(--hc-text-secondary);
  padding: 5px 8px;
  border-radius: 9px;
  cursor: pointer;
}

.k12cw__filter button.on {
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  font-weight: 400;
  border-color: color-mix(in srgb, var(--hc-accent) 35%, var(--hc-border));
}

.k12cw__rules {
  position: relative;
  margin-bottom: 12px;
  padding: 11px 13px 11px 17px;
  border: 0.5px solid var(--hc-border);
  border-radius: 12px;
  background: rgba(255, 254, 249, 0.96);
  color: var(--hc-text-secondary);
  font-size: 12.5px;
  line-height: 1.55;
}

.k12cw__rules::before {
  content: '';
  position: absolute;
  top: 11px;
  bottom: 11px;
  left: 0;
  width: 3px;
  border-radius: 2px;
  background: var(--hc-accent);
}

.k12cw__rules b {
  display: block;
  margin-bottom: 0;
  color: var(--hc-text-primary);
}

.k12cw__error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 0;
  color: var(--hc-error);
  font-size: 13px;
}

.k12cw__empty,
.k12cw__loading {
  padding: 11px 13px;
  border: 0.5px solid var(--hc-border);
  border-radius: 12px;
  background: var(--hc-bg-card);
  color: var(--hc-text-secondary);
  font-size: 12.5px;
  line-height: 1.55;
}

.k12cw__empty b {
  color: var(--hc-text-primary);
}

.k12cw__list {
  display: grid;
  /* 作品集合按可用宽度形成 1/2/3 列；auto-fill 保留空轨，避免单件作品拉满整行。 */
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr));
  gap: 14px;
  align-items: stretch;
  margin: 0;
  padding: 0;
  list-style: none;
}

.k12cw__card {
  display: grid;
  grid-template-columns: 104px minmax(0, 1fr);
  min-height: 138px;
  padding: 16px;
  gap: 14px;
  align-items: stretch;
  border: 0.5px solid var(--hc-border);
  border-radius: 16px;
  background: rgba(255, 254, 249, 0.9);
  box-shadow: var(--hc-shadow-sm);
  transition:
    box-shadow 0.2s var(--hc-ease-out),
    border-color 0.15s var(--hc-ease-out);
}

.k12cw__card:hover {
  border-color: var(--hc-border-hl);
  box-shadow: var(--hc-shadow-md);
}

.k12cw__card[data-review-state='failed'] {
  border-color: color-mix(in srgb, var(--hc-error) 22%, var(--hc-border));
}

.k12cw__preview {
  min-height: 104px;
  height: 104px;
  position: relative;
  overflow: hidden;
  border-radius: 12px;
  background: linear-gradient(180deg, #a9c9e6 0 54%, #8fbb7d 54% 76%, #729a63 76%);
}

.k12cw__preview--writing {
  border: 1px solid color-mix(in srgb, #b88945 22%, var(--hc-border));
  background: linear-gradient(135deg, #fffdf7, #f4ead5);
}

.k12cw__preview-placeholder {
  position: absolute;
  inset: 0;
}

.k12cw__preview--writing .k12cw__preview-placeholder::before {
  content: '春天的校园\A\A柳枝像绿色的丝带……';
  position: absolute;
  inset: 13px;
  color: #685b48;
  font-family: ui-serif, STSong, serif;
  font-size: 10px;
  line-height: 1.7;
  white-space: pre-wrap;
  background: repeating-linear-gradient(transparent 0 16px, rgba(104, 91, 72, 0.13) 16px 17px);
}

.k12cw__preview--line {
  background: linear-gradient(150deg, #f5f1e8, #d6d0c4);
}

.k12cw__preview--line .k12cw__preview-placeholder::before {
  content: '';
  position: absolute;
  inset: 18px 22px;
  width: auto;
  height: auto;
  background: transparent;
  border: 2px solid #59636f;
  border-radius: 48% 52% 45% 55%;
  transform: rotate(-11deg);
  box-shadow: 16px 10px 0 -9px #59636f, -13px 19px 0 -11px #59636f;
}

.k12cw__preview--writing .k12cw__preview-placeholder::after {
  content: none;
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

.k12cw__preview.k12cw__preview--line .k12cw__preview-placeholder::before {
  content: '';
  position: absolute;
  inset: 18px 22px;
  width: auto;
  height: auto;
  background: transparent;
  border: 2px solid #59636f;
  border-radius: 48% 52% 45% 55%;
  transform: rotate(-11deg);
  box-shadow: 16px 10px 0 -9px #59636f, -13px 19px 0 -11px #59636f;
}

.k12cw__thumb {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  cursor: zoom-in;
}

.k12cw__thumb:focus-visible {
  outline: 2px solid var(--hc-accent);
  outline-offset: -3px;
}

.k12cw__copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 104px;
}

.k12cw__head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.k12cw__kind {
  padding: 2px 7px;
  border-radius: 4px;
  font-size: 10.5px;
  font-weight: 650;
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

.k12cw__pill {
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 700;
}

.k12cw__pill--pending {
  color: var(--hc-text-muted);
  background: var(--hc-bg-input);
}

.k12cw__pill--reviewed {
  color: var(--hc-success);
  background: color-mix(in srgb, var(--hc-success) 10%, transparent);
}

.k12cw__pill--failed {
  color: var(--hc-error);
  background: color-mix(in srgb, var(--hc-error) 10%, transparent);
}

.k12cw__title {
  margin: 4px 0 5px;
  overflow: hidden;
  color: var(--hc-text-primary);
  font-size: 13.5px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.k12cw__evidence {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  margin: 6px 0;
}

.k12cw__evidence span {
  max-width: 100%;
  padding: 3px 8px;
  overflow: hidden;
  border-radius: 7px;
  background: var(--hc-bg-input);
  color: var(--hc-text-secondary);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.k12cw__summary {
  display: -webkit-box;
  margin: 5px 0 8px;
  overflow: hidden;
  color: var(--hc-text-muted);
  font-size: 11.5px;
  line-height: 1.55;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.k12cw__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: auto;
}

.k12cw__time {
  min-width: 0;
  color: var(--hc-text-muted);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.k12cw__detail-toggle {
  align-self: flex-end;
  min-height: 32px;
  margin-top: 0;
  padding: 6px 12px;
  background: rgba(255, 254, 249, 0.9);
  /* 共享按钮继承全局字体并固定行高，避免 WebKit 原生字体回退造成卡片纵向漂移。 */
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  box-shadow: none;
}

.k12cw__card[data-review-state='failed'] .k12cw__detail-toggle {
  border-color: color-mix(in srgb, var(--hc-error) 20%, var(--hc-border));
  color: var(--hc-error);
}

.k12cw__card[data-review-state='pending'] .k12cw__detail-toggle {
  color: var(--hc-text-muted);
}

.k12cw-detail-overlay,
.k12cw-overlay {
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

.k12cw-detail-modal {
  width: min(720px, calc(100vw - 48px));
  overflow: hidden;
  border: 0.5px solid var(--hc-border);
  border-radius: 16px;
  outline: none;
  background: var(--hc-bg-elevated);
  box-shadow: var(--hc-shadow-float);
}

.k12cw-detail-modal__head,
.k12cw-modal__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 18px;
  border-bottom: 0.5px solid var(--hc-border);
}

.k12cw-detail-modal__head b {
  min-width: 0;
  overflow: hidden;
  font-size: 15px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.k12cw-detail-modal__x,
.k12cw-modal__x {
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

.k12cw-detail-modal__x:hover,
.k12cw-modal__x:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}

.k12cw-detail-modal__body {
  max-height: min(68vh, 680px);
  overflow: auto;
  padding: 20px;
}

.k12cw__source {
  display: grid;
  gap: 10px;
  margin-bottom: 12px;
}

.k12cw__source-image {
  display: block;
  width: 100%;
  max-height: 260px;
  padding: 0;
  overflow: hidden;
  border: 0;
  border-radius: 12px;
  background: var(--hc-bg-input);
  cursor: zoom-in;
}

.k12cw__source-image img {
  display: block;
  width: 100%;
  max-height: 260px;
  object-fit: contain;
}

.k12cw__source-content,
.k12cw__feedback {
  display: grid;
  gap: 8px;
}

.k12cw__source-content,
.k12cw__feedback-row {
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--hc-bg-input);
  color: var(--hc-text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.k12cw__source-content > b,
.k12cw__feedback-row > b {
  display: block;
  margin-bottom: 4px;
  color: var(--hc-text-primary);
}

.k12cw__source-content :deep(p) {
  margin: 0;
}

.k12cw__notice {
  margin: 0;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--hc-bg-input);
  color: var(--hc-text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.k12cw__notice--error {
  color: var(--hc-error);
}

.k12cw__action-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: nowrap;
  padding-top: 14px;
  margin-top: 14px;
  border-top: 0.5px solid var(--hc-divider);
}

.k12cw__action-bar .hc-btn {
  flex: none;
  min-height: 36px;
  padding-inline: 11px;
  font-size: 12px;
}

.k12cw__send {
  width: 128px;
}

.k12cw__danger {
  flex: none;
  margin-inline-start: auto;
}

.k12cw__action-bar--compact {
  justify-content: flex-end;
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

.k12cw-modal {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: 478px;
  max-width: 92vw;
  max-height: min(720px, calc(100vh - 24px));
  overflow: hidden;
  border: 0.5px solid var(--hc-border);
  border-radius: 16px;
  background: var(--hc-bg-elevated);
  box-shadow: var(--hc-shadow-float);
}

.k12cw-modal__body {
  display: grid;
  gap: 13px;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  min-height: 0;
  padding: 18px;
  overflow: auto;
}

.k12cw-modal__field {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.k12cw-modal__field > span {
  color: var(--hc-text-primary);
  font-size: 12.5px;
}

.k12cw-modal__field > small {
  color: var(--hc-text-muted);
  font-size: 11px;
  line-height: 1.5;
}

.k12cw-modal__foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 18px;
  border-top: 0.5px solid var(--hc-border);
}

.k12cw__seg {
  display: flex;
  min-width: 0;
  gap: 4px;
}

.k12cw__seg button {
  flex: 1;
  padding: 7px 0;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input);
  color: var(--hc-text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.k12cw__seg button.on {
  border-color: var(--hc-accent);
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  font-weight: 650;
}

.k12cw__drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: 16px 12px;
  border: 1px dashed var(--hc-border);
  border-radius: 12px;
  background: var(--hc-bg-input);
  color: var(--hc-text-muted);
  text-align: center;
  cursor: pointer;
}

.k12cw__drop:hover,
.k12cw__drop--over {
  border-color: var(--hc-accent);
}

.k12cw__drop--over {
  border-style: solid;
  background: var(--hc-accent-subtle);
}

.k12cw__drop b {
  color: var(--hc-text-primary);
  font-size: 12.5px;
  font-weight: 600;
}

.k12cw__dropicon {
  font-size: 24px;
  line-height: 1;
}

.k12cw__file {
  display: none;
}

.k12cw__photopreview {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.k12cw__photopreview img {
  flex-shrink: 0;
  width: 92px;
  height: 92px;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  object-fit: cover;
}

.k12cw__photostate {
  display: grid;
  gap: 6px;
  justify-items: start;
  color: var(--hc-text-secondary);
  font-size: 11.5px;
}

.k12cw__ocr {
  display: grid;
  gap: 6px;
  padding: 8px 10px;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input);
  color: var(--hc-text-secondary);
  font-size: 11.5px;
}

.k12cw__ocr p {
  margin: 0;
}

.k12cw__ocr-success {
  color: var(--hc-success);
}

.k12cw__inline-error {
  color: var(--hc-error);
}

.k12cw__ocr-confirm {
  justify-self: start;
}

.k12cw__input {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: 8px 11px;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  outline: none;
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
  font: inherit;
  font-size: 12px;
  resize: vertical;
}

.k12cw__input:focus {
  border-color: var(--hc-accent);
}

@media (max-width: 860px) {
  .k12cw__overview {
    align-items: flex-start;
  }

  .k12cw__kpis {
    margin-left: 0;
  }
}

@media (max-width: 680px) {
  .k12cw-detail-modal {
    width: min(540px, calc(100vw - 28px));
  }

  .k12cw__action-bar {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .k12cw__action-bar .hc-btn,
  .k12cw__send {
    width: 100%;
  }

  .k12cw__danger {
    margin-inline-start: 0;
  }
}

@media (max-width: 600px) {
  .k12cw__card {
    grid-template-columns: 88px minmax(0, 1fr);
    padding: 14px;
  }

  .k12cw__preview {
    min-height: 88px;
    height: 88px;
  }

  .k12cw__copy {
    min-height: 88px;
  }

  .k12cw__kpis {
    width: 100%;
    overflow-x: auto;
  }
}
</style>
