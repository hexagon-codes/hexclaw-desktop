<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { Copy, Check } from 'lucide-vue-next'
import DOMPurify from 'dompurify'
import type { Artifact } from '@/types'
import { setClipboard } from '@/api/desktop'

const props = defineProps<{
  artifact: Artifact
}>()

const codeHtml = ref('')
const copied = ref(false)

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
}

async function highlight() {
  try {
    const { codeToHtml } = await import('shiki')
    const raw = await codeToHtml(props.artifact.content, {
      lang: props.artifact.language || 'text',
      theme: 'github-dark',
    })
    codeHtml.value = sanitize(raw)
  } catch {
    // fallback: 纯文本
    codeHtml.value = sanitize(`<pre><code>${escapeHtml(props.artifact.content)}</code></pre>`)
  }
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function copyCode() {
  try {
    await setClipboard(props.artifact.content)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  } catch {
    // clipboard access can be unavailable in tests or restricted runtimes
  }
}

onMounted(highlight)
watch(() => props.artifact.content, highlight)
</script>

<template>
  <div class="hc-code-view">
    <div class="hc-code-view__header">
      <span class="hc-code-view__lang">{{ artifact.language || 'text' }}</span>
      <span class="hc-code-view__title">{{ artifact.title }}</span>
      <button class="hc-code-view__copy" @click="copyCode">
        <Check v-if="copied" :size="13" />
        <Copy v-else :size="13" />
      </button>
    </div>
    <div class="hc-code-view__body" v-html="codeHtml" />
  </div>
</template>

<style scoped>
.hc-code-view {
  border-radius: var(--hc-radius-md);
  overflow: hidden;
  border: 1px solid var(--hc-border);
}

.hc-code-view__header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--hc-bg-active);
  border-bottom: 1px solid var(--hc-border);
  font-size: 11px;
}

.hc-code-view__lang {
  font-weight: 600;
  color: var(--hc-accent);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.hc-code-view__title {
  flex: 1;
  color: var(--hc-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hc-code-view__copy {
  padding: 3px;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  display: flex;
  border-radius: 3px;
  transition: color 0.15s;
}

.hc-code-view__copy:hover {
  color: var(--hc-text-primary);
}

.hc-code-view__body {
  overflow-x: auto;
  font-size: 12px;
  line-height: 1.6;
}

.hc-code-view__body :deep(pre) {
  margin: 0;
  padding: 12px;
}

.hc-code-view__body :deep(code) {
  font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
}
</style>
