<!--
  K12 练习集面板（PRD §3.8 购物车模型 · 2026-07-18 收敛 / §4.13 呈现物规范）。
  页面固定两段：**待打印篮**（单一 draft，按学科分组、阻断沉底、逐题移除）+ **打印历史**（倒序，三态呈现）。
  打印/发送即家长确认（finalize 一步固化，逐题跳过阻断题）；界面不展示六态时间轴（三态：待打印/待完成/已批改）。
-->
<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import {
  k12ListPracticeSets,
  k12FinalizePracticeSet,
  k12RemoveFromBasket,
  k12AdvancePracticeSet,
  k12SubmitPracticeSet,
  k12GradePracticeSet,
  k12CancelPracticeSet,
  k12GetPracticePaper,
  k12GetPracticePrintJobPaper,
  k12PreparePracticePrintJob,
  k12RecordPracticePrintEvent,
  k12RetryPracticePrintJob,
  k12UploadAsset,
  k12AssetURL,
  type PracticeSetDTO,
  type PracticeItemDTO,
  type PracticePaperResp,
  type PracticeReturnAssetDTO,
} from '@/api/k12'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import { printPracticePaper, printPracticePaperWithReceipt, savePracticePaperPdf } from '../export'
import { printPersistentArtifact } from '../persistent-print'

const props = defineProps<{ agentId: string }>()
const emit = defineEmits<{ (event: 'count', count: number): void }>()
const { t, locale } = useI18n()
const toast = useToast()

const sets = ref<PracticeSetDTO[]>([])
const loading = ref(false)
const error = ref('')
const busy = ref('') // record_id（或 record_id:item_id）级操作锁
let printRequestSequence = 0

