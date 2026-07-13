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
  it('tauri.conf.json version matches package.json', () => {
    const tauriConf = JSON.parse(readFile(path.join(ROOT, 'src-tauri/tauri.conf.json')))
    const packageJson = JSON.parse(readFile(path.join(ROOT, 'package.json')))
    expect(tauriConf.version).toBe(packageJson.version)
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

  // 产品评审结论（2026-07-13）：面向 K12 家长的消费级产品，角落版本号是「产品身份证」
  // （客服锚点 / 更新基准），应显示 HexClaw 产品版本，而非内部引擎 Hexagon 的版本。
  // Hexagon 引擎版本退到「关于」页展示。
  it('Sidebar shows HexClaw product version, not the Hexagon engine version', () => {
    const sidebar = readFile(path.join(SRC, 'components/layout/Sidebar.vue'))
    const scriptSection = sidebar.slice(0, sidebar.indexOf('<template>'))

    // 产品版本来自 Tauri app 版本（与 AboutView 主版本同源），不再取 hexagon engine_version
    expect(scriptSection).toMatch(/const appVersion\s*=\s*ref/)
    expect(scriptSection).toContain('@tauri-apps/api/app')

    // 底部标签展示产品名 HexClaw + 版本，不再出现 "Hexagon engine"
    expect(sidebar).not.toContain('Hexagon engine')

    // Template should not have hardcoded version strings
    const templateSection = sidebar.slice(sidebar.indexOf('<template>'))
    expect(templateSection).not.toMatch(/v0\.\d+\.\d+(?!.*\{\{)/)
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

  it('all appVersion fallback defaults are consistent (—)', () => {
    const filesToCheck = [
      path.join(SRC, 'views/AboutView.vue'),
      path.join(SRC, 'views/SettingsView.vue'),
    ]

    for (const file of filesToCheck) {
      const content = readFile(file)
      // All components should use '—' as fallback, version loaded dynamically from Tauri
      const versionMatch = content.match(/appVersion\s*=\s*ref\(['"]([^'"]+)['"]\)/)
      expect(versionMatch).not.toBeNull()
      expect(versionMatch![1]).toBe('—')
    }
  })

  it('Sidebar appVersion fallback is empty string', () => {
    const sidebar = readFile(path.join(SRC, 'components/layout/Sidebar.vue'))
    // appVersion starts empty, only shows once the Tauri app version resolves（避免 '—' 闪烁）
    const versionMatch = sidebar.match(/appVersion\s*=\s*ref\(['"]([^']*)['"]\)/)
    expect(versionMatch).not.toBeNull()
    expect(versionMatch![1]).toBe('')
  })

  it('AboutView surfaces the Hexagon engine version (moved out of the sidebar)', () => {
    const aboutView = readFile(path.join(SRC, 'views/AboutView.vue'))
    // 引擎版本仍从后端解析
    expect(aboutView).toMatch(/const engineVersion\s*=\s*ref/)
    // 且必须在模板里真正渲染出来（Hexagon 版本的归宿 = 关于页，而非只 fetch 不显示）
    const templateSection = aboutView.slice(aboutView.indexOf('<template>'))
    expect(templateSection).toContain('engineVersion')
  })
})
