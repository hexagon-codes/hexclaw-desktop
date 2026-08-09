// @vitest-environment node

import { createFilter } from 'vite'
import { describe, expect, it } from 'vitest'
import { configDefaults, type ViteUserConfig } from 'vitest/config'

import vitestConfig from '../../vitest.config'

const testConfig = (vitestConfig as ViteUserConfig).test
const include = testConfig?.include ?? configDefaults.include
const exclude = testConfig?.exclude ?? configDefaults.exclude

// 使用配置最终生效的 include/exclude 共同判断，避免只断言某个字符串存在。
const isCollected = createFilter(include, exclude, { resolve: false })

describe('Vitest collection boundary', () => {
  it.each([
    'src-tauri/target/release/bundle/dmg/HexClaw.dmgroot/Applications/Codex.app/Contents/Resources/tests/rendered-html.test.mjs',
    'dist/assets/generated.test.js',
    'coverage/unit.test.js',
    'playwright-report-k12-live/data/report.test.js',
    'test-results/native-smoke/result.test.ts',
  ])('does not collect build artifact %s', (file) => {
    expect(isCollected(file)).toBe(false)
  })

  it.each([
    'src/stores/__tests__/chat.test.ts',
    'src/components/chat/ChatInput.spec.tsx',
    'tests/gates/k12-operation-receipt-poll.test.ts',
  ])('keeps canonical source test %s', (file) => {
    expect(isCollected(file)).toBe(true)
  })

  it.each([
    'tests/e2e/chat.spec.ts',
    'tests/live/provider.test.ts',
    'tests/mock/contract.test.mjs',
  ])('does not expand collection into %s', (file) => {
    expect(isCollected(file)).toBe(false)
  })
})
