<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronUp } from 'lucide-vue-next'
import DOMPurify from 'dompurify'
import {
  KATEX_DOMPURIFY_CONFIG,
  plainMathSegments,
  plainMathSegmentsWithSourceSpans,
  readMathClipboard,
  type PlainMathSegment,
} from '@/utils/math-content'
import { isKatexParseError, renderKatexToHtml } from '@/utils/math-render'
import { useMathOverflowAccessibility } from '@/composables/useMathOverflowAccessibility'

/**
 * 用户消息纯文本渲染：
 *   - white-space: pre-wrap 逐字保留换行/空格（修 BUG-20260623：粘贴多行塌成一段）。
 *   - 过长内容 ChatGPT 式「展开/收起」：默认折叠到 N 行，点开看全文。
 * 助手消息走 Markdown，不用本组件。
 */
const props = withDefaults(defineProps<{
  content: string
  editable?: boolean
  autofocus?: boolean
  disabled?: boolean
  editorClass?: string
  editorTestId?: string
  placeholder?: string
}>(), {
  editable: false,
  autofocus: false,
  disabled: false,
  editorClass: '',
  editorTestId: 'message-math-editor',
  placeholder: '',
})
const emit = defineEmits<{
  'update:content': [content: string]
}>()
const { t } = useI18n()

const COLLAPSE_LINES = 8
const COLLAPSE_CHARS = 480

const collapsible = computed(() => {
  const c = props.content ?? ''
  return c.split('\n').length > COLLAPSE_LINES || c.length > COLLAPSE_CHARS
})

const expanded = ref(false)
const messageRoot = ref<HTMLElement | null>(null)
const editorRoot = ref<HTMLElement | null>(null)
const { refreshMathOverflowAccessibility } = useMathOverflowAccessibility(messageRoot)
type RenderedSegment = Extract<PlainMathSegment, { type: 'text' }>
  | (Extract<PlainMathSegment, { type: 'math' }> & { html: string })

function renderSegment(segment: PlainMathSegment): RenderedSegment {
  if (segment.type === 'text') return segment
  try {
    return {
      ...segment,
      html: DOMPurify.sanitize(
        renderKatexToHtml(segment.content, segment.display),
        KATEX_DOMPURIFY_CONFIG,
      ),
    }
  } catch (error) {
    if (!isKatexParseError(error)) throw error
    return { type: 'text' as const, content: segment.source, source: segment.source }
  }
}

const renderedSegments = computed<RenderedSegment[]>(() =>
  plainMathSegments(props.content ?? '').map(renderSegment),
)

let canonicalSource = props.content ?? ''
let activeFormula: HTMLElement | null = null
let composing = false
let compositionHistoryStart: string | null = null
let compositionSequence = 0
let internalDrag:
  | { start: number; end: number; text: string }
  | null = null
const HISTORY_LIMIT = 200
let canonicalHistory = [canonicalSource]
let canonicalHistoryIndex = 0

function editorNodeSource(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (!(node instanceof HTMLElement)) return ''
  if (node.dataset.editMathState === 'rendered') {
    return node.dataset.formulaMarkdown ?? ''
  }
  if (node.tagName === 'BR') return '\n'
  return Array.from(node.childNodes).map(editorNodeSource).join('')
}

function serializeEditor(): string {
  const editor = editorRoot.value
  if (!editor) return canonicalSource
  return Array.from(editor.childNodes).map(editorNodeSource).join('')
}

function nodeCanonicalLength(node: Node): number {
  return editorNodeSource(node).length
}

function offsetWithinNode(
  node: Node,
  target: Node,
  targetOffset: number,
  endPoint: boolean,
): number {
  const length = nodeCanonicalLength(node)
  if (node === target) {
    if (node.nodeType === Node.TEXT_NODE) {
      return Math.max(0, Math.min(targetOffset, length))
    }
    if (node instanceof HTMLElement && node.dataset.editMathState === 'rendered') {
      return endPoint ? length : 0
    }
    let offset = 0
    const children = Array.from(node.childNodes)
    for (let index = 0; index < Math.min(targetOffset, children.length); index++) {
      offset += nodeCanonicalLength(children[index]!)
    }
    return offset
  }
  if (!node.contains(target)) return 0
  if (node instanceof HTMLElement && node.dataset.editMathState === 'rendered') {
    return endPoint ? length : 0
  }
  let offset = 0
  for (const child of Array.from(node.childNodes)) {
    if (child === target || child.contains(target)) {
      return offset + offsetWithinNode(child, target, targetOffset, endPoint)
    }
    offset += nodeCanonicalLength(child)
  }
  return offset
}

