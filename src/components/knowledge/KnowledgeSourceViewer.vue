<script setup lang="ts">
import { ChevronLeft, ChevronRight, Minus, Plus, Scan } from 'lucide-vue-next'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { getDocumentSource } from '@/api/knowledge'
import { backendScopeKey } from '@/services/backend-context'

const props = withDefaults(
  defineProps<{ documentId: string; sourceDigest?: string; initialPage?: number }>(),
  { initialPage: 1 },
)
const pageNumber = ref(1)
const pageDraft = ref('1')
const totalPages = ref(0)
const zoom = ref(100)
const error = ref('')
const loading = ref(true)
const host = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
let document: PDFDocumentProxy | null = null
let task: PDFDocumentLoadingTask | null = null
let rendering: RenderTask | null = null
let request: AbortController | null = null
let generation = 0
let renderGeneration = 0
let observer: ResizeObserver | null = null
let observedSize = ''

function dispose() {
  generation++
  renderGeneration++
  request?.abort()
  request = null
  rendering?.cancel()
  rendering = null
  const old = document
  document = null
  if (old) void old.destroy().catch(() => undefined)
  else if (task) void task.destroy().catch(() => undefined)
  task = null
}

async function renderPage() {
  const current = document
  if (!current || !host.value || !canvas.value) return
  const version = ++renderGeneration
  // 同一画布不能同时渲染两页，取消后等待上一渲染释放。
  const previous = rendering
  previous?.cancel()
  if (previous) await previous.promise.catch(() => undefined)
  if (version !== renderGeneration) return
  loading.value = true
  error.value = ''
  try {
    const page = await current.getPage(pageNumber.value)
    if (version !== renderGeneration || current !== document || !canvas.value || !host.value) return
    const base = page.getViewport({ scale: 1 })
    const fit = Math.min(
      Math.max(1, host.value.clientWidth - 24) / base.width,
      Math.max(1, host.value.clientHeight - 24) / base.height,
    )
    const cssScale = (fit * zoom.value) / 100
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const viewport = page.getViewport({ scale: cssScale * dpr })
    const target = window.document.createElement('canvas')
    target.width = Math.ceil(viewport.width)
    target.height = Math.ceil(viewport.height)
    target.style.width = `${base.width * cssScale}px`
    target.style.height = `${base.height * cssScale}px`
    rendering = page.render({ canvas: target, viewport, background: '#ffffff' })
    await rendering.promise
    if (version !== renderGeneration || current !== document || !canvas.value) return
    const visible = canvas.value
    visible.width = target.width
    visible.height = target.height
    visible.style.width = target.style.width
    visible.style.height = target.style.height
    visible.getContext('2d')?.drawImage(target, 0, 0)
  } catch (cause) {
    if (version === renderGeneration)
      error.value = cause instanceof Error ? cause.message : 'Failed to render PDF page'
  } finally {
    if (version === renderGeneration) {
      loading.value = false
      rendering = null
    }
  }
}

async function load() {
  dispose()
  const version = generation
  loading.value = true
  error.value = ''
  totalPages.value = 0
  zoom.value = 100
  request = new AbortController()
  try {
    const blob = await getDocumentSource(props.documentId, props.sourceDigest, request.signal)
    const [{ GlobalWorkerOptions, getDocument }, { default: workerSrc }] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.mjs?url'),
    ])
    const data = new Uint8Array(await blob.arrayBuffer())
    if (version !== generation) return
    GlobalWorkerOptions.workerSrc = workerSrc
    task = getDocument({
      data,
      cMapUrl: new URL('/pdfjs/cmaps/', window.location.href).href,
      cMapPacked: true,
      iccUrl: new URL('/pdfjs/iccs/', window.location.href).href,
      standardFontDataUrl: new URL('/pdfjs/standard_fonts/', window.location.href).href,
      wasmUrl: new URL('/pdfjs/wasm/', window.location.href).href,
      isEvalSupported: false,
      useSystemFonts: true,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
    })
    const loaded = await task.promise
    if (version !== generation) {
      await loaded.destroy()
      return
    }
    task = null
    document = loaded
    totalPages.value = loaded.numPages
    if (
      !Number.isInteger(props.initialPage) ||
      props.initialPage < 1 ||
      props.initialPage > loaded.numPages
    )
      throw new Error('Referenced PDF page is unavailable')
    pageNumber.value = props.initialPage
    await nextTick()
    await renderPage()
  } catch (cause) {
    if (version === generation) {
      error.value = cause instanceof Error ? cause.message : 'Failed to load PDF source'
      loading.value = false
    }
  }
}

