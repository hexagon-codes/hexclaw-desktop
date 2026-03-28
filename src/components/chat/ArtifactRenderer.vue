<script setup lang="ts">
import { ref, computed } from 'vue'
import { Play, Maximize2, X } from 'lucide-vue-next'

const props = defineProps<{
  content: string
  language: string
}>()

const showPreview = ref(false)
const fullscreen = ref(false)

const isPreviewable = computed(() =>
  ['html', 'svg', 'mermaid'].includes(props.language)
)

const iframeSrcdoc = computed(() => {
  if (props.language === 'svg') {
    return `<!DOCTYPE html><html><head><style>body{margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#fff}</style></head><body>${props.content}</body></html>`
  }
  // HTML — inject CSP for security
  return `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:"><style>body{margin:8px;font-family:system-ui}</style></head><body>${props.content}</body></html>`
})
</script>

<template>
  <div v-if="isPreviewable" class="artifact-renderer">
    <button v-if="!showPreview" class="artifact-renderer__btn" @click="showPreview = true">
      <Play :size="12" /> Preview
    </button>
    <div v-else class="artifact-renderer__preview" :class="{ 'artifact-renderer__preview--fullscreen': fullscreen }">
      <div class="artifact-renderer__toolbar">
        <span class="artifact-renderer__label">{{ language }} preview</span>
        <button class="artifact-renderer__icon-btn" @click="fullscreen = !fullscreen">
          <Maximize2 :size="12" />
        </button>
        <button class="artifact-renderer__icon-btn" @click="showPreview = false">
          <X :size="12" />
        </button>
      </div>
      <iframe
        :srcdoc="iframeSrcdoc"
        sandbox="allow-scripts"
        class="artifact-renderer__iframe"
        :style="{ height: fullscreen ? '80vh' : '300px' }"
      />
    </div>
  </div>
</template>

<style scoped>
.artifact-renderer { margin-top: 4px; }
.artifact-renderer__btn { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; font-size: 11px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-secondary); color: var(--text-secondary); cursor: pointer; }
.artifact-renderer__btn:hover { background: var(--bg-tertiary); }
.artifact-renderer__preview { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.artifact-renderer__preview--fullscreen { position: fixed; inset: 40px; z-index: 100; background: var(--bg-primary); }
.artifact-renderer__toolbar { display: flex; align-items: center; gap: 8px; padding: 4px 8px; background: var(--bg-secondary); border-bottom: 1px solid var(--border); }
.artifact-renderer__label { flex: 1; font-size: 11px; color: var(--text-secondary); }
.artifact-renderer__icon-btn { padding: 2px; border: none; background: none; color: var(--text-secondary); cursor: pointer; border-radius: 4px; }
.artifact-renderer__icon-btn:hover { background: var(--bg-tertiary); }
.artifact-renderer__iframe { width: 100%; border: none; background: white; }
</style>
