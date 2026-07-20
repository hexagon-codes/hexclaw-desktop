<!--
  K12 作品面板（PRD §3.10）· 学习档案「作品」对象 Tab。
  语文写作 / 美术作品统一承载成长版本：draft→已点评→已修改→再点评（可归档）。
  只给证据化点评，不打分、不代写、不排名（INV-011）——点评内容由家长/Skill 提供，此处只做流转与展示。
  自包含：直连 /api/k12/creative-works*，本地状态，按 agentId 隔离拉取。
-->
<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import {
  k12ListCreativeWorks,
  k12CreateCreativeWork,
  k12AttachWorkFeedback,
  k12GenerateWorkFeedback,
  k12SubmitWorkRevision,
  k12ArchiveCreativeWork,
  k12AddAccumulation,
  k12RecordMistake,
  k12UploadAsset,
  k12CreateCreativeWorkOCR,
  k12RetryCreativeWorkOCR,
  k12ConfirmCreativeWorkOCR,
  k12AssetURL,
  k12SendWorkFeedback,
  k12RetryDeliveryReceipt,
  k12QueryDeliveryReceipt,
  k12MarkPracticeCardDone,
  type CreativeWorkDTO,
  type CreativeWorkOCRJobDTO,
  type DeliveryReceiptDTO,
  type WorkFeedbackDTO,
  type WorkVersionDTO,
  type WorkType,
} from '@/api/k12'
import { printPracticePaper, savePracticePaperPdf } from '../export'
import { printPersistentArtifact } from '../persistent-print'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'

const props = withDefaults(defineProps<{ agentId: string; showAddButton?: boolean }>(), {
  showAddButton: true,
})
const { t } = useI18n()
const toast = useToast()

const works = ref<CreativeWorkDTO[]>([])
const loading = ref(false)
const error = ref('')
let loadGeneration = 0
const busyId = ref('')
const typeFilter = ref<'' | WorkType>('')
const expandedId = ref('')
// 点评/修改稿的行内输入：按 record_id 存草稿文本。
const feedbackDraft = ref<Record<string, string>>({})
const revisionDraft = ref<Record<string, string>>({})
const feedbackGeneratingId = ref('')
const feedbackGenerateError = ref<Record<string, string>>({})
const deliveryReceipts = ref<Record<string, DeliveryReceiptDTO>>({})
const deliverySetupErrors = ref<Record<string, string>>({})
let feedbackGeneration = 0
let feedbackAbort: AbortController | null = null

const filtered = computed(() =>
  typeFilter.value ? works.value.filter((w) => w.work_type === typeFilter.value) : works.value,
)

