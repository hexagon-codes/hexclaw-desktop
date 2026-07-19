import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const EXCLUDED_INPUT_TYPES = new Set([
  'button', 'checkbox', 'color', 'date', 'file', 'hidden', 'radio', 'range', 'reset', 'submit',
])

function uncoveredFields(file: string): string[] {
  if (file.endsWith('/SearchInput.vue')) return [] // 自带 hc-search__clear
  const source = readFileSync(resolve(process.cwd(), file), 'utf8')
  const template = source.match(/<template>([\s\S]*)<\/template>/)?.[1] ?? ''
  const withoutClearableWrappers = template.replace(
    /<HcClearableField\b[\s\S]*?<\/HcClearableField>/g,
    '',
  )
  const missing: string[] = []

  for (const match of withoutClearableWrappers.matchAll(/<input\b([\s\S]*?)(?<![=])>/g)) {
    const attrs = match[1] ?? ''
    const type = attrs.match(/\btype\s*=\s*["']([^"']+)["']/)?.[1] ?? 'text'
    const staticallyProtected = /(?:^|\s)(?:disabled|readonly)(?:\s|\/|$)/.test(attrs)
    if (!EXCLUDED_INPUT_TYPES.has(type) && !staticallyProtected) {
      missing.push(match[0].replace(/\s+/g, ' ').slice(0, 140))
    }
  }
  for (const match of withoutClearableWrappers.matchAll(/<textarea\b/g)) {
    missing.push(match[0])
  }
  return missing
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
  })
})
