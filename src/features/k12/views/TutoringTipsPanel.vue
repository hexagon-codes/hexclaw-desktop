<script setup lang="ts">
/**
 * 「这份作业的辅导要点」只在识题结果持久确认后内联展示；从不存在当前独立侧栏或入口。
 * 生成请求只携带可信 agent + dispatch_id，正文与来源均以服务端冻结图片任务为准。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Printer } from 'lucide-vue-next'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import { useToast } from '@/composables/useToast'
import {
  k12SendTutoringTips,
} from '@/api/k12'
import { useK12Store } from '../store'
import { useK12DeliveryBatch } from '../useK12DeliveryBatch'
import { printTutoringTips, tutoringTipsToMarkdown, tutoringTipsToText } from '../export'
import type { PersistentPrintRequest } from '../persistent-print'
import K12PersistentPrintController from '../components/K12PersistentPrintController.vue'

const props = defineProps<{
  /** 隔离键 = agents.name（与 recognize/grade 同键） */
  agentId: string
  /** 当前已确认并冻结输入的 ImageTaskDispatch。 */
  dispatchId: string
  /** 当前会话稳定 ID；与图片任务的持久绑定共同构成可信生成作用域。 */
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
const delivery = useK12DeliveryBatch({
  agent: () => props.agentId,
  idleLabel: '发送到手机',
})

function cancelTutoringTips() {
  tutoringTipsAbort?.abort()
  tutoringTipsAbort = null
}

const generationAllowed = computed(
  () =>
    !props.generationLocked &&
    !!props.agentId.trim() &&
    !!props.dispatchId?.trim() &&
    !!props.sessionId?.trim(),
)

function requestTutoringTips(
  agentId = props.agentId,
  dispatchId = props.dispatchId,
  sessionId = props.sessionId,
  generationLocked = props.generationLocked,
) {
  cancelTutoringTips()
  if (generationLocked || !agentId.trim() || !dispatchId?.trim() || !sessionId?.trim()) return
  const controller = new AbortController()
  tutoringTipsAbort = controller
  void store.loadTutoringTips(agentId, dispatchId, controller.signal).finally(() => {
    if (tutoringTipsAbort === controller) tutoringTipsAbort = null
  })
}

// 只随可信图片任务作用域生成；结果未知时仅中止生成，不清空已经拿到的辅导要点。
watch(
  () => [props.agentId, props.dispatchId, props.sessionId, props.generationLocked] as const,
  ([agentId, dispatchId, sessionId, generationLocked], previous) => {
    if (!previous || previous[0] !== agentId || previous[1] !== dispatchId || previous[2] !== sessionId) {
      delivery.reset()
    }
    requestTutoringTips(agentId, dispatchId, sessionId, generationLocked)
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

onBeforeUnmount(cancelTutoringTips)

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
      sourceRef: `tutoring-tips:${props.dispatchId}`,
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

async function doSendPhone() {
  if (!store.tutoringTips) return
  await delivery.send(() =>
    k12SendTutoringTips(
      props.agentId,
      tutoringTipsToText(store.tutoringTips!, tutoringTipsMeta()),
    ),
  )
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
        <button
          class="icbtn tutoring-tips__send"
          :title="t('k12.tutoringTips.sendPhone')"
          data-testid="tutoring-tips-send"
          :disabled="delivery.disabled.value || !store.tutoringTips"
          @click="doSendPhone"
        >
          {{ delivery.label.value }}
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
.tutoring-tips__send {
  width: auto;
  min-width: 76px;
  padding: 0 10px;
  white-space: nowrap;
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
.tutoring-tips__hint--err {
  color: var(--hc-error);
}
</style>