// ── KPI（原型 2570-2576）：从列表计算，不另拉端点 ─────────────
// 「已点评」以证据判定：任一版本带 feedback 即算（status 会随修改稿回到待点评态，证据不回退）。
function isReviewed(w: CreativeWorkDTO): boolean {
  return w.versions.some((v) => !!v.feedback)
}
function latestVersion(w: CreativeWorkDTO): WorkVersionDTO | undefined {
  return w.versions[w.versions.length - 1]
}
function cardSummary(w: CreativeWorkDTO): string {
  const version = latestVersion(w)
  return (version?.feedback || version?.content_markdown || w.task || '').trim()
}
function toggleDetails(w: CreativeWorkDTO) {
  expandedId.value = expandedId.value === w.record_id ? '' : w.record_id
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

function feedbackActionLabel(action: WorkFeedbackDTO['allowed_actions'][number]): string {
  const labels: Record<typeof action, string> = {
    send: t('k12.works.feedbackActionSend'),
    print_practice_card: t('k12.works.feedbackActionPrint'),
    collect: t('k12.works.feedbackActionCollect'),
    record_language_issue: t('k12.works.feedbackActionLanguageIssue'),
  }
  return labels[action]
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

// DD-013：上传成功只代表原图落盘；写作照片必须再经过持久 OCR Job 与家长确认。
const photoOCRJob = ref<CreativeWorkOCRJobDTO | null>(null)
const photoOCRBusy = ref(false)
const photoOCRRequestError = ref('')
let photoOCRGeneration = 0
let photoOCRRequestId = ''

function newOCRRequestId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `cwocr-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
}

function resetPhotoOCR(clearDraft = false) {
  photoOCRGeneration += 1
  photoOCRJob.value = null
  photoOCRBusy.value = false
  photoOCRRequestError.value = ''
  photoOCRRequestId = ''
  if (clearDraft) addDraft.value = ''
}

function applyPhotoOCRJob(job: CreativeWorkOCRJobDTO) {
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
  if (!assetId || addType.value !== 'writing') return
  if (!photoOCRRequestId) photoOCRRequestId = newOCRRequestId()
  const generation = ++photoOCRGeneration
  photoOCRBusy.value = true
  photoOCRRequestError.value = ''
  photoOCRJob.value = null
  try {
    const job = await k12CreateCreativeWorkOCR({
      agent: props.agentId,
      request_id: photoOCRRequestId,
      source_asset_id: assetId,
    })
    if (generation !== photoOCRGeneration || assetId !== photoAssetId.value) return
    applyPhotoOCRJob(job)
  } catch (e) {
    if (generation !== photoOCRGeneration) return
    photoOCRRequestError.value = (e as Error).message || t('k12.works.ocrFailed')
  } finally {
    if (generation === photoOCRGeneration) photoOCRBusy.value = false
  }
}

async function retryPhotoOCR() {
  const job = photoOCRJob.value
  if (!job || photoOCRBusy.value) {
    if (!job && photoAssetId.value) await startPhotoOCR()
    return
  }
  const generation = ++photoOCRGeneration
  photoOCRBusy.value = true
  photoOCRRequestError.value = ''
  try {
    const updated = await k12RetryCreativeWorkOCR(props.agentId, job.job_id)
    if (generation !== photoOCRGeneration || job.source_asset_id !== photoAssetId.value) return
    applyPhotoOCRJob(updated)
  } catch (e) {
    if (generation !== photoOCRGeneration) return
    photoOCRRequestError.value = (e as Error).message || t('k12.works.ocrFailed')
  } finally {
    if (generation === photoOCRGeneration) photoOCRBusy.value = false
  }
}

async function confirmPhotoOCR() {
  const job = photoOCRJob.value
  const content = addDraft.value.trim()
  if (!job || !content || photoOCRBusy.value) return
  const generation = ++photoOCRGeneration
  photoOCRBusy.value = true
  photoOCRRequestError.value = ''
  try {
    const confirmed = await k12ConfirmCreativeWorkOCR(props.agentId, job.job_id, content)
    if (generation !== photoOCRGeneration || job.source_asset_id !== photoAssetId.value) return
    applyPhotoOCRJob(confirmed)
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

function resetPhoto() {
  photoGeneration += 1
  photoAbort?.abort()
  photoAbort = null
  if (photoPreview.value) URL.revokeObjectURL(photoPreview.value)
  photoAssetId.value = ''
  photoPreview.value = ''
  photoPct.value = -1
  photoError.value = ''
  photoFile = null
  resetPhotoOCR()
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
    if (addType.value === 'writing') void startPhotoOCR()
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
  () => !photoPreview.value || (!!photoAssetId.value && !photoUploading.value && !photoError.value),
)
const photoOCRConfirmed = computed(() => {
  const job = photoOCRJob.value
  return (
    !!job &&
    job.status === 'confirmed' &&
    job.source_asset_id === photoAssetId.value &&
    !!job.confirmed_version &&
    !!job.confirmed_digest &&
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

watch(addType, (type) => {
  if (type === 'writing' && photoAssetId.value && !photoOCRJob.value && !photoOCRBusy.value) {
    void startPhotoOCR()
  }
})
function openAdd() {
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
  const opener = addOpener
  addOpener = null
  void nextTick(() => {
    if (opener?.isConnected) opener.focus()
  })
}
function onAddKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !addOpen.value) return
  event.preventDefault()
  closeAdd()
}
async function submitAdd() {
  if (!addValid.value || addBusy.value) return
  addBusy.value = true
  try {
    const confirmedOCR =
      addType.value === 'writing' && photoPreview.value ? photoOCRJob.value : null
    await k12CreateCreativeWork({
      agent: props.agentId,
      work_type: addType.value,
      title: addTitle.value.trim(),
      task: addTask.value.trim(),
      intent: addType.value === 'art' ? addIntent.value.trim() || undefined : undefined,
      content_markdown: addType.value === 'writing' ? addDraft.value.trim() : undefined,
      source_asset_id: photoAssetId.value || undefined,
      ...(confirmedOCR && confirmedOCR.status === 'confirmed'
        ? {
            ocr_job_id: confirmedOCR.job_id,
            ocr_version: confirmedOCR.confirmed_version,
            ocr_confirmed_digest: confirmedOCR.confirmed_digest,
          }
        : {}),
    })
    toast.success(t('k12.works.created'))
    closeAdd()
    resetPhoto()
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

// ── 观察练习卡（任务2：§3.10 美术——练习必须有产物 + 打印/发送/打卡出口）────
// 卡文本由服务端从点评正文提炼（practice_card，单一事实源）；取最新带点评版本。
function practiceCardOf(w: CreativeWorkDTO): WorkVersionDTO | null {
  if (w.work_type !== 'art') return null
  for (let i = w.versions.length - 1; i >= 0; i--) {
    const v = w.versions[i]
    if (v?.practice_card) return v
  }
  return null
}

const printBusyId = ref('')
const savePdfBusyId = ref('')
const printError = ref<Record<string, string>>({})
async function printCard(w: CreativeWorkDTO) {
  const ver = practiceCardOf(w)
  if (!ver?.practice_card) return
  const title = `${t('k12.works.practiceCardTitle')} · ${w.title}`
  printBusyId.value = w.record_id
  printError.value[w.record_id] = ''
  try {
    const markdown = `# ${title}\n${ver.practice_card}`
    const ok = await printPersistentArtifact({
      agent: props.agentId,
      sourceKind: 'creative_observation_card',
      sourceRef: `creative-work:${w.record_id}:${ver.version_id}:practice-card`,
      title,
      canonicalMarkdown: markdown,
      browserPrint: () => printPracticePaper(markdown, title),
    })
    if (!ok) throw new Error(t('k12.works.printFailed'))
  } catch (e) {
    printError.value[w.record_id] = (e as Error).message || t('k12.works.printFailed')
  } finally {
    printBusyId.value = ''
  }
}

async function saveCardPdf(w: CreativeWorkDTO) {
  const ver = practiceCardOf(w)
  if (!ver?.practice_card) return
  const title = `${t('k12.works.practiceCardTitle')} · ${w.title}`
  savePdfBusyId.value = w.record_id
  try {
    await savePracticePaperPdf(`# ${title}\n${ver.practice_card}`, title)
  } catch (e) {
    toast.error((e as Error).message || t('k12.works.practiceCardSavePdfFailed'))
  } finally {
    savePdfBusyId.value = ''
  }
}

