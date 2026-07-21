<script setup lang="ts">
/**
 * 「这份作业的辅导要点」内联卡（features/k12）· 20260709 最优雅形态（原「家长备课卡」侧栏去侧栏化）。
 *
 * 设计翻转：家长辅导是临场的——先看到作业才知怎么教，事前"备课"是逆链路的教师心智。故取消独立侧栏 +
 * nudge + 头部按钮，改为**识题确认后由 RecognizeGuardPanel 内联渲染**，用识题识别出的**真实知识点**
 * 绑定当前作业（不再是科目级泛化）。只读聚合 + 来源标注：source_label 由后端直出
 * （📖 依据课本 / 🗂 本地记录 / ✅ 已程序验算 / 🧠 学情信号 / 🤖 AI 归纳·供参考）——无验算保护段落用来源
 * 徽章替代信任兜底（AP-5）。事件驱动生成（识题给出知识点即生成，非每日 cron）。
 */
import { onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookOpen, Printer, Smartphone } from 'lucide-vue-next'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import { useToast } from '@/composables/useToast'
import {
  k12QueryDeliveryReceipt,
  k12RetryDeliveryReceipt,
  k12SendPrepCard,
  type DeliveryReceiptDTO,
} from '@/api/k12'
import { useK12Store } from '../store'
import { printPrepCard, prepCardToMarkdown, prepCardToText } from '../export'
import { printPersistentArtifact } from '../persistent-print'
import { parseDocument } from '@/utils/file-parser'

const props = defineProps<{
  /** 隔离键 = agents.name（与 recognize/grade 同键） */
  agentId: string
  grade: string
  /** 当前档案的兼容教材边界，仅用于诚实展示当前依据；分科绑定由 profile metadata 承载。 */
  textbook?: string
  /** 识题识别出的真实知识点（绑定当前作业）；非空即生成 */
  knowledgePoints: string[]
}>()

const { t } = useI18n()
const toast = useToast()
const store = useK12Store()

let prepAbort: AbortController | null = null
const deliveryReceipt = ref<DeliveryReceiptDTO | null>(null)
const deliveryBusy = ref(false)
const deliverySetupError = ref('')

function cancelPrepCard() {
  prepAbort?.abort()
  prepAbort = null
}

function requestPrepCard(
  agentId = props.agentId,
  grade = props.grade,
  kps = props.knowledgePoints,
) {
  cancelPrepCard()
  if (!agentId || !kps.length) return
  const controller = new AbortController()
  prepAbort = controller
  void store.loadPrepCard(agentId, grade, kps, controller.signal).finally(() => {
    if (prepAbort === controller) prepAbort = null
  })
}

// 识题给出知识点即生成辅导要点（绑定当前作业）；知识点变化重拉。
watch(
  () => [props.agentId, props.grade, props.knowledgePoints] as const,
  ([agentId, grade, kps]) => {
    deliveryReceipt.value = null
    deliverySetupError.value = ''
    requestPrepCard(agentId, grade, kps)
  },
  { immediate: true, deep: true },
)

/** AI 归纳段落用告警色徽章（未校验），其余用 accent（本地记录/课本/验算） */
function isWeakSource(label: string): boolean {
  return label.includes('AI') || label.includes('⚠️')
}

