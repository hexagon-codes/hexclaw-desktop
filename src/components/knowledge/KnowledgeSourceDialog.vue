<script setup lang="ts">
import { nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'
import KnowledgeSourceViewer from './KnowledgeSourceViewer.vue'
import '@/components/common/image-preview.css'
import { checkDocumentSource, documentSourceStatus } from '@/api/knowledge'
import { backendScopeKey } from '@/services/backend-context'
import { useToast } from '@/composables/useToast'
const props = defineProps<{
  documentId: string
  title: string
  sourceDigest?: string
  initialPage?: number
}>()
const emit = defineEmits<{ close: [] }>()
const root = ref<HTMLDialogElement | null>(null)
const viewer = ref<InstanceType<typeof KnowledgeSourceViewer> | null>(null)
let previous: HTMLElement | null = null
const available = ref(false)
let request = new AbortController()
const scope = backendScopeKey()
const toast = useToast()
function unavailable(error: unknown) {
  if (request.signal.aborted || backendScopeKey() !== scope) return
  const status = documentSourceStatus(error)
  if (status === 410) toast.info('File deleted. The original is no longer available.')
  else if (status === 404) toast.warning('The original file is unavailable.')
  else toast.error(error instanceof Error ? error.message : 'Failed to check the original file.')
  emit('close')
}
watch(
  () => backendScopeKey(),
  () => {
    request.abort()
    emit('close')
  },
)
async function prepareSource() {
  request.abort()
  const current = new AbortController()
  request = current
  root.value?.close()
  available.value = false
  try {
    // 先核对原文件，避免已删除来源进入空白预览；HEAD 不下载 PDF 正文。
    await checkDocumentSource(props.documentId, props.sourceDigest, current.signal)
    if (current.signal.aborted || backendScopeKey() !== scope) return
    available.value = true
    await nextTick()
    if (current.signal.aborted) return
    root.value?.showModal()
    root.value?.focus({ preventScroll: true })
  } catch (error) {
    if (!current.signal.aborted) unavailable(error)
  }
}
function cancelPending(event: KeyboardEvent) {
  if (available.value || event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  request.abort()
  emit('close')
}
watch(() => [props.documentId, props.sourceDigest], prepareSource)
onMounted(() => {
  previous = document.activeElement as HTMLElement
  document.addEventListener('keydown', cancelPending, true)
  void prepareSource()
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', cancelPending, true)
  request.abort()
  root.value?.close()
  if (previous?.isConnected && backendScopeKey() === scope) previous.focus({ preventScroll: true })
})
</script>
<template>
  <Teleport to="body">
    <dialog
      v-if="available"
      ref="root"
      class="hc-image-viewer hc-pdf-source"
      tabindex="-1"
      :aria-label="title"
      @cancel.prevent="emit('close')"
      @keydown.stop="viewer?.keyboard($event)"
    >
      <header class="hc-image-viewer__header">
        <span class="hc-image-viewer__title">{{ title }}</span>
      </header>
      <button
        class="hc-image-viewer__button hc-image-viewer__close"
        aria-label="Close source"
        @click="emit('close')"
      >
        <X />
      </button>
      <KnowledgeSourceViewer
        ref="viewer"
        :document-id="documentId"
        :source-digest="sourceDigest"
        :initial-page="initialPage"
        @unavailable="unavailable"
      />
    </dialog>
  </Teleport>
</template>

<style scoped>
/* 对话框的背景层负责模糊，保证 WebKit 与 Chromium 都处理实际窗口背景。 */
.hc-pdf-source {
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
.hc-pdf-source:focus {
  outline: none;
}
.hc-pdf-source::backdrop {
  backdrop-filter: blur(12px) saturate(150%);
  -webkit-backdrop-filter: blur(12px) saturate(150%);
  clip-path: inset(var(--hc-titlebar-height, 38px) 0 0);
}
</style>
