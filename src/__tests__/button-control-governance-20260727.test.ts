import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { compileTemplate, parse } from 'vue/compiler-sfc'
import { describe, expect, it } from 'vitest'

const REPORT_PATH = '/tmp/BUG-20260725-019.button-audit.RED.json'
const SHARED_BUTTON_CLASS = 'btn'
const REQUIRED_SHARED_SELECTORS = [
  '.btn',
  '.btn-primary',
  '.btn-secondary',
  '.btn-danger-ghost',
  '.btn-ghost',
  '.btn:focus-visible',
  '.btn:disabled',
]
const BUTTON_FILE_EXEMPTION_MARKERS = [
  'BUTTON_FILE_ALLOWLIST',
  'BUTTON_FILE_EXEMPTIONS',
  'button-governance-ignore-file',
  'button-governance-exempt-file',
]
const BUTTON_VISUAL_PROPERTIES = new Set([
  'appearance',
  'background',
  'background-color',
  'background-image',
  'border',
  'border-color',
  'border-radius',
  'box-shadow',
  'color',
  'cursor',
  'font',
  'font-family',
  'font-size',
  'font-weight',
  'height',
  'line-height',
  'min-height',
  'opacity',
  'padding',
  'padding-block',
  'padding-bottom',
  'padding-inline',
  'padding-left',
  'padding-right',
  'padding-top',
  'text-shadow',
  'transform',
  'transition',
  'width',
])

interface TemplateProp {
  type: number
  name?: string
  value?: { content?: string }
  arg?: { type?: number; content?: string }
  exp?: { type?: number; content?: string }
}

interface TemplateNode {
  type: number
  tag?: string
  props?: TemplateProp[]
  children?: TemplateNode[]
  branches?: TemplateNode[]
  loc?: { start?: { line?: number; column?: number } }
}

interface ButtonNodeAudit {
  file: string
  line: number
  column: number
  classes: string[]
  dynamicClass: string
  hasSharedClass: boolean
  hasInlineStyle: boolean
}

interface CssRuleAudit {
  file: string
  line: number
  selector: string
  properties: string[]
}

interface CssRule {
  line: number
  selectors: string[]
  declarations: Map<string, string>
  atRules: string[]
}

interface ButtonGovernanceReport {
  summary: {
    nativeButtonNodes: number
    sharedButtonNodes: number
    ungovernedNativeButtons: number
    inlineStyleButtons: number
    privateVisualRules: number
    wholeFileExemptions: number
    missingSharedSelectors: number
    hasReducedMotionContract: boolean
  }
  ungovernedNativeButtons: ButtonNodeAudit[]
  inlineStyleButtons: ButtonNodeAudit[]
  privateVisualRules: CssRuleAudit[]
  wholeFileExemptions: string[]
  missingSharedSelectors: string[]
}

function staticAttribute(node: TemplateNode, name: string): string | undefined {
  const attribute = node.props?.find((prop) => prop.type === 6 && prop.name === name)
  return attribute?.value?.content ?? (attribute ? '' : undefined)
}

function directiveExpression(node: TemplateNode, name: string, argument: string): string {
  return (
    node.props
      ?.filter(
        (prop) =>
          prop.type === 7 &&
          prop.name === name &&
          prop.arg?.type === 4 &&
          prop.arg.content === argument,
      )
      .map((prop) => prop.exp?.content ?? '')
      .join(' ') ?? ''
  )
}

function auditButtonsInSfc(source: string, file: string): ButtonNodeAudit[] {
  const descriptor = parse(source, { filename: file }).descriptor
  const template = descriptor.template?.content
  if (!template) return []
  const compiled = compileTemplate({ source: template, filename: file, id: 'button-governance' })
  if (compiled.errors.length > 0) {
    throw new Error(`${file}: Vue template parse failed: ${compiled.errors.join(', ')}`)
  }

  const buttons: ButtonNodeAudit[] = []
  function visit(node: TemplateNode) {
    if (node.type === 1 && node.tag === 'button') {
      const classes = (staticAttribute(node, 'class') ?? '')
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean)
      const dynamicClass = directiveExpression(node, 'bind', 'class')
      const hasInlineStyle =
        staticAttribute(node, 'style') !== undefined ||
        directiveExpression(node, 'bind', 'style').trim().length > 0
      buttons.push({
        file,
        line: node.loc?.start?.line ?? 0,
        column: node.loc?.start?.column ?? 0,
        classes,
        dynamicClass,
        hasSharedClass: classes.includes(SHARED_BUTTON_CLASS),
        hasInlineStyle,
      })
    }
    for (const child of node.children ?? []) visit(child)
    for (const branch of node.branches ?? []) visit(branch)
  }
  visit(compiled.ast as unknown as TemplateNode)
  return buttons
}

