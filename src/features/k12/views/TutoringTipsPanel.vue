<script setup lang="ts">
/**
 * 「这份作业的辅导要点」只在识题结果持久确认后内联展示；从不存在当前独立侧栏或入口。
 * 生成请求只携带可信 agent + grading_job_id，正文与来源均以服务端冻结 Job 为准。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookOpen, Printer, Smartphone } from 'lucide-vue-next'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import { useToast } from '@/composables/useToast'
import {
  k12QueryDeliveryReceipt,
  k12RetryDeliveryReceipt,
  k12SendTutoringTips,
  type DeliveryReceiptDTO,
} from '@/api/k12'
import { useK12Store } from '../store'
import { printTutoringTips, tutoringTipsToMarkdown, tutoringTipsToText } from '../export'
import type { PersistentPrintRequest } from '../persistent-print'
import K12PersistentPrintController from '../components/K12PersistentPrintController.vue'
import { parseDocument } from '@/utils/file-parser'

const props = defineProps<{
  /** 隔离键 = agents.name（与 recognize/grade 同键） */
  agentId: string
  /** 当前已确认并冻结输入的 GradingJob。 */
  gradingJobId: string
  /** 当前会话稳定 ID；与 Job 的持久绑定共同构成可信生成作用域。 */
  sessionId?: string
  /** Job 结果未知时冻结所有生成型动作；已生成内容与投递/打印仍保留。 */
  generationLocked?: boolean
  grade: string
  /** 识题确认的当前学科，用于分科教材检索与写入隔离。 */
  subject?: string
  /** 当前档案的兼容教材边界，仅用于诚实展示当前依据；分科绑定由 profile metadata 承载。 */
  textbook?: string
  /** 识题识别出的真实知识点（绑定当前作业）；非空即生成 */
  knowledgePoints: string[]
}>()

const { t } = useI18n()
const toast = useToast()
const store = useK12Store()
const persistentPrintController = ref<{
  open: (request: PersistentPrintRequest) => Promise<void>
} | null>(null)

let tutoringTipsAbort: AbortController | null = null
const deliveryReceipt = ref<DeliveryReceiptDTO | null>(null)
const deliveryBusy = ref(false)
const deliverySetupError = ref('')

function cancelTutoringTips() {
  tutoringTipsAbort?.abort()
  tutoringTipsAbort = null
}

const generationAllowed = computed(
  () =>
    !props.generationLocked &&
    !!props.agentId.trim() &&
    !!props.gradingJobId?.trim() &&
    !!props.sessionId?.trim(),
)

function requestTutoringTips(
  agentId = props.agentId,
  gradingJobId = props.gradingJobId,
  sessionId = props.sessionId,
  generationLocked = props.generationLocked,
) {
  cancelTutoringTips()
  if (generationLocked || !agentId.trim() || !gradingJobId?.trim() || !sessionId?.trim()) return
  const controller = new AbortController()
  tutoringTipsAbort = controller
  void store.loadTutoringTips(agentId, gradingJobId, controller.signal).finally(() => {
    if (tutoringTipsAbort === controller) tutoringTipsAbort = null
  })
}

// 只随可信 Job 作用域生成；结果未知时仅中止生成，不清空已经拿到的辅导要点。
watch(
  () => [props.agentId, props.gradingJobId, props.sessionId, props.generationLocked] as const,
  ([agentId, gradingJobId, sessionId, generationLocked], previous) => {
    if (!previous || previous[0] !== agentId || previous[1] !== gradingJobId || previous[2] !== sessionId) {
      deliveryReceipt.value = null
      deliverySetupError.value = ''
    }
    requestTutoringTips(agentId, gradingJobId, sessionId, generationLocked)
  },
  { immediate: true },
)

/** AI 归纳段落用告警色徽章（未校验），课本与学情来源用 accent。 */
function isWeakSource(label: string): boolean {
  return label.includes('AI') || label.includes('⚠️')
}

function retryTutoringTips() {
  if (!store.tutoringTipsLoading && generationAllowed.value) {
    requestTutoringTips()
  }
}

const groundingInput = ref<HTMLInputElement | null>(null)
const groundingBusy = ref(false)
let groundingGeneration = 0
let groundingAbort: AbortController | null = null

function cancelGroundingUpload() {
  groundingGeneration++
  groundingAbort?.abort()
  groundingAbort = null
  groundingBusy.value = false
}

