import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const readRoot = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8')

describe('package workflow · release artifact contract', () => {
  it('stages every Tauri external binary and bundled Ollama resource', () => {
    const workflow = readRoot('.github/workflows/package.yml')

    expect(workflow).toContain('Download Ollama binary')
    expect(workflow).toContain('release/scripts/render-bundle.sh src-tauri/binaries')
    expect(workflow).toContain('src-tauri/binaries/pandoc-*')
    expect(workflow).toContain('src-tauri/binaries/typst-*')
  })
})