function stripCssComments(source: string): string {
  let result = ''
  let index = 0
  while (index < source.length) {
    if (source[index] === '/' && source[index + 1] === '*') {
      result += '  '
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        result += source[index] === '\n' ? '\n' : ' '
        index += 1
      }
      if (index < source.length) {
        result += '  '
        index += 2
      }
      continue
    }
    result += source[index]
    index += 1
  }
  return result
}

function splitTopLevel(source: string, separator: string): string[] {
  const parts: string[] = []
  let start = 0
  let quote = ''
  let escaped = false
  let roundDepth = 0
  let squareDepth = 0
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '(') roundDepth += 1
    else if (character === ')') roundDepth = Math.max(0, roundDepth - 1)
    else if (character === '[') squareDepth += 1
    else if (character === ']') squareDepth = Math.max(0, squareDepth - 1)
    else if (character === separator && roundDepth === 0 && squareDepth === 0) {
      parts.push(source.slice(start, index))
      start = index + 1
    }
  }
  parts.push(source.slice(start))
  return parts
}

function findBlockEnd(source: string, openBrace: number): number {
  let depth = 1
  let quote = ''
  let escaped = false
  for (let index = openBrace + 1; index < source.length; index += 1) {
    const character = source[index]!
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  throw new Error(`Unclosed CSS block at offset ${openBrace}`)
}

function firstTopLevelBrace(source: string, start: number, end: number): number {
  let quote = ''
  let escaped = false
  let roundDepth = 0
  let squareDepth = 0
  for (let index = start; index < end; index += 1) {
    const character = source[index]!
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '(') roundDepth += 1
    else if (character === ')') roundDepth = Math.max(0, roundDepth - 1)
    else if (character === '[') squareDepth += 1
    else if (character === ']') squareDepth = Math.max(0, squareDepth - 1)
    else if (character === '{' && roundDepth === 0 && squareDepth === 0) return index
  }
  return -1
}

function parseDeclarations(source: string): Map<string, string> {
  const declarations = new Map<string, string>()
  for (const candidate of splitTopLevel(source, ';')) {
    const colon = candidate.indexOf(':')
    if (colon <= 0) continue
    const property = candidate.slice(0, colon).trim().toLowerCase()
    if (!/^--|^-?[a-z][a-z0-9-]*$/i.test(property)) continue
    declarations.set(property, candidate.slice(colon + 1).trim())
  }
  return declarations
}

function parseCssRules(source: string, baseLine = 1): CssRule[] {
  const css = stripCssComments(source)
  const rules: CssRule[] = []
  function walk(start: number, end: number, atRules: string[]) {
    let cursor = start
    while (cursor < end) {
      while (cursor < end && /\s|;/.test(css[cursor]!)) cursor += 1
      if (cursor >= end) break
      const openBrace = firstTopLevelBrace(css, cursor, end)
      if (openBrace < 0) break
      const prelude = css.slice(cursor, openBrace).trim()
      const closeBrace = findBlockEnd(css, openBrace)
      const line = baseLine + css.slice(0, cursor).split('\n').length - 1
      const body = css.slice(openBrace + 1, closeBrace)
      if (prelude.startsWith('@')) {
        const name = prelude.split(/\s+/, 1)[0]!.toLowerCase()
        if (!name.includes('keyframes') && name !== '@font-face' && name !== '@property') {
          walk(openBrace + 1, closeBrace, [...atRules, prelude])
        }
      } else {
        rules.push({
          line,
          selectors: splitTopLevel(prelude, ',').map((selector) => selector.trim()).filter(Boolean),
          declarations: parseDeclarations(body),
          atRules,
        })
      }
      cursor = closeBrace + 1
    }
  }
  walk(0, css.length, [])
  return rules
}

function selectorClassNames(selector: string): string[] {
  const names: string[] = []
  let index = 0
  while (index < selector.length) {
    if (selector[index] !== '.') {
      index += 1
      continue
    }
    index += 1
    let name = ''
    while (index < selector.length && /[-_a-zA-Z0-9]/.test(selector[index]!)) {
      name += selector[index]
      index += 1
    }
    if (name) names.push(name)
  }
  return names
}