watch(
  () => [
    props.agentId,
    props.subject,
    props.gradingJobId,
    props.sessionId,
    props.generationLocked,
  ],
  cancelGroundingUpload,
)
onBeforeUnmount(() => {
  cancelTutoringTips()
  cancelGroundingUpload()
})

function openGroundingPicker() {
  if (!groundingBusy.value && generationAllowed.value) groundingInput.value?.click()
}

async function onGroundingFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // 同一文件修订后可再次选择。
  if (!file || !generationAllowed.value) return

  groundingAbort?.abort()
  const controller = new AbortController()
  groundingAbort = controller
  const generation = ++groundingGeneration
  const agentId = props.agentId
  const subject = props.subject ?? ''
  const gradingJobId = props.gradingJobId
  const sessionId = props.sessionId ?? ''
  groundingBusy.value = true
  try {
    const parsed = await parseDocument(file)
    if (
      generation !== groundingGeneration ||
      controller.signal.aborted ||
      props.agentId !== agentId ||
      (props.subject ?? '') !== subject ||
      props.gradingJobId !== gradingJobId ||
      (props.sessionId ?? '') !== sessionId ||
      props.generationLocked
    )
      return
    if (!parsed.text.trim()) throw new Error('empty grounding document')
    await store.addGrounding(
      agentId,
      subject,
      parsed.fileName || file.name,
      parsed.text,
      controller.signal,
    )
    if (
      generation !== groundingGeneration ||
      controller.signal.aborted ||
      props.agentId !== agentId ||
      (props.subject ?? '') !== subject ||
      props.gradingJobId !== gradingJobId ||
      (props.sessionId ?? '') !== sessionId ||
      props.generationLocked
    )
      return
    await store.loadTutoringTips(agentId, gradingJobId, controller.signal)
    if (
      generation === groundingGeneration &&
      props.agentId === agentId &&
      (props.subject ?? '') === subject &&
      props.gradingJobId === gradingJobId &&
      (props.sessionId ?? '') === sessionId &&
      !props.generationLocked
    )
      toast.success(t('k12.tutoringTips.groundingUploaded'))
  } catch {
    if (!controller.signal.aborted && generation === groundingGeneration)
      toast.error(t('k12.tutoringTips.groundingFailed'))
  } finally {
    if (generation === groundingGeneration) {
      groundingBusy.value = false
      groundingAbort = null
    }
  }
}

const tutoringTipsMeta = () => ({ title: t('k12.tutoringTips.title'), gradeLabel: props.grade })

// 打印辅导要点（Tauri：原生 PrintJob/系统打印对话框；浏览器开发态：window.print）。
async function doPrint() {
  if (!store.tutoringTips) {
    toast.info(t('k12.tutoringTips.empty'))
    return
  }
  try {
    const card = store.tutoringTips
    const meta = tutoringTipsMeta()
    await persistentPrintController.value?.open({
      agent: props.agentId,
      sourceKind: 'tutoring_tips',
      sourceRef: `tutoring-tips:${props.gradingJobId}`,
      title: meta.title,
      canonicalMarkdown: tutoringTipsToMarkdown(card, meta),
      browserPrint: () => printTutoringTips(card, meta),
    })
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  }
}

