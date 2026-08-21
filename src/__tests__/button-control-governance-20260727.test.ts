import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { compileTemplate, parse } from 'vue/compiler-sfc'
import { describe, expect, it } from 'vitest'

const REPORT_PATH = '/tmp/BUG-20260725-019.button-audit.GREEN.json'
const SHARED_BUTTON_CLASSES = new Set(['btn', 'hc-btn'])
const APPROVED_SPECIALIZED_BUTTON_OWNERS = new Set([
  'interactive-action',
  'interactive-option',
  'clearable-action',
  'workflow-node',
  'workflow-selector',
  'connection-alert',
  'chat-retry',
  'settings-stepper',
  'k12-action',
  'k12-modal',
  'k12-retry',
  'k12-copy',
  'k12-capability',
  'tasks-schedule',
  'tasks-delivery',
])
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
const BUTTON_LAYOUT_PROPERTIES = new Set([
  'font-size',
  'height',
  'line-height',
  'min-height',
  'padding',
  'padding-block',
  'padding-bottom',
  'padding-inline',
  'padding-left',
  'padding-right',
  'padding-top',
  'border-radius',
  'width',
])
const UTILITY_CLASS_PREFIXES = [
  'absolute',
  'active:',
  'align-',
  'appearance-',
  'bg-',
  'block',
  'border',
  'bottom-',
  'capitalize',
  'col-',
  'content-',
  'cursor-',
  'dark:',
  'decoration-',
  'delay-',
  'disabled:',
  'divide-',
  'duration-',
  'ease-',
  'flex',
  'float-',
  'focus',
  'font-',
  'from-',
  'gap-',
  'grid',
  'grow',
  'h-',
  'hidden',
  'hover:',
  'inline',
  'inset-',
  'items-',
  'justify-',
  'leading-',
  'left-',
  'lowercase',
  'max-',
  'mb-',
  'min-',
  'ml-',
  'mr-',
  'mt-',
  'mx-',
  'my-',
  'normal-case',
  'opacity-',
  'order-',
  'outline-',
  'overflow-',
  'p-',
  'pb-',
  'pe-',
  'pl-',
  'place-',
  'pr-',
  'ps-',
  'pt-',
  'px-',
  'py-',
  'relative',
  'right-',
  'ring-',
  'rounded',
  'row-',
  'scale-',
  'rotate-',
  'translate-',
  'select-',
  'self-',
  'shadow',
  'shrink',
  'space-',
  'sr-only',
  'text-',
  'to-',
  'top-',
  'tracking-',
  'transition',
  'truncate',
  'underline',
  'uppercase',
  'via-',
  'whitespace-',
  'w-',
  'z-',
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
  kind: 'action' | 'specialized' | 'unowned'
  owner: string
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
    governedButtonNodes: number
    sharedActionButtonNodes: number
    specializedButtonNodes: number
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

function dynamicClassTokens(expression: string): string[] {
  return expression.match(/[a-zA-Z][a-zA-Z0-9_-]*(?:__[a-zA-Z0-9_-]+)?/g) ?? []
}

function isUtilityClass(token: string): boolean {
  const parts = token.split(':')
  const base = parts[parts.length - 1] ?? token
  const normalized = base.startsWith('-') ? base.slice(1) : base
  return UTILITY_CLASS_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(prefix),
  )
}

function isNamespacedSpecializedClass(token: string): boolean {
  return (
    token.includes('__') ||
    /^(?:hc|k12|rl|task|rec|cron|wf|tpl|mm|ollama|type-toggle|icbtn)(?:-|$)/.test(token)
  )
}

