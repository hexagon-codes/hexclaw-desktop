import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { compileTemplate, parse } from 'vue/compiler-sfc'

const EXCLUDED_INPUT_TYPES = new Set([
  'button', 'checkbox', 'color', 'date', 'file', 'hidden', 'number', 'radio', 'range', 'reset', 'submit',
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

function staticAttribute(node: TemplateNode, name: string): string | undefined {
  const attribute = node.props?.find((prop) => prop.type === 6 && prop.name === name)
  return attribute?.value?.content ?? (attribute ? '' : undefined)
}

function hasStaticAttribute(node: TemplateNode, name: string): boolean {
  return node.props?.some((prop) => prop.type === 6 && prop.name === name) ?? false
}

function isEditableTextNode(node: TemplateNode): boolean {
  if (node.type !== 1) return false
  // `data-clearable-control` marks the one shared canonical contenteditable
  // surface. Its call sites are checked separately because the
  // HcClearableField wrapper lives in the parent SFC.
  if (hasStaticAttribute(node, 'data-clearable-control')) return false
  if (node.tag === 'textarea') return !hasStaticAttribute(node, 'disabled')
    && !hasStaticAttribute(node, 'readonly')
  if (node.tag === 'input') {
    const inputType = staticAttribute(node, 'type')
    if (inputType && EXCLUDED_INPUT_TYPES.has(inputType)) return false
    return !hasStaticAttribute(node, 'disabled') && !hasStaticAttribute(node, 'readonly')
  }
  if (hasStaticAttribute(node, 'contenteditable')) {
    return staticAttribute(node, 'contenteditable') !== 'false'
  }
  return node.props?.some(
    (prop) =>
      prop.type === 7 &&
      prop.name === 'bind' &&
      prop.arg?.type === 4 &&
      prop.arg.content === 'contenteditable',
  ) ?? false
}

function directiveExpression(node: TemplateNode, name: string): string {
  return node.props
    ?.filter((prop) => prop.type === 7 && prop.name === name)
    .map((prop) => prop.exp?.content ?? '')
    .join(' ') ?? ''
}

function isSearchSemanticInput(node: TemplateNode): boolean {
  if (node.type !== 1 || node.tag !== 'input') return false
  if (hasStaticAttribute(node, 'data-search-control')) return false
  const semanticSource = [
    directiveExpression(node, 'model'),
    directiveExpression(node, 'bind'),
    staticAttribute(node, 'placeholder') ?? '',
  ].join(' ')
  return /(?:search|filter|query|搜索|筛选|过滤)/i.test(semanticSource)
}

function uncoveredFieldsInSource(source: string, file: string): string[] {
  const descriptor = parse(source, { filename: file }).descriptor
  const template = descriptor.template?.content
  if (!template) return []
  const compiled = compileTemplate({ source: template, filename: file, id: 'governance' })
  if (compiled.errors.length > 0) {
    throw new Error(`${file}: Vue template parse failed: ${compiled.errors.join(', ')}`)
  }

  const missing: string[] = []
  function visit(node: TemplateNode, clearableDepth: number) {
    const nextDepth = clearableDepth + (node.type === 1 && node.tag === 'HcClearableField' ? 1 : 0)
    if (isEditableTextNode(node) && nextDepth === 0) {
      const line = node.loc?.start?.line ?? 0
      const column = node.loc?.start?.column ?? 0
      missing.push(`${file}:${line}:${column}: <${node.tag}> is outside HcClearableField`)
    }
    for (const child of node.children ?? []) visit(child, nextDepth)
    for (const branch of node.branches ?? []) visit(branch, nextDepth)
  }
  visit(compiled.ast as unknown as TemplateNode, 0)
  return missing
}

function uncoveredEditableMessageTextInSource(source: string, file: string): string[] {
  const descriptor = parse(source, { filename: file }).descriptor
  const template = descriptor.template?.content
  if (!template) return []
  const compiled = compileTemplate({ source: template, filename: file, id: 'governance' })
  if (compiled.errors.length > 0) {
    throw new Error(`${file}: Vue template parse failed: ${compiled.errors.join(', ')}`)
  }
  const missing: string[] = []
  function visit(node: TemplateNode, clearableDepth: number) {
    const nextDepth = clearableDepth + (node.type === 1 && node.tag === 'HcClearableField' ? 1 : 0)
    const editableMessageText =
      node.type === 1 &&
      node.tag === 'MessageText' &&
      (hasStaticAttribute(node, 'editable') ||
        node.props?.some(
          (prop) =>
            prop.type === 7 &&
            prop.name === 'bind' &&
            prop.arg?.type === 4 &&
            prop.arg.content === 'editable',
        ))
    if (editableMessageText && nextDepth === 0) {
      const line = node.loc?.start?.line ?? 0
      const column = node.loc?.start?.column ?? 0
      missing.push(`${file}:${line}:${column}: editable <MessageText> is outside HcClearableField`)
    }
    for (const child of node.children ?? []) visit(child, nextDepth)
    for (const branch of node.branches ?? []) visit(branch, nextDepth)
  }
  visit(compiled.ast as unknown as TemplateNode, 0)
  return missing
}

function uncoveredSearchFieldsInSource(source: string, file: string): string[] {
  const descriptor = parse(source, { filename: file }).descriptor
  const template = descriptor.template?.content
  if (!template) return []
  const compiled = compileTemplate({ source: template, filename: file, id: 'governance' })
  if (compiled.errors.length > 0) {
    throw new Error(`${file}: Vue template parse failed: ${compiled.errors.join(', ')}`)
  }
  const missing: string[] = []
  function visit(node: TemplateNode) {
    if (isSearchSemanticInput(node)) {
      const line = node.loc?.start?.line ?? 0
      const column = node.loc?.start?.column ?? 0
      missing.push(`${file}:${line}:${column}: search semantic must use <SearchInput>`)
    }
    for (const child of node.children ?? []) visit(child)
    for (const branch of node.branches ?? []) visit(branch)
  }
  visit(compiled.ast as unknown as TemplateNode)
  return missing
}

function uncoveredFields(file: string): string[] {
  const source = readFileSync(resolve(process.cwd(), file), 'utf8')
  return [
    ...uncoveredFieldsInSource(source, file),
    ...uncoveredEditableMessageTextInSource(source, file),
  ]
}

describe('clearable text field coverage', () => {
  it('wraps every editable native input and textarea in HcClearableField', () => {
    const files = execFileSync(
      'rg',
      ['--files', 'src', '-g', '*.vue', '-g', '!**/__tests__/**'],
      { encoding: 'utf8' },
    ).trim().split('\n').filter(Boolean)

    const missing = files.flatMap((file) =>
      uncoveredFields(file).map((field) => `${file}: ${field}`),
    )

    expect(missing).toEqual([])
  }, 20_000)

  it('fails closed for a newly introduced editable branch without a node-level wrapper', () => {
    const mutation = `
      <template>
        <section>
          <HcClearableField><input type="text" /></HcClearableField>
          <input v-if="enabled" type="text" />
        </section>
      </template>
    `
    expect(uncoveredFieldsInSource(mutation, 'mutation.vue')).toEqual([
      'mutation.vue:4:11: <input> is outside HcClearableField',
    ])
  })

  it('fails closed when the shared canonical editor is mounted without its clearable owner', () => {
    const mutation = `
      <template><MessageText editable /></template>
    `
    expect(uncoveredEditableMessageTextInSource(mutation, 'message-mutation.vue')).toEqual([
      'message-mutation.vue:1:1: editable <MessageText> is outside HcClearableField',
    ])
  })

  it('routes every search-semantic text field through SearchInput without file allowlists', () => {
    const files = execFileSync(
      'rg',
      ['--files', 'src', '-g', '*.vue', '-g', '!**/__tests__/**'],
      { encoding: 'utf8' },
    ).trim().split('\n').filter(Boolean)

    const missing = files.flatMap((file) => {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8')
      return uncoveredSearchFieldsInSource(source, file)
    })

    expect(missing).toEqual([])
  }, 20_000)

  it('fails closed for a conditionally rendered private search field', () => {
    const mutation = `
      <template>
        <SearchInput v-model="search" />
        <input v-if="advanced" v-model="filterQuery" />
      </template>
    `
    expect(uncoveredSearchFieldsInSource(mutation, 'search-mutation.vue')).toEqual([
      'search-mutation.vue:3:9: search semantic must use <SearchInput>',
    ])
  })
})
