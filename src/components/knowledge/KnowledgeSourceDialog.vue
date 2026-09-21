<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { X } from 'lucide-vue-next'
import KnowledgeSourceViewer from './KnowledgeSourceViewer.vue'
import '@/components/common/image-preview.css'
defineProps<{ documentId: string; title: string; sourceDigest?: string; initialPage?: number }>()
const emit = defineEmits<{ close: [] }>()
const root = ref<HTMLDialogElement | null>(null)
const viewer = ref<InstanceType<typeof KnowledgeSourceViewer> | null>(null)
let previous: HTMLElement | null = null
onMounted(() => {
  previous = document.activeElement as HTMLElement
  root.value?.showModal()
  // 初始焦点留在容器，关闭按钮仅在键盘导航时显示焦点环。
  root.value?.focus({ preventScroll: true })
})
onBeforeUnmount(() => {
  root.value?.close()
  if (previous?.isConnected) previous.focus({ preventScroll: true })
})
</script>
<template>
  <Teleport to="body">
    <dialog
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
      />
    </dialog>
  </Teleport>
</template>

<style scoped>
/* 对话框的背景层负责模糊，保证 WebKit 与 Chromium 都处理实际窗口背景。 */
.hc-pdf-source { backdrop-filter: none; -webkit-backdrop-filter: none; }
.hc-pdf-source:focus { outline: none; }
.hc-pdf-source::backdrop { backdrop-filter: blur(12px) saturate(150%); -webkit-backdrop-filter: blur(12px) saturate(150%); clip-path: inset(var(--hc-titlebar-height, 38px) 0 0); }
</style>