function onPersistentPrintError(error: Error) {
  toast.error(error.message)
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

function applyDeliveryReceipt(receipt: DeliveryReceiptDTO) {
  deliveryReceipt.value = receipt
  deliverySetupError.value = ''
  if (receipt.status === 'delivered') toast.success(deliveryStatusText(receipt))
  else if (receipt.status === 'failed') toast.error(deliveryStatusText(receipt))
  else toast.info(deliveryStatusText(receipt))
}

// 发到手机：真实直发先落 durable Receipt。平台受理只显示「发送中」，
// 只有查询证据为 delivered 时才显示「已送达」。
async function doSendPhone() {
  if (!store.tutoringTips || deliveryBusy.value) {
    toast.info(t('k12.tutoringTips.empty'))
    return
  }
  deliveryBusy.value = true
  try {
    applyDeliveryReceipt(
      await k12SendTutoringTips(props.agentId, tutoringTipsToText(store.tutoringTips, tutoringTipsMeta())),
    )
  } catch (e) {
    deliverySetupError.value = (e as Error).message || t('k12.delivery.setupRequired')
    toast.error(deliverySetupError.value)
  } finally {
    deliveryBusy.value = false
  }
}

async function retryDelivery() {
  const receipt = deliveryReceipt.value
  if (!receipt || receipt.status !== 'failed' || deliveryBusy.value) return
  deliveryBusy.value = true
  try {
    applyDeliveryReceipt(await k12RetryDeliveryReceipt(props.agentId, receipt.delivery_id))
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    deliveryBusy.value = false
  }
}

async function queryDelivery() {
  const receipt = deliveryReceipt.value
  if (!receipt || !['sending', 'outcome_unknown'].includes(receipt.status) || deliveryBusy.value)
    return
  deliveryBusy.value = true
  try {
    applyDeliveryReceipt(await k12QueryDeliveryReceipt(props.agentId, receipt.delivery_id))
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    deliveryBusy.value = false
  }
}
</script>

<template>
  <section class="tutoring-tips" data-testid="tutoring-tips" aria-label="这份作业的辅导要点">
    <K12PersistentPrintController
      ref="persistentPrintController"
      @error="onPersistentPrintError"
    />
    <div class="tutoring-tips__head">
      <b>📋 {{ t('k12.tutoringTips.title') }}</b>
      <span
        v-if="store.tutoringTips?.knowledge_points.length"
        class="tutoring-tips__unit"
        :title="store.tutoringTips.knowledge_points.join(' · ')"
        >{{ store.tutoringTips.knowledge_points[0] }}</span
      >
      <div class="tutoring-tips__actions">
        <input
          ref="groundingInput"
          class="grounding-file"
          data-testid="tutoring-tips-grounding-file"
          type="file"
          accept=".pdf,.doc,.docx,.pptx,.txt,.md,.csv,.xlsx,.xls,.json"
          @change="onGroundingFile"
        />
        <button
          class="icbtn"
          :disabled="groundingBusy || !generationAllowed"
          :title="t('k12.tutoringTips.uploadGrounding')"
          data-testid="tutoring-tips-grounding-open"
          @click="openGroundingPicker"
        >
          <span v-if="groundingBusy">…</span>
          <BookOpen v-else :size="17" aria-hidden="true" />
        </button>
        <button
          class="icbtn"
          :title="t('k12.tutoringTips.sendPhone')"
          data-testid="tutoring-tips-send"
          :disabled="deliveryBusy || !store.tutoringTips"
          @click="doSendPhone"
        >
          <span v-if="deliveryBusy">…</span>
          <Smartphone v-else :size="17" aria-hidden="true" />
        </button>
        <button
          class="icbtn"
          :title="t('k12.tutoringTips.print')"
          data-testid="tutoring-tips-print"
          @click="doPrint"
        >
          <Printer :size="17" aria-hidden="true" />
        </button>
      </div>
    </div>

    <div class="tutoring-tips__body">
      <p v-if="store.tutoringTipsLoading" class="tutoring-tips__hint">{{ t('k12.tutoringTips.generating') }}</p>
      <div v-else-if="store.tutoringTipsError" class="tutoring-tips__error" role="alert">
        <p class="tutoring-tips__hint tutoring-tips__hint--err">{{ store.tutoringTipsError }}</p>
        <button
          class="tutoring-tips__retry"
          data-testid="tutoring-tips-retry"
          type="button"
          :disabled="!generationAllowed"
          @click="retryTutoringTips"
        >
          {{ t('common.retry') }}
        </button>
      </div>

      <template v-else-if="store.tutoringTips">
        <div v-for="(s, i) in store.tutoringTips.sections" :key="i" class="tutoring-tips__section">
          <h5 class="tutoring-tips__section__title">
            {{ s.title }}
            <span
              v-if="s.source_label"
              class="tutor-badge"
              :class="{ 'tutor-badge--weak': isWeakSource(s.source_label) }"
              >{{ s.source_label }}</span
            >
          </h5>
          <MarkdownRenderer :content="s.content" />
        </div>
      </template>

      <p v-else class="tutoring-tips__hint">{{ t('k12.tutoringTips.empty') }}</p>
    </div>

    <footer v-if="store.tutoringTips" class="tutoring-tips__legend">
      <span>{{ t('k12.tutoringTips.legend') }}</span>
      <span v-if="textbook || grade" class="tutoring-tips__basis">
        {{
          t('k12.tutoringTips.currentBasis', {
            textbook: textbook || t('k12.customPaper.textbookMissing'),
            grade,
          })
        }}
      </span>
      <div
        v-if="deliveryReceipt"
        class="tutoring-tips__delivery"
        :class="`tutoring-tips__delivery--${deliveryReceipt.status}`"
        data-testid="tutoring-tips-delivery-receipt"
        role="status"
      >
        <span>{{ deliveryStatusText(deliveryReceipt) }}</span>
        <button
          v-if="deliveryReceipt.status === 'failed'"
          type="button"
          data-testid="tutoring-tips-delivery-retry"
          :disabled="deliveryBusy"
          @click="retryDelivery"
        >
          {{ t('k12.delivery.retry') }}
        </button>
        <button
          v-if="
            deliveryReceipt.status === 'sending' || deliveryReceipt.status === 'outcome_unknown'
          "
          type="button"
          data-testid="tutoring-tips-delivery-query"
          :disabled="deliveryBusy"
          @click="queryDelivery"
        >
          {{ t('k12.delivery.query') }}
        </button>
      </div>
      <div
        v-if="deliverySetupError"
        class="tutoring-tips__delivery tutoring-tips__delivery--failed"
        data-testid="tutoring-tips-delivery-setup"
      >
        <span>{{ deliverySetupError }}</span>
        <a href="/channels" data-testid="tutoring-tips-bind-cta">{{ t('k12.delivery.bindCTA') }}</a>
      </div>
    </footer>
  </section>
</template>

<style scoped>
/* 内联卡（长在识题结果下方，不是侧栏）：绑定框 + accent 头 */
.tutoring-tips {
  border: 1px solid var(--hc-border-hl);
  border-radius: 14px;
  background: var(--hc-bg-card);
  overflow: hidden;
  margin-top: 6px;
  box-shadow: var(--hc-shadow-sm);
}
.tutoring-tips__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 15px;
  border-bottom: 0.5px solid var(--hc-divider);
  background: var(--hc-accent-subtle);
  font-size: 13px;
}
.tutoring-tips__head b {
  font-weight: 700;
}
.tutoring-tips__unit {
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 2px 8px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--hc-accent) 12%, transparent);
  color: var(--hc-accent);
  font-size: 11.5px;
  font-weight: 600;
}
.tutoring-tips__actions {
  display: flex;
  gap: 4px;
  align-items: center;
  margin-left: auto;
}
.icbtn {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--hc-text-secondary);
  cursor: pointer;
  font-size: 14px;
}
.icbtn:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}
.icbtn:active {
  transform: scale(0.9);
}
.icbtn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--hc-accent-subtle);
}
.icbtn:disabled {
  cursor: wait;
  opacity: 0.6;
}
.grounding-file {
  display: none;
}
.tutoring-tips__body {
  padding: 13px 15px;
  display: flex;
  flex-direction: column;
  gap: 13px;
}
.tutoring-tips__hint {
  color: var(--hc-text-muted);
  font-size: 12.5px;
  margin: 0;
}
.tutoring-tips__error {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.tutoring-tips__retry {
  flex-shrink: 0;
  border: 1px solid var(--hc-danger);
  border-radius: var(--hc-radius-sm);
  background: transparent;
  color: var(--hc-danger);
  cursor: pointer;
  padding: 5px 12px;
  font-size: 12px;
}
.tutoring-tips__retry:hover {
  background: color-mix(in srgb, var(--hc-danger) 8%, transparent);
}
.tutoring-tips__section__title {
  margin: 0 0 4px;
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--hc-accent);
  font-weight: 600;
}
.tutor-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 5px;
  vertical-align: middle;
  background: color-mix(in srgb, var(--hc-accent) 13%, transparent);
  color: var(--hc-accent);
}
.tutor-badge--weak {
  background: color-mix(in srgb, var(--hc-warning) 15%, transparent);
  color: var(--hc-warning);
  border: 1px dashed color-mix(in srgb, var(--hc-warning) 40%, transparent);
}
.tutoring-tips__legend {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  margin: 0;
  padding: 9px 15px 12px;
  border-top: 0.5px solid var(--hc-divider);
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--hc-text-muted);
}
.tutoring-tips__basis {
  display: block;
  color: var(--hc-accent);
}
.tutoring-tips__delivery {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 0;
  padding: 0;
  background: transparent;
  color: var(--hc-text-secondary);
  font-size: 12px;
}
.tutoring-tips__delivery--delivered {
  color: var(--hc-success);
}
.tutoring-tips__delivery--failed,
.tutoring-tips__delivery--outcome_unknown {
  color: var(--hc-error);
  background: color-mix(in srgb, var(--hc-error) 8%, transparent);
}
.tutoring-tips__delivery button,
.tutoring-tips__delivery a {
  flex-shrink: 0;
  border: 0;
  background: transparent;
  color: var(--hc-accent);
  cursor: pointer;
  font: inherit;
  font-weight: 650;
  text-decoration: none;
}
.tutoring-tips__hint--err {
  color: var(--hc-error);
}
</style>
