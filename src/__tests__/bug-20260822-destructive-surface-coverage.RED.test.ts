import { describe, expect, it } from 'vitest'

const vueSources = import.meta.glob('../**/*.vue', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

function source(pathSuffix: string): string {
  const match = Object.entries(vueSources).find(([path]) => path.endsWith(pathSuffix))
  if (!match) throw new Error(`missing Vue source: ${pathSuffix}`)
  return match[1]
}

describe('BUG-20260725-018 / BUG-20260726-013 destructive surface coverage', () => {
  it('does not retain any known page-private destructive confirmation pattern', () => {
    const forbidden = [
      /v-if="pendingUninstall"/,
      /confirmingClear/,
      /@click="clearChat"/,
      /@click="handleDeleteEntry\(entry\.id\)"/,
    ]
    const violations = Object.entries(vueSources).flatMap(([path, currentSource]) =>
      forbidden
        .filter((pattern) => pattern.test(currentSource))
        .map((pattern) => `${path}:${pattern.source}`),
    )

    expect(violations).toEqual([])
  })

  it.each([
    ['views/SkillsView.vue', 1],
    ['views/MemoryView.vue', 3],
    ['views/QuickChatView.vue', 1],
    ['components/layout/NotificationPanel.vue', 1],
  ])('%s routes every persistent destructive action through ConfirmDialog', (path, minimumCount) => {
    const currentSource = source(path)
    const componentCount = currentSource.match(/<ConfirmDialog\b/g)?.length ?? 0

    expect(currentSource).toContain("import ConfirmDialog from '@/components/common/ConfirmDialog.vue'")
    expect(componentCount).toBeGreaterThanOrEqual(minimumCount)
    expect(currentSource).toContain(':confirmation-key=')
  })
})
