<script setup lang="ts">
import { computed } from 'vue'
import type { Artifact } from '@/types'
import { sanitizeArtifactHtml } from '@/utils/safe-html'

const props = defineProps<{
  artifact: Artifact
}>()

const previewHtml = computed(() =>
  sanitizeArtifactHtml(props.artifact.content, props.artifact.title),
)
</script>

<template>
  <div class="hc-preview">
    <div class="hc-preview__header">
      <span class="hc-preview__badge">Preview</span>
      <span class="hc-preview__title">{{ artifact.title }}</span>
    </div>
    <iframe
      class="hc-preview__frame"
      :title="artifact.title || 'Artifact Preview'"
      :srcdoc="previewHtml"
      sandbox=""
    />
  </div>
</template>

<style scoped>
.hc-preview {
  height: 100%;
  display: flex;
  flex-direction: column;
  border-radius: var(--hc-radius-md);
  overflow: hidden;
  border: 1px solid var(--hc-border);
}

.hc-preview__header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--hc-bg-active);
  border-bottom: 1px solid var(--hc-border);
  font-size: 11px;
}

.hc-preview__badge {
  font-weight: 600;
  color: #34c759;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.hc-preview__title {
  flex: 1;
  color: var(--hc-text-muted);
}

.hc-preview__frame {
  flex: 1;
  border: none;
  background: #fff;
  width: 100%;
  min-height: 300px;
}
</style>