watch(() => [props.documentId, props.sourceDigest, props.initialPage, backendScopeKey()], load)
watch(pageNumber, (value) => {
  pageDraft.value = String(value)
})
watch([pageNumber, zoom], () => {
  if (document) void renderPage()
})
onMounted(() => {
  observer = new ResizeObserver(() => {
    // 滚动条改变内容区宽度不代表窗口变化，避免放大后反复取消渲染。
    const rect = host.value?.getBoundingClientRect()
    const size = `${rect?.width}:${rect?.height}`
    if (rect?.width && size !== observedSize) {
      observedSize = size
      if (document) void renderPage()
    }
  })
  if (host.value) observer.observe(host.value)
  void load()
})
// 输入草稿不改变当前页；非法值恢复原页，Escape 不穿透到预览关闭。
function commitPage() {
  const value = pageDraft.value.trim()
  const target = Number(value)
  if (
    !loading.value &&
    /^\d+$/.test(value) &&
    Number.isInteger(target) &&
    target >= 1 &&
    target <= totalPages.value
  )
    pageNumber.value = target
  pageDraft.value = String(pageNumber.value)
}
function pageInputKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' && event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  if (event.key === 'Escape') pageDraft.value = String(pageNumber.value)
  ;(event.target as HTMLInputElement).blur()
}
function keyboard(event: KeyboardEvent) {
  if (event.target instanceof HTMLInputElement) return
  if (loading.value) return
  if (event.key === 'ArrowLeft' && pageNumber.value > 1) {
    event.preventDefault()
    pageNumber.value--
  } else if (event.key === 'ArrowRight' && pageNumber.value < totalPages.value) {
    event.preventDefault()
    pageNumber.value++
  }
}
defineExpose({ keyboard })

onBeforeUnmount(() => {
  observer?.disconnect()
  dispose()
})
</script>

<template>
  <section class="hc-pdf-reader" :aria-busy="loading">
    <div ref="host" class="hc-pdf-reader__canvas">
      <div v-if="error" class="hc-pdf-reader__status" role="alert">{{ error }}</div>
      <div v-else-if="loading" class="hc-pdf-reader__status" role="status">Loading PDF…</div>
      <canvas
        ref="canvas"
        :style="{ visibility: loading || error ? 'hidden' : undefined }"
        :aria-hidden="loading || !!error"
        :aria-label="`PDF page ${pageNumber}`"
      />
    </div>
    <div class="hc-image-viewer__tools">
      <button
        class="hc-image-viewer__button"
        aria-label="Previous page"
        :disabled="loading || pageNumber <= 1"
        @click="pageNumber--"
      >
        <ChevronLeft />
      </button>
      <span class="hc-pdf-reader__pages">
        <input
          v-model="pageDraft"
          class="hc-pdf-reader__page-input"
          type="text"
          inputmode="numeric"
          aria-label="Page number"
          autocomplete="off"
          :style="{ width: `${Math.max(2, String(totalPages).length)}ch` }"
          :disabled="loading || !totalPages"
          @blur="commitPage"
          @keydown="pageInputKeydown"
        />
        <span>/ {{ totalPages || '—' }}</span>
      </span>
      <button
        class="hc-image-viewer__button"
        aria-label="Next page"
        :disabled="loading || pageNumber >= totalPages"
        @click="pageNumber++"
      >
        <ChevronRight />
      </button>
      <span class="hc-image-viewer__divider" />
      <button
        class="hc-image-viewer__button"
        aria-label="Zoom out"
        :disabled="loading || zoom <= 50"
        @click="zoom -= 25"
      >
        <Minus />
      </button>
      <span class="hc-image-viewer__scale">{{ zoom }}%</span>
      <button
        class="hc-image-viewer__button"
        aria-label="Zoom in"
        :disabled="loading || zoom >= 300"
        @click="zoom += 25"
      >
        <Plus />
      </button>
      <span class="hc-image-viewer__divider" />
      <button
        class="hc-image-viewer__button"
        aria-label="Fit to window"
        :disabled="loading"
        @click="zoom = 100"
      >
        <Scan />
      </button>
    </div>
  </section>
</template>

<style scoped>
/* PDF 与图片共享全窗口背景；文档滚动只发生在固定尺寸的阅读舞台。 */
.hc-pdf-reader {
  position: absolute;
  inset: 0;
  min-width: 0;
  color: #fff;
}
.hc-pdf-reader__canvas {
  position: absolute;
  inset: 72px 76px 88px;
  overflow: auto;
  scrollbar-gutter: stable both-edges;
  padding: 12px;
  text-align: center;
  box-sizing: border-box;
}
.hc-pdf-reader__canvas canvas {
  display: block;
  margin: auto;
  box-shadow: 0 2px 20px #0003;
  max-width: none;
}
.hc-pdf-reader__status {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  font-size: 13px;
  color: #ffffffcc;
  pointer-events: none;
}
.hc-pdf-reader__pages {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-variant-numeric: tabular-nums;
  min-width: 72px;
  text-align: center;
  font-size: 12px;
  white-space: nowrap;
}
.hc-pdf-reader__page-input {
  box-sizing: content-box;
  padding: 4px;
  border: 1px solid #ffffff30;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-variant-numeric: tabular-nums;
  text-align: center;
  outline: none;
  box-shadow: none;
}
.hc-pdf-reader__page-input:focus {
  border-color: #ffffffa6;
  outline: none;
  box-shadow: none;
}
.hc-pdf-reader__page-input:disabled {
  opacity: 0.4;
}
@media (max-width: 600px) {
  .hc-pdf-reader__canvas {
    left: 12px;
    right: 12px;
  }
}
</style>
