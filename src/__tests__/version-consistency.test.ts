/**
 * Version Consistency Tests
 *
 * Ensures version strings are consistent across the application and
 * no stale versions remain in the codebase.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(__dirname, '../../')
const SRC = path.resolve(ROOT, 'src')

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8')
}

function findFilesRecursive(dir: string, ext: string): string[] {
  const results: string[] = []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      results.push(...findFilesRecursive(fullPath, ext))
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      results.push(fullPath)
    }
  }
  return results
}

describe('Version Consistency', () => {
  it('tauri.conf.json version is "0.2.2"', () => {
    const tauriConf = JSON.parse(readFile(path.join(ROOT, 'src-tauri/tauri.conf.json')))
    expect(tauriConf.version).toBe('0.2.2')
  })

  it('no hardcoded "v0.1.0-beta" anywhere in src/ directory', () => {
    const files = [
      ...findFilesRecursive(SRC, '.ts'),
      ...findFilesRecursive(SRC, '.vue'),
    ]

    const staleVersionFiles: string[] = []
    for (const file of files) {
      // Skip test files
      if (file.includes('__tests__') || file.includes('.test.')) continue
      const content = readFile(file)
      if (content.includes('v0.1.0-beta') || content.includes('v0.1.0')) {
        staleVersionFiles.push(path.relative(ROOT, file))
      }
    }

    expect(staleVersionFiles).toEqual([])
  })

  it('Sidebar uses dynamic appVersion ref (not hardcoded in template)', () => {
    const sidebar = readFile(path.join(SRC, 'components/layout/Sidebar.vue'))

    // Should have a ref for appVersion
    expect(sidebar).toMatch(/const appVersion\s*=\s*ref/)

    // Template should use {{ appVersion }} not a literal version string
    const templateSection = sidebar.slice(sidebar.indexOf('<template>'))
    expect(templateSection).toContain('{{ appVersion }}')
    expect(templateSection).not.toMatch(/v0\.\d+\.\d+(?!.*\{\{)/)
  })

  it('AboutModal uses dynamic appVersion ref (not hardcoded in template)', () => {
    const about = readFile(path.join(SRC, 'components/common/AboutModal.vue'))

    // Should have a ref
    expect(about).toMatch(/const appVersion\s*=\s*ref/)

    // Should attempt to get version from Tauri API
    expect(about).toContain('getVersion')

    // Template should use {{ appVersion }}
    const templateSection = about.slice(about.indexOf('<template>'))
    expect(templateSection).toContain('{{ appVersion }}')
  })

  it('AboutView uses dynamic appVersion ref (not hardcoded in template)', () => {
    const aboutView = readFile(path.join(SRC, 'views/AboutView.vue'))

    // Should have a ref
    expect(aboutView).toMatch(/const appVersion\s*=\s*ref/)

    // Should attempt to get version from Tauri API
    expect(aboutView).toContain('getVersion')

    // Template should use {{ appVersion }}
    const templateSection = aboutView.slice(aboutView.indexOf('<template>'))
    expect(templateSection).toContain('{{ appVersion }}')
  })

  it('all version fallback defaults are v0.2.2', () => {
    const filesToCheck = [
      path.join(SRC, 'components/layout/Sidebar.vue'),
      path.join(SRC, 'components/common/AboutModal.vue'),
      path.join(SRC, 'views/AboutView.vue'),
    ]

    for (const file of filesToCheck) {
      const content = readFile(file)
      // The ref should default to 'v0.2.2'
      const versionMatch = content.match(/appVersion\s*=\s*ref\(['"]([^'"]+)['"]\)/)
      expect(versionMatch).not.toBeNull()
      expect(versionMatch![1]).toBe('v0.2.2')
    }
  })
})
