<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { codeToHtml } from 'shiki'
import ArtifactRenderer from '@/components/chat/ArtifactRenderer.vue'
import { setClipboard } from '@/api/desktop'

const props = defineProps<{
  content: string
}>()

/** Extract previewable code blocks (html/svg) from raw markdown */
const previewableBlocks = computed(() => {
  const blocks: { language: string; code: string }[] = []
  const fenceRe = /```(html|svg)\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = fenceRe.exec(props.content)) !== null) {
    blocks.push({ language: m[1]!, code: m[2] || '' })
  }
  return blocks
})

const { t } = useI18n()

let activeInstanceCount = 0
const HIGHLIGHT_CACHE_MAX = 200
const highlightCache = new Map<string, string>()

// LRU eviction: when cache exceeds max, remove oldest entries
function highlightCacheSet(key: string, value: string) {
  if (highlightCache.size >= HIGHLIGHT_CACHE_MAX) {
    const firstKey = highlightCache.keys().next().value
    if (firstKey !== undefined) highlightCache.delete(firstKey)
  }
  highlightCache.set(key, value)
}

function createMarkdownRenderer(copyLabel: string) {
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
    const cacheKey = `${lang}:${code}`
    const highlighted = highlightCache.get(cacheKey)

    const codeHtml = highlighted
      ? highlighted
      : `<pre class="code-block"><code class="language-${lang}">${instance.utils.escapeHtml(code)}</code></pre>`

    return `<div class="code-block-wrapper">
      <div class="code-block-header">
        <span class="code-lang">${lang || 'text'}</span>
        <button class="copy-btn" data-code="${instance.utils.escapeHtml(code)}">${instance.utils.escapeHtml(copyLabel)}</button>
      </div>
      ${codeHtml}
    </div>`
  }

  return instance
}

async function highlightCodeBlocks(content: string) {
  const fenceRegex = /```(\w+)?\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  let needsRerender = false

  while ((match = fenceRegex.exec(content)) !== null) {
    const lang = match[1] || 'text'
    const code = match[2] || ''
    const cacheKey = `${lang}:${code}`
    if (highlightCache.has(cacheKey)) continue

    try {
      const html = await codeToHtml(code, {
        lang: lang as never,
        theme: 'github-dark',
      })
      highlightCacheSet(cacheKey, html)
      needsRerender = true
    } catch {
      highlightCacheSet(cacheKey, '')
    }
  }

  if (needsRerender) renderVersion.value++
}

function handleCopyClick(e: MouseEvent) {
  const btn = (e.target as HTMLElement).closest('.copy-btn') as HTMLElement | null
  if (!btn?.dataset.code) return
  const originalText = btn.textContent || ''
  setClipboard(btn.dataset.code)
    .then(() => {
      btn.textContent = '✓ ' + (originalText.includes('复制') ? '已复制' : 'Copied')
      btn.classList.add('copy-btn--success')
      setTimeout(() => {
        btn.textContent = originalText
        btn.classList.remove('copy-btn--success')
      }, 1500)
    })
    .catch(() => {
      btn.textContent = '✗ ' + (originalText.includes('复制') ? '失败' : 'Failed')
      setTimeout(() => { btn.textContent = originalText }, 1500)
    })
}

onMounted(() => {
  if (activeInstanceCount === 0) {
    document.addEventListener('click', handleCopyClick)
  }
  activeInstanceCount++
})

onUnmounted(() => {
  activeInstanceCount--
  if (activeInstanceCount === 0) {
    document.removeEventListener('click', handleCopyClick)
  }
})

const cachedCopyLabel = ref(t('common.copy'))
const mdInstance = ref(createMarkdownRenderer(cachedCopyLabel.value))
const renderVersion = ref(0)

watch(() => t('common.copy'), (newLabel) => {
  if (newLabel !== cachedCopyLabel.value) {
    cachedCopyLabel.value = newLabel
    mdInstance.value = createMarkdownRenderer(newLabel)
  }
})

watch(() => props.content, (content) => {
  if (content.includes('```')) highlightCodeBlocks(content)
}, { immediate: true })

const rendered = computed(() => {
  void renderVersion.value
  return DOMPurify.sanitize(mdInstance.value.render(props.content))
})
</script>

<template>
  <div>
    <div class="markdown-body" v-html="rendered" />
    <ArtifactRenderer
      v-for="(block, i) in previewableBlocks"
      :key="`artifact-${i}`"
      :content="block.code"
      :language="block.language"
    />
  </div>
</template>

<style scoped>
.markdown-body {
  line-height: 1.7;
  word-wrap: break-word;
  font-size: 14px;
}

.markdown-body :deep(p) {
  margin: 0.5em 0;
}

.markdown-body :deep(p:first-child) {
  margin-top: 0;
}

.markdown-body :deep(p:last-child) {
  margin-bottom: 0;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  padding-left: 1.5em;
  margin: 0.5em 0;
}

.markdown-body :deep(li) {
  margin: 0.25em 0;
}

.markdown-body :deep(a) {
  color: var(--hc-accent);
  text-decoration: none;
}

.markdown-body :deep(a:hover) {
  text-decoration: underline;
}

.markdown-body :deep(code) {
  background: var(--hc-bg-hover);
  padding: 0.15em 0.45em;
  border-radius: 5px;
  font-size: 0.88em;
  font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
}

.markdown-body :deep(pre code) {
  background: none;
  padding: 0;
}

.markdown-body :deep(blockquote) {
  border-left: 2px solid var(--hc-accent);
  padding-left: 1em;
  margin: 0.5em 0;
  color: var(--hc-text-secondary);
}

.markdown-body :deep(strong) {
  font-weight: 600;
}

.markdown-body :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 0.5em 0;
  border-radius: var(--hc-radius-md);
  overflow: hidden;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--hc-border);
  padding: 0.5em 0.8em;
  text-align: left;
  font-size: 13px;
}