function newPrintIdempotencyKey(recordId: string): string {
  const nonce = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${++printRequestSequence}`
  return `desktop-print:${props.agentId}:${recordId}:${nonce}`
}

async function load() {
  if (!props.agentId) return
  loading.value = true
  error.value = ''
  try {
    const resp = await k12ListPracticeSets(props.agentId)
    sets.value = resp.items ?? []
  } catch (e) {
    error.value = (e as Error).message || t('k12.practice.loadError')
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(() => props.agentId, load)
defineExpose({ load })

// ── 待打印篮（单 Learner 单篮：draft 态练习集，§3.8）──
const basket = computed(() => sets.value.find((s) => s.status === 'draft') ?? null)
watch(
  () => basket.value?.items.length ?? 0,
  (count) => emit('count', count),
  { immediate: true },
)

// §4.13 卷面学科分组顺序：数学→语文→英语→科学→信息科技→未分科；阻断题沉底独立组。
const SUBJECT_ORDER = ['数学', '语文', '英语', '科学', '信息科技']
interface BasketGroup {
  key: string
  label: string
  blocked: boolean
  items: PracticeItemDTO[]
}
const basketGroups = computed<BasketGroup[]>(() => {
  const b = basket.value
  if (!b) return []
  const verified = b.items.filter((it) => it.verification_status === 'verified')
  const blocked = b.items.filter((it) => it.verification_status !== 'verified')
  const groups: BasketGroup[] = []
  for (const subj of [...SUBJECT_ORDER, '']) {
    const items = verified.filter((it) => (it.subject ?? '') === subj)
    if (items.length)
      groups.push({ key: subj || 'other', label: subj || '其他', blocked: false, items })
  }
  if (blocked.length)
    groups.push({
      key: 'blocked',
      label: t('k12.practice.blockedGroup'),
      blocked: true,
      items: blocked,
    })
  return groups
})
const verifiedCount = computed(
  () => basket.value?.items.filter((it) => it.verification_status === 'verified').length ?? 0,
)
const blockedCount = computed(() => (basket.value?.items.length ?? 0) - verifiedCount.value)
const canFinalize = computed(() => verifiedCount.value > 0)

// 篮内连续题号（§4.13 paper_seq 镜像）：只给 verified 题按分组顺序编号；阻断题无题号。
const seqOf = computed(() => {
  const m = new Map<string, number>()
  let n = 0
  for (const g of basketGroups.value) {
    if (g.blocked) continue
    for (const it of g.items) m.set(it.item_id, ++n)
  }
  return m
})

// added_via → 来源小字（§3.8 装篮入口三个）。
function viaLabel(via?: string): string {
  switch (via) {
    case 'weekly':
      return '每周自动加入'
    case 'single_variant':
      return '错题再练加入'
    case 'custom':
      return '组卷加入'
    case 'accumulation':
      return '积累默写加入'
    case 'manual':
      return '手工加入'
    default:
      return ''
  }
}

async function removeItem(it: PracticeItemDTO) {
  const b = basket.value
  if (!b) return
  busy.value = `${b.record_id}:${it.item_id}`
  try {
    await k12RemoveFromBasket(props.agentId, b.record_id, it.item_id)
    await load()
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busy.value = ''
  }
}

async function finalize(via: 'print' | 'send') {
  const b = basket.value
  if (!b) return
  busy.value = b.record_id
  let finalized = false
  try {
    if (via === 'print') {
      // DD-023A：后端先冻结卷源并预占卷面号；原生对话框的 definitive
      // receipt 再原子推进 PrintJob + PracticeSet。旧 finalize(print) 不得
      // 旁路这条链，取消/失败/未知态都必须保留 draft。
      const prepared = await k12PreparePracticePrintJob(
        props.agentId,
        b.record_id,
        newPrintIdempotencyKey(b.record_id),
        'question',
      )
      let job = prepared.print_job
      if (job.status === 'printed') {
        finalized = true
        toast.success(t('k12.practice.print'))
        return
      }
      if (job.status === 'cancelled' || job.status === 'failed') {
        job = (await k12RetryPracticePrintJob(props.agentId, job.print_job_id)).print_job
      } else if (
        job.status === 'dialog_open' ||
        job.status === 'submitted' ||
        job.status === 'outcome_unknown'
      ) {
        throw new Error('上一次打印结果仍待核对，请先查询 PrintJob 回执')
      }

      const rendered = await k12GetPracticePrintJobPaper(
        props.agentId,
        job.print_job_id,
        'question',
      )
      await k12RecordPracticePrintEvent(props.agentId, job.print_job_id, {
        status: 'dialog_open',
      })

      let receipt
      try {
        receipt = await printPracticePaperWithReceipt(rendered.markdown, rendered.title)
      } catch (error) {
        await k12RecordPracticePrintEvent(props.agentId, job.print_job_id, {
          status: 'outcome_unknown',
          failure_kind: 'native_adapter_interrupted',
          failure_detail: '系统打印对话框未返回可验证回执',
        })
        throw error
      }

      if (receipt.status === 'cancelled') {
        await k12RecordPracticePrintEvent(props.agentId, job.print_job_id, {
          status: 'cancelled',
          native_job_id: receipt.native_job_id,
          printer_snapshot: receipt.printer_snapshot,
        })
        throw new Error(t('k12.practice.paperPrintFailed'))
      }

      await k12RecordPracticePrintEvent(props.agentId, job.print_job_id, {
        status: 'submitted',
        native_job_id: receipt.native_job_id,
      })
      await k12RecordPracticePrintEvent(props.agentId, job.print_job_id, {
        status: 'printed',
        native_job_id: receipt.native_job_id,
        native_receipt_id: receipt.native_receipt_id,
        printer_snapshot: receipt.printer_snapshot,
      })
      finalized = true
      const skipped =
        blockedCount.value > 0 ? ` · ${t('k12.practice.skipped', { n: blockedCount.value })}` : ''
      toast.success(`${t('k12.practice.print')}${skipped}`)
      return
    }

    const resp = await k12FinalizePracticeSet(props.agentId, b.record_id, 'send', '手机私聊')
    finalized = true
    const skipped =
      resp.skipped_blocked_count > 0
        ? ` · ${t('k12.practice.skipped', { n: resp.skipped_blocked_count })}`
        : ''
    if (resp.set.delivery_status === 'pending') {
      toast.info(resp.delivery_note || t('k12.practice.deliveryPending'))
    } else if (resp.set.delivery_status === 'failed') {
      toast.warning(t('k12.practice.deliveryFailed'))
    } else {
      toast.success(`${t('k12.practice.assign')}${skipped}`)
    }
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    if (finalized) await load()
    busy.value = ''
  }
}

// ── 打印历史（非 draft；finalized_at 倒序，§4.13 唯一排序依据）──
const history = computed(() =>
  sets.value
    .filter((s) => s.status !== 'draft')
    .sort((a, b) => (b.finalized_at ?? 0) - (a.finalized_at ?? 0)),
)

// 三态呈现（§3.8 状态机映射）：待完成（confirmed/assigned/submitted）/ 已批改（graded/closed）/ 已取消。
function displayState(s: PracticeSetDTO): { label: string; tone: string } {
  if (s.status === 'cancelled') return { label: s.status_label, tone: 'muted' }
  if (s.status === 'graded' || s.status === 'closed') return { label: '已批改', tone: 'got' }
  return { label: '待完成', tone: 'todo' }
}

async function advance(s: PracticeSetDTO, step: 'submit' | 'grade' | 'close', okMsg: string) {
  busy.value = s.record_id
  try {
    await k12AdvancePracticeSet(props.agentId, s.record_id, step)
    toast.success(okMsg)
    await load()
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busy.value = ''
  }
}

// ── 作答回传 / 逐题复批（§3.8）──
// 禁止直接用 agent-only 旧调用推进：回传必须有真实照片和覆盖题；复批必须逐题给出对/错，
// 从调用侧彻底封死后端“空 results = 整卷通过”的兼容旁路。
interface ReturnDraft {
  set: PracticeSetDTO | null
  file: File | null
  itemIds: string[]
  /** 上传成功后保留；submit 结果未知时重试不再制造第二份资产。 */
  assetId: string
  /** 同一请求快照重试必须复用，后端按它返回既有 return_assets 记录。 */
  returnId: string
  requestFingerprint: string
}
const emptyReturnDraft = (): ReturnDraft => ({
  set: null,
  file: null,
  itemIds: [],
  assetId: '',
  returnId: '',
  requestFingerprint: '',
})
const returnDraft = ref<ReturnDraft>(emptyReturnDraft())
const returnError = ref('')
let returnIdSequence = 0

function newReturnId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return `desktop-return:${props.agentId}:${uuid ?? `${Date.now()}-${++returnIdSequence}`}`
}
const returnOpen = computed(() => !!returnDraft.value.set)
const returnItems = computed(
  () => returnDraft.value.set?.items.filter((it) => it.verification_status === 'verified') ?? [],
)
const returnCanSubmit = computed(
  () => !!returnDraft.value.file && returnDraft.value.itemIds.length > 0,
)
function openReturn(s: PracticeSetDTO) {
  returnError.value = ''
  returnDraft.value = { ...emptyReturnDraft(), set: s }
}
function closeReturn() {
  if (busy.value) return
  returnError.value = ''
  returnDraft.value = emptyReturnDraft()
}
function pickReturnFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0] ?? null
  returnError.value = ''
  returnDraft.value.assetId = ''
  returnDraft.value.returnId = ''
  returnDraft.value.requestFingerprint = ''
  if (!file) {
    returnDraft.value.file = null
    return
  }
  if (!file.type.startsWith('image/')) {
    toast.error(t('k12.practice.returnPhotoType'))
    ;(e.target as HTMLInputElement).value = ''
    returnDraft.value.file = null
    return
  }
  if (file.size > 10 * 1024 * 1024) {
    toast.error(t('k12.practice.returnPhotoSize'))
    ;(e.target as HTMLInputElement).value = ''
    returnDraft.value.file = null
    return
  }
  returnDraft.value.file = file
}
async function submitReturn() {
  const s = returnDraft.value.set
  const file = returnDraft.value.file
  if (!s || !file || !returnDraft.value.itemIds.length) return
  busy.value = s.record_id
  returnError.value = ''
  try {
    if (!returnDraft.value.assetId) {
      const asset = await k12UploadAsset(props.agentId, file)
      returnDraft.value.assetId = asset.asset_id
    }
    const itemIds = [...returnDraft.value.itemIds]
    const fingerprint = `${returnDraft.value.assetId}\n${[...itemIds].sort().join(',')}`
    if (!returnDraft.value.returnId || returnDraft.value.requestFingerprint !== fingerprint) {
      returnDraft.value.returnId = newReturnId()
      returnDraft.value.requestFingerprint = fingerprint
    }
    const updated = await k12SubmitPracticeSet(props.agentId, s.record_id, {
      return_id: returnDraft.value.returnId,
      asset_id: returnDraft.value.assetId,
      item_ids: itemIds,
    })
    const index = sets.value.findIndex((entry) => entry.record_id === updated.record_id)
    if (index >= 0) sets.value.splice(index, 1, updated)
    toast.success(t('k12.practice.returnSaved'))
    returnDraft.value = emptyReturnDraft()
  } catch (e) {
    returnError.value = (e as Error).message || t('k12.practice.returnFailed')
  } finally {
    busy.value = ''
  }
}

function itemHasReturn(it: PracticeItemDTO): boolean {
  return !!it.return_ids?.length || !!it.returned
}

function canUploadReturn(s: PracticeSetDTO): boolean {
  return s.status === 'assigned' || s.status === 'submitted'
}

function canGradeReturn(s: PracticeSetDTO): boolean {
  return (
    s.status === 'submitted' &&
    s.items.some(
      (it) =>
        it.verification_status === 'verified' &&
        itemHasReturn(it) &&
        it.result_correct === undefined,
    )
  )
}

function returnButtonLabel(s: PracticeSetDTO): string {
  return s.return_assets?.length ? t('k12.practice.returnContinue') : t('k12.practice.submit')
}

function returnPaperSeqs(s: PracticeSetDTO, asset: PracticeReturnAssetDTO): string {
  const positions = asset.item_ids.map((itemId) => {
    const index = s.items.findIndex((item) => item.item_id === itemId)
    const item = index >= 0 ? s.items[index] : undefined
    return item?.paper_seq ?? (index >= 0 ? index + 1 : '?')
  })
  return positions.join('、')
}

function returnTimeLabel(returnedAt: number): string {
  if (!returnedAt) return ''
  return new Intl.DateTimeFormat(locale.value, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(returnedAt * 1000))
}

type GradeChoice = '' | 'correct' | 'incorrect'
const gradeDraft = ref<{ set: PracticeSetDTO | null; results: Record<string, GradeChoice> }>({
  set: null,
  results: {},
})
const gradeOpen = computed(() => !!gradeDraft.value.set)
const gradeItems = computed(
  () =>
    gradeDraft.value.set?.items.filter(
      (it) =>
        it.verification_status === 'verified' &&
        itemHasReturn(it) &&
        it.result_correct === undefined,
    ) ?? [],
)
const gradeCanSubmit = computed(
  () =>
    gradeItems.value.length > 0 &&
    gradeItems.value.every((it) => !!gradeDraft.value.results[it.item_id]),
)
function openGrade(s: PracticeSetDTO) {
  gradeDraft.value = {
    set: s,
    results: Object.fromEntries(
      s.items.filter((it) => it.verification_status === 'verified').map((it) => [it.item_id, '']),
    ),
  }
}
function closeGrade() {
  if (busy.value) return
  gradeDraft.value = { set: null, results: {} }
}
async function submitGrade() {
  const s = gradeDraft.value.set
  if (!s || !gradeCanSubmit.value) return
  const results = gradeItems.value.map((it) => ({
    item_id: it.item_id,
    correct: gradeDraft.value.results[it.item_id] === 'correct',
  }))
  busy.value = s.record_id
  try {
    await k12GradePracticeSet(props.agentId, s.record_id, results)
    toast.success(t('k12.practice.gradeSaved'))
    gradeDraft.value = { set: null, results: {} }
    await load()
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busy.value = ''
  }
}
// ── 题目卷/答案卷查看（§4.13 呈现物真实渲染，2026-07-18）──
// 历史卡片：正卷（页眉/页脚含卷面号）；待打印区：draft 预览走后端同一渲染器
// （诚实预览：预览口径 = 固化产物口径，无卷面号、明示“打印或发送后分配”）。
const paper = ref<{
  open: boolean
  loading: boolean
  error: string
  resp: PracticePaperResp | null
}>({
  open: false,
  loading: false,
  error: '',
  resp: null,
})
const paperRequest = ref<{ recordId: string; kind: 'question' | 'answer' } | null>(null)
async function openPaper(recordId: string, kind: 'question' | 'answer') {
  paperRequest.value = { recordId, kind }
  paper.value = { open: true, loading: true, error: '', resp: null }
  try {
    const resp = await k12GetPracticePaper(props.agentId, recordId, kind)
    paper.value = { open: true, loading: false, error: '', resp }
  } catch (e) {
    paper.value = {
      open: true,
      loading: false,
      error: (e as Error).message || t('k12.practice.paperLoadError'),
      resp: null,
    }
  }
}
function retryPaper() {
  const req = paperRequest.value
  if (req) void openPaper(req.recordId, req.kind)
}
function closePaper() {
  paper.value = { open: false, loading: false, error: '', resp: null }
  paperRequest.value = null
}
// 打印只对正卷开放：预览无卷面号，纸质卷必须走「打印题目卷」固化通道（打印即确认），
// 预览通道不得成为绕过固化的旁路。
async function printPaper() {
  const p = paper.value.resp
  const req = paperRequest.value
  if (!p || p.preview || !req) return
  // 重试开始即撤下上一次失败提示；本次仍失败时再写入新的可重试错误。
  paper.value.error = ''
  try {
    const title = p.title + (p.kind === 'answer' ? ' · ' + t('k12.practice.paperAnswer') : '')
    const ok = await printPersistentArtifact({
      agent: props.agentId,
      sourceKind: p.kind === 'answer' ? 'practice_answer' : 'practice_question',
      sourceRef: `practice-set:${req.recordId}:${p.kind}`,
      title,
      canonicalMarkdown: p.markdown,
      browserPrint: () => printPracticePaper(p.markdown, title),
    })
    if (!ok) throw new Error(t('k12.practice.paperPrintFailed'))
  } catch (e) {
    paper.value.error = (e as Error).message || t('k12.practice.paperPrintFailed')
  }
}

const paperSaveBusy = ref(false)
async function savePaperPdf() {
  const p = paper.value.resp
  if (!p || p.preview || paperSaveBusy.value) return
  paperSaveBusy.value = true
  try {
    await savePracticePaperPdf(
      p.markdown,
      p.title + (p.kind === 'answer' ? ' · ' + t('k12.practice.paperAnswer') : ''),
    )
  } catch (e) {
    paper.value.error = (e as Error).message || t('k12.practice.paperSavePdfFailed')
  } finally {
    paperSaveBusy.value = false
  }
}

function deliveryLabel(status: string): string {
  if (status === 'pending') return t('k12.practice.deliveryPendingShort')
  if (status === 'delivered') return t('k12.practice.deliveryDelivered')
  if (status === 'failed') return t('k12.practice.deliveryFailed')
  return ''
}

async function cancelSet(s: PracticeSetDTO) {
  busy.value = s.record_id
  try {
    await k12CancelPracticeSet(props.agentId, s.record_id)
    toast.success(t('k12.practice.cancel'))
    await load()
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <section class="k12ps">
    <div v-if="error" class="k12ps__err" data-testid="ps-error">
      <span>{{ error }}</span>
      <button class="k12ps__btn" data-testid="ps-load-retry" :disabled="loading" @click="load">
        {{ t('k12.practice.retry') }}
      </button>
    </div>

    <p v-if="loading && !error" class="k12ps__loading" role="status" data-testid="ps-loading">
      {{ t('common.loading') }}
    </p>

    <!-- ═══ 待打印篮 ═══ -->
    <template v-else-if="!error">
      <section class="k12ps__basket" aria-label="待打印" data-testid="ps-basket">
        <header class="k12ps__bhead">
          <div class="k12ps__bhead-copy">
            <h3 class="k12ps__btitle">
              {{ t('k12.practice.basketTitle') }}
              <span class="k12ps__pill k12ps__pill--todo" data-testid="ps-basket-count">{{
                t('k12.practice.itemCount', { n: basket?.items.length ?? 0 })
              }}</span>
            </h3>
            <p class="k12ps__bmeta">{{ t('k12.practice.basketMeta') }}</p>
            <p class="k12ps__bhint">{{ t('k12.practice.basketHint') }}</p>
          </div>
          <div class="k12ps__bactions">
            <button
              class="k12ps__btn k12ps__btn--primary"
              :disabled="!canFinalize || busy === basket?.record_id"
              :title="!canFinalize ? t('k12.practice.publishBlocked') : ''"
              data-testid="ps-finalize-print"
              @click="finalize('print')"
            >
              {{ t('k12.practice.print') }}
            </button>
            <button
              class="k12ps__btn"
              :disabled="!canFinalize || busy === basket?.record_id"
              data-testid="ps-finalize-send"
              @click="finalize('send')"
            >
              {{ t('k12.practice.assign') }}
            </button>
          </div>
        </header>

        <div
          v-if="!basket || basket.items.length === 0"
          class="k12ps__bempty"
          data-testid="ps-basket-empty"
        >
          {{ t('k12.practice.basketEmpty') }}
        </div>
        <template v-else>
          <div class="k12ps__groups">
            <template v-for="g in basketGroups" :key="g.key">
              <div
                class="k12ps__group"
                :class="{ 'k12ps__group--blocked': g.blocked }"
                :data-testid="g.blocked ? 'ps-blocked-group' : undefined"
              >
                {{ g.label }}
              </div>
              <div
                v-for="it in g.items"
                :key="it.item_id"
                class="k12ps__item"
                :class="{ 'k12ps__item--blocked': g.blocked }"
              >
                <i class="k12ps__seq">{{ g.blocked ? '–' : seqOf.get(it.item_id) }}</i>
                <div class="k12ps__qwrap">
                  <b class="k12ps__q">{{ it.question_markdown }}</b>
                  <small class="k12ps__qmeta">{{
                    [
                      viaLabel(it.added_via),
                      g.blocked ? it.blocked_reason : it.verification_evidence,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  }}</small>
                </div>
                <span class="k12ps__item-actions">
                  <span v-if="g.blocked" class="k12ps__vbadge k12ps__vbadge--na">{{
                    t('k12.practice.blocked')
                  }}</span>
                  <span v-else class="k12ps__vbadge k12ps__vbadge--ok">{{
                    t('k12.practice.verified')
                  }}</span>
                  <button
                    class="k12ps__rm"
                    :disabled="busy === `${basket!.record_id}:${it.item_id}`"
                    :title="t('k12.practice.removeTitle')"
                    data-testid="ps-remove-item"
                    @click="removeItem(it)"
                  >
                    {{ t('k12.practice.remove') }}
                  </button>
                </span>
              </div>
            </template>
          </div>
          <p v-if="blockedCount > 0 && canFinalize" class="k12ps__skiphint">
            {{ t('k12.practice.willSkip', { n: blockedCount }) }}
          </p>
          <p v-else-if="!canFinalize" class="k12ps__skiphint">
            {{ t('k12.practice.publishBlocked') }}
          </p>
        </template>
      </section>

      <!-- ═══ 打印历史 ═══ -->
      <section class="k12ps__history" aria-label="打印历史" data-testid="ps-history">
        <div class="k12ps__hhead">
          <h3 class="k12ps__htitle">{{ t('k12.practice.historyTitle') }}</h3>
          <span class="k12ps__hdesc">{{ t('k12.practice.historyDesc') }}</span>
        </div>
        <p v-if="history.length === 0" class="k12ps__hempty" data-testid="ps-history-empty">
          {{ t('k12.practice.historyEmpty') }}
        </p>
        <ul v-else class="k12ps__hlist" data-testid="ps-history-list">
          <li
            v-for="s in history"
            :key="s.record_id"
            class="k12ps__hcard"
            :class="{ 'k12ps__hcard--cancelled': s.status === 'cancelled' }"
          >
            <header class="k12ps__hcardtop">
              <b class="k12ps__htitle2">{{ s.title }}</b>
              <span v-if="s.paper_no" class="k12ps__paperno" data-testid="ps-paper-no">{{
                s.paper_no
              }}</span>
              <span :class="`k12ps__pill k12ps__pill--${displayState(s).tone}`">{{
                displayState(s).label
              }}</span>
            </header>
            <div class="k12ps__hmeta">
              <span>{{
                t('k12.practice.itemCount', {
                  n: s.items.filter((it) => it.verification_status === 'verified').length,
                })
              }}</span>
              <span v-if="s.skipped_blocked_count">{{
                t('k12.practice.skipped', { n: s.skipped_blocked_count })
              }}</span>
              <span v-if="s.delivery_target">→ {{ s.delivery_target }}</span>
              <span
                v-if="deliveryLabel(s.delivery_status)"
                :class="{
                  'k12ps__delivery--pending': s.delivery_status === 'pending',
                  'k12ps__delivery--failed': s.delivery_status === 'failed',
                }"
              >
                {{ deliveryLabel(s.delivery_status) }}
              </span>
            </div>
            <div
              v-if="s.return_assets?.length"
              class="k12ps__returns"
              role="list"
              :aria-label="t('k12.practice.returnHistory')"
              data-testid="ps-return-assets"
            >
              <article
                v-for="(asset, assetIndex) in s.return_assets ?? []"
                :key="asset.return_id"
                class="k12ps__return-asset"
                role="listitem"
                data-testid="ps-return-asset"
              >
                <img
                  :src="k12AssetURL(agentId, asset.asset_id)"
                  class="k12ps__return-thumb"
                  :alt="t('k12.practice.returnPhotoAlt', { n: assetIndex + 1 })"
                  loading="lazy"
                />
                <span>
                  <b>{{ t('k12.practice.returnPhotoNumber', { n: assetIndex + 1 }) }}</b>
                  ·
                  {{ t('k12.practice.returnCoveredNumbers', { nums: returnPaperSeqs(s, asset) }) }}
                </span>
                <time
                  v-if="asset.returned_at"
                  :datetime="new Date(asset.returned_at * 1000).toISOString()"
                >
                  {{ returnTimeLabel(asset.returned_at) }}
                </time>
              </article>
            </div>
            <footer class="k12ps__hactions">
              <!-- 题目卷/答案卷查看入口（§4.13）：固化过（有卷面号）的卷才有 -->
              <template v-if="s.paper_no">
                <button
                  class="k12ps__btn k12ps__btn--ghost"
                  :disabled="busy === s.record_id"
                  data-testid="ps-paper-question"
                  @click="openPaper(s.record_id, 'question')"
                >
                  {{ t('k12.practice.paperQuestion') }}
                </button>
                <button
                  class="k12ps__btn k12ps__btn--ghost"
                  :disabled="busy === s.record_id"
                  data-testid="ps-paper-answer"
                  @click="openPaper(s.record_id, 'answer')"
                >
                  {{ t('k12.practice.paperAnswer') }}
                </button>
              </template>
              <!-- DD-028：assigned/submitted 都可继续追加照片；已有覆盖证据的题可分批复批。 -->
              <button
                v-if="canUploadReturn(s)"
                class="k12ps__btn"
                :disabled="busy === s.record_id"
                data-testid="ps-return-open"
                @click="openReturn(s)"
              >
                {{ returnButtonLabel(s) }}
              </button>
              <button
                v-if="canGradeReturn(s)"
                class="k12ps__btn"
                :disabled="busy === s.record_id"
                @click="openGrade(s)"
              >
                {{ t('k12.practice.grade') }}
              </button>
              <button
                v-else-if="s.status === 'graded'"
                class="k12ps__btn k12ps__btn--ghost"
                :disabled="busy === s.record_id"
                @click="advance(s, 'close', t('k12.practice.close'))"
              >
                {{ t('k12.practice.close') }}
              </button>
              <button
                v-if="s.status === 'confirmed' || s.status === 'assigned'"
                class="k12ps__btn k12ps__btn--ghost"
                :disabled="busy === s.record_id"
                @click="cancelSet(s)"
              >
                {{ t('k12.practice.cancel') }}
              </button>
            </footer>
          </li>
        </ul>
      </section>
    </template>

    <!-- ═══ 题目卷/答案卷查看弹层（§4.13 详情/预览类：单「关闭」+ 右上 ✕）═══ -->
    <div
      v-if="paper.open"
      class="k12ps__modal"
      data-testid="ps-paper-modal"
      @click.self="closePaper"
    >
      <div class="k12ps__mcard">
        <header class="k12ps__mhead">
          <b>{{
            paper.resp
              ? paper.resp.kind === 'answer'
                ? t('k12.practice.paperAnswer')
                : t('k12.practice.paperQuestion')
              : t('k12.practice.paperQuestion')
          }}</b>
          <span v-if="paper.resp?.paper_no" class="k12ps__paperno">{{ paper.resp.paper_no }}</span>
          <span v-else-if="paper.resp?.preview" class="k12ps__pill k12ps__pill--muted">{{
            t('k12.practice.paperPreviewTag')
          }}</span>
          <span class="k12ps__msp" />
          <button class="k12ps__rm" :aria-label="t('k12.practice.paperClose')" @click="closePaper">
            ✕
          </button>
        </header>
        <p v-if="paper.loading" class="k12ps__mhint">{{ t('k12.practice.paperLoading') }}</p>
        <div v-else-if="paper.error" class="k12ps__paper-error">
          <p class="k12ps__err">{{ paper.error }}</p>
          <button
            v-if="!paper.resp"
            class="k12ps__btn"
            data-testid="ps-paper-retry"
            @click="retryPaper"
          >
            {{ t('k12.practice.retry') }}
          </button>
        </div>
        <div v-else-if="paper.resp" class="k12ps__mbody">
          <MarkdownRenderer :content="paper.resp.markdown" />
        </div>
        <footer class="k12ps__mfoot">
          <button
            v-if="paper.resp && !paper.resp.preview"
            class="k12ps__btn"
            data-testid="ps-paper-print"
            @click="printPaper"
          >
            {{ t('k12.practice.paperPrint') }}
          </button>
          <button
            v-if="paper.resp && !paper.resp.preview"
            class="k12ps__btn"
            data-testid="ps-paper-save-pdf"
            :disabled="paperSaveBusy"
            @click="savePaperPdf"
          >
            {{ t('k12.practice.paperSavePdf') }}
          </button>
          <button
            class="k12ps__btn k12ps__btn--primary"
            data-testid="ps-paper-close"
            @click="closePaper"
          >
            {{ t('k12.practice.paperClose') }}
          </button>
        </footer>
      </div>
    </div>

    <!-- 回传照片：照片与覆盖题均为必填；不再以空 body 把整卷标为已回传。 -->
    <div
      v-if="returnOpen"
      class="k12ps__modal"
      data-testid="ps-return-modal"
      @click.self="closeReturn"
    >
      <div
        class="k12ps__mcard k12ps__mcard--compact"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ps-return-title"
      >
        <header class="k12ps__mhead">
          <b id="ps-return-title">{{ t('k12.practice.returnTitle') }}</b>
          <span v-if="returnDraft.set?.paper_no" class="k12ps__paperno">{{
            returnDraft.set.paper_no
          }}</span>
          <span class="k12ps__msp" />
          <button class="k12ps__rm" :aria-label="t('k12.practice.paperClose')" @click="closeReturn">
            ✕
          </button>
        </header>
        <div class="k12ps__formbody">
          <p class="k12ps__mhint">{{ t('k12.practice.returnHint') }}</p>
          <label class="k12ps__file">
            <span>{{ t('k12.practice.returnPhoto') }}</span>
            <input
              data-testid="ps-return-file"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              @change="pickReturnFile"
            />
          </label>
          <b class="k12ps__formlabel">{{ t('k12.practice.returnCovered') }}</b>
          <label v-for="(it, index) in returnItems" :key="it.item_id" class="k12ps__choice">
            <input
              v-model="returnDraft.itemIds"
              type="checkbox"
              :value="it.item_id"
              :data-testid="`ps-return-item-${it.item_id}`"
              @change="returnError = ''"
            />
            <span>
              {{ it.paper_seq || index + 1 }}. {{ it.question_markdown }}
              <small v-if="it.return_ids?.length" class="k12ps__returned-ref">
                {{ t('k12.practice.returnAlreadyCovered', { n: it.return_ids.length }) }}
              </small>
            </span>
          </label>
          <div
            v-if="returnError"
            class="k12ps__return-error"
            role="alert"
            data-testid="ps-return-error"
          >
            <span>{{ returnError }}</span>
            <button
              type="button"
              class="k12ps__btn"
              data-testid="ps-return-retry"
              :disabled="!!busy"
              @click="submitReturn"
            >
              {{ t('k12.practice.retry') }}
            </button>
          </div>
        </div>
        <footer class="k12ps__mfoot">
          <button class="k12ps__btn" :disabled="!!busy" @click="closeReturn">
            {{ t('k12.practice.paperClose') }}
          </button>
          <button
            class="k12ps__btn k12ps__btn--primary"
            data-testid="ps-return-confirm"
            :disabled="!returnCanSubmit || !!busy"
            @click="submitReturn"
          >
            {{ t('k12.practice.returnConfirm') }}
          </button>
        </footer>
      </div>
    </div>

    <!-- 逐题复批：每题必须明确对/错，空 results 无提交入口。 -->
    <div
      v-if="gradeOpen"
      class="k12ps__modal"
      data-testid="ps-grade-modal"
      @click.self="closeGrade"
    >
      <div class="k12ps__mcard k12ps__mcard--compact">
        <header class="k12ps__mhead">
          <b>{{ t('k12.practice.gradeTitle') }}</b>
          <span class="k12ps__msp" />
          <button class="k12ps__rm" :aria-label="t('k12.practice.paperClose')" @click="closeGrade">
            ✕
          </button>
        </header>
        <div class="k12ps__formbody">
          <p class="k12ps__mhint">{{ t('k12.practice.gradeHint') }}</p>
          <div v-for="(it, index) in gradeItems" :key="it.item_id" class="k12ps__grade-row">
            <span>{{ it.paper_seq || index + 1 }}. {{ it.question_markdown }}</span>
            <label>
              <input
                v-model="gradeDraft.results[it.item_id]"
                type="radio"
                value="correct"
                :name="`grade-${it.item_id}`"
                :data-testid="`ps-grade-correct-${it.item_id}`"
              />
              {{ t('k12.practice.gradeCorrect') }}
            </label>
            <label>
              <input
                v-model="gradeDraft.results[it.item_id]"
                type="radio"
                value="incorrect"
                :name="`grade-${it.item_id}`"
                :data-testid="`ps-grade-incorrect-${it.item_id}`"
              />
              {{ t('k12.practice.gradeIncorrect') }}
            </label>
          </div>
        </div>
        <footer class="k12ps__mfoot">
          <button class="k12ps__btn" :disabled="!!busy" @click="closeGrade">
            {{ t('k12.practice.paperClose') }}
          </button>
          <button
            class="k12ps__btn k12ps__btn--primary"
            data-testid="ps-grade-confirm"
            :disabled="!gradeCanSubmit || !!busy"
            @click="submitGrade"
          >
            {{ t('k12.practice.gradeConfirm') }}
          </button>
        </footer>
      </div>
    </div>
  </section>
</template>

<style scoped>
.k12ps {
  display: grid;
  gap: 16px;
}
.k12ps__err {
  color: var(--hc-error);
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.k12ps__loading {
  margin: 0;
  padding: 18px 2px;
  color: var(--hc-text-muted);
  font-size: 12.5px;
}

/* 待打印篮：单卡容器（原型 .practice-basket 语言） */
.k12ps__basket {
  border: 0.5px solid var(--hc-border);
  border-radius: 16px;
  background: var(--hc-bg-card);
  box-shadow: var(--hc-shadow-sm);
  overflow: hidden;
}
.k12ps__bhead {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  flex-wrap: wrap;
  padding: 15px 18px;
  border-bottom: 1px solid var(--hc-border);
  background: linear-gradient(135deg, var(--hc-accent-subtle), var(--hc-bg-card));
}
.k12ps__bhead-copy {
  min-width: 240px;
  flex: 1;
}
.k12ps__btitle {
  font-size: 14px;
  margin: 0 0 3px;
  color: var(--hc-text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}
.k12ps__bmeta {
  font-size: 11.5px;
  color: var(--hc-text-muted);
  margin: 0;
  line-height: 1.55;
}
.k12ps__bhint {
  font-size: 11.5px;
  color: var(--hc-accent);
  margin: 3px 0 0;
}
.k12ps__bactions {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  margin-left: auto;
}
.k12ps__bempty {
  padding: 18px;
  font-size: 12.5px;
  color: var(--hc-text-muted);
}
.k12ps__groups {
  padding: 12px 14px 0;
  display: grid;
  gap: 8px;
}
.k12ps__group {
  font-size: 10.5px;
  font-weight: 750;
  color: var(--hc-text-secondary);
  margin-top: 5px;
}
.k12ps__group--blocked {
  color: var(--hc-text-muted);
}
.k12ps__item {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  align-items: start;
  gap: 9px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--hc-bg-input);
  font-size: 11.5px;
}
.k12ps__item--blocked {
  opacity: 0.72;
}
.k12ps__seq {
  width: 21px;
  height: 21px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  border-radius: 6px;
  background: var(--hc-bg-card);
  color: var(--hc-accent);
  font-style: normal;
  font-size: 10px;
  font-weight: 800;
}
.k12ps__qwrap {
  flex: 1;
  min-width: 0;
}
.k12ps__q {
  display: block;
  font-size: 12px;
  color: var(--hc-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.k12ps__qmeta {
  display: block;
  margin-top: 3px;
  color: var(--hc-text-muted);
  font-size: 10.5px;
  line-height: 1.55;
}
.k12ps__item-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}
.k12ps__vbadge {
  font-size: 10.5px;
  font-weight: 700;
  border-radius: 999px;
  padding: 2px 9px;
  white-space: nowrap;
}
.k12ps__vbadge--ok {
  color: var(--hc-success);
  background: color-mix(in srgb, var(--hc-success) 10%, transparent);
}
.k12ps__vbadge--na {
  color: var(--hc-text-muted);
  background: var(--hc-bg-active);
}
.k12ps__rm {
  font: inherit;
  font-size: 10.5px;
  border: none;
  background: transparent;
  color: var(--hc-text-secondary);
  padding: 2px 8px;
  border-radius: var(--hc-radius-sm);
  cursor: pointer;
}
.k12ps__rm:hover:not(:disabled) {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}
.k12ps__skiphint {
  font-size: 10.5px;
  color: var(--hc-text-muted);
  padding: 0 15px 13px;
  margin: 6px 0 0;
}

/* 打印历史 */
.k12ps__hhead {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.k12ps__htitle {
  font-size: 13.5px;
  margin: 0;
  color: var(--hc-text-primary);
}
.k12ps__hdesc {
  font-size: 11.5px;
  color: var(--hc-text-muted);
}
.k12ps__hempty {
  font-size: 12px;
  color: var(--hc-text-muted);
  padding: 8px 2px;
}
.k12ps__hlist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 330px));
  gap: 10px;
}
.k12ps__hcard {
  border: 0.5px solid var(--hc-border);
  border-radius: 14px;
  background: var(--hc-bg-card);
  box-shadow: var(--hc-shadow-sm);
  padding: 12px 13px;
}
.k12ps__hcard--cancelled {
  opacity: 0.6;
}
.k12ps__hcardtop {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}
.k12ps__htitle2 {
  font-size: 12.5px;
  color: var(--hc-text-primary);
  flex: 1;
  min-width: 0;
}
.k12ps__paperno {
  font-size: 10px;
  font-weight: 800;
  color: var(--hc-accent);
  background: var(--hc-accent-subtle);
  border-radius: 5px;
  padding: 2px 7px;
  font-variant-numeric: tabular-nums;
}
.k12ps__pill {
  font-size: 10.5px;
  font-weight: 700;
  border-radius: 999px;
  padding: 2px 9px;
  white-space: nowrap;
}
.k12ps__pill--todo {
  color: var(--hc-error);
  background: color-mix(in srgb, var(--hc-error) 10%, transparent);
}
.k12ps__pill--got {
  color: var(--hc-success);
  background: color-mix(in srgb, var(--hc-success) 10%, transparent);
}
.k12ps__pill--muted {
  color: var(--hc-text-muted);
  background: var(--hc-bg-input);
}
.k12ps__hmeta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 7px;
  color: var(--hc-text-muted);
  font-size: 10.5px;
}
.k12ps__returns {
  display: grid;
  gap: 6px;
  margin-top: 9px;
}
.k12ps__return-asset {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr);
  gap: 7px 9px;
  align-items: center;
  padding: 6px 8px;
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input);
  color: var(--hc-text-secondary);
  font-size: 10.5px;
}
.k12ps__return-thumb {
  grid-row: 1 / span 2;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  object-fit: cover;
  border: 0.5px solid var(--hc-border);
  background: var(--hc-bg-card);
}
.k12ps__return-asset time {
  color: var(--hc-text-muted);
  font-size: 10px;
}
.k12ps__delivery--pending {
  color: var(--hc-warning, #b26a00);
}
.k12ps__delivery--failed {
  color: var(--hc-error);
}
.k12ps__hactions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 9px;
}

/* 按钮 */
.k12ps__btn {
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  border-radius: var(--hc-radius-md);
  padding: 6px 13px;
  border: 0.5px solid var(--hc-border);
  background: var(--hc-bg-card);
  color: var(--hc-text-primary);
  cursor: pointer;
  transition:
    background 0.15s,
    border-color 0.15s,
    opacity 0.15s,
    filter 0.15s;
}
.k12ps__btn:hover:not(:disabled) {
  background: var(--hc-bg-hover);
  border-color: var(--hc-border-hl);
}
.k12ps__btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.k12ps__btn--primary {
  background: linear-gradient(180deg, #5fb3ea 0%, #4a9de0 100%);
  color: #fff;
  border-color: transparent;
  box-shadow: 0 4px 12px rgba(95, 179, 234, 0.24);
}
.k12ps__btn--primary:hover:not(:disabled) {
  filter: brightness(1.04);
}
.k12ps__btn--ghost {
  background: transparent;
  border-color: transparent;
  color: var(--hc-text-secondary);
}
.k12ps__btn--ghost:hover:not(:disabled) {
  background: var(--hc-bg-hover);
}

/* 题目卷/答案卷查看弹层 */
.k12ps__modal {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, #000 42%, transparent);
  padding: 24px;
}
.k12ps__mcard {
  width: min(680px, 100%);
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  border: 0.5px solid var(--hc-border);
  border-radius: 16px;
  background: var(--hc-bg-card);
  box-shadow: var(--hc-shadow-lg, 0 18px 48px rgba(0, 0, 0, 0.28));
  overflow: hidden;
}
.k12ps__mhead {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 13px 16px;
  border-bottom: 1px solid var(--hc-border);
  font-size: 13px;
  color: var(--hc-text-primary);
}
.k12ps__msp {
  flex: 1;
}
.k12ps__mhint {
  padding: 18px 16px;
  font-size: 12px;
  color: var(--hc-text-muted);
  margin: 0;
}
.k12ps__mbody {
  padding: 14px 18px;
  overflow-y: auto;
  font-size: 13px;
}
.k12ps__mfoot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 11px 16px;
  border-top: 1px solid var(--hc-border);
}
.k12ps__mcard--compact {
  width: min(620px, 100%);
}
.k12ps__formbody {
  display: grid;
  gap: 10px;
  padding: 14px 18px;
  overflow-y: auto;
}
.k12ps__paper-error {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
}
.k12ps__paper-error .k12ps__err {
  margin: 0;
  flex: 1;
}
.k12ps__formbody .k12ps__mhint {
  padding: 0;
}
.k12ps__file {
  display: grid;
  gap: 6px;
  font-size: 12px;
  color: var(--hc-text-secondary);
}
.k12ps__formlabel {
  font-size: 12px;
  color: var(--hc-text-primary);
}
.k12ps__choice {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  font-size: 12px;
  color: var(--hc-text-secondary);
}
.k12ps__returned-ref {
  display: block;
  margin-top: 2px;
  color: var(--hc-accent);
}
.k12ps__return-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 10px;
  border-radius: var(--hc-radius-md);
  color: var(--hc-error);
  background: color-mix(in srgb, var(--hc-error) 8%, transparent);
  font-size: 12px;
}
.k12ps__grade-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 10px;
  align-items: center;
  padding: 9px 10px;
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input);
  font-size: 12px;
}
.k12ps__grade-row label {
  white-space: nowrap;
}
</style>