async function markCardDone(w: CreativeWorkDTO) {
  busyId.value = w.record_id
  try {
    await k12MarkPracticeCardDone(props.agentId, w.record_id)
    toast.success(t('k12.works.practiceCardDoneOk'))
    await load()
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busyId.value = ''
  }
}

// ── 发送到手机（DD-024：先落 Receipt，再发绑定私聊）────────────────
function latestFeedbackOf(w: CreativeWorkDTO): string {
  for (let i = w.versions.length - 1; i >= 0; i--) {
    const fb = (w.versions[i]?.feedback || '').trim()
    if (fb) return fb
  }
  return ''
}

function deliveryKey(w: CreativeWorkDTO, kind: 'feedback' | 'practice_card'): string {
  return `${w.record_id}:${kind}`
}

function deliveryOf(w: CreativeWorkDTO, kind: 'feedback' | 'practice_card') {
  return deliveryReceipts.value[deliveryKey(w, kind)]
}

function deliverySetupErrorOf(w: CreativeWorkDTO, kind: 'feedback' | 'practice_card') {
  return deliverySetupErrors.value[deliveryKey(w, kind)] || ''
}

function deliveryTextOf(w: CreativeWorkDTO, kind: 'feedback' | 'practice_card'): string {
  const receipt = deliveryOf(w, kind)
  return receipt ? deliveryStatusText(receipt) : ''
}

function deliveryStatusText(receipt: DeliveryReceiptDTO): string {
  const target = receipt.target.label || receipt.target.platform
  switch (receipt.status) {
    case 'pending':
      return t('k12.delivery.pending')
    case 'sending':
      return t('k12.delivery.sending', { target })
    case 'delivered':
      return t('k12.delivery.delivered', { target })
    case 'failed':
      return t('k12.delivery.failed', {
        reason: receipt.last_error || t('k12.delivery.unknownReason'),
      })
    case 'outcome_unknown':
      return t('k12.delivery.outcomeUnknown')
  }
}

function applyDeliveryReceipt(
  w: CreativeWorkDTO,
  kind: 'feedback' | 'practice_card',
  receipt: DeliveryReceiptDTO,
) {
  const key = deliveryKey(w, kind)
  deliveryReceipts.value[key] = receipt
  delete deliverySetupErrors.value[key]
  const message = deliveryStatusText(receipt)
  if (receipt.status === 'delivered') toast.success(message)
  else if (receipt.status === 'failed') toast.error(message)
  else toast.info(message)
}

async function sendToPhone(w: CreativeWorkDTO, kind: 'feedback' | 'practice_card') {
  const text =
    kind === 'practice_card' ? practiceCardOf(w)?.practice_card || '' : latestFeedbackOf(w)
  if (!text) return
  busyId.value = w.record_id
  try {
    const resp = await k12SendWorkFeedback(props.agentId, w.record_id, kind)
    applyDeliveryReceipt(w, kind, resp)
  } catch (e) {
    const message = (e as Error).message || t('k12.delivery.setupRequired')
    deliverySetupErrors.value[deliveryKey(w, kind)] = message
    toast.error(message)
  } finally {
    busyId.value = ''
  }
}

async function retryPhoneDelivery(w: CreativeWorkDTO, kind: 'feedback' | 'practice_card') {
  const receipt = deliveryOf(w, kind)
  if (!receipt || receipt.status !== 'failed' || busyId.value) return
  busyId.value = w.record_id
  try {
    applyDeliveryReceipt(w, kind, await k12RetryDeliveryReceipt(props.agentId, receipt.delivery_id))
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busyId.value = ''
  }
}

async function queryPhoneDelivery(w: CreativeWorkDTO, kind: 'feedback' | 'practice_card') {
  const receipt = deliveryOf(w, kind)
  if (!receipt || !['sending', 'outcome_unknown'].includes(receipt.status) || busyId.value) return
  busyId.value = w.record_id
  try {
    applyDeliveryReceipt(w, kind, await k12QueryDeliveryReceipt(props.agentId, receipt.delivery_id))
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busyId.value = ''
  }
}

// ── 点评联动出口（§3.10，原型 5385-5464）：写作已点评卡 → 好句入积累 / 确认错处入错题 ──
// 只在 feedback_ready 的写作卡展示；内容由家长确认后填入（不自动摘取，点评是家长手写的）。
const accumOpenId = ref('')
const mistakeOpenId = ref('')
const accumDraft = ref<Record<string, string>>({})
const mistakeDraft = ref<Record<string, string>>({})
function toggleAccum(w: CreativeWorkDTO) {
  accumOpenId.value = accumOpenId.value === w.record_id ? '' : w.record_id
  mistakeOpenId.value = ''
}
function toggleMistake(w: CreativeWorkDTO) {
  mistakeOpenId.value = mistakeOpenId.value === w.record_id ? '' : w.record_id
  accumOpenId.value = ''
}
async function submitAccum(w: CreativeWorkDTO) {
  const content = (accumDraft.value[w.record_id] || '').trim()
  if (!content) return
  busyId.value = w.record_id
  try {
    await k12AddAccumulation({
      agent: props.agentId,
      subject: '语文',
      entry_type: '写作素材',
      content,
      source: `作品点评 · ${w.title}`,
    })
    accumDraft.value[w.record_id] = ''
    accumOpenId.value = ''
    toast.success(t('k12.works.accumSaved'))
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busyId.value = ''
  }
}
async function submitMistake(w: CreativeWorkDTO) {
  const problem = (mistakeDraft.value[w.record_id] || '').trim()
  if (!problem) return
  busyId.value = w.record_id
  try {
    // grade 留空：后端 resolveGrade 从孩子档案回填（record_mistake handler 契约）。
    await k12RecordMistake({ agent: props.agentId, subject: '语文', grade: '', problem })
    mistakeDraft.value[w.record_id] = ''
    mistakeOpenId.value = ''
    toast.success(t('k12.works.mistakeSaved'))
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busyId.value = ''
  }
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
    feedbackGeneratingId.value = ''
    feedbackGenerateError.value = {}
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
  resetPhoto()
  resetAllRevisionPhotos()
})