function retryPrepCard() {
  if (!store.prepLoading && props.agentId && props.knowledgePoints.length) {
    requestPrepCard()
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

watch(() => props.agentId, cancelGroundingUpload)
onBeforeUnmount(() => {
  cancelPrepCard()
  cancelGroundingUpload()
})

function openGroundingPicker() {
  if (!groundingBusy.value) groundingInput.value?.click()
}

async function onGroundingFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // 同一文件修订后可再次选择。
  if (!file || !props.agentId) return

  groundingAbort?.abort()
  const controller = new AbortController()
  groundingAbort = controller
  const generation = ++groundingGeneration
  const agentId = props.agentId
  groundingBusy.value = true
  try {
    const parsed = await parseDocument(file)
    if (
      generation !== groundingGeneration ||
      controller.signal.aborted ||
      props.agentId !== agentId
    )
      return
    if (!parsed.text.trim()) throw new Error('empty grounding document')
    await store.addGrounding(agentId, parsed.fileName || file.name, parsed.text, controller.signal)
    if (
      generation !== groundingGeneration ||
      controller.signal.aborted ||
      props.agentId !== agentId
    )
      return
    await store.loadPrepCard(agentId, props.grade, props.knowledgePoints)
    if (generation === groundingGeneration && props.agentId === agentId)
      toast.success(t('k12.prep.groundingUploaded'))
  } catch {
    if (!controller.signal.aborted && generation === groundingGeneration)
      toast.error(t('k12.prep.groundingFailed'))
  } finally {
    if (generation === groundingGeneration) {
      groundingBusy.value = false
      groundingAbort = null
    }
  }
}

const prepMeta = () => ({ title: t('k12.prep.title'), gradeLabel: props.grade })

// 打印辅导要点（Tauri：原生 PrintJob/系统打印对话框；浏览器开发态：window.print）。
async function doPrint() {
  if (!store.prepCard) {
    toast.info(t('k12.prep.empty'))
    return
  }
  try {
    const card = store.prepCard
    const meta = prepMeta()
    await printPersistentArtifact({
      agent: props.agentId,
      sourceKind: 'prep_card',
      sourceRef: `prep-card:${props.grade}:${props.knowledgePoints.join(',')}`,
      title: meta.title,
      canonicalMarkdown: prepCardToMarkdown(card, meta),
      browserPrint: () => printPrepCard(card, meta),
    })
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  }
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
  if (!store.prepCard || deliveryBusy.value) {
    toast.info(t('k12.prep.empty'))
    return
  }
  deliveryBusy.value = true
  try {
    applyDeliveryReceipt(
      await k12SendPrepCard(props.agentId, prepCardToText(store.prepCard, prepMeta())),
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
  <section class="tutor-guide" data-testid="tutor-guide" aria-label="这份作业的辅导要点">
    <div class="tutor-guide__head">
      <b>📋 {{ t('k12.prep.title') }}</b>
      <span
        v-if="store.prepCard?.knowledge_points.length"
        class="tutor-guide__unit"
        :title="store.prepCard.knowledge_points.join(' · ')"
        >{{ store.prepCard.knowledge_points[0] }}</span
      >
      <div class="tutor-guide__actions">
        <input
          ref="groundingInput"
          class="grounding-file"
          data-testid="prep-grounding-file"
          type="file"
          accept=".pdf,.doc,.docx,.pptx,.txt,.md,.csv,.xlsx,.xls,.json"
          @change="onGroundingFile"
        />
        <button
          class="icbtn"
          :disabled="groundingBusy"
          :title="t('k12.prep.uploadGrounding')"
          data-testid="prep-grounding-open"
          @click="openGroundingPicker"
        >
          <span v-if="groundingBusy">…</span>
          <BookOpen v-else :size="17" aria-hidden="true" />
        </button>
        <button
          class="icbtn"
          :title="t('k12.prep.sendPhone')"
          data-testid="prep-send"
          :disabled="deliveryBusy || !store.prepCard"
          @click="doSendPhone"
        >
          <span v-if="deliveryBusy">…</span>
          <Smartphone v-else :size="17" aria-hidden="true" />
        </button>
        <button
          class="icbtn"
          :title="t('k12.prep.print')"
          data-testid="prep-print"
          @click="doPrint"
        >
          <Printer :size="17" aria-hidden="true" />
        </button>
      </div>
    </div>

    <div class="tutor-guide__body">
      <p v-if="store.prepLoading" class="tutor-guide__hint">{{ t('k12.prep.generating') }}</p>
      <div v-else-if="store.prepError" class="tutor-guide__error" role="alert">
        <p class="tutor-guide__hint tutor-guide__hint--err">{{ store.prepError }}</p>
        <button
          class="tutor-guide__retry"
          data-testid="prep-retry"
          type="button"
          @click="retryPrepCard"
        >
          {{ t('common.retry') }}
        </button>
      </div>

      <template v-else-if="store.prepCard">
        <div v-for="(s, i) in store.prepCard.sections" :key="i" class="tutor-section">
          <h5 class="tutor-section__title">
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

      <p v-else class="tutor-guide__hint">{{ t('k12.prep.empty') }}</p>
    </div>

    <footer v-if="store.prepCard" class="tutor-guide__legend">
      <span>{{ t('k12.prep.legend') }}</span>
      <span v-if="textbook || grade" class="tutor-guide__basis">
        {{
          t('k12.prep.currentBasis', {
            textbook: textbook || t('k12.customPaper.textbookMissing'),
            grade,
          })
        }}
      </span>
      <div
        v-if="deliveryReceipt"
        class="tutor-guide__delivery"
        :class="`tutor-guide__delivery--${deliveryReceipt.status}`"
        data-testid="prep-delivery-receipt"
        role="status"
      >
        <span>{{ deliveryStatusText(deliveryReceipt) }}</span>
        <button
          v-if="deliveryReceipt.status === 'failed'"
          type="button"
          data-testid="prep-delivery-retry"
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
          data-testid="prep-delivery-query"
          :disabled="deliveryBusy"
          @click="queryDelivery"
        >
          {{ t('k12.delivery.query') }}
        </button>
      </div>
      <div
        v-if="deliverySetupError"
        class="tutor-guide__delivery tutor-guide__delivery--failed"
        data-testid="prep-delivery-setup"
      >
        <span>{{ deliverySetupError }}</span>
        <a href="/channels" data-testid="prep-bind-cta">{{ t('k12.delivery.bindCTA') }}</a>
      </div>
    </footer>
  </section>
</template>

<style scoped>
/* 内联卡（长在识题结果下方，不是侧栏）：绑定框 + accent 头 */
.tutor-guide {
  border: 1px solid var(--hc-border-hl);
  border-radius: 14px;
  background: var(--hc-bg-card);
  overflow: hidden;
  margin-top: 6px;
  box-shadow: var(--hc-shadow-sm);
}
.tutor-guide__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 15px;
  border-bottom: 0.5px solid var(--hc-divider);
  background: var(--hc-accent-subtle);
  font-size: 13px;
}
.tutor-guide__head b {
  font-weight: 700;
}
.tutor-guide__unit {
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
.tutor-guide__actions {
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
.tutor-guide__body {
  padding: 13px 15px;
  display: flex;
  flex-direction: column;
  gap: 13px;
}
.tutor-guide__hint {
  color: var(--hc-text-muted);
  font-size: 12.5px;
  margin: 0;
}
.tutor-guide__error {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.tutor-guide__retry {
  flex-shrink: 0;
  border: 1px solid var(--hc-danger);
  border-radius: var(--hc-radius-sm);
  background: transparent;
  color: var(--hc-danger);
  cursor: pointer;
  padding: 5px 12px;
  font-size: 12px;
}
.tutor-guide__retry:hover {
  background: color-mix(in srgb, var(--hc-danger) 8%, transparent);
}
.tutor-section__title {
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
.tutor-guide__legend {
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
.tutor-guide__basis {
  display: block;
  color: var(--hc-accent);
}
.tutor-guide__delivery {
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
.tutor-guide__delivery--delivered {
  color: var(--hc-success);
}
.tutor-guide__delivery--failed,
.tutor-guide__delivery--outcome_unknown {
  color: var(--hc-error);
  background: color-mix(in srgb, var(--hc-error) 8%, transparent);
}
.tutor-guide__delivery button,
.tutor-guide__delivery a {
  flex-shrink: 0;
  border: 0;
  background: transparent;
  color: var(--hc-accent);
  cursor: pointer;
  font: inherit;
  font-weight: 650;
  text-decoration: none;
}
.tutor-guide__hint--err {
  color: var(--hc-error);
}
</style>
