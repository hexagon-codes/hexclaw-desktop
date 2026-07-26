import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { compileTemplate, parse } from 'vue/compiler-sfc'
import { describe, expect, it } from 'vitest'

interface TemplateProp {
  type: number
  name?: string
  value?: { content?: string }
}

interface TemplateNode {
  type: number
  tag?: string
  props?: TemplateProp[]
  children?: TemplateNode[]
  branches?: TemplateNode[]
  loc?: { start?: { line?: number; column?: number } }
}

const APPROVED_SELECT_OWNERS = new Set([
  'hc-select',
  'provider-select',
  // Rich, domain-specific pickers are not ordinary form selects: both carry
  // metadata/actions that HcSelect intentionally does not own. Their exact
  // singleton count below prevents the marker becoming a generic escape hatch.
  'embedding-profile',
  'agent-binding',
])

function staticAttribute(node: TemplateNode, name: string): string | undefined {
  const attribute = node.props?.find((prop) => prop.type === 6 && prop.name === name)
  return attribute?.value?.content ?? (attribute ? '' : undefined)
}

function selectOwnersInSource(source: string, file: string) {
  const descriptor = parse(source, { filename: file }).descriptor
  const template = descriptor.template?.content
  if (!template) return { native: [] as string[], unowned: [] as string[], owners: [] as string[] }
  const compiled = compileTemplate({ source: template, filename: file, id: 'select-governance' })
  if (compiled.errors.length > 0) {
    throw new Error(`${file}: Vue template parse failed: ${compiled.errors.join(', ')}`)
  }

  const native: string[] = []
  const unowned: string[] = []
  const owners: string[] = []
  function visit(node: TemplateNode) {
    if (node.type === 1) {
      const line = node.loc?.start?.line ?? 0
      const column = node.loc?.start?.column ?? 0
      if (node.tag === 'select') native.push(`${file}:${line}:${column}: native <select>`)

      const role = staticAttribute(node, 'role')
      const hasListboxPopup = staticAttribute(node, 'aria-haspopup') === 'listbox'
      const owner = staticAttribute(node, 'data-governed-select')
      if (owner) owners.push(owner)
      if ((role === 'combobox' || hasListboxPopup) && !APPROVED_SELECT_OWNERS.has(owner ?? '')) {
        unowned.push(`${file}:${line}:${column}: combobox is not owned by an approved control`)
      }
    }
    for (const child of node.children ?? []) visit(child)
    for (const branch of node.branches ?? []) visit(branch)
  }
  visit(compiled.ast as unknown as TemplateNode)
  return { native, unowned, owners }
}

describe('global select control governance', () => {
  it('has no native select and keeps every combobox on an exact node-level owner ledger', () => {
    const files = execFileSync(
      'rg',
      ['--files', 'src', '-g', '*.vue', '-g', '!**/__tests__/**'],
      { encoding: 'utf8' },
    ).trim().split('\n').filter(Boolean)

    const reports = files.map((file) =>
      selectOwnersInSource(readFileSync(resolve(process.cwd(), file), 'utf8'), file),
    )
    expect(reports.flatMap((report) => report.native)).toEqual([])
    expect(reports.flatMap((report) => report.unowned)).toEqual([])
    expect(
      reports.flatMap((report) => report.owners).sort(),
    ).toEqual([
      'agent-binding',
      'embedding-profile',
      'hc-select',
      'provider-select',
    ])
  })

  it('fails closed for a private combobox and an unknown marker', () => {
    const privateSelect = `
      <template>
        <button role="combobox" aria-haspopup="listbox">Private</button>
        <button
          role="combobox"
          aria-haspopup="listbox"
          data-governed-select="page-private"
        >Private marker</button>
      </template>
    `
    expect(selectOwnersInSource(privateSelect, 'mutation.vue').unowned).toEqual([
      'mutation.vue:2:9: combobox is not owned by an approved control',
      'mutation.vue:3:9: combobox is not owned by an approved control',
    ])
  })
})
