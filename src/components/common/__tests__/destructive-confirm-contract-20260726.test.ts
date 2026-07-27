import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ConfirmDialog from '../ConfirmDialog.vue'

function productionFiles(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...productionFiles(path))
      continue
    }
    if (/\.(?:ts|vue)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)) {
      files.push(path)
    }
  }
  return files
}

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('global destructive confirmation contract 2026-07-26', () => {
  it('默认危险确认在 1499ms 仍禁用，1500ms 才启用', async () => {
    vi.useFakeTimers()
    mount(ConfirmDialog, {
      props: {
        open: true,
        danger: true,
        title: '删除模型？',
      },
      attachTo: document.body,
    })

    const confirm = document.body.querySelector<HTMLButtonElement>(
      '.hc-dialog__btn--danger',
    )
    expect(confirm).not.toBeNull()
    expect(confirm!.disabled).toBe(true)

    await vi.advanceTimersByTimeAsync(1_499)
    expect(confirm!.disabled).toBe(true)

    await vi.advanceTimersByTimeAsync(1)
    expect(confirm!.disabled).toBe(false)
  })

  it('生产代码只有一个 1500ms 常量，业务调用不得传局部 delay', () => {
    const sourceRoot = resolve(process.cwd(), 'src')
    const files = productionFiles(sourceRoot)
    const occurrences: Array<{ file: string; count: number }> = []
    const localDelayCallsites: string[] = []

    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      const count = source.match(/DESTRUCTIVE_CONFIRM_COOLDOWN_MS\s*=\s*1_500/g)?.length ?? 0
      if (count > 0) occurrences.push({ file, count })
      if (
        !file.endsWith('/components/common/ConfirmDialog.vue') &&
        /(?:confirm-delay-ms|confirmDelayMs\s*:)/.test(source)
      ) {
        localDelayCallsites.push(file)
      }
    }

    expect(occurrences).toHaveLength(1)
    expect(occurrences[0]!.file).toBe(
      resolve(process.cwd(), 'src/config/destructive-actions.ts'),
    )
    expect(occurrences[0]!.count).toBe(1)
    expect(localDelayCallsites).toEqual([])
  })

  it('模型删除只设置 pending target，并由公共 ConfirmDialog 提交', () => {
    const settingsSource = readFileSync(
      resolve(process.cwd(), 'src/views/SettingsView.vue'),
      'utf8',
    )

    expect(settingsSource).not.toMatch(
      /class="hc-model-chip__remove"[\s\S]{0,400}@click\.stop="removeProviderModel\(/,
    )
    expect(settingsSource).toMatch(/pendingDeleteModel\.value\s*=\s*\{/)
    expect(settingsSource).toMatch(
      /<ConfirmDialog[\s\S]*:open="pendingDeleteModel !== null"[\s\S]*@confirm="confirmDeleteModel"/,
    )
  })
})