.markdown-body :deep(th) {
  background: var(--hc-bg-hover);
  font-weight: 600;
}

.markdown-body :deep(hr) {
  border: none;
  height: 1px;
  background: var(--hc-divider);
  margin: 1em 0;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  margin: 1em 0 0.5em;
  font-weight: 600;
}

.markdown-body :deep(h1) { font-size: 1.4em; }
.markdown-body :deep(h2) { font-size: 1.2em; }
.markdown-body :deep(h3) { font-size: 1.1em; }

.markdown-body :deep(img) {
  max-width: 100%;
  max-height: 512px;
  border-radius: var(--hc-radius-md);
  margin: 0.5em 0;
  cursor: pointer;
}

/* ─── Code Blocks ───── */
.markdown-body :deep(.code-block-wrapper) {
  margin: 0.5em 0;
  border-radius: var(--hc-radius-md);
  overflow: hidden;
  border: 1px solid var(--hc-border);
}

.markdown-body :deep(.code-block-header) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--hc-space-2) var(--hc-space-3);
  background: var(--hc-bg-hover);
  font-size: 11px;
}

.markdown-body :deep(.code-lang) {
  color: var(--hc-text-muted);
  text-transform: uppercase;
  font-weight: 600;
  letter-spacing: 0.03em;
}

.markdown-body :deep(.copy-btn) {
  color: var(--hc-text-muted);
  background: none;
  border: none;
  cursor: pointer;
  font-size: 11px;
  padding: var(--hc-space-1) var(--hc-space-2);
  border-radius: var(--hc-space-1);
  transition: color 0.15s, background 0.15s;
  font-weight: 500;
}

.markdown-body :deep(.copy-btn:hover) {
  color: var(--hc-text-primary);
  background: var(--hc-bg-active);
}

.markdown-body :deep(.copy-btn--success) {
  color: var(--hc-success);
}

.markdown-body :deep(.code-block) {
  margin: 0;
  padding: var(--hc-space-3) var(--hc-space-4);
  background: var(--hc-bg-input);
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.6;
}

.markdown-body :deep(.code-block code) {
  font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
}

/* Shiki highlighted output */
.markdown-body :deep(.code-block-wrapper .shiki) {
  margin: 0;
  padding: var(--hc-space-3) var(--hc-space-4);
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.6;
  border-radius: 0;
}

.markdown-body :deep(.code-block-wrapper .shiki code) {
  font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
}
</style>
