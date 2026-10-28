<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import KnowledgeSourceDialog from '@/components/knowledge/KnowledgeSourceDialog.vue'
import pdfIcon from '@/assets/pdf-file.png'
import { backendScopeKey } from '@/services/backend-context'
import { useToast } from '@/composables/useToast'
import { savePdfFile } from '@/utils/download'

const props = defineProps<{
  filename: string
  sourceKey: string
  loadPdf: (signal: AbortSignal) => Promise<Blob>
  preparing?: boolean
}>()
const { t } = useI18n()
const toast = useToast()
const busy = ref(false)
const preview = shallowRef<Blob | null>(null)
let cached: Blob | null = null
let request: AbortController | null = null
let generation = 0
let trigger: HTMLElement | null = null
let pendingPreviewCancel: ((event: KeyboardEvent) => void) | null = null

function release() {
  generation++
  if (pendingPreviewCancel) document.removeEventListener('keydown', pendingPreviewCancel, true)
  pendingPreviewCancel = null
  request?.abort()
  request = null
  cached = null
  preview.value = null
  busy.value = false
  trigger = null
}
watch(() => [props.sourceKey, backendScopeKey()], release)
onBeforeUnmount(release)

async function open(action: 'preview' | 'download') {
  if (busy.value || props.preparing) return
  const version = generation
  const scope = backendScopeKey()
  const filename = props.filename
  const sourceTrigger =
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  busy.value = true
  const current = new AbortController()
  request = current
  const cancelPendingPreview = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || version !== generation || preview.value) return
    event.preventDefault()
    event.stopPropagation()
    release()
    const cancelledGeneration = generation
    void nextTick(() => {
      if (
        generation === cancelledGeneration &&
        scope === backendScopeKey() &&
        sourceTrigger?.isConnected
      )
        sourceTrigger.focus({ preventScroll: true })
    })
  }
  // 与知识库入口相同，等待文件期间的Esc也取消本次预览。
  if (action === 'preview') {
    pendingPreviewCancel = cancelPendingPreview
    document.addEventListener('keydown', cancelPendingPreview, true)
  }
  try {
    // 同次打开持有冻结快照；新的远程读取由共享缓存校验，不重新渲染。
    const pdf = cached ?? (await props.loadPdf(current.signal))
    if (current.signal.aborted || version !== generation || scope !== backendScopeKey()) return
    cached = pdf
    if (action === 'preview') {
      trigger = sourceTrigger
      preview.value = pdf
    } else await savePdfFile(pdf, filename)
  } catch (error) {
    if (!current.signal.aborted && version === generation && scope === backendScopeKey()) {
      toast.error(error instanceof Error ? error.message : 'Failed to read PDF report')
    }
  } finally {
    document.removeEventListener('keydown', cancelPendingPreview, true)
    if (pendingPreviewCancel === cancelPendingPreview) pendingPreviewCancel = null
    if (version === generation) {
      request = null
      busy.value = false
      if (action === 'download' && !preview.value) cached = null
    }
  }
}

async function closePreview() {
  preview.value = null
  cached = null
  const target = trigger
  const version = generation
  trigger = null
  await nextTick()
  if (version === generation && target?.isConnected) target.focus({ preventScroll: true })
}
</script>

<template>
  <div class="hc-report-pdf-card" :aria-busy="busy || preparing" data-testid="report-pdf-card">
    <img
      class="hc-report-pdf-card__icon"
      :src="pdfIcon"
      width="28"
      height="36"
      alt=""
      aria-hidden="true"
    />
    <button
      class="hc-report-pdf-card__name"
      type="button"
      :disabled="busy || preparing"
      @click="open('preview')"
    >
      {{ filename }}
    </button>
    <span class="hc-report-pdf-card__format">PDF</span>
    <div class="hc-report-pdf-card__actions">
      <button
        class="hc-report-pdf-card__action"
        type="button"
        :disabled="busy || preparing"
        @click="open('preview')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
          <circle cx="12" cy="12" r="3" /></svg
        >{{ t('common.preview') }}
      </button>
      <button
        class="hc-report-pdf-card__action"
        type="button"
        :disabled="busy || preparing"
        @click="open('download')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4" /></svg
        >{{ t('common.download') }}
      </button>
    </div>
  </div>
  <KnowledgeSourceDialog v-if="preview" :pdf="preview" :title="filename" @close="closePreview" />
</template>

<style scoped>
.hc-report-pdf-card {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 68px;
  margin-top: 12px;
  padding: 15px 16px;
  border: 1px solid var(--hc-border);
  border-radius: var(--hc-radius-sm);
  background: var(--hc-bg-card);
  box-sizing: border-box;
}
.hc-report-pdf-card__icon {
  display: block;
  width: 28px;
  height: 36px;
  object-fit: contain;
  flex: none;
}
.hc-report-pdf-card__name {
  min-width: 0;
  padding: 0;
  border: 0;
  background: none;
  color: var(--hc-text-primary);
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.6;
  text-align: start;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.hc-report-pdf-card__name:hover {
  color: var(--hc-accent);
}
.hc-report-pdf-card__format {
  color: var(--hc-text-muted);
  font-size: 11px;
}
.hc-report-pdf-card__actions {
  display: flex;
  gap: 8px;
}
.hc-report-pdf-card__action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 34px;
  padding: 6px 11px;
  border: 1px solid var(--hc-border);
  border-radius: var(--hc-radius-sm);
  background: var(--hc-bg-main);
  color: var(--hc-text-secondary);
  font: inherit;
  font-size: 12px;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
}
.hc-report-pdf-card__action:hover {
  color: var(--hc-accent);
  border-color: var(--hc-accent);
  background: var(--hc-accent-subtle);
}
.hc-report-pdf-card__action svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.hc-report-pdf-card__action:focus-visible,
.hc-report-pdf-card__name:focus-visible {
  outline: 2px solid var(--hc-accent);
  outline-offset: 3px;
}
.hc-report-pdf-card__action:disabled,
.hc-report-pdf-card__name:disabled {
  cursor: default;
  opacity: 0.6;
}
@media (max-width: 1100px) {
  .hc-report-pdf-card {
    grid-template-columns: 28px minmax(0, 1fr) auto;
    gap: 10px;
    padding: 14px;
  }
  .hc-report-pdf-card__actions {
    grid-column: 2/4;
  }
  .hc-report-pdf-card__name {
    font-size: 13px;
  }
  .hc-report-pdf-card__action {
    min-height: 36px;
  }
}
</style>
