<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

const props = defineProps<{
  content: string
}>()

// 全局单例 — 所有消息共享同一个解析器实例
const md = createMarkdownRenderer()
let initialized = false

function createMarkdownRenderer() {
  // Check if already created (module-level cache)
  if ((globalThis as any).__hc_md) return (globalThis as any).__hc_md as MarkdownIt

  const instance = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: true,
    typographer: true,
  })

  instance.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx]!
    const lang = token.info?.trim() || ''
    const code = token.content || ''

    return `<div class="code-block-wrapper">
      <div class="code-block-header">
        <span class="code-lang">${lang || 'text'}</span>
        <button class="copy-btn" data-code="${instance.utils.escapeHtml(code)}">复制</button>
      </div>
      <pre class="code-block"><code class="language-${lang}">${instance.utils.escapeHtml(code)}</code></pre>
    </div>`
  }

  ;(globalThis as any).__hc_md = instance
  return instance
}

function handleCopyClick(e: MouseEvent) {
  const btn = (e.target as HTMLElement).closest('.copy-btn') as HTMLElement | null
  if (btn?.dataset.code) {
    navigator.clipboard.writeText(btn.dataset.code)
  }
}

onMounted(() => {
  if (!initialized) {
    document.addEventListener('click', handleCopyClick)
    initialized = true
  }
})

onUnmounted(() => {
  // Note: only remove when last instance unmounts - but singleton pattern means this is fine
})

const rendered = computed(() => DOMPurify.sanitize(md.render(props.content)))
</script>

<template>
  <div class="markdown-body" v-html="rendered" />
</template>

<style>
.markdown-body {
  line-height: 1.7;
  word-wrap: break-word;
}

.markdown-body p {
  margin: 0.5em 0;
}

.markdown-body p:first-child {
  margin-top: 0;
}

.markdown-body p:last-child {
  margin-bottom: 0;
}

.markdown-body ul,
.markdown-body ol {
  padding-left: 1.5em;
  margin: 0.5em 0;
}

.markdown-body li {
  margin: 0.25em 0;
}

.markdown-body a {
  color: var(--hc-accent);
  text-decoration: none;
}

.markdown-body a:hover {
  text-decoration: underline;
}

.markdown-body code {
  background: var(--hc-bg-hover);
  padding: 0.15em 0.4em;
  border-radius: 4px;
  font-size: 0.9em;
  font-family: 'SF Mono', 'Fira Code', monospace;
}

.markdown-body pre code {
  background: none;
  padding: 0;
}

.markdown-body blockquote {
  border-left: 3px solid var(--hc-border);
  padding-left: 1em;
  margin: 0.5em 0;
  color: var(--hc-text-secondary);
}

.markdown-body strong {
  font-weight: 600;
}

.markdown-body table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.5em 0;
}

.markdown-body th,
.markdown-body td {
  border: 1px solid var(--hc-border);
  padding: 0.4em 0.8em;
  text-align: left;
}

.markdown-body th {
  background: var(--hc-bg-hover);
  font-weight: 600;
}

.code-block-wrapper {
  margin: 0.5em 0;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--hc-border);
}

.code-block-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.4em 0.8em;
  background: var(--hc-bg-hover);
  font-size: 0.75em;
}

.code-lang {
  color: var(--hc-text-muted);
  text-transform: uppercase;
  font-weight: 500;
}

.copy-btn {
  color: var(--hc-text-muted);
  background: none;
  border: none;
  cursor: pointer;
  font-size: inherit;
  padding: 0.2em 0.5em;
  border-radius: 4px;
  transition: color 0.2s;
}

.copy-btn:hover {
  color: var(--hc-text-primary);
}

.code-block {
  margin: 0;
  padding: 0.8em;
  background: var(--hc-bg-input);
  overflow-x: auto;
  font-size: 0.85em;
  line-height: 1.5;
}

.code-block code {
  font-family: 'SF Mono', 'Fira Code', monospace;
}
</style>
