<script setup lang="ts">
import { computed, reactive, ref, watch, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { FileText, Printer, Download, LoaderCircle } from 'lucide-vue-next'
import HcSelect from '@/components/common/HcSelect.vue'
import { useToast } from '@/composables/useToast'
import { backendScopeKey } from '@/services/backend-context'
import {
  k12PrepareWeeklyTrackOutput,
  k12GetPrintArtifactContent,
  type WeeklyPracticePlanDTO,
  type PrintableArtifactDTO,
} from '@/api/k12'
import { download } from '../export'
import K12ManualQuestionCountField from './K12ManualQuestionCountField.vue'
import K12PrintPreviewModal from './K12PrintPreviewModal.vue'
import K12PersistentPrintController from './K12PersistentPrintController.vue'

type Section = 'textbook_consolidation' | 'arithmetic_warmup'
const props = defineProps<{
  agent: string
  plan: WeeklyPracticePlanDTO
  scopeLabel: string
  textbookBusy?: boolean
  arithmeticBusy?: boolean
}>()
const emit = defineEmits<{ generate: [section: Section, count: number] }>()
const { t } = useI18n()
const toast = useToast()
const selected = ref<Section>('textbook_consolidation')
const counts = reactive<Record<Section, number | null>>({
  textbook_consolidation: 5,
  arithmetic_warmup: 10,
})
type FileState = {
  key: string
  artifact?: PrintableArtifactDTO
  pdf?: Blob
  preparing: boolean
  delivering: boolean
  saved: boolean
  printed: boolean
  count: number
  error: string
}
const files = reactive<Record<Section, FileState>>({
  textbook_consolidation: blank(),
  arithmetic_warmup: blank(),
})
function blank(): FileState {
  return {
    key: '',
    preparing: false,
    delivering: false,
    saved: false,
    printed: false,
    count: 0,
    error: '',
  }
}
const preview = ref<{
  section: Section
  title: string
  artifact: PrintableArtifactDTO | null
  pdf: Blob | null
} | null>(null)
let previewGeneration = 0
function closePreview() {
  previewGeneration++
  preview.value = null
}
onBeforeUnmount(closePreview)
const printController = ref<InstanceType<typeof K12PersistentPrintController>>()
const printing = ref<Section | null>(null)
let printTarget: {
  file: FileState
  section: Section
  artifactId: string
  agent: string
  scope: string
} | null = null
const labels = computed(() => ({
  textbook_consolidation: t('k12.supplement.textbook'),
  arithmetic_warmup: t('k12.supplement.arithmetic'),
}))
const options = computed(() =>
  Object.entries(labels.value).map(([value, label]) => ({ value, label })),
)
const current = computed(() => files[selected.value])
const recommendation = computed(() => props.plan.manual_track_recommendations?.[selected.value])
const track = (section: Section) => props.plan.tracks.find((item) => item.plan_section === section)
const items = (section: Section) =>
  track(section)?.items.filter((item) => item.verification.status === 'verified') ?? []
const trackKey = (section: Section) =>
  JSON.stringify([
    backendScopeKey(),
    props.agent,
    props.plan.plan_id,
    section,
    items(section).map((item) => [item.item_id, item.prompt_markdown]),
  ])
const generating = (section: Section) =>
  Boolean(
    (section === 'textbook_consolidation' ? props.textbookBusy : props.arithmeticBusy) ||
    props.plan.manual_track_recommendations?.[section]?.availability === 'processing' ||
    track(section)?.arithmetic_batch?.state === 'preparing',
  )
const busy = computed(() => generating(selected.value))
const arithmeticRetryPending = computed(
  () => track('arithmetic_warmup')?.arithmetic_batch?.state === 'failed_retryable',
)
const countFrozen = computed(
  () => selected.value === 'arithmetic_warmup' && arithmeticRetryPending.value,
)
const unavailable = computed(
  () =>
    recommendation.value?.availability === 'setup_required' ||
    recommendation.value?.availability === 'failed_terminal',
)
const scope = computed(() =>
  selected.value === 'textbook_consolidation'
    ? props.scopeLabel
    : t('k12.supplement.arithmeticScope'),
)
const fileTitle = computed(() => t('k12.supplement.sheet', { type: labels.value[selected.value] }))
const failure = computed(() => {
  if (current.value.error) return current.value.error
  const message =
    track(selected.value)?.arithmetic_batch?.failure_message ||
    track(selected.value)?.failure_message ||
    ''
  if (recommendation.value?.availability === 'setup_required') return t('k12.supplement.setup')
  if (recommendation.value?.availability === 'failed_terminal' && props.plan.status === 'frozen') {
    return t('k12.supplement.frozen')
  }
  const known: Record<string, string> = {
    'weekly candidate duplicates practiced problem': 'k12.records.weeklyDuplicate',
    'weekly duplicate replacement limit reached': 'k12.records.weeklyDuplicateLimit',
  }
  if (known[message]) return t(known[message])
  if (recommendation.value?.availability === 'failed_terminal') {
    const summary = t('k12.supplement.generateFailed')
    return message ? `${summary}: ${message}` : summary
  }
  return current.value.error || (message ? t('k12.supplement.generateFailed') : '')
})
function receiptKey(artifact: PrintableArtifactDTO) {
  return `k12-sheet-delivery:${backendScopeKey()}:${props.agent}:${artifact.artifact_id}`
}
function remember(section: Section) {
  const file = files[section]
  if (!file.artifact) return
  try {
    localStorage.setItem(
      receiptKey(file.artifact),
      JSON.stringify({ saved: file.saved, printed: file.printed }),
    )
  } catch {
    /* 本机空间不足不改变实际交付结果。 */
  }
}
async function prepare(section: Section) {
  if (!items(section).length) return
  const key = trackKey(section),
    file = files[section],
    agent = props.agent,
    plan = props.plan
  if (file.key === key && (file.artifact || file.preparing)) return
  file.key = key
  file.preparing = true
  file.error = ''
  try {
    const response = await k12PrepareWeeklyTrackOutput(agent, plan.plan_id, section, plan.revision)
    const pdf = await k12GetPrintArtifactContent(agent, response.artifact.artifact_id)
    if (key !== trackKey(section) || file !== files[section]) return
    Object.assign(file, {
      artifact: response.artifact,
      pdf,
      count: items(section).length,
      saved: false,
      printed: false,
    })
    try {
      const facts = JSON.parse(localStorage.getItem(receiptKey(response.artifact)) || '{}')
      file.saved = facts.saved === true
      file.printed = facts.printed === true
    } catch {
      /* 损坏的展示缓存不影响冻结 PDF。 */
    }
  } catch {
    if (key === trackKey(section)) {
      file.key = ''
      file.error = t('k12.supplement.pdfFailed')
    }
  } finally {
    if (file === files[section] && (file.key === key || !file.key)) file.preparing = false
  }
}
async function output(
  section: Section,
  action: 'preview' | 'print' | 'download',
  frozen?: { artifact: PrintableArtifactDTO; pdf: Blob },
) {
  const previewVersion = action === 'preview' ? ++previewGeneration : previewGeneration
  const previewScope = backendScopeKey()
  if (action === 'preview') {
    preview.value = { section, title: files[section].artifact?.title ?? '', artifact: null, pdf: null }
  }
  if (!frozen) await prepare(section)
  if (action === 'preview' && (previewVersion !== previewGeneration || previewScope !== backendScopeKey() || !preview.value)) return
  const file = files[section],
    artifact = frozen?.artifact ?? file.artifact,
    pdf = frozen?.pdf ?? file.pdf,
    agent = props.agent
  if (!artifact || !pdf || file.delivering) {
    if (action === 'preview' && previewVersion === previewGeneration) closePreview()
    return
  }
  if (action === 'preview') {
    preview.value = { section, title: artifact.title, artifact, pdf }
    return
  }
  file.delivering = true
  file.error = ''
  try {
    if (action === 'download') {
      const saved = await download(`${artifact.title}.pdf`, pdf, 'application/pdf')
      if (
        saved &&
        agent === props.agent &&
        files[section] === file &&
        file.artifact?.artifact_id === artifact.artifact_id
      ) {
        file.saved = true
        remember(section)
        toast.success(t('k12.supplement.pdfSaved'))
      }
    } else {
      if (printing.value) return
      printing.value = section
      printTarget = {
        file,
        section,
        artifactId: artifact.artifact_id,
        agent,
        scope: backendScopeKey(),
      }
      await printController.value?.open({
        agent,
        scope: backendScopeKey(),
        sourceKind: 'practice_question',
        sourceRef: artifact.source_ref,
        title: artifact.title,
        artifactId: artifact.artifact_id,
        browserPrint: async () => {
          throw new Error(t('k12.supplement.nativePrintRequired'))
        },
      })
    }
  } catch (cause) {
    file.error = cause instanceof Error ? cause.message : String(cause)
    if (action === 'print') printed(false)
  } finally {
    file.delivering = false
  }
}
function printFailed(cause: Error) {
  const target = printTarget
  if (
    target &&
    target.agent === props.agent &&
    target.scope === backendScopeKey() &&
    target.file.artifact?.artifact_id === target.artifactId
  )
    target.file.error = cause.message
  printed(false)
}
function printed(result: boolean) {
  const target = printTarget
  if (
    result &&
    target &&
    target.agent === props.agent &&
    target.scope === backendScopeKey() &&
    files[target.section] === target.file &&
    target.file.artifact?.artifact_id === target.artifactId
  ) {
    target.file.printed = true
    remember(target.section)
  }
  printing.value = null
  printTarget = null
}
watch(
  () => [backendScopeKey(), props.agent, props.plan.plan_id],
  () => {
    files.textbook_consolidation = blank()
    files.arithmetic_warmup = blank()
    closePreview()
    for (const section of ['textbook_consolidation', 'arithmetic_warmup'] as Section[])
      counts[section] =
        props.plan.manual_track_recommendations?.[section]?.selected_item_count ??
        (section === 'textbook_consolidation' ? 5 : 10)
  },
  { immediate: true },
)
watch(
  () => [
    track('arithmetic_warmup')?.arithmetic_batch?.batch_id,
    arithmeticRetryPending.value,
    props.plan.manual_track_recommendations?.arithmetic_warmup.selected_item_count,
  ],
  () => {
    const frozenCount = props.plan.manual_track_recommendations?.arithmetic_warmup.selected_item_count
    if (arithmeticRetryPending.value && frozenCount !== undefined)
      counts.arithmetic_warmup = frozenCount
  },
  { immediate: true },
)
watch(
  () => [trackKey('textbook_consolidation'), trackKey('arithmetic_warmup')],
  () => {
    void prepare('textbook_consolidation')
    void prepare('arithmetic_warmup')
  },
  { immediate: true },
)
</script>

<template>
  <section class="k12-supplement">
    <div class="k12-supplement__heading">
      <b>{{ t('k12.supplement.title') }}</b
      ><span>{{ t('k12.supplement.description') }}</span>
    </div>
    <div class="k12-supplement__surface">
      <div class="k12-supplement__toolbar">
        <HcSelect
          v-model="selected"
          class="k12-supplement__type"
          :options="options"
          :aria-label="t('k12.supplement.type')"
        />
        <span class="k12-supplement__scope" :title="scope">{{ scope }}</span>
        <K12ManualQuestionCountField
          v-model="counts[selected]"
          :track="selected"
          :label="labels[selected]"
          :min="recommendation?.min_item_count ?? 1"
          :max="recommendation?.max_item_count ?? (selected === 'textbook_consolidation' ? 10 : 20)"
          :disabled="busy || unavailable || countFrozen"
        />
        <button
          type="button"
          class="btn k12-supplement__generate"
          :disabled="busy || unavailable || counts[selected] === null"
          :aria-busy="busy"
          @click="emit('generate', selected, counts[selected]!)"
        >
          <span :style="{ visibility: busy ? 'hidden' : undefined }">{{
            current.artifact ? t('k12.supplement.regenerate') : t('k12.supplement.generate')
          }}</span>
          <span :style="{ visibility: busy ? undefined : 'hidden' }"
            ><LoaderCircle :size="12" class="k12-supplement__spinner" />{{
              t('k12.customPaper.generatingShort')
            }}</span
          >
        </button>
      </div>
      <p v-if="failure" class="k12-supplement__feedback is-error" role="status">{{ failure }}</p>
      <p v-else-if="busy" class="k12-supplement__feedback" role="status">
        {{ t('k12.supplement.independent') }}
      </p>
      <div v-if="current.artifact || items(selected).length" class="k12-supplement__sheet">
        <span class="k12-supplement__file"><FileText :size="24" /></span>
        <div class="k12-supplement__filebody">
          <button
            type="button"
            class="k12-supplement__title"
            :disabled="current.preparing"
            @click="output(selected, 'preview')"
          >
            {{ fileTitle }}
          </button>
          <div class="k12-supplement__filemeta">
            <span>{{
              t('k12.supplement.meta', {
                count: current.artifact ? current.count : items(selected).length,
              })
            }}</span
            ><span class="stpill" :class="{ got: current.saved || current.printed }">{{
              current.preparing
                ? t('k12.supplement.preparing')
                : current.saved && current.printed
                  ? t('k12.supplement.savedPrinted')
                  : current.saved
                    ? t('k12.supplement.saved')
                    : current.printed
                      ? t('k12.supplement.printed')
                      : current.artifact
                        ? t('k12.supplement.ready')
                        : t('k12.supplement.pdfFailed')
            }}</span>
          </div>
        </div>
        <div class="k12-supplement__outputs">
          <button
            type="button"
            class="btn btn-primary"
            :disabled="current.preparing || current.delivering"
            @click="output(selected, 'print')"
          >
            <Printer :size="14" />{{ t('k12.supplement.print') }}
          </button>
          <button
            type="button"
            class="btn"
            :disabled="current.preparing || current.delivering"
            @click="output(selected, 'download')"
          >
            <Download :size="14" />{{ t('k12.supplement.download') }}
          </button>
        </div>
      </div>
    </div>
    <K12PrintPreviewModal
      :open="Boolean(preview)"
      :title="preview?.title ?? ''"
      :pdf="preview?.pdf ?? null"
      :preparing="Boolean(preview && !preview.pdf)"
      @close="closePreview"
      @print="preview?.artifact && preview.pdf && output(preview.section, 'print', { artifact: preview.artifact, pdf: preview.pdf })"
    />
    <K12PersistentPrintController
      ref="printController"
      mode="native-dialog"
      @result="printed"
      @error="printFailed"
    />
  </section>
</template>

<style scoped>
.k12-supplement {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 0.5px solid var(--hc-divider);
}
.k12-supplement__heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 9px;
}
.k12-supplement__heading > b {
  font-size: 13px;
  color: var(--hc-text-primary);
}
.k12-supplement__heading > span {
  font-size: 11.5px;
  color: var(--hc-text-muted);
}
.k12-supplement__surface {
  container-type: inline-size;
  border: 0.5px solid var(--hc-border);
  border-radius: 10px;
  background: var(--hc-bg-card);
  padding: 12px;
}
.k12-supplement__toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.k12-supplement__toolbar :deep(.manual-count) {
  flex: none;
}
.k12-supplement__toolbar :deep(.k12-manual-count-control__error:empty) {
  display: none;
}
.k12-supplement__type {
  flex: 0 0 134px;
  min-width: 0;
  width: 134px;
}
.k12-supplement__type :deep(.hc-select__trigger) {
  height: 36px;
  padding: 7px 32px 7px 11px;
  font-family: inherit;
}
.k12-supplement__scope {
  flex: 1;
  min-width: 0;
  color: var(--hc-text-muted);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.k12-supplement__generate {
  display: grid;
  flex: none;
  min-width: 98px;
  height: 36px;
  white-space: nowrap;
  justify-content: center;
}
.k12-supplement__generate > span {
  grid-area: 1/1;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  justify-content: center;
}
.k12-supplement__feedback {
  margin: 9px 0 0;
  color: var(--hc-text-muted);
  font-size: 11px;
  line-height: 1.5;
}
.k12-supplement__feedback.is-error {
  color: var(--hc-error);
}
.k12-supplement__sheet {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 0.5px solid var(--hc-divider);
}
.k12-supplement__file {
  width: 36px;
  height: 42px;
  display: grid;
  place-items: center;
  flex: none;
  color: var(--hc-accent);
  background: var(--hc-accent-subtle);
  border-radius: 8px;
}
.k12-supplement__filebody {
  flex: 1;
  min-width: 0;
}
.k12-supplement__title {
  display: block;
  max-width: 100%;
  border: 0;
  background: none;
  padding: 0;
  color: var(--hc-text-primary);
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.6;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.k12-supplement__title:hover {
  color: var(--hc-accent);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.k12-supplement__filemeta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin-top: 3px;
  font-size: 11px;
  color: var(--hc-text-muted);
}
.k12-supplement__filemeta > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.k12-supplement__filemeta > .stpill {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 7px;
  flex: none;
}
.k12-supplement__outputs {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.k12-supplement__outputs .btn {
  white-space: nowrap;
}
.k12-supplement__spinner {
  animation: sheet-spin 1s linear infinite;
}
@keyframes sheet-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .k12-supplement__spinner {
    animation: none;
  }
}
@container (max-width:420px) {
  .k12-supplement__toolbar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
  }
  .k12-supplement__type {
    grid-column: 1/-1;
    width: 100%;
  }
  .k12-supplement__scope {
    display: none;
  }
  .k12-supplement__sheet {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }
  .k12-supplement__file {
    display: none;
  }
  .k12-supplement__outputs {
    justify-content: flex-start;
  }
  .k12-supplement__heading > span {
    display: none;
  }
}
</style>