function classifyButton(
  node: TemplateNode,
  classes: string[],
  dynamicClass: string,
): { kind: ButtonNodeAudit['kind']; owner: string; hasSharedClass: boolean } {
  const hasSharedClass = classes.some((token) => SHARED_BUTTON_CLASSES.has(token))
  if (hasSharedClass) {
    return { kind: 'action', owner: 'shared-action', hasSharedClass }
  }

  const owner = staticAttribute(node, 'data-governed-button')
  if (owner) {
    return APPROVED_SPECIALIZED_BUTTON_OWNERS.has(owner)
      ? { kind: 'specialized', owner, hasSharedClass }
      : { kind: 'unowned', owner: `unknown:${owner}`, hasSharedClass }
  }

  const role = staticAttribute(node, 'role')
  const hasSemanticAttribute =
    Boolean(role && role !== 'button') ||
    (node.props?.some(
      (prop) =>
        (prop.type === 6 && (prop.name ?? '').startsWith('aria-')) ||
        (prop.type === 7 &&
          prop.arg?.type === 4 &&
          (prop.arg.content ?? '').startsWith('aria-')),
    ) ?? false)
  const allClasses = [...classes, ...dynamicClassTokens(dynamicClass)]
  const hasSpecializedNamespace = allClasses.some(isNamespacedSpecializedClass)
  const isTokenizedControl = allClasses.length > 0 && allClasses.every(isUtilityClass)

  if (hasSemanticAttribute || hasSpecializedNamespace || isTokenizedControl) {
    return {
      kind: 'specialized',
      owner: role && role !== 'button' ? `role:${role}` : 'specialized-control',
      hasSharedClass,
    }
  }

  return { kind: 'unowned', owner: 'missing-owner', hasSharedClass }
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
      const classification = classifyButton(node, classes, dynamicClass)
      buttons.push({
        file,
        line: node.loc?.start?.line ?? 0,
        column: node.loc?.start?.column ?? 0,
        classes,
        dynamicClass,
        kind: classification.kind,
        owner: classification.owner,
        hasSharedClass: classification.hasSharedClass,
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

const SHARED_BUTTON_SELECTOR_CLASSES = new Set([
  'btn',
  'btn-primary',
  'btn-secondary',
  'btn-danger-ghost',
  'btn-ghost',
  'btn-sm',
  'hc-btn',
  'hc-btn-primary',
  'hc-btn-secondary',
  'hc-btn-danger-ghost',
  'hc-btn-ghost',
  'hc-btn-sm',
])

function selectorTargetsSharedButton(selector: string): boolean {
  const elementButton = /(^|[\s>+~,(])button(?=$|[\s>+~,.#:[(])/i.test(selector)
  const selectorClasses = selectorClassNames(selector)
  const targetsSharedClass = selectorClasses.some((name) =>
    SHARED_BUTTON_SELECTOR_CLASSES.has(name),
  )
  const targetsBareButton = elementButton && selectorClasses.length === 0
  return targetsSharedClass || targetsBareButton
}

function privateButtonVisualRules(
  source: string,
  file: string,
): CssRuleAudit[] {
  const descriptor = parse(source, { filename: file }).descriptor
  const findings: CssRuleAudit[] = []
  for (const style of descriptor.styles) {
    const baseLine = style.loc.start.line
    for (const rule of parseCssRules(style.content, baseLine)) {
      const properties = [...rule.declarations.keys()]
        .filter((property) => BUTTON_VISUAL_PROPERTIES.has(property))
        .sort()
      if (properties.length === 0) continue
      for (const selector of rule.selectors) {
        if (!selectorTargetsSharedButton(selector)) continue
        const selectorClasses = selectorClassNames(selector)
        const hasLayoutOwner = selectorClasses.some(
          (name) => !SHARED_BUTTON_SELECTOR_CLASSES.has(name),
        )
        const hasCompositeOwner = selectorClasses.some((name) => name.includes('split'))
        const allowedProperties = properties.every(
          (property) =>
            BUTTON_LAYOUT_PROPERTIES.has(property) ||
            (hasCompositeOwner && ['box-shadow', 'transform'].includes(property)),
        )
        if (
          hasLayoutOwner &&
          allowedProperties
        ) {
          continue
        }
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
    privateVisualRules: privateButtonVisualRules(source, file),
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
  const ungovernedNativeButtons = buttons.filter((button) => button.kind === 'unowned')
  const actionButtons = buttons.filter((button) => button.kind === 'action')
  const specializedButtons = buttons.filter((button) => button.kind === 'specialized')
  const inlineStyleButtons = actionButtons.filter((button) => button.hasInlineStyle)
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
      governedButtonNodes: buttons.length - ungovernedNativeButtons.length,
      sharedActionButtonNodes: actionButtons.length,
      specializedButtonNodes: specializedButtons.length,
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
      governedButtonNodes: report.summary.nativeButtonNodes,
      sharedActionButtonNodes: report.summary.sharedActionButtonNodes,
      specializedButtonNodes: report.summary.specializedButtonNodes,
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
        <button v-if="enabled" class="btn page-retry" :style="{ color: 'red' }">Retry</button>
      </template>
      <style scoped>
      @media (min-width: 600px) {
        .btn.page-retry {
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
        kind: 'action',
        hasSharedClass: true,
        hasInlineStyle: true,
      },
    ])
    expect(audit.privateVisualRules).toMatchObject([
      {
        file: 'mutation.vue',
        selector: '.btn.page-retry',
        properties: ['background', 'border', 'padding'],
      },
    ])

    const unknownOwner = auditSource(
      `
        <template>
          <button data-governed-button="page-private">Private</button>
        </template>
      `,
      'unknown-owner.vue',
    )
    expect(unknownOwner.buttons).toMatchObject([
      {
        kind: 'unowned',
        owner: 'unknown:page-private',
      },
    ])

    const genericClass = auditSource(
      `
        <template>
          <button class="page-button">Ordinary</button>
        </template>
      `,
      'generic-class.vue',
    )
    expect(genericClass.buttons).toMatchObject([
      {
        kind: 'unowned',
        owner: 'missing-owner',
      },
    ])
  })
})
