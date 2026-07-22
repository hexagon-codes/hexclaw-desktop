<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronUp } from 'lucide-vue-next'
import katex from 'katex'
import DOMPurify from 'dompurify'
import {
  KATEX_DOMPURIFY_CONFIG,
  plainMathSegments,
  type PlainMathSegment,
} from '@/utils/math-content'

/**
 * 用户消息纯文本渲染：
 *   - white-space: pre-wrap 逐字保留换行/空格（修 BUG-20260623：粘贴多行塌成一段）。
 *   - 过长内容 ChatGPT 式「展开/收起」：默认折叠到 N 行，点开看全文。
 * 助手消息走 Markdown，不用本组件。
 */
const props = defineProps<{ content: string }>()
const { t } = useI18n()

const COLLAPSE_LINES = 8
const COLLAPSE_CHARS = 480

const collapsible = computed(() => {
  const c = props.content ?? ''
  return c.split('\n').length > COLLAPSE_LINES || c.length > COLLAPSE_CHARS
})

const expanded = ref(false)
type RenderedSegment = Extract<PlainMathSegment, { type: 'text' }>
  | (Extract<PlainMathSegment, { type: 'math' }> & { html: string })

const renderedSegments = computed<RenderedSegment[]>(() => plainMathSegments(props.content ?? '').map((segment): RenderedSegment => {
  if (segment.type === 'text') return segment
  try {
    return {
      ...segment,
      html: DOMPurify.sanitize(katex.renderToString(segment.content, {
        displayMode: segment.display,
        throwOnError: false,
        trust: false,
        strict: 'warn',
        errorColor: 'var(--hc-text-primary)',
      }), KATEX_DOMPURIFY_CONFIG),
    }
  } catch {
    return { type: 'text' as const, content: segment.source, source: segment.source }
  }
}))

function toggle() {
  expanded.value = !expanded.value
}
</script>

<template>
  <div class="hc-msg__text-wrap">
    <div
      class="hc-msg__text"
      :class="{ 'hc-msg__text--collapsed': collapsible && !expanded }"
      data-testid="msg-text"
    >
      <template v-for="(segment, index) in renderedSegments" :key="index">
        <span v-if="segment.type === 'text'">{{ segment.content }}</span>
        <span
          v-else
          class="hc-msg__math"
          :class="{ 'hc-msg__math--display': segment.display }"
          v-html="segment.html"
        />
      </template>
    </div>
    <button
      v-if="collapsible"
      type="button"
      class="hc-msg__text-toggle"
      data-testid="msg-expand"
      @click="toggle"
    >
      <component :is="expanded ? ChevronUp : ChevronDown" :size="13" />
      <span>{{ expanded ? t('chat.collapseMessage') : t('chat.expandMessage') }}</span>
    </button>
  </div>
</template>

<style scoped>
.hc-msg__text {
  white-space: pre-wrap;
  word-break: break-word;
}

.hc-msg__text--collapsed {
  display: -webkit-box;
  -webkit-line-clamp: 8;
  line-clamp: 8;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.hc-msg__math--display {
  display: block;
  overflow-x: auto;
  overflow-y: hidden;
}

.hc-msg__text-toggle {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-top: 6px;
  padding: 2px 6px;
  border: none;
  background: transparent;
  color: inherit;
  opacity: 0.7;
  font-size: 12px;
  font-family: inherit;
  line-height: 1.4;
  cursor: pointer;
  border-radius: 6px;
  transition: opacity 0.15s, background 0.15s;
}

.hc-msg__text-toggle:hover {
  opacity: 1;
  background: color-mix(in srgb, currentColor 10%, transparent);
}
</style>
