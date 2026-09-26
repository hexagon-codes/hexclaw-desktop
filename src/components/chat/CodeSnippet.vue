<script setup lang="ts">
import { ref, watch } from 'vue'
import { codeToHtml } from 'shiki'
import { setClipboard } from '@/api/desktop'

const props = withDefaults(defineProps<{ code: string; language?: string }>(), { language: 'text' })
const highlighted = ref('')
const copyState = ref('Copy')
watch(() => [props.code, props.language], async (_, __, onCleanup) => {
  let current = true
  onCleanup(() => { current = false })
  highlighted.value = ''
  copyState.value = 'Copy'
  let html = ''
  try {
    html = await codeToHtml(props.code, { lang: props.language, themes: { light: 'github-light', dark: 'monokai' } })
  } catch {
    // 未知语言仍保留原始正文，不从内容猜测执行语言。
  }
  if (current) highlighted.value = html
}, { immediate: true })
async function copy() {
  try { await setClipboard(props.code); copyState.value = 'Copied' }
  catch { copyState.value = 'Copy failed' }
}
</script>

<template>
  <div class="hc-code-snippet">
    <div class="hc-code-snippet__header">
      <span>{{ language }}</span>
      <button type="button" @click="copy" @mouseleave="copyState = 'Copy'" @blur="copyState = 'Copy'">{{ copyState }}</button>
    </div>
    <div v-if="highlighted" class="hc-code-snippet__body" v-html="highlighted" />
    <div v-else class="hc-code-snippet__body"><pre><code>{{ code }}</code></pre></div>
  </div>
</template>

<style scoped>
.hc-code-snippet { min-width: 0; margin: 5px 0 10px; border: 1px solid var(--hc-border); border-radius: 8px; overflow: hidden; }
.hc-code-snippet__header { display: flex; align-items: center; justify-content: space-between; padding: 6px 12px; background: var(--hc-bg-hover); color: var(--hc-text-muted); font-size: 11px; }
.hc-code-snippet__header > span { text-transform: uppercase; letter-spacing: .03em; }
.hc-code-snippet__header button { border: 0; padding: 2px 4px; background: none; color: inherit; font: inherit; cursor: pointer; }
.hc-code-snippet__header button:hover { color: var(--hc-text-primary); }
.hc-code-snippet__body :deep(pre) { margin: 0; padding: 12px 14px; border: 0; border-radius: 0; max-height: 320px; overflow: auto; white-space: pre; overflow-wrap: normal; tab-size: 4; font: 13px/1.65 'SF Mono', Menlo, Consolas, monospace; background: var(--hc-bg-input); color: var(--hc-text-primary); }
.hc-code-snippet__body :deep(code) { font: inherit; white-space: inherit; }

</style>

<style>
[data-theme="dark"] .hc-code-snippet .shiki,
[data-theme="dark"] .hc-code-snippet .shiki span { color: var(--shiki-dark) !important; background-color: var(--shiki-dark-bg) !important; }
</style>