function selectionOffsets(): { start: number; end: number } | null {
  const editor = editorRoot.value
  const selection = window.getSelection()
  if (!editor || !selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return null
  return {
    start: offsetWithinNode(editor, range.startContainer, range.startOffset, false),
    end: offsetWithinNode(editor, range.endContainer, range.endOffset, true),
  }
}

function setCaret(node: Node, offset: number) {
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

function setCaretAtCanonicalOffset(requestedOffset: number) {
  const editor = editorRoot.value
  if (!editor) return
  let remaining = Math.max(0, Math.min(requestedOffset, canonicalSource.length))
  const children = Array.from(editor.childNodes)

  for (let index = 0; index < children.length; index++) {
    const child = children[index]!
    const length = nodeCanonicalLength(child)
    if (remaining > length) {
      remaining -= length
      continue
    }
    if (child instanceof HTMLElement && child.dataset.editMathState === 'rendered') {
      setCaret(editor, remaining === 0 ? index : index + 1)
      return
    }
    const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT)
    let textNode = walker.nextNode()
    while (textNode) {
      const textLength = textNode.textContent?.length ?? 0
      if (remaining <= textLength) {
        setCaret(textNode, remaining)
        return
      }
      remaining -= textLength
      textNode = walker.nextNode()
    }
    setCaret(editor, index + 1)
    return
  }
  setCaret(editor, children.length)
}

function canonicalPointAtOffset(offset: number): { node: Node; offset: number } | null {
  setCaretAtCanonicalOffset(offset)
  const selection = window.getSelection()
  if (!selection?.anchorNode) return null
  return { node: selection.anchorNode, offset: selection.anchorOffset }
}

function setCanonicalSelection(start: number, end = start) {
  const editor = editorRoot.value
  const selection = window.getSelection()
  if (!editor || !selection) return
  const lower = Math.max(0, Math.min(start, end, canonicalSource.length))
  const upper = Math.max(lower, Math.min(Math.max(start, end), canonicalSource.length))
  const startPoint = canonicalPointAtOffset(lower)
  const endPoint = canonicalPointAtOffset(upper)
  if (!startPoint || !endPoint) return
  const range = document.createRange()
  range.setStart(startPoint.node, startPoint.offset)
  range.setEnd(endPoint.node, endPoint.offset)
  selection.removeAllRanges()
  selection.addRange(range)
}

function recordCanonicalHistory(source: string) {
  if (canonicalHistory[canonicalHistoryIndex] === source) return
  canonicalHistory = canonicalHistory.slice(0, canonicalHistoryIndex + 1)
  canonicalHistory.push(source)
  if (canonicalHistory.length > HISTORY_LIMIT) canonicalHistory.shift()
  canonicalHistoryIndex = canonicalHistory.length - 1
}

function updateCanonical(source: string, recordHistory = true) {
  const editor = editorRoot.value
  if (source === canonicalSource) return
  canonicalSource = source
  if (recordHistory) recordCanonicalHistory(source)
  if (editor) editor.dataset.canonicalSource = canonicalSource
  emit('update:content', canonicalSource)
}

function syncCanonicalFromDom(recordHistory = true) {
  updateCanonical(serializeEditor(), recordHistory)
}

function createFormulaElement(segment: Extract<RenderedSegment, { type: 'math' }>) {
  const formula = document.createElement('span')
  formula.className = segment.display
    ? 'hc-msg__math hc-msg__math--display'
    : 'hc-msg__math hc-math-inline'
  formula.contentEditable = 'false'
  formula.dataset.editMathState = 'rendered'
  formula.dataset.formulaMarkdown = segment.source
  formula.innerHTML = segment.html
  return formula
}

function projectEditor(source = canonicalSource) {
  const editor = editorRoot.value
  if (!editor) return
  canonicalSource = source
  activeFormula = null
  const fragment = document.createDocumentFragment()
  for (const segment of plainMathSegmentsWithSourceSpans(source).map(renderSegment)) {
    if (segment.type === 'text') {
      const text = document.createElement('span')
      text.dataset.editText = ''
      text.textContent = segment.content
      fragment.append(text)
    } else {
      fragment.append(createFormulaElement(segment))
    }
  }
  editor.replaceChildren(fragment)
  editor.dataset.canonicalSource = canonicalSource
  refreshMathOverflowAccessibility()
}

function formulaContentRange(source: string): {
  contentStart: number
  contentEnd: number
} {
  let openingLength = 0
  let closingLength = 0
  let displayDelimited = false

  if (source.startsWith('$$') && source.endsWith('$$')) {
    openingLength = 2
    closingLength = 2
    displayDelimited = true
  } else if (source.startsWith('$') && source.endsWith('$')) {
    openingLength = 1
    closingLength = 1
  } else {
    const opening = /^(\\{1,2})([([])/.exec(source)
    if (opening) {
      const close = opening[2] === '(' ? ')' : ']'
      const closing = `${opening[1]}${close}`
      if (source.endsWith(closing)) {
        openingLength = opening[0].length
        closingLength = closing.length
        displayDelimited = opening[2] === '['
      }
    }
  }

  const contentStart = Math.min(
    source.length,
    openingLength + (displayDelimited && source[openingLength] === '\n' ? 1 : 0),
  )
  const closingStart = Math.max(contentStart, source.length - closingLength)
  const contentEnd = Math.max(
    contentStart,
    closingStart - (displayDelimited && source[closingStart - 1] === '\n' ? 1 : 0),
  )
  return { contentStart, contentEnd }
}

function activateRenderedFormula(formula: HTMLElement, caretAtEnd = false) {
  const source = formula.dataset.formulaMarkdown ?? ''
  const display = formula.classList.contains('hc-msg__math--display')
  const sourceFormula = document.createElement('span')
  sourceFormula.dataset.editMathState = 'source-active'
  sourceFormula.dataset.formulaMarkdown = source
  sourceFormula.className = display
    ? 'hc-msg__math-source hc-msg__math-source--display'
    : 'hc-msg__math-source'
  sourceFormula.textContent = source
  formula.replaceWith(sourceFormula)
  activeFormula = sourceFormula
  const text = sourceFormula.firstChild ?? sourceFormula
  const contentRange = formulaContentRange(source)
  setCaret(text, caretAtEnd ? contentRange.contentEnd : contentRange.contentStart)
}

function commitProjection(caretOffset?: number) {
  syncCanonicalFromDom()
  projectEditor(canonicalSource)
  if (caretOffset !== undefined) setCaretAtCanonicalOffset(caretOffset)
}

function handleEditorClick(event: MouseEvent) {
  const editor = editorRoot.value
  const target = event.target
  if (!editor || !(target instanceof Element)) return
  const selectedFormula = target.closest<HTMLElement>('[data-edit-math-state="rendered"]')
  if (selectedFormula && editor.contains(selectedFormula)) {
    const nextFormulaOffset = offsetWithinNode(editor, selectedFormula, 0, false)
    if (activeFormula) {
      commitProjection()
      const nextFormula = formulaRanges()
        .find((range) => range.start === nextFormulaOffset)?.element
      if (nextFormula) activateRenderedFormula(nextFormula)
    } else {
      activateRenderedFormula(selectedFormula)
    }
    return
  }
  if (target.closest('[data-edit-math-state="source-active"]')) return
  if (activeFormula) {
    const caret = selectionOffsets()?.start
    commitProjection(caret)
  }
}

function handleEditorInput() {
  syncCanonicalFromDom(!composing && compositionHistoryStart === null)
}

function handleCompositionStart() {
  composing = true
  compositionSequence += 1
  compositionHistoryStart = canonicalSource
}

function handleCompositionEnd() {
  composing = false
  const sequence = compositionSequence
  void nextTick(() => {
    if (composing || sequence !== compositionSequence) return
    syncCanonicalFromDom(false)
    const historyStart = compositionHistoryStart
    compositionHistoryStart = null
    if (historyStart !== null && historyStart !== canonicalSource) {
      recordCanonicalHistory(canonicalSource)
    }
    const editor = editorRoot.value
    if (activeFormula && editor && !editor.contains(document.activeElement)) {
      commitProjection()
    }
  })
}

function handleEditorFocusOut(event: FocusEvent) {
  const editor = editorRoot.value
  if (!editor || editor.contains(event.relatedTarget as Node | null)) return
  if (activeFormula && !composing && compositionHistoryStart === null) commitProjection()
}

function formulaRanges() {
  const editor = editorRoot.value
  if (!editor) return [] as Array<{ element: HTMLElement; start: number; end: number }>
  const ranges: Array<{ element: HTMLElement; start: number; end: number }> = []
  let offset = 0
  for (const child of Array.from(editor.childNodes)) {
    const length = nodeCanonicalLength(child)
    if (child instanceof HTMLElement && child.dataset.editMathState === 'rendered') {
      ranges.push({ element: child, start: offset, end: offset + length })
    }
    offset += length
  }
  return ranges
}

function replaceCanonicalRange(start: number, end: number, insertion: string) {
  updateCanonical(canonicalSource.slice(0, start) + insertion + canonicalSource.slice(end))
  projectEditor(canonicalSource)
  setCaretAtCanonicalOffset(start + insertion.length)
}

function moveCanonicalHistory(delta: -1 | 1) {
  const nextIndex = canonicalHistoryIndex + delta
  if (nextIndex < 0 || nextIndex >= canonicalHistory.length) return
  canonicalHistoryIndex = nextIndex
  updateCanonical(canonicalHistory[nextIndex]!, false)
  projectEditor(canonicalSource)
  setCaretAtCanonicalOffset(canonicalSource.length)
}

function handleEditorKeydown(event: KeyboardEvent) {
  if (composing) return
  const target = event.target
  if (
    target instanceof Element &&
    target.closest('.hc-math-viewport--scrollable')
  ) {
    return
  }
  const key = event.key.toLowerCase()
  const historyModifier = event.metaKey || event.ctrlKey
  const undo = historyModifier && key === 'z' && !event.shiftKey
  const redo = historyModifier && ((key === 'z' && event.shiftKey) || key === 'y')
  if (undo || redo) {
    // The projected KaTeX DOM is deliberately disposable and must never enter
    // the browser's native contenteditable history. Even at a canonical
    // history boundary this shortcut is a canonical no-op, not a DOM undo.
    event.preventDefault()
    moveCanonicalHistory(undo ? -1 : 1)
    return
  }
  if (activeFormula) return
  const offsets = selectionOffsets()
  if (!offsets || offsets.start !== offsets.end) return
  const ranges = formulaRanges()
  if (event.key === 'ArrowRight') {
    const formula = ranges.find((range) => range.start === offsets.start)
    if (formula) {
      event.preventDefault()
      activateRenderedFormula(formula.element)
    }
    return
  }
  if (event.key === 'ArrowLeft') {
    const formula = ranges.find((range) => range.end === offsets.start)
    if (formula) {
      event.preventDefault()
      activateRenderedFormula(formula.element, true)
    }
    return
  }
  const formula = event.key === 'Backspace'
    ? ranges.find((range) => range.end === offsets.start)
    : event.key === 'Delete'
      ? ranges.find((range) => range.start === offsets.start)
      : undefined
  if (!formula) return
  event.preventDefault()
  replaceCanonicalRange(formula.start, formula.end, '')
}

function replaceSelection(insertion: string) {
  const offsets = selectionOffsets() ?? {
    start: canonicalSource.length,
    end: canonicalSource.length,
  }
  replaceCanonicalRange(offsets.start, offsets.end, insertion)
}

function handleEditorBeforeInput(event: InputEvent) {
  if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
    event.preventDefault()
    moveCanonicalHistory(event.inputType === 'historyUndo' ? -1 : 1)
    return
  }
  if (event.inputType !== 'insertParagraph' && event.inputType !== 'insertLineBreak') return
  event.preventDefault()
  replaceSelection('\n')
}

function handleEditorPaste(event: ClipboardEvent) {
  const payload = readMathClipboard(event.clipboardData)
  const text = payload.text || event.clipboardData?.getData('text/plain') || ''
  if (!text) return
  event.preventDefault()
  replaceSelection(text)
}

function handleEditorDrop(event: DragEvent) {
  const drag = internalDrag
  const payload = drag ? undefined : readMathClipboard(event.dataTransfer)
  const text = drag?.text
    || payload?.text
    || event.dataTransfer?.getData('text/plain')
    || ''
  if (!text) return
  const dropOffset = dropCanonicalOffset(event)
  event.preventDefault()
  internalDrag = null
  if (drag && dropOffset !== null) {
    moveCanonicalRange(drag.start, drag.end, dropOffset)
    return
  }
  if (dropOffset !== null) {
    replaceCanonicalRange(dropOffset, dropOffset, text)
    return
  }
  replaceSelection(text)
}

function dropCanonicalOffset(event: DragEvent): number | null {
  const editor = editorRoot.value
  if (!editor) return null
  const caretDocument = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => {
      offsetNode: Node
      offset: number
    } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }

  let node: Node | null = null
  let offset = 0
  const position = caretDocument.caretPositionFromPoint?.(event.clientX, event.clientY)
  if (position) {
    node = position.offsetNode
    offset = position.offset
  } else {
    const range = caretDocument.caretRangeFromPoint?.(event.clientX, event.clientY)
    if (range) {
      node = range.startContainer
      offset = range.startOffset
    }
  }
  if (!node || !editor.contains(node)) return null

  const element = node instanceof Element ? node : node.parentElement
  const formula = element?.closest<HTMLElement>('[data-edit-math-state="rendered"]')
  if (formula && editor.contains(formula)) {
    const formulaRange = formulaRanges().find((candidate) => candidate.element === formula)
    if (formulaRange) {
      const rect = formula.getBoundingClientRect()
      return event.clientX >= rect.left + rect.width / 2
        ? formulaRange.end
        : formulaRange.start
    }
  }
  return offsetWithinNode(editor, node, offset, false)
}

function moveCanonicalRange(start: number, end: number, requestedDropOffset: number) {
  const dropOffset = Math.max(0, Math.min(requestedDropOffset, canonicalSource.length))
  if (dropOffset >= start && dropOffset <= end) {
    projectEditor(canonicalSource)
    setCaretAtCanonicalOffset(end)
    return
  }

  const moved = canonicalSource.slice(start, end)
  const withoutMoved = canonicalSource.slice(0, start) + canonicalSource.slice(end)
  const insertionOffset = dropOffset > end ? dropOffset - (end - start) : dropOffset
  updateCanonical(
    withoutMoved.slice(0, insertionOffset) + moved + withoutMoved.slice(insertionOffset),
  )
  projectEditor(canonicalSource)
  setCaretAtCanonicalOffset(insertionOffset + moved.length)
}

function handleEditorDragStart(event: DragEvent) {
  const offsets = selectionOffsets()
  if (!offsets || offsets.start === offsets.end || !event.dataTransfer) {
    internalDrag = null
    return
  }
  internalDrag = {
    start: offsets.start,
    end: offsets.end,
    text: canonicalSource.slice(offsets.start, offsets.end),
  }
  event.dataTransfer.setData('text/plain', internalDrag.text)
  event.dataTransfer.effectAllowed = 'copyMove'
}

function handleEditorDragEnd() {
  internalDrag = null
}

function handleEditorCopy(event: ClipboardEvent) {
  const offsets = selectionOffsets()
  if (!offsets || offsets.start === offsets.end || !event.clipboardData) return
  event.preventDefault()
  event.clipboardData.setData('text/plain', canonicalSource.slice(offsets.start, offsets.end))
}

function handleEditorCut(event: ClipboardEvent) {
  const offsets = selectionOffsets()
  if (!offsets || offsets.start === offsets.end || !event.clipboardData) return
  event.preventDefault()
  event.clipboardData.setData('text/plain', canonicalSource.slice(offsets.start, offsets.end))
  replaceCanonicalRange(offsets.start, offsets.end, '')
}

function focusToEnd() {
  const editor = editorRoot.value
  if (!editor) return
  editor.focus()
  setCaretAtCanonicalOffset(canonicalSource.length)
}

function focusEditor() {
  editorRoot.value?.focus()
}

function getEditorElement() {
  return editorRoot.value
}

function getSelectionOffsets() {
  return selectionOffsets()
}

watch(
  () => props.content,
  (content) => {
    const nextSource = content ?? ''
    if (!props.editable || nextSource === canonicalSource) return
    canonicalHistory = [nextSource]
    canonicalHistoryIndex = 0
    projectEditor(nextSource)
  },
)

onMounted(() => {
  if (!props.editable) return
  projectEditor(props.content ?? '')
  if (props.autofocus) void nextTick(focusToEnd)
})

defineExpose({
  focusToEnd,
  focusEditor,
  getEditorElement,
  getSelectionOffsets,
  setCanonicalSelection,
})

function toggle() {
  expanded.value = !expanded.value
}
</script>

<template>
  <div ref="messageRoot" class="hc-msg__text-wrap">
    <div
      v-if="editable"
      ref="editorRoot"
      class="hc-msg__text hc-msg__text--editable"
      :class="editorClass"
      :data-testid="editorTestId"
      :data-placeholder="placeholder || undefined"
      data-clearable-control
      :contenteditable="disabled ? 'false' : 'true'"
      role="textbox"
      aria-multiline="true"
      :aria-disabled="disabled ? 'true' : undefined"
      :aria-placeholder="placeholder || undefined"
      spellcheck="true"
      @beforeinput="handleEditorBeforeInput"
      @click="handleEditorClick"
      @input="handleEditorInput"
      @focusout="handleEditorFocusOut"
      @keydown="handleEditorKeydown"
      @paste="handleEditorPaste"
      @drop="handleEditorDrop"
      @dragstart="handleEditorDragStart"
      @dragend="handleEditorDragEnd"
      @copy="handleEditorCopy"
      @cut="handleEditorCut"
      @compositionstart="handleCompositionStart"
      @compositionend="handleCompositionEnd"
    />
    <div
      v-else
      class="hc-msg__text"
      :class="{ 'hc-msg__text--collapsed': collapsible && !expanded }"
      data-testid="msg-text"
    >
      <template v-for="(segment, index) in renderedSegments" :key="index">
        <span v-if="segment.type === 'text'">{{ segment.content }}</span>
        <span
          v-else
          class="hc-msg__math"
          :class="{
            'hc-msg__math--display': segment.display,
            'hc-math-inline': !segment.display,
          }"
          v-html="segment.html"
        />
      </template>
    </div>
    <button
      v-if="!editable && collapsible"
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

.hc-msg__text--editable {
  min-height: inherit;
  outline: none;
  cursor: text;
}

.hc-msg__text--editable[data-placeholder]:empty::before {
  content: attr(data-placeholder);
  color: var(--hc-text-muted);
  pointer-events: none;
}

.hc-msg__text--editable[aria-disabled='true'] {
  cursor: default;
}

.hc-msg__text--editable :deep(.hc-msg__math) {
  cursor: text;
}

.hc-msg__text--editable :deep(.hc-msg__math-source) {
  white-space: pre-wrap;
  direction: ltr;
  unicode-bidi: isolate;
}

.hc-msg__text--editable :deep(.hc-msg__math-source--display) {
  display: block;
}

.hc-msg__text--editable :deep(.hc-msg__math--display) {
  display: block;
  max-width: 100%;
  overflow: visible;
}

.hc-msg__text--editable :deep(.hc-msg__math--display .hc-math-viewport--display),
.hc-msg__math--display :deep(.hc-math-viewport--display) {
  margin-block: 1em;
}

.hc-msg__text--editable :deep(.hc-msg__math--display .katex-display),
.hc-msg__math--display :deep(.katex-display) {
  margin: 0;
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
  max-width: 100%;
  overflow: visible;
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
