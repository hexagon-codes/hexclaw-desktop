import { normalizePastedText } from './chat-compose'

export interface ClipboardDataLike {
  getData(type: string): string
}

export interface MathClipboardPayload {
  text: string
  handled: boolean
  source: 'html' | 'plain' | 'none'
}

export type PlainMathSegment =
  | { type: 'text'; content: string; source: string }
  | { type: 'math'; content: string; source: string; display: boolean }

const VULGAR_FRACTIONS: Record<string, string> = {
  '½': String.raw`\frac{1}{2}`,
  '⅓': String.raw`\frac{1}{3}`,
  '⅔': String.raw`\frac{2}{3}`,
  '¼': String.raw`\frac{1}{4}`,
  '¾': String.raw`\frac{3}{4}`,
  '⅕': String.raw`\frac{1}{5}`,
  '⅖': String.raw`\frac{2}{5}`,
  '⅗': String.raw`\frac{3}{5}`,
  '⅘': String.raw`\frac{4}{5}`,
  '⅙': String.raw`\frac{1}{6}`,
  '⅚': String.raw`\frac{5}{6}`,
  '⅐': String.raw`\frac{1}{7}`,
  '⅛': String.raw`\frac{1}{8}`,
  '⅜': String.raw`\frac{3}{8}`,
  '⅝': String.raw`\frac{5}{8}`,
  '⅞': String.raw`\frac{7}{8}`,
  '⅑': String.raw`\frac{1}{9}`,
  '⅒': String.raw`\frac{1}{10}`,
}

type CodePartition = { code: boolean; content: string }

function findClosingRun(source: string, from: number, marker: string): number {
  let cursor = from
  while (cursor < source.length) {
    const found = source.indexOf(marker, cursor)
    if (found < 0) return -1
    if (marker.length < 3 || found === 0 || source[found - 1] === '\n') return found
    cursor = found + marker.length
  }
  return -1
}

/** Split Markdown into transformable text and protected inline/fenced code. */
function partitionCode(source: string): CodePartition[] {
  const parts: CodePartition[] = []
  let plainStart = 0
  let cursor = 0

  const pushPlain = (end: number) => {
    if (end > plainStart) parts.push({ code: false, content: source.slice(plainStart, end) })
  }

  while (cursor < source.length) {
    if (source[cursor] !== '`' && source[cursor] !== '~') {
      cursor++
      continue
    }

    const markerChar = source[cursor]!
    let runEnd = cursor + 1
    while (source[runEnd] === markerChar) runEnd++
    const runLength = runEnd - cursor
    const isFence = runLength >= 3 && (cursor === 0 || source[cursor - 1] === '\n')
    const isInlineCode = markerChar === '`' && runLength >= 1
    if (!isFence && !isInlineCode) {
      cursor = runEnd
      continue
    }

    const marker = markerChar.repeat(runLength)
    const close = findClosingRun(source, runEnd, marker)
    if (close < 0) {
      if (isFence) {
        pushPlain(cursor)
        parts.push({ code: true, content: source.slice(cursor) })
        return parts
      }
      cursor = runEnd
      continue
    }

    pushPlain(cursor)
    const codeEnd = close + marker.length
    parts.push({ code: true, content: source.slice(cursor, codeEnd) })
    cursor = codeEnd
    plainStart = codeEnd
  }

  pushPlain(source.length)
  return parts
}

function unescapeDoubleEncodedTex(body: string, delimiterEscapes: string): string {
  return delimiterEscapes.length === 2 ? body.replace(/\\\\/g, '\\') : body
}

function normalizeBareTexWrappers(text: string): string {
  const explicitTex = String.raw`\\(?:dfrac|tfrac|frac)\{[^{}\n]+\}\{[^{}\n]+\}|\\sqrt(?:\[[^\]\n]+\])?\{[^{}\n]+\}`
  return text.replace(new RegExp(String.raw`([([])\s*(${explicitTex})\s*([)\]])`, 'g'), (all, open: string, tex: string, close: string) => {
    if ((open === '(' && close !== ')') || (open === '[' && close !== ']')) return all
    return `$${tex}$`
  })
}

function normalizeMathText(text: string): string {
  const normalizedDelimiters = text
    .replace(/(\\{1,2})\[([\s\S]*?)\1\]/g, (_all, slashes: string, body: string) => {
      const tex = unescapeDoubleEncodedTex(body, slashes).trim()
      return tex ? `$$\n${tex}\n$$` : _all
    })
    .replace(/(\\{1,2})\(([^\n]*?)\1\)/g, (_all, slashes: string, body: string) => {
      const tex = unescapeDoubleEncodedTex(body, slashes).trim()
      return tex ? `$${tex}$` : _all
    })
  return normalizeBareTexWrappers(normalizedDelimiters)
    .replace(/[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒]/g, (fraction) => `$${VULGAR_FRACTIONS[fraction]}$`)
}

