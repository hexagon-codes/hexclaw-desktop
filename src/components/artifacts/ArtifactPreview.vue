<script setup lang="ts">
import { ref, computed } from 'vue'
import { Play, ShieldOff } from 'lucide-vue-next'
import type { Artifact } from '@/types'

const props = defineProps<{
  artifact: Artifact
}>()

const allowScripts = ref(false)
const sandboxAttr = computed(() => allowScripts.value ? 'allow-scripts' : '')
</script>

<template>
  <div class="hc-preview">
    <div class="hc-preview__header">
      <span class="hc-preview__badge">Preview</span>
      <span class="hc-preview__title">{{ artifact.title }}</span>
      <button
        v-if="!allowScripts"
        class="hc-preview__run-btn"
        title="Allow scripts to run in this preview"
        @click="allowScripts = true"
      >
        <Play :size="12" />
        Run
      </button>
      <span v-else class="hc-preview__running-badge">
        <ShieldOff :size="11" />
        Scripts enabled
      </span>
    </div>
    <iframe
      class="hc-preview__frame"
      :srcdoc="artifact.content"
      :sandbox="sandboxAttr"
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

.hc-preview__run-btn {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border: 1px solid var(--hc-border);
  border-radius: var(--hc-radius-sm);
  background: transparent;
  color: var(--hc-text-secondary);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
}

.hc-preview__run-btn:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}

.hc-preview__running-badge {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  color: var(--hc-warning, #ff9500);
}

.hc-preview__frame {
  flex: 1;
  border: none;
  background: #fff;
  width: 100%;
  min-height: 300px;
}
</style>
