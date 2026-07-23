import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('macOS native print localization contract', () => {
  it('declares Simplified Chinese and English without replacing the AppKit print panel', () => {
    const plist = readFileSync(resolve(process.cwd(), 'src-tauri/Info.plist'), 'utf8')

    expect(plist).toContain('<key>CFBundleDevelopmentRegion</key>')
    expect(plist).toMatch(/<string>zh-Hans<\/string>/)
    expect(plist).toContain('<key>CFBundleLocalizations</key>')
    expect(plist).toMatch(
      /<key>CFBundleLocalizations<\/key>\s*<array>\s*<string>zh-Hans<\/string>\s*<string>en<\/string>\s*<\/array>/,
    )
    expect(plist).toContain('<key>CFBundleAllowMixedLocalizations</key>')
    expect(plist).toMatch(/<key>CFBundleAllowMixedLocalizations<\/key>\s*<true\/>/)

    const nativePrint = readFileSync(
      resolve(process.cwd(), 'src-tauri/src/native_print.rs'),
      'utf8',
    )
    expect(nativePrint).toContain('runModalWithPrintInfo')
    expect(nativePrint).not.toMatch(/\.setTitle\s*\(|\.setPrompt\s*\(/)
  })
})