function statusTone(s: string): string {
  if (s === 'draft') return 'todo'
  if (s === 'feedback_ready') return 'got'
  if (s === 'revised') return 'done'
  return 'muted'
}

async function submitFeedback(w: CreativeWorkDTO) {
  const fb = (feedbackDraft.value[w.record_id] || '').trim()
  if (!fb) return
  busyId.value = w.record_id
  try {
    await k12AttachWorkFeedback(props.agentId, w.record_id, fb)
    feedbackDraft.value[w.record_id] = ''
    toast.success(t('k12.works.addFeedback'))
    await load()
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busyId.value = ''
  }
}

async function generateFeedback(w: CreativeWorkDTO) {
  if (feedbackGeneratingId.value) return
  const agent = props.agentId
  const generation = ++feedbackGeneration
  feedbackAbort?.abort()
  const controller = new AbortController()
  feedbackAbort = controller
  feedbackGeneratingId.value = w.record_id
  feedbackGenerateError.value[w.record_id] = ''
  try {
    const updated = await k12GenerateWorkFeedback(agent, w.record_id, controller.signal)
    if (generation !== feedbackGeneration || agent !== props.agentId) return
    const index = works.value.findIndex((item) => item.record_id === w.record_id)
    if (index >= 0) works.value.splice(index, 1, updated)
    toast.success(t('k12.works.aiGenerated'))
  } catch (e) {
    if (
      generation !== feedbackGeneration ||
      agent !== props.agentId ||
      (e as Error).name === 'AbortError'
    )
      return
    feedbackGenerateError.value[w.record_id] =
      (e as Error).message || t('k12.works.aiGenerateFailed')
  } finally {
    if (generation === feedbackGeneration) {
      feedbackGeneratingId.value = ''
      if (feedbackAbort === controller) feedbackAbort = null
    }
  }
}

interface RevisionPhotoState {
  assetId: string
  preview: string
  pct: number
  error: string
  ocrJob: CreativeWorkOCRJobDTO | null
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
    !!job.confirmed_digest &&
    job.confirmed_content === (revisionDraft.value[w.record_id] || '').trim()
  )
}