function selectorTargetsButton(selector: string, buttonClasses: Set<string>): boolean {
  const elementButton = /(^|[\s>+~,(])button(?=$|[\s>+~,.#:[(])/i.test(selector)
  return elementButton || selectorClassNames(selector).some((name) => buttonClasses.has(name))
}

function privateButtonVisualRules(
  source: string,
  file: string,
  buttons: ButtonNodeAudit[],
): CssRuleAudit[] {
  const descriptor = parse(source, { filename: file }).descriptor
  const buttonClasses = new Set(buttons.flatMap((button) => button.classes))
  const findings: CssRuleAudit[] = []
  for (const style of descriptor.styles) {
    const baseLine = style.loc.start.line
    for (const rule of parseCssRules(style.content, baseLine)) {
      const properties = [...rule.declarations.keys()]
        .filter((property) => BUTTON_VISUAL_PROPERTIES.has(property))
        .sort()
      if (properties.length === 0) continue
      for (const selector of rule.selectors) {
        if (!selectorTargetsButton(selector, buttonClasses)) continue
        findings.push({ file, line: rule.line, selector, properties })
      }
    }
  }
  return findings
}

function auditSource(source: string, file: string) {
  const buttons = auditButtonsInSfc(source, file)
  return {
    buttons,
    privateVisualRules: privateButtonVisualRules(source, file, buttons),
  }
}

function sourceFiles(): string[] {
  return execFileSync(
    'rg',
    ['--files', 'src', '-g', '*.vue', '-g', '!**/__tests__/**'],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort()
}

function buildReport(files: string[]): ButtonGovernanceReport {
  const audits = files.map((file) => {
    const source = readFileSync(resolve(process.cwd(), file), 'utf8')
    return auditSource(source, file)
  })
  const buttons = audits.flatMap((audit) => audit.buttons)
  const ungovernedNativeButtons = buttons.filter((button) => !button.hasSharedClass)
  const inlineStyleButtons = buttons.filter((button) => button.hasInlineStyle)
  const privateVisualRules = audits
    .flatMap((audit) => audit.privateVisualRules)
    .sort((left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.selector.localeCompare(right.selector),
    )

  const globalCss = readFileSync(resolve(process.cwd(), 'src/assets/styles/global.css'), 'utf8')
  const globalRules = parseCssRules(globalCss)
  const selectors = new Set(globalRules.flatMap((rule) => rule.selectors))
  const missingSharedSelectors = REQUIRED_SHARED_SELECTORS.filter(
    (selector) => !selectors.has(selector),
  )
  const hasReducedMotionContract = globalRules.some(
    (rule) =>
      rule.atRules.some((atRule) => /prefers-reduced-motion\s*:\s*reduce/i.test(atRule)) &&
      rule.selectors.some((selector) => selector.includes('.btn')),
  )
  const wholeFileExemptions = files.flatMap((file) => {
    const source = readFileSync(resolve(process.cwd(), file), 'utf8')
    return BUTTON_FILE_EXEMPTION_MARKERS.filter((marker) => source.includes(marker)).map(
      (marker) => `${file}: ${marker}`,
    )
  })

  return {
    summary: {
      nativeButtonNodes: buttons.length,
      sharedButtonNodes: buttons.length - ungovernedNativeButtons.length,
      ungovernedNativeButtons: ungovernedNativeButtons.length,
      inlineStyleButtons: inlineStyleButtons.length,
      privateVisualRules: privateVisualRules.length,
      wholeFileExemptions: wholeFileExemptions.length,
      missingSharedSelectors: missingSharedSelectors.length,
      hasReducedMotionContract,
    },
    ungovernedNativeButtons,
    inlineStyleButtons,
    privateVisualRules,
    wholeFileExemptions,
    missingSharedSelectors,
  }
}

describe('BUG-20260725-019 · shared button exact-set governance', () => {
  it('reports every production button node and private visual rule without file exemptions', () => {
    const report = buildReport(sourceFiles())
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

    expect(
      report.summary,
      `Exact report: ${REPORT_PATH}`,
    ).toEqual({
      nativeButtonNodes: report.summary.nativeButtonNodes,
      sharedButtonNodes: report.summary.nativeButtonNodes,
      ungovernedNativeButtons: 0,
      inlineStyleButtons: 0,
      privateVisualRules: 0,
      wholeFileExemptions: 0,
      missingSharedSelectors: 0,
      hasReducedMotionContract: true,
    })
    expect(report.ungovernedNativeButtons).toEqual([])
    expect(report.inlineStyleButtons).toEqual([])
    expect(report.privateVisualRules).toEqual([])
    expect(report.wholeFileExemptions).toEqual([])
    expect(report.missingSharedSelectors).toEqual([])
  }, 30_000)

  it('fails closed for a conditional private button, inline style and local base visual', () => {
    const mutation = `
      <template>
        <button v-if="enabled" class="page-retry" :style="{ color: 'red' }">Retry</button>
      </template>
      <style scoped>
      @media (min-width: 600px) {
        .page-retry {
          border: 0;
          background: transparent;
          padding: 8px 12px;
        }
      }
      </style>
    `
    const audit = auditSource(mutation, 'mutation.vue')
    expect(audit.buttons).toMatchObject([
      {
        file: 'mutation.vue',
        line: 2,
        hasSharedClass: false,
        hasInlineStyle: true,
      },
    ])
    expect(audit.privateVisualRules).toMatchObject([
      {
        file: 'mutation.vue',
        selector: '.page-retry',
        properties: ['background', 'border', 'padding'],
      },
    ])
  })
})
