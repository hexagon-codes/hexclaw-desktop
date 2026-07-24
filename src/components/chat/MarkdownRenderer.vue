<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { codeToHtml } from 'shiki'
import { tex } from '@mdit/plugin-tex'
import ArtifactRenderer from '@/components/chat/ArtifactRenderer.vue'
import { setClipboard } from '@/api/desktop'
import { KATEX_DOMPURIFY_CONFIG, normalizeMathMarkdown } from '@/utils/math-content'
import { isKatexParseError, renderKatexToHtml } from '@/utils/math-render'
import { decoratePromptPreviewHtml, projectPromptPreview } from '@/utils/prompt-preview'
import {
  createRenderManifest,
  resolveMessageContent,
  type MessageContent,
  type RenderManifest,
  type RenderSurface,
} from '@/contracts/message-content'
import { useMathOverflowAccessibility } from '@/composables/useMathOverflowAccessibility'

const props = withDefaults(
  defineProps<{
    content: string | MessageContent
    surface?: RenderSurface
    receiptRef?: string
    highlightPromptArgs?: boolean
    showArtifacts?: boolean
  }>(),
  {
    surface: 'desktop',
    receiptRef: undefined,
    highlightPromptArgs: false,
    showArtifacts: true,
  },
)

const emit = defineEmits<{
  rendered: [manifest: RenderManifest]
}>()

const rendererRoot = ref<HTMLElement | null>(null)
useMathOverflowAccessibility(rendererRoot)

const resolvedContent = computed(() => resolveMessageContent(props.content))
const canonicalMarkdown = computed(() => resolvedContent.value.markdown)
const promptPreviewProjection = computed(() =>
  props.highlightPromptArgs ? projectPromptPreview(canonicalMarkdown.value) : undefined,
)

