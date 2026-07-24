<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'

const props = defineProps<{
  open: boolean
  title: string
  /** The exact frozen PDF Blob that is also handed to the native print adapter. */
  pdf: Blob | null
  printing?: boolean
}>()

const emit = defineEmits<{
  close: []
  print: []
}>()

type PreviewStatus = 'idle' | 'loading' | 'ready' | 'error'

const canvasHost = ref<HTMLElement | null>(null)
const status = ref<PreviewStatus>('idle')
const errorMessage = ref('')
const renderedPages = ref(0)
const totalPages = ref(0)

let generation = 0
let loadingTask: PDFDocumentLoadingTask | null = null
let pdfDocument: PDFDocumentProxy | null = null
let renderTasks: RenderTask[] = []

async function readPdfBytes(pdf: Blob): Promise<Uint8Array> {
  if (typeof pdf.arrayBuffer === 'function') {
    return new Uint8Array(await pdf.arrayBuffer())
  }
  return await new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('读取 PDF 失败'))
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.readAsArrayBuffer(pdf)
  })
}

function clearCanvasHost() {
  canvasHost.value?.replaceChildren()
}

function disposeSession() {
  const staleLoadingTask = loadingTask
  const staleDocument = pdfDocument
  const staleRenderTasks = renderTasks
  loadingTask = null
  pdfDocument = null
  renderTasks = []

  for (const task of staleRenderTasks) {
    try {
      task.cancel()
    } catch {
      // A completed PDF.js render task is already settled.
    }
  }
  if (staleDocument) {
    void Promise.resolve(staleDocument.destroy()).catch(() => undefined)
  } else if (staleLoadingTask) {
    void Promise.resolve(staleLoadingTask.destroy()).catch(() => undefined)
  }
}

function resetPreview() {
  generation += 1
  disposeSession()
  clearCanvasHost()
  status.value = 'idle'
  errorMessage.value = ''
  renderedPages.value = 0
  totalPages.value = 0
}

async function renderPreview(pdf: Blob) {
  const currentGeneration = ++generation
  disposeSession()
  clearCanvasHost()
  status.value = 'loading'
  errorMessage.value = ''
  renderedPages.value = 0
  totalPages.value = 0

  try {
    const [{ GlobalWorkerOptions, getDocument }, { default: workerSrc }] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.mjs?url'),
    ])
    if (currentGeneration !== generation) return
    GlobalWorkerOptions.workerSrc = workerSrc

    const data = await readPdfBytes(pdf)
    if (currentGeneration !== generation) return
    const task = getDocument({
      data,
      isEvalSupported: false,
      useSystemFonts: true,
    })
    loadingTask = task
    const documentProxy = await task.promise
    if (currentGeneration !== generation) {
      await documentProxy.destroy()
      return
    }
    loadingTask = null
    pdfDocument = documentProxy
    totalPages.value = documentProxy.numPages
    await nextTick()

    const host = canvasHost.value
    if (!host) throw new Error('打印预览容器不可用')

    for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
      if (currentGeneration !== generation) return
      const page = await documentProxy.getPage(pageNumber)
      const baseViewport = page.getViewport({ scale: 1 })
      const availableWidth = host.clientWidth > 0 ? Math.max(320, host.clientWidth - 24) : 794
      const cssScale = Math.min(1.45, availableWidth / baseViewport.width)
      const outputScale = Math.min(window.devicePixelRatio || 1, 2)
      const viewport = page.getViewport({ scale: cssScale * outputScale })

      const pageShell = document.createElement('article')
      pageShell.className = 'k12-print-preview__page'
      pageShell.dataset.testid = 'k12-print-preview-page'
      pageShell.setAttribute('aria-label', `第 ${pageNumber} 页，共 ${documentProxy.numPages} 页`)

      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      canvas.style.width = `${Math.ceil(baseViewport.width * cssScale)}px`
      canvas.style.height = `${Math.ceil(baseViewport.height * cssScale)}px`
      pageShell.append(canvas)
      host.append(pageShell)

      const renderTask = page.render({
        canvas,
        viewport,
        intent: 'display',
        background: '#ffffff',
      })
      renderTasks.push(renderTask)
      await renderTask.promise
      renderTasks = renderTasks.filter((candidate) => candidate !== renderTask)
      renderedPages.value = pageNumber
    }

    if (currentGeneration === generation) status.value = 'ready'
  } catch (cause) {
    if (currentGeneration !== generation) return
    disposeSession()
    clearCanvasHost()
    errorMessage.value = cause instanceof Error ? cause.message : String(cause)
    status.value = 'error'
  }
}

function retryPreview() {
  if (!props.pdf || props.printing) return
  void renderPreview(props.pdf)
}

function confirmPrint() {
  if (status.value !== 'ready' || props.printing) return
  emit('print')
}

watch(
  () => [props.open, props.pdf] as const,
  ([open, pdf]) => {
    resetPreview()
    if (!open) return
    if (!pdf) {
      errorMessage.value = '打印 PDF 不可用'
      status.value = 'error'
      return
    }
    void renderPreview(pdf)
  },
  { immediate: true, flush: 'post' },
)

