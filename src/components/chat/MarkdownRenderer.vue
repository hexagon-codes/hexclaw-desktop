<script setup lang="ts">
import { computed } from 'vue'
import MarkdownIt from 'markdown-it'

const props = defineProps<{
  content: string
}>()

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: true,
})

// 自定义代码块渲染 — 添加语言标签和复制按钮
const defaultFence = md.renderer.rules.fence!
md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx]!
  const lang = token.info?.trim() || ''
  const code = token.content || ''

  return `<div class="code-block-wrapper">
    <div class="code-block-header">
      <span class="code-lang">${lang || 'text'}</span>
      <button class="copy-btn" onclick="navigator.clipboard.writeText(decodeURIComponent('${encodeURIComponent(code)}'))">复制</button>
    </div>
    <pre class="code-block"><code class="language-${lang}">${md.utils.escapeHtml(code)}</code></pre>
  </div>`
}

const rendered = computed(() => md.render(props.content))
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
