import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = join(here, '..', '..', '..')
const repoRoot = join(srcRoot, '..')

function source(relativePath: string): string {
  const path = join(repoRoot, relativePath)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function sha256(relativePath: string): string | null {
  const path = join(repoRoot, relativePath)
  if (!existsSync(path)) return null
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const appearanceRoot = 'src/features/k12/appearance'
const ownerSource = source(`${appearanceRoot}/useK12Appearance.ts`)
const presentationSource = source(`${appearanceRoot}/K12GlobalPresentation.vue`)
const settingsExtensionSource = source(`${appearanceRoot}/K12AppearanceSettings.vue`)
const registrySource = source('src/shell/scenario/registry.ts')
const registerSource = source('src/features/k12/register.ts')
const layoutSource = source('src/components/layout/AppLayout.vue')
const settingsSource = source('src/views/SettingsView.vue')
const toastProviderSource = source('src/components/common/ToastProvider.vue')
const toastSource = source('src/composables/useToast.ts')
const chatSource = source('src/views/ChatView.vue')
const insightSource = source('src/features/k12/views/K12InsightPanel.vue')

describe('BUG-20260801-012 · K12 v9 production contract (unchanged-production RED)', () => {
  it('has one feature-owned appearance owner, global presentation and settings extension', () => {
    expect(ownerSource, 'missing canonical K12 appearance owner').not.toBe('')
    expect(presentationSource, 'missing single global K12 presentation component').not.toBe('')
    expect(settingsExtensionSource, 'missing K12 appearance settings extension').not.toBe('')
    expect(ownerSource).toContain('hc-k12-appearance-v1')
    expect(ownerSource).toContain('activateOnFirstEntry')
  })

  it('extends the generic registry instead of importing the feature into the shell', () => {
    expect(registrySource).toContain('registerGlobalPresentationExtension')
    expect(registrySource).toContain('registerAppearanceSettingsExtension')
    expect(layoutSource).toContain('globalPresentationExtensions')
    expect(settingsSource).toContain('appearanceSettingsExtensions')
    expect(layoutSource).not.toMatch(/features\/k12|useK12/i)
  })

  it('registers exactly one production scene and one appearance settings extension', () => {
    expect(registerSource).toContain('K12GlobalPresentation')
    expect(registerSource).toContain('K12AppearanceSettings')
    expect(registerSource).toContain('registerGlobalPresentationExtension')
    expect(registerSource).toContain('registerAppearanceSettingsExtension')
  })

  it('packages only the four approved v9 masters with their authoritative hashes', () => {
    const expected = new Map([
      [
        `${appearanceRoot}/assets/k12-scene-light.png`,
        'bbf5dc0bc7e35f5b2fd393075477d40c34affe87155a28bf17e1072e0612cbc3',
      ],
      [
        `${appearanceRoot}/assets/k12-scene-dark.png`,
        'a957de8ba3f78e6fbed9fb65323c658864819f5a014650b8aa95c1b133afddca',
      ],
      [
        `${appearanceRoot}/assets/k12-content-light.png`,
        'd3e0e2dab6b9524bc23bb984e23827f3676e3b7a54899dd1190153d38edccf0e',
      ],
      [
        `${appearanceRoot}/assets/k12-content-dark.png`,
        '37b4451c44ec91d9c231a085d6339eb828020e8fa1b1891d40bcda6d0e52226f',
      ],
    ])

    for (const [path, hash] of expected) {
      expect(sha256(path), `${path} must be an exact copy of the approved master`).toBe(hash)
    }
    expect(source('src/features/k12/register.ts')).not.toMatch(/亮色模式\.png|暗色模式\.png/)
  })

  it('owns the final 2-butterfly / 18-firefly continuous ambient exact-set', () => {
    expect(presentationSource).toMatch(/RIGHT_FIREFLY_COUNT\s*=\s*14/)
    expect(presentationSource).toMatch(/SIDEBAR_FIREFLY_COUNT\s*=\s*4/)
    expect(presentationSource).toMatch(/BUTTERFLY_COUNT\s*=\s*2/)
    expect(presentationSource).toContain('aria-hidden="true"')
    expect(presentationSource).toContain('pointer-events: none')
    expect(presentationSource).toContain('prefers-reduced-motion: reduce')
    expect(presentationSource).not.toMatch(/k12-blackboard|clip-path/i)
  })

  it('keeps every Dark firefly translate keyframe inside the approved 6px anchor radius', () => {
    const fireflyKeyframes = presentationSource.match(
      /@keyframes k12FireflyDrift\s*\{([\s\S]*?)\n\}\n\n@media/,
    )?.[1]
    expect(fireflyKeyframes, 'missing k12FireflyDrift keyframes').toBeTruthy()
    const translations = [
      ...fireflyKeyframes!.matchAll(/translate3d\(([-\d.]+)(?:px)?,\s*([-\d.]+)(?:px)?,\s*0\)/g),
    ].map((match) => ({ x: Number(match[1]), y: Number(match[2]) }))

    expect(translations).toHaveLength(4)
    for (const translation of translations) {
      expect(Math.hypot(translation.x, translation.y)).toBeLessThanOrEqual(6)
    }
  })

  it('keeps the scene and motion target inside each complete scoped global selector', () => {
    expect(presentationSource).toMatch(
      /:global\(\s*\[data-theme='light'\]\s+body\[data-k12-skin-active='k12'\]\s+\.k12-global-presentation__sidebar-scene\s*\)/,
    )
    expect(presentationSource).toMatch(
      /:global\(\s*\[data-theme='light'\]\s+body\[data-k12-skin-active='k12'\]\s+\.k12-global-presentation__main-scene\s*\)/,
    )
    expect(presentationSource).toMatch(
      /:global\(\s*\[data-theme='light'\]\s+body\[data-k12-skin-active='k12'\]\s+\.k12-ambient-butterfly--one\s*\)/,
    )
    expect(presentationSource).toMatch(
      /:global\(\s*\[data-theme='dark'\]\s+body\[data-k12-skin-active='k12'\]\s+\.k12-ambient-firefly\s*\)/,
    )
  })

  it('projects the approved K12 theme tokens and keeps the sidebar signature unblurred', () => {
    expect(presentationSource).toMatch(
      /\[data-theme='light'\][^{]*body\[data-k12-skin-active='k12'\][^{]*\{[^}]*--hc-accent:\s*#4f8f66;/s,
    )
    expect(presentationSource).toMatch(
      /\[data-theme='dark'\][^{]*body\[data-k12-skin-active='k12'\][^{]*\{[^}]*--hc-accent:\s*#79bce5;/s,
    )
    expect(presentationSource).toMatch(
      /body\[data-k12-skin-active='k12'\][^{]*\.hc-sidebar\s*\)[^{]*\{[^}]*-webkit-backdrop-filter:\s*none;[^}]*backdrop-filter:\s*none;/s,
    )
  })

  it('provides the approved compact appearance controls and actionable intro toast', () => {
    expect(settingsSource).toContain('role="radiogroup"')
    expect(settingsSource).not.toContain('settings.appearance.lightDesc')
    expect(settingsSource).not.toContain('settings.appearance.darkDesc')
    expect(settingsSource).not.toContain('settings.appearance.systemDesc')
    expect(settingsExtensionSource).toContain('K12 专属皮肤')
    expect(settingsExtensionSource).toContain('通用外观')
    expect(toastProviderSource).toContain('actionLabel')
    expect(toastProviderSource).toContain('onAction')
    expect(toastSource).toContain('action:')
  })

  it('keeps the shared 226/256/220 geometry and the K12 1024px reading column', () => {
    expect(presentationSource).not.toMatch(/\.hc-chat__sessions[^}]*width\s*:/s)
    expect(presentationSource).not.toMatch(/\.hc-chat__sessions[^}]*flex-basis\s*:/s)
    expect(presentationSource).toContain('max-inline-size: 1024px')
    expect(source('src/components/layout/Sidebar.vue')).toContain('width: 226px')
    expect(chatSource).toMatch(/SIDEBAR_DEFAULT_WIDTH\s*=\s*256/)
    expect(chatSource).toMatch(/SIDEBAR_COMPACT_WIDTH\s*=\s*220/)
    expect(chatSource).toMatch(/SIDEBAR_COMPACT_BREAKPOINT\s*=\s*1040/)
    expect(insightSource).not.toMatch(/\.k12ins__priority\s*\{[^}]*max-width:\s*640px/s)
    expect(insightSource).toMatch(/\.k12ins\s*\{[^}]*max-inline-size:\s*1024px/s)
  })
})