onBeforeUnmount(resetPreview)
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="k12-print-preview__overlay" @click.self="emit('close')">
      <section
        class="k12-print-preview"
        role="dialog"
        aria-modal="true"
        :aria-label="`${title}打印预览`"
        data-testid="k12-print-preview"
      >
        <header class="k12-print-preview__head">
          <div>
            <b>{{ title }}</b>
            <span>打印预览</span>
          </div>
          <button
            type="button"
            class="k12-print-preview__close"
            :disabled="printing"
            aria-label="关闭打印预览"
            data-testid="k12-print-preview-close"
            @click="emit('close')"
          >
            ×
          </button>
        </header>
        <div class="k12-print-preview__body" :aria-busy="status === 'loading'">
          <div
            v-if="status === 'loading'"
            class="k12-print-preview__state"
            role="status"
            data-testid="k12-print-preview-loading"
          >
            <span class="k12-print-preview__spinner" aria-hidden="true" />
            <b>正在生成打印预览…</b>
            <span v-if="totalPages > 0">已渲染 {{ renderedPages }} / {{ totalPages }} 页</span>
            <span v-else>正在读取 PDF</span>
          </div>
          <div
            v-else-if="status === 'error'"
            class="k12-print-preview__state k12-print-preview__state--error"
            role="alert"
            data-testid="k12-print-preview-error"
          >
            <b>无法显示打印预览</b>
            <span>{{ errorMessage }}</span>
            <button
              type="button"
              class="hc-btn"
              :disabled="printing"
              data-testid="k12-print-preview-retry"
              @click="retryPreview"
            >
              重试预览
            </button>
          </div>
          <span
            v-else-if="status === 'ready'"
            class="sr-only"
            role="status"
            data-testid="k12-print-preview-ready"
          >
            打印预览已就绪，共 {{ totalPages }} 页
          </span>
          <div
            ref="canvasHost"
            class="k12-print-preview__pages"
            :class="{ 'k12-print-preview__pages--ready': status === 'ready' }"
            data-testid="k12-print-preview-pages"
          />
        </div>
        <footer class="k12-print-preview__foot">
          <button type="button" class="hc-btn" :disabled="printing" @click="emit('close')">
            取消
          </button>
          <button
            type="button"
            class="hc-btn hc-btn-primary"
            :disabled="printing || status !== 'ready'"
            data-testid="k12-print-preview-print"
            @click="confirmPrint"
          >
            {{ printing ? '正在打开系统打印…' : '打印' }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.k12-print-preview__overlay {
  position: fixed;
  z-index: var(--hc-z-modal);
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, #081220 42%, transparent);
  backdrop-filter: blur(4px);
}
.k12-print-preview {
  width: min(920px, 100%);
  height: min(820px, 92vh);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  border: 0.5px solid var(--hc-border);
  border-radius: 16px;
  background: var(--hc-bg-elevated);
  box-shadow: var(--hc-shadow-float);
}
.k12-print-preview__head,
.k12-print-preview__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-color: var(--hc-border);
}
.k12-print-preview__head {
  border-bottom: 0.5px solid var(--hc-border);
}
.k12-print-preview__head div {
  display: grid;
  gap: 2px;
}
.k12-print-preview__head b {
  color: var(--hc-text-primary);
  font-size: 15px;
}
.k12-print-preview__head span {
  color: var(--hc-text-muted);
  font-size: 12px;
}
.k12-print-preview__close {
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--hc-text-muted);
  font: inherit;
  font-size: 20px;
  cursor: pointer;
}
.k12-print-preview__close:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}
.k12-print-preview__body {
  position: relative;
  min-height: 0;
  overflow: auto;
  padding: 18px;
  background: var(--hc-bg-main);
}
.k12-print-preview__pages {
  display: grid;
  justify-items: center;
  gap: 18px;
  min-height: 100%;
  opacity: 0;
}
.k12-print-preview__pages--ready {
  opacity: 1;
}
.k12-print-preview__pages :deep(.k12-print-preview__page) {
  overflow: hidden;
  max-width: 100%;
  border: 0.5px solid var(--hc-border);
  border-radius: 8px;
  background: #fff;
  box-shadow: var(--hc-shadow-sm);
}
.k12-print-preview__pages :deep(canvas) {
  display: block;
  max-width: 100%;
  height: auto !important;
  background: #fff;
}
.k12-print-preview__state {
  position: absolute;
  z-index: 1;
  inset: 18px;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 8px;
  border-radius: 8px;
  background: var(--hc-bg-elevated);
  color: var(--hc-text-secondary);
  text-align: center;
}
.k12-print-preview__state b {
  color: var(--hc-text-primary);
}
.k12-print-preview__state--error {
  color: var(--hc-danger);
}
.k12-print-preview__spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--hc-border);
  border-top-color: var(--hc-accent);
  border-radius: 999px;
  animation: k12-print-preview-spin 0.8s linear infinite;
}
.k12-print-preview__foot {
  justify-content: flex-end;
  gap: 10px;
  border-top: 0.5px solid var(--hc-border);
}
@keyframes k12-print-preview-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .k12-print-preview__spinner {
    animation: none;
  }
}
</style>