/**
 * Convert supported external delimiters to the app's canonical dollar-delimited
 * Markdown/LaTeX without touching inline code or fenced code blocks.
 */
export function normalizeMathMarkdown(source: string): string {
  return partitionCode(source)
    .map((part) => part.code ? part.content : normalizeMathText(part.content))
    .join('')
}

function texAnnotation(element: Element): string {
  const annotation = Array.from(element.querySelectorAll('annotation')).find((node) => {
    const encoding = node.getAttribute('encoding')?.toLowerCase() ?? ''
    return encoding === 'application/x-tex' || encoding === 'application/tex' || encoding === 'text/latex'
  })
  return annotation?.textContent?.trim() ?? ''
}

function mathChildren(element: Element): Element[] {
  return Array.from(element.children).filter((child) => child.localName !== 'annotation')
}

function mathMlToTex(element: Element): string {
  const children = mathChildren(element)
  const child = (index: number) => children[index] ? mathMlToTex(children[index]!) : ''
  const joined = () => children.map(mathMlToTex).join('')
  const text = element.textContent?.trim() ?? ''

  switch (element.localName.toLowerCase()) {
    case 'math':
    case 'semantics':
    case 'mrow':
    case 'mstyle':
    case 'mpadded':
    case 'mphantom':
      return joined()
    case 'mn':
    case 'mi':
      return text
    case 'mo':
      return text
        .split('×').join(String.raw`\times `)
        .split('÷').join(String.raw`\div `)
        .split('−').join('-')
    case 'mtext':
      return text ? String.raw`\text{${text}}` : ''
    case 'mfrac':
      return String.raw`\frac{${child(0)}}{${child(1)}}`
    case 'msup':
      return `{${child(0)}}^{${child(1)}}`
    case 'msub':
      return `{${child(0)}}_{${child(1)}}`
    case 'msubsup':
      return `{${child(0)}}_{${child(1)}}^{${child(2)}}`
    case 'msqrt':
      return String.raw`\sqrt{${joined()}}`
    case 'mroot':
      return String.raw`\sqrt[${child(1)}]{${child(0)}}`
    case 'mover':
      return String.raw`\overset{${child(1)}}{${child(0)}}`
    case 'munder':
      return String.raw`\underset{${child(1)}}{${child(0)}}`
    case 'munderover':
      return String.raw`\underset{${child(1)}}{\overset{${child(2)}}{${child(0)}}}`
    case 'mfenced':
      return `${element.getAttribute('open') ?? '('}${joined()}${element.getAttribute('close') ?? ')'}`
    case 'mtable':
      return String.raw`\begin{matrix}${children.map(mathMlToTex).join(String.raw`\\`)}\end{matrix}`
    case 'mtr':
      return children.map(mathMlToTex).join(' & ')
    case 'mtd':
      return joined()
    default:
      return joined() || text
  }
}

const BLOCK_ELEMENTS = new Set([
  'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
  'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul',
])

function htmlNodeText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const element = node as Element
  const tag = element.localName.toLowerCase()
  if (tag === 'br') return '\n'
  if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'iframe' || tag === 'object') return ''
  const content = Array.from(element.childNodes).map(htmlNodeText).join('')
  return BLOCK_ELEMENTS.has(tag) ? `${content}\n` : content
}

function replaceHtmlFractions(document: Document): boolean {
  let replaced = false
  for (const numerator of Array.from(document.body.querySelectorAll('sup'))) {
    const slash = numerator.nextSibling
    const denominator = slash?.nextSibling
    if (!slash || slash.nodeType !== Node.TEXT_NODE || !/^\s*\/\s*$/.test(slash.textContent ?? '')) continue
    if (!(denominator instanceof Element) || denominator.localName.toLowerCase() !== 'sub') continue
    const top = numerator.textContent?.trim()
    const bottom = denominator.textContent?.trim()
    if (!top || !bottom) continue
    numerator.replaceWith(document.createTextNode(String.raw`$\frac{${top}}{${bottom}}$`))
    slash.parentNode?.removeChild(slash)
    denominator.parentNode?.removeChild(denominator)
    replaced = true
  }
  return replaced
}