function applyRevisionOCRJob(
  recordId: string,
  state: RevisionPhotoState,
  job: CreativeWorkOCRJobDTO,
) {
  if (revisionPhotos.value[recordId] !== state || job.source_asset_id !== state.assetId) return
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
  if (!state?.assetId || work?.work_type !== 'writing') return
  const assetId = state.assetId
  const generation = ++state.ocrGeneration
  state.ocrBusy = true
  state.ocrError = ''
  state.ocrJob = null
  try {
    const job = await k12CreateCreativeWorkOCR({
      agent: props.agentId,
      request_id: state.ocrRequestId,
      source_asset_id: assetId,
    })
    if (revisionPhotos.value[recordId] !== state || generation !== state.ocrGeneration) return
    applyRevisionOCRJob(recordId, state, job)
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
  const job = state.ocrJob
  if (!job) {
    await startRevisionOCR(recordId)
    return
  }
  const generation = ++state.ocrGeneration
  state.ocrBusy = true
  state.ocrError = ''
  try {
    const updated = await k12RetryCreativeWorkOCR(props.agentId, job.job_id)
    if (revisionPhotos.value[recordId] !== state || generation !== state.ocrGeneration) return
    applyRevisionOCRJob(recordId, state, updated)
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
  const content = (revisionDraft.value[recordId] || '').trim()
  if (!state || !job || !content || state.ocrBusy) return
  const generation = ++state.ocrGeneration
  state.ocrBusy = true
  state.ocrError = ''
  try {
    const confirmed = await k12ConfirmCreativeWorkOCR(props.agentId, job.job_id, content)
    if (revisionPhotos.value[recordId] !== state || generation !== state.ocrGeneration) return
    applyRevisionOCRJob(recordId, state, confirmed)
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
  if (previous?.preview) URL.revokeObjectURL(previous.preview)
  revisionPhotoFiles.set(w.record_id, file)
  revisionPhotos.value[w.record_id] = {
    assetId: '',
    preview: URL.createObjectURL(file),
    pct: 0,
    error: '',
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
    if (work?.work_type === 'writing') void startRevisionOCR(recordId)
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
      const ocrJob = photoState?.ocrJob
      const ocr =
        w.work_type === 'writing' &&
        ocrJob?.status === 'confirmed' &&
        ocrJob.confirmed_version &&
        ocrJob.confirmed_digest
          ? {
              jobId: ocrJob.job_id,
              version: ocrJob.confirmed_version,
              digest: ocrJob.confirmed_digest,
            }
          : undefined
      await k12SubmitWorkRevision(props.agentId, w.record_id, content || undefined, assetId, ocr)
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

async function archive(w: CreativeWorkDTO) {
  busyId.value = w.record_id
  try {
    await k12ArchiveCreativeWork(props.agentId, w.record_id)
    toast.success(t('k12.works.archive'))
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

    <div class="k12cw__filter" role="tablist" aria-label="作品类型">
      <span class="k12cw__filter-label">{{ t('k12.works.typeLabel') }}</span>
      <button :class="{ on: typeFilter === '' }" @click="typeFilter = ''">全部</button>
      <button :class="{ on: typeFilter === 'writing' }" @click="typeFilter = 'writing'">
        {{ t('k12.works.writing') }}
      </button>
      <button :class="{ on: typeFilter === 'art' }" @click="typeFilter = 'art'">
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
    <div v-else-if="loading && works.length === 0" class="k12cw__empty">…</div>
    <div v-else-if="filtered.length === 0" class="k12cw__empty" data-testid="cw-empty">
      {{ t('k12.works.empty') }}
    </div>

    <ul v-else class="k12cw__list" data-testid="cw-list">
      <li
        v-for="w in filtered"
        :key="w.record_id"
        class="k12cw__card"
        :class="{ 'k12cw__card--expanded': expandedId === w.record_id }"
      >
        <div class="k12cw__preview" :class="`k12cw__preview--${w.work_type}`">
          <img
            v-if="workThumbURL(w)"
            :src="workThumbURL(w)"
            class="k12cw__thumb"
            :alt="w.title"
            data-testid="cw-thumb"
            loading="lazy"
          />
          <span v-else class="k12cw__preview-placeholder" aria-hidden="true" />
        </div>
        <div class="k12cw__copy">
          <header class="k12cw__head">
            <span class="k12cw__kind">{{
              w.work_type === 'writing' ? t('k12.works.writing') : t('k12.works.art')
            }}</span>
            <b class="k12cw__title">{{ w.title }}</b>
            <span :class="`k12cw__pill k12cw__pill--${statusTone(w.status)}`">{{
              w.status_label
            }}</span>
            <span class="k12cw__vers"
              >{{ w.versions.length }} {{ t('k12.works.versionCount') }}</span
            >
          </header>
          <div class="k12cw__evidence">
            <span>{{ t('k12.works.versionCount') }}：{{ w.versions.length }}</span>
            <span>{{ w.task }}</span>
          </div>
          <p class="k12cw__summary">{{ cardSummary(w) }}</p>
          <button
            class="k12cw__detail-toggle"
            data-testid="cw-detail-toggle"
            @click="toggleDetails(w)"
          >
            {{
              expandedId === w.record_id
                ? t('k12.works.collapseDetail')
                : isReviewed(w)
                  ? t('k12.works.viewReview')
                  : t('k12.works.startReview')
            }}
          </button>

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
                    <div class="k12cw__feedback-facts">
                      <b>{{ t('k12.works.feedbackObservations') }}</b>
                      <ul class="k12cw__feedback-list">
                        <li
                          v-for="(observation, index) in ver.structured_feedback.observations"
                          :key="`${observation.dimension}-${index}`"
                        >
                          <span class="k12cw__feedback-dimension">{{
                            feedbackDimensionLabel(observation.dimension)
                          }}</span>
                          <MarkdownRenderer :content="observation.evidence" />
                        </li>
                      </ul>
                      <b>{{ t('k12.works.feedbackSuggestions') }}</b>
                      <ol class="k12cw__feedback-list">
                        <li
                          v-for="suggestion in ver.structured_feedback.suggestions"
                          :key="suggestion"
                        >
                          <MarkdownRenderer :content="suggestion" />
                        </li>
                      </ol>
                      <p class="k12cw__feedback-limit">
                        <b>{{ t('k12.works.feedbackLimitations') }}</b>
                        {{ ver.structured_feedback.limitations }}
                      </p>
                      <div
                        class="k12cw__feedback-actions"
                        :aria-label="t('k12.works.feedbackAllowedActions')"
                      >
                        <span
                          v-for="action in ver.structured_feedback.allowed_actions"
                          :key="action"
                        >
                          {{ feedbackActionLabel(action) }}
                        </span>
                      </div>
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
                    <MarkdownRenderer data-testid="cw-version-feedback" :content="ver.feedback" />
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
                      <template v-if="ver.feedback_skill"> · {{ ver.feedback_skill }}</template>
                    </small>
                  </div>
                </div>
              </li>
            </ol>

            <!-- 发送点评要点（任务3，§3.10：点评可发送到手机）：失败诚实降级为复制文本 -->
            <div v-if="latestFeedbackOf(w) && w.status !== 'archived'" class="k12cw__sendrow">
              <button
                class="k12cw__btn k12cw__btn--ghost"
                data-testid="cw-send-feedback"
                :disabled="busyId === w.record_id"
                @click="sendToPhone(w, 'feedback')"
              >
                {{ t('k12.works.sendFeedback') }}
              </button>
              <div
                v-if="deliveryOf(w, 'feedback')"
                class="k12cw__delivery"
                :class="`k12cw__delivery--${deliveryOf(w, 'feedback')?.status}`"
                data-testid="cw-feedback-delivery-receipt"
                role="status"
              >
                <span>{{ deliveryTextOf(w, 'feedback') }}</span>
                <button
                  v-if="deliveryOf(w, 'feedback')?.status === 'failed'"
                  type="button"
                  data-testid="cw-feedback-delivery-retry"
                  @click="retryPhoneDelivery(w, 'feedback')"
                >
                  {{ t('k12.delivery.retry') }}
                </button>
                <button
                  v-if="
                    deliveryOf(w, 'feedback')?.status === 'sending' ||
                    deliveryOf(w, 'feedback')?.status === 'outcome_unknown'
                  "
                  type="button"
                  data-testid="cw-feedback-delivery-query"
                  @click="queryPhoneDelivery(w, 'feedback')"
                >
                  {{ t('k12.delivery.query') }}
                </button>
              </div>
              <div
                v-if="deliverySetupErrorOf(w, 'feedback')"
                class="k12cw__delivery k12cw__delivery--failed"
                data-testid="cw-feedback-bind-required"
              >
                <span>{{ deliverySetupErrorOf(w, 'feedback') }}</span>
                <a href="/channels">{{ t('k12.delivery.bindCTA') }}</a>
              </div>
            </div>

            <!-- 观察练习卡（任务2，§3.10 美术）：练习必须有产物——归档在版本记录，
             承诺即动作：打印 / 发送到手机 / 完成打卡；不进错题与练习集 -->
            <div v-if="practiceCardOf(w)" class="k12cw__pcard" data-testid="cw-practice-card">
              <b>{{ t('k12.works.practiceCardTitle') }}</b>
              <p class="k12cw__pcardtext">{{ practiceCardOf(w)!.practice_card }}</p>
              <p
                v-if="practiceCardOf(w)!.practice_card_done_at"
                class="k12cw__pcarddone"
                data-testid="cw-card-done-state"
              >
                ✓ {{ t('k12.works.practiceCardDoneAt') }}
              </p>
              <div class="k12cw__linkbtns">
                <button
                  class="k12cw__btn k12cw__btn--ghost"
                  data-testid="cw-card-print"
                  :disabled="printBusyId === w.record_id"
                  @click="printCard(w)"
                >
                  {{ t('k12.works.practiceCardPrint') }}
                </button>
                <button
                  class="k12cw__btn k12cw__btn--ghost"
                  data-testid="cw-card-save-pdf"
                  :disabled="savePdfBusyId === w.record_id"
                  @click="saveCardPdf(w)"
                >
                  {{ t('k12.works.practiceCardSavePdf') }}
                </button>
                <button
                  class="k12cw__btn k12cw__btn--ghost"
                  data-testid="cw-card-send"
                  :disabled="busyId === w.record_id"
                  @click="sendToPhone(w, 'practice_card')"
                >
                  {{ t('k12.works.practiceCardSend') }}
                </button>
                <button
                  v-if="!practiceCardOf(w)!.practice_card_done_at"
                  class="k12cw__btn"
                  data-testid="cw-card-done"
                  :disabled="busyId === w.record_id"
                  @click="markCardDone(w)"
                >
                  {{ t('k12.works.practiceCardMarkDone') }}
                </button>
              </div>
              <div
                v-if="deliveryOf(w, 'practice_card')"
                class="k12cw__delivery"
                :class="`k12cw__delivery--${deliveryOf(w, 'practice_card')?.status}`"
                data-testid="cw-card-delivery-receipt"
                role="status"
              >
                <span>{{ deliveryTextOf(w, 'practice_card') }}</span>
                <button
                  v-if="deliveryOf(w, 'practice_card')?.status === 'failed'"
                  type="button"
                  data-testid="cw-card-delivery-retry"
                  @click="retryPhoneDelivery(w, 'practice_card')"
                >
                  {{ t('k12.delivery.retry') }}
                </button>
                <button
                  v-if="
                    deliveryOf(w, 'practice_card')?.status === 'sending' ||
                    deliveryOf(w, 'practice_card')?.status === 'outcome_unknown'
                  "
                  type="button"
                  data-testid="cw-card-delivery-query"
                  @click="queryPhoneDelivery(w, 'practice_card')"
                >
                  {{ t('k12.delivery.query') }}
                </button>
              </div>
              <div
                v-if="deliverySetupErrorOf(w, 'practice_card')"
                class="k12cw__delivery k12cw__delivery--failed"
                data-testid="cw-card-bind-required"
              >
                <span>{{ deliverySetupErrorOf(w, 'practice_card') }}</span>
                <a href="/channels">{{ t('k12.delivery.bindCTA') }}</a>
              </div>
              <p
                v-if="printError[w.record_id]"
                class="k12cw__inlineerr"
                data-testid="cw-card-print-error"
              >
                {{ printError[w.record_id] }}
                <button
                  class="k12cw__btn k12cw__btn--ghost"
                  data-testid="cw-card-print-retry"
                  :disabled="printBusyId === w.record_id"
                  @click="printCard(w)"
                >
                  {{ t('k12.works.retry') }}
                </button>
              </p>
              <p class="k12cw__ainote">{{ t('k12.works.practiceCardHint') }}</p>
            </div>

            <!-- 待点评 / 已修改：后端 Skill 真实生成 + 家长手写，两条入口均只写证据化点评。 -->
            <div v-if="w.status === 'draft' || w.status === 'revised'" class="k12cw__act">
              <HcClearableField>
                <textarea
                  v-model="feedbackDraft[w.record_id]"
                  class="k12cw__input"
                  :placeholder="t('k12.works.addFeedback') + '（只给具体建议，不打分不代写）'"
                  rows="2"
                  data-testid="cw-feedback-input"
                ></textarea>
              </HcClearableField>
              <div class="k12cw__linkbtns">
                <button
                  class="k12cw__btn k12cw__btn--ghost"
                  data-testid="cw-feedback-generate"
                  :disabled="!!feedbackGeneratingId || busyId === w.record_id"
                  @click="generateFeedback(w)"
                >
                  {{ t('k12.works.aiGenerate') }}
                </button>
                <span
                  v-if="feedbackGeneratingId === w.record_id"
                  class="k12cw__ainote"
                  data-testid="cw-feedback-generating"
                  >{{ t('k12.works.aiGenerating') }}</span
                >
              </div>
              <p
                v-if="feedbackGenerateError[w.record_id]"
                class="k12cw__inlineerr"
                data-testid="cw-feedback-generate-error"
              >
                {{ feedbackGenerateError[w.record_id] }}
                <button
                  class="k12cw__btn k12cw__btn--ghost"
                  data-testid="cw-feedback-generate-retry"
                  :disabled="!!feedbackGeneratingId"
                  @click="generateFeedback(w)"
                >
                  {{ t('k12.works.retry') }}
                </button>
              </p>
              <button
                class="k12cw__btn k12cw__btn--primary"
                :disabled="busyId === w.record_id || !(feedbackDraft[w.record_id] || '').trim()"
                data-testid="cw-feedback-submit"
                @click="submitFeedback(w)"
              >
                {{ t('k12.works.addFeedback') }}
              </button>
            </div>

            <!-- 已点评：提交修改稿 -->
            <div v-else-if="w.status === 'feedback_ready'" class="k12cw__act">
              <HcClearableField>
                <textarea
                  v-model="revisionDraft[w.record_id]"
                  class="k12cw__input"
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
                    {{ t('k12.works.photoUploading') }} {{ revisionPhotos[w.record_id]!.pct }}%
                  </span>
                  <span
                    v-else-if="revisionPhotos[w.record_id]!.error"
                    class="k12cw__inlineerr"
                    data-testid="cw-revision-photo-error"
                    >{{ revisionPhotos[w.record_id]!.error }}</span
                  >
                  <span v-else-if="revisionPhotos[w.record_id]!.assetId" class="k12cw__ainote">
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
                        revisionPhotos[w.record_id]!.ocrJob?.status === 'awaiting_confirmation' ||
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
            </div>

            <!-- 点评联动出口（§3.10，仅写作 · 已点评）：好句入积累 / 确认错处入错题 -->
            <div
              v-if="w.work_type === 'writing' && w.status === 'feedback_ready'"
              class="k12cw__link"
            >
              <div class="k12cw__linkbtns">
                <button
                  class="k12cw__btn k12cw__btn--ghost"
                  data-testid="cw-accum-open"
                  @click="toggleAccum(w)"
                >
                  {{ t('k12.works.toAccum') }}
                </button>
                <button
                  class="k12cw__btn k12cw__btn--ghost"
                  data-testid="cw-mistake-open"
                  @click="toggleMistake(w)"
                >
                  {{ t('k12.works.toMistake') }}
                </button>
              </div>
              <div v-if="accumOpenId === w.record_id" class="k12cw__linkform">
                <HcClearableField>
                  <textarea
                    v-model="accumDraft[w.record_id]"
                    class="k12cw__input"
                    :placeholder="t('k12.works.accumPlaceholder')"
                    rows="2"
                    data-testid="cw-accum-input"
                  ></textarea>
                </HcClearableField>
                <button
                  class="k12cw__btn k12cw__btn--primary"
                  :disabled="busyId === w.record_id || !(accumDraft[w.record_id] || '').trim()"
                  data-testid="cw-accum-submit"
                  @click="submitAccum(w)"
                >
                  {{ t('k12.works.confirm') }}
                </button>
              </div>
              <div v-if="mistakeOpenId === w.record_id" class="k12cw__linkform">
                <HcClearableField>
                  <textarea
                    v-model="mistakeDraft[w.record_id]"
                    class="k12cw__input"
                    :placeholder="t('k12.works.mistakePlaceholder')"
                    rows="2"
                    data-testid="cw-mistake-input"
                  ></textarea>
                </HcClearableField>
                <button
                  class="k12cw__btn k12cw__btn--primary"
                  :disabled="busyId === w.record_id || !(mistakeDraft[w.record_id] || '').trim()"
                  data-testid="cw-mistake-submit"
                  @click="submitMistake(w)"
                >
                  {{ t('k12.works.confirm') }}
                </button>
              </div>
            </div>

            <footer v-if="w.status !== 'archived'" class="k12cw__foot">
              <button
                class="k12cw__btn k12cw__btn--ghost"
                :disabled="busyId === w.record_id"
                @click="archive(w)"
              >
                {{ t('k12.works.archive') }}
              </button>
            </footer>
          </div>
        </div>
      </li>
    </ul>

    <!-- 添加作品弹窗（原型 5326-5361）。z-index 走 modal 令牌，与 K12BackupModal 同层。 -->
    <div
      v-if="addOpen"
      class="k12cw-overlay"
      data-testid="cw-add-modal"
      @click.self="closeAdd"
    >
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
                <span v-else-if="photoError" class="k12cw__photoerr" data-testid="cw-photo-error">{{
                  photoError
                }}</span>
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
                  @click="resetPhoto"
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
              addType === 'writing' ? t('k12.works.taskLabelWriting') : t('k12.works.taskLabelArt')
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
  gap: 14px;
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
  padding: 8px 12px;
  font-size: 10.5px;
  color: var(--hc-text-secondary);
}
.k12cw__kpi b {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--hc-text-primary);
  font-variant-numeric: tabular-nums;
}
.k12cw__rules {
  border: 0.5px solid var(--hc-border);
  border-left: 3px solid var(--hc-accent);
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-card);
  padding: 10px 13px;
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--hc-text-secondary);
  margin-bottom: 12px;
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
.k12cw__link {
  border-top: 0.5px dashed var(--hc-border);
  padding-top: 8px;
  margin-bottom: 8px;
  display: grid;
  gap: 7px;
}
.k12cw__linkbtns {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
}
.k12cw__linkbtns .k12cw__btn--ghost {
  border-color: var(--hc-border);
}
.k12cw__linkform {
  display: grid;
  gap: 7px;
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
}
.k12cw__sendrow {
  display: grid;
  justify-items: end;
  gap: 7px;
  margin-bottom: 8px;
}
.k12cw__sendrow .k12cw__btn--ghost {
  border-color: var(--hc-border);
}
.k12cw__delivery {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border-radius: var(--hc-radius-sm);
  background: var(--hc-accent-subtle);
  color: var(--hc-text-secondary);
  font-size: 11.5px;
}
.k12cw__delivery--delivered {
  color: var(--hc-success);
}
.k12cw__delivery--failed,
.k12cw__delivery--outcome_unknown {
  color: var(--hc-error);
  background: color-mix(in srgb, var(--hc-error) 8%, transparent);
}
.k12cw__delivery button,
.k12cw__delivery a {
  flex-shrink: 0;
  border: 0;
  background: transparent;
  color: var(--hc-accent);
  cursor: pointer;
  font: inherit;
  font-weight: 650;
  text-decoration: none;
}
.k12cw__pcard {
  border: 0.5px solid var(--hc-border);
  border-left: 3px solid var(--hc-success);
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input);
  padding: 10px 13px;
  margin-bottom: 10px;
  display: grid;
  gap: 7px;
}
.k12cw__pcard > b {
  font-size: 12px;
  color: var(--hc-text-primary);
}
.k12cw__pcardtext {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--hc-text-secondary);
  white-space: pre-line;
}
.k12cw__pcarddone {
  margin: 0;
  font-size: 11px;
  color: var(--hc-success);
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
  padding: clamp(12px, 9vh, 72px) 12px;
  overflow-y: auto;
  background: rgba(8, 18, 32, 0.4);
  backdrop-filter: blur(3px) saturate(120%);
  -webkit-backdrop-filter: blur(3px) saturate(120%);
}
.k12cw-modal {
  width: 478px;
  max-width: 100%;
  max-height: 100%;
  overflow: auto;
  background: var(--hc-bg-elevated);
  border: 0.5px solid var(--hc-border);
  border-radius: 16px;
  box-shadow: var(--hc-shadow-float);
}
.k12cw-modal__head {
  display: flex;
  align-items: center;
  padding: 15px 18px;
  border-bottom: 0.5px solid var(--hc-border);
  font-size: 14.5px;
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
  padding: 16px 18px;
  display: grid;
  gap: 13px;
}
.k12cw-modal__field {
  display: grid;
  gap: 6px;
}
.k12cw-modal__field > span {
  font-size: 12.5px;
  color: var(--hc-text-primary);
}
.k12cw-modal__foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 13px 18px;
  border-top: 0.5px solid var(--hc-border);
}
.k12cw__filter {
  display: flex;
  align-items: center;
  gap: 3px;
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-card);
}
.k12cw__filter-label {
  margin-right: 8px;
  font-size: 11px;
  color: var(--hc-text-secondary);
}
.k12cw__filter button {
  font: inherit;
  font-size: 12px;
  border: none;
  background: transparent;
  color: var(--hc-text-secondary);
  padding: 6px 12px;
  border-radius: var(--hc-radius-md);
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.15s;
}
.k12cw__filter button:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}
.k12cw__filter button.on {
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  font-weight: 600;
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
.k12cw__empty {
  color: var(--hc-text-muted);
  font-size: 13px;
  padding: 24px 4px;
  line-height: 1.6;
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
  border-radius: var(--hc-radius-lg);
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
.k12cw__card--expanded {
  grid-column: 1 / -1;
  grid-template-columns: 150px minmax(0, 1fr);
  transform: none;
}
.k12cw__preview {
  height: 112px;
  min-height: 112px;
  border-radius: 12px;
  overflow: hidden;
  position: relative;
  background: linear-gradient(180deg, #a9c9e6 0 54%, #8fbb7d 54% 76%, #729a63 76%);
}
.k12cw__card--expanded .k12cw__preview {
  height: 150px;
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
  gap: 8px;
  flex-wrap: wrap;
}
.k12cw__kind {
  font-size: 10.5px;
  font-weight: 650;
  color: var(--hc-accent);
  background: var(--hc-accent-subtle);
  border-radius: 4px;
  padding: 2px 7px;
}
.k12cw__title {
  font-size: 13.5px;
  color: var(--hc-text-primary);
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
  color: var(--hc-accent);
  background: var(--hc-accent-subtle);
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
  padding: 5px 0;
  color: var(--hc-text-primary);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.k12cw__card:not(.k12cw__card--expanded) .k12cw__details {
  display: none;
}
.k12cw__details {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 0.5px dashed var(--hc-border);
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
.k12cw__feedback-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.k12cw__feedback-actions span {
  padding: 2px 7px;
  border: 1px solid var(--hc-border);
  border-radius: 999px;
  background: var(--hc-bg-subtle);
}
.k12cw__act {
  display: grid;
  gap: 7px;
  margin-bottom: 8px;
}
.k12cw__input {
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
.k12cw__foot {
  display: flex;
  justify-content: flex-end;
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
  .k12cw__card,
  .k12cw__card--expanded {
    grid-template-columns: 88px minmax(0, 1fr);
  }
  .k12cw__kpis {
    width: 100%;
    overflow-x: auto;
  }
}
</style>