/** Extract previewable code blocks (html/svg) from raw markdown */
const previewableBlocks = computed(() => {
  const blocks: { language: string; code: string }[] = []
  const fenceRe = /```(html|svg)\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = fenceRe.exec(canonicalMarkdown.value)) !== null) {
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

  // 本组件只拥有 TeX delimiter/token 解析；KaTeX 执行统一委托给 math-render adapter。
  const parseErrorSignal = 'data-math-render-error="parse-error"'
  instance.use(tex, {
    delimiters: 'all',
    render: (content, displayMode) => {
      try {
        const html = renderKatexToHtml(content, displayMode)
        return displayMode
          ? `<p class="katex-block">${html}</p>\n`
          : `<span class="hc-math-inline">${html}</span>`
      } catch (error) {
        if (!isKatexParseError(error)) throw error
        const tag = displayMode ? 'p' : 'span'
        return `<${tag} ${parseErrorSignal}></${tag}>${displayMode ? '\n' : ''}`
      }
    },
  })

  // The delimiter parser owns token.markup/content, so this is the only layer
  // that can restore the complete source instead of a partial, misleading formula.
  const closeMathDelimiter = (markup: string) => {
    if (markup === String.raw`\(`) return String.raw`\)`
    if (markup === String.raw`\[`) return String.raw`\]`
    return markup
  }
  const restoreFailedMath = (ruleName: 'math_inline' | 'math_block') => {
    const renderRule = instance.renderer.rules[ruleName]
    if (!renderRule) return
    instance.renderer.rules[ruleName] = (tokens, index, options, env, self) => {
      const html = renderRule(tokens, index, options, env, self)
      if (!html.includes(parseErrorSignal)) return html
      const token = tokens[index]!
      const source = instance.utils.escapeHtml(
        `${token.markup}${token.content}${closeMathDelimiter(token.markup)}`,
      )
      const tag = token.block ? 'p' : 'span'
      return `<${tag} class="hc-math-fallback" data-math-fallback="parse-error">${source}</${tag}>${token.block ? '\n' : ''}`
    }
  }
  restoreFailedMath('math_inline')
  restoreFailedMath('math_block')

  // markdown-it 默认已支持 GFM 表格/删除线/linkify；补齐 GitHub 任务列表语义和类名。
  instance.renderer.rules.s_open = () => '<del>'
  instance.renderer.rules.s_close = () => '</del>'
  instance.core?.ruler.after('inline', 'github-task-lists', (state) => {
    state.tokens.forEach((token, index) => {
      if (token.type !== 'inline' || !token.children?.length) return
      const firstText = token.children[0]
      if (firstText?.type !== 'text') return
      const marker = /^\[([ xX])\]\s+/.exec(firstText.content)
      if (!marker) return

      const checkbox = new state.Token('html_inline', '', 0)
      const checked = marker[1]?.toLowerCase() === 'x'
      checkbox.content = `<input class="task-list-item-checkbox" type="checkbox" disabled${checked ? ' checked' : ''}>`
      firstText.content = firstText.content.slice(marker[0].length)
      token.children.unshift(checkbox)

      let itemIndex = index - 1
      while (itemIndex >= 0 && state.tokens[itemIndex]?.type !== 'list_item_open') itemIndex--
      const item = state.tokens[itemIndex]
      if (!item) return
      item.attrJoin('class', 'task-list-item')

      let listIndex = itemIndex - 1
      while (listIndex >= 0) {
        const list = state.tokens[listIndex]
        if (list?.type.endsWith('_list_open') && list.level === item.level - 1) {
          list.attrJoin('class', 'contains-task-list')
          break
        }
        listIndex--
      }
    })
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

    // Language-less fences are usually LLM-wrapped prose/flows, not code, so
    // they get minimal chrome (no language tag, lighter header). All blocks
    // soft-wrap via CSS so nothing hides behind a horizontal scrollbar.
    const plainClass = lang ? '' : ' code-block-wrapper--plain'
    return `<div class="code-block-wrapper${plainClass}">
      <div class="code-block-header">
        <span class="code-lang">${instance.utils.escapeHtml(lang || 'text')}</span>
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

watch(canonicalMarkdown, (content) => {
  if (content.includes('```')) highlightCodeBlocks(content)
}, { immediate: true })

const rendered = computed(() => {
  void renderVersion.value
  const projection = promptPreviewProjection.value
  const markdown = projection?.markdown ?? canonicalMarkdown.value
  const html = mdInstance.value.render(normalizeMathMarkdown(markdown))
  return DOMPurify.sanitize(
    projection ? decoratePromptPreviewHtml(html, projection) : html,
    KATEX_DOMPURIFY_CONFIG,
  )
})

const renderManifest = computed<RenderManifest | undefined>(() => {
  if (resolvedContent.value.protocol !== 'canonical') return undefined
  const content = props.content as MessageContent
  return createRenderManifest(content, {
    renderId: `render:${content.content_id.slice('content:'.length)}:${props.surface}`,
    surface: props.surface,
    rendererVersion: 'desktop-markdown-v1',
    capabilities: {
      markdown: true,
      tex_math: true,
      mathml: true,
      attachments: true,
    },
    parts: [{ kind: 'markdown', text: content.markdown }],
    receiptRef: props.receiptRef,
  })
})

watch(renderManifest, (manifest) => {
  if (manifest) emit('rendered', manifest)
}, { immediate: true })
</script>

<template>
  <div
    ref="rendererRoot"
    :data-content-protocol="resolvedContent.protocol"
    :data-source-digest="resolvedContent.sourceDigest"
    :data-producer-kind="resolvedContent.producerKind"
    :data-render-id="renderManifest?.render_id"
  >
    <div class="markdown-body" v-html="rendered" />
    <template v-if="showArtifacts">
      <ArtifactRenderer
        v-for="(block, i) in previewableBlocks"
        :key="`artifact-${i}`"
        :content="block.code"
        :language="block.language"
      />
    </template>
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

.markdown-body :deep(.contains-task-list) {
  padding-left: 0.25em;
  list-style: none;
}

.markdown-body :deep(.task-list-item) {
  list-style: none;
}

.markdown-body :deep(.task-list-item-checkbox) {
  margin: 0 0.5em 0.15em 0;
  vertical-align: middle;
  accent-color: var(--hc-accent);
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
  /* HIG: 0.5-1px 细边框；用 1px accent 条 + padding 形成 quote 视觉，不破粗边框规则 */
  border-left: 1px solid var(--hc-accent);
  padding-left: 12px;
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
  /* 逻辑方向：LTR=left、RTL(维语)=right 自动翻转，避免物理 left 让 RTL 表格列方向错（BUG-20260625 §3-9） */
  text-align: start;
  font-size: 13px;
}

.markdown-body :deep(th) {
  background: var(--hc-bg-hover);
  font-weight: 600;
}

.markdown-body :deep(tbody tr:nth-child(2n)) {
  background: var(--hc-bg-hover);
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

.markdown-body :deep(h1),
.markdown-body :deep(h2) {
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--hc-border);
}

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
  opacity: 0;
  transition: color 0.15s, background 0.15s, opacity 0.15s;
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
  white-space: pre-wrap;
  overflow-wrap: anywhere;
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
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 13px;
  line-height: 1.6;
  border-radius: 0;
}

.markdown-body :deep(.code-block-wrapper .shiki code) {
  font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
}

/* Copy reveals on hover (ChatGPT / Open WebUI pattern), not permanently shown. */
.markdown-body :deep(.code-block-wrapper:hover .copy-btn),
.markdown-body :deep(.copy-btn:focus-visible),
.markdown-body :deep(.copy-btn--success) {
  opacity: 1;
}

/* Language-less fences: neutral wrapped monospace box, no code-header chrome. */
.markdown-body :deep(.code-block-wrapper--plain .code-lang) {
  display: none;
}

.markdown-body :deep(.code-block-wrapper--plain .code-block-header) {
  background: transparent;
  padding-bottom: 0;
}

/* ─── KaTeX 数学公式 ─── */
/* 块级公式把间距留在稳定 viewport，内部 KaTeX 永不承担裁剪或滚动。 */
.markdown-body :deep(.katex-display) {
  overflow: visible;
  padding-block: 0;
  padding-inline: 0;
  margin: 0;
}

.markdown-body :deep(.hc-math-viewport--display) {
  margin-block: 0.5em;
}
/* 失败降级：非法公式退回原文用正文色呈现，不报红（§M1-1 DoD） */
.markdown-body :deep(.katex-error) {
  color: var(--hc-text-primary) !important;
}
</style>