function mathAwareTextFromHtml(html: string): { text: string; hasMath: boolean } {
  if (!html || typeof DOMParser === 'undefined') return { text: '', hasMath: false }
  const document = new DOMParser().parseFromString(html, 'text/html')
  let hasMath = replaceHtmlFractions(document)

  const replaceMath = (element: Element, replacementTarget: Element = element) => {
    const annotation = texAnnotation(element)
    const tex = annotation || mathMlToTex(element)
    if (!tex) return
    const display = element.getAttribute('display') === 'block' || element.closest('[display="block"], .katex-display') !== null
    replacementTarget.replaceWith(document.createTextNode(display ? `$$\n${tex}\n$$` : `$${tex}$`))
    hasMath = true
  }

  for (const container of Array.from(document.body.querySelectorAll('.katex, mjx-container'))) {
    const math = container.querySelector('math')
    if (math) replaceMath(math, container)
  }
  for (const math of Array.from(document.body.querySelectorAll('math'))) {
    if (document.body.contains(math)) replaceMath(math)
  }

  const text = htmlNodeText(document.body)
    .split('\u00a0').join(' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text, hasMath }
}

/** Read a paste payload without trusting or injecting clipboard HTML. */
export function readMathClipboard(data: ClipboardDataLike | null | undefined): MathClipboardPayload {
  if (!data) return { text: '', handled: false, source: 'none' }
  const plain = data.getData('text/plain') ?? ''
  const normalizedPlain = normalizeMathMarkdown(normalizePastedText(plain))
  const html = data.getData('text/html') ?? ''
  const rich = mathAwareTextFromHtml(html)
  if (rich.hasMath && rich.text) {
    return { text: normalizeMathMarkdown(normalizePastedText(rich.text)), handled: true, source: 'html' }
  }
  if (!plain) return { text: '', handled: false, source: 'none' }
  return {
    text: normalizedPlain,
    handled: normalizedPlain !== plain,
    source: 'plain',
  }
}

function isEscaped(source: string, index: number): boolean {
  let slashes = 0
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor--) slashes++
  return slashes % 2 === 1
}

function pushText(segments: PlainMathSegment[], content: string) {
  if (!content) return
  const previous = segments[segments.length - 1]
  if (previous?.type === 'text') {
    previous.content += content
    previous.source += content
  } else {
    segments.push({ type: 'text', content, source: content })
  }
}

function parseDollarMath(source: string): PlainMathSegment[] {
  const segments: PlainMathSegment[] = []
  let textStart = 0
  let cursor = 0

  while (cursor < source.length) {
    if (source[cursor] !== '$' || isEscaped(source, cursor)) {
      cursor++
      continue
    }
    const display = source[cursor + 1] === '$'
    const delimiter = display ? '$$' : '$'
    const contentStart = cursor + delimiter.length
    if (!display && /\s/.test(source[contentStart] ?? '')) {
      cursor++
      continue
    }
    let close = source.indexOf(delimiter, contentStart)
    while (close >= 0 && isEscaped(source, close)) close = source.indexOf(delimiter, close + delimiter.length)
    if (close < 0 || close === contentStart) {
      cursor += delimiter.length
      continue
    }
    if (!display) {
      const beforeClose = source[close - 1] ?? ''
      const afterClose = source[close + 1] ?? ''
      if (/\s/.test(beforeClose) || /\d/.test(afterClose)) {
        cursor++
        continue
      }
    }

    pushText(segments, source.slice(textStart, cursor))
    const content = source.slice(contentStart, close)
    segments.push({ type: 'math', content, source: source.slice(cursor, close + delimiter.length), display })
    cursor = close + delimiter.length
    textStart = cursor
  }

  pushText(segments, source.slice(textStart))
  return segments
}

/** Tokenize plain user text into literal text and safe KaTeX render units. */
export function plainMathSegments(source: string): PlainMathSegment[] {
  const segments: PlainMathSegment[] = []
  for (const part of partitionCode(source)) {
    if (part.code) {
      pushText(segments, part.content)
      continue
    }
    for (const segment of parseDollarMath(normalizeMathText(part.content))) {
      if (segment.type === 'text') pushText(segments, segment.content)
      else segments.push(segment)
    }
  }
  return segments
}

export function insertAtSelection(value: string, insertion: string, start: number, end: number) {
  const safeStart = Math.max(0, Math.min(start, value.length))
  const safeEnd = Math.max(safeStart, Math.min(end, value.length))
  return {
    value: value.slice(0, safeStart) + insertion + value.slice(safeEnd),
    caret: safeStart + insertion.length,
  }
}
