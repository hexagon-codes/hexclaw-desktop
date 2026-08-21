import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const prototype = readFileSync(
  resolve(__dirname, '../../../../../hexclaw-docs/prototype/app.html'),
  'utf8',
)
const globalCSS = readFileSync(resolve(__dirname, '../../../assets/styles/global.css'), 'utf8')
const appLayout = readFileSync(resolve(__dirname, '../AppLayout.vue'), 'utf8')
const k12Presentation = readFileSync(
  resolve(__dirname, '../../../features/k12/appearance/K12GlobalPresentation.vue'),
  'utf8',
)

function cssBlock(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
}

function hasTexture(block: string): boolean {
  return block.includes('background-image:') && block.includes('image/svg+xml')
}

function hasTopGlow(block: string): boolean {
  return block.includes('radial-gradient') && block.includes('circle at top center')
}

describe('BUG-20260723-015 — app shell background layers match the prototype exact-set', () => {
  it('keeps exactly one hex texture layer across the rendered application shell', () => {
    const prototypeTextureCount = [
      cssBlock(prototype, '.app::after'),
      cssBlock(prototype, '.mn::after'),
    ].filter(hasTexture).length
    const implementationTextureCount = [
      cssBlock(globalCSS, '.hc-app::after'),
      cssBlock(globalCSS, '.hc-app__body::after'),
      cssBlock(appLayout, '.hc-app::after'),
      cssBlock(appLayout, '.hc-app__body::after'),
    ].filter(hasTexture).length

    expect(prototypeTextureCount).toBe(1)
    expect(implementationTextureCount).toBe(prototypeTextureCount)
    expect(hasTexture(cssBlock(globalCSS, '.hc-app::after'))).toBe(false)
    expect(hasTexture(cssBlock(appLayout, '.hc-app__body::after'))).toBe(true)
  })

  it('keeps exactly one top radial glow across the rendered application shell', () => {
    const prototypeGlowCount = [
      cssBlock(prototype, '.mn-glow'),
      cssBlock(prototype, '.mn::before'),
    ].filter(hasTopGlow).length
    const implementationGlowCount = [
      cssBlock(globalCSS, '.hc-app__content::before'),
      cssBlock(globalCSS, '.hc-app__glow'),
      cssBlock(appLayout, '.hc-app__content::before'),
      cssBlock(appLayout, '.hc-app__glow'),
    ].filter(hasTopGlow).length

    expect(prototypeGlowCount).toBe(1)
    expect(implementationGlowCount).toBe(prototypeGlowCount)
  })

  it('keeps the approved glow visible when K12 hides only the shell texture', () => {
    expect(k12Presentation).not.toMatch(
      /:global\(body\[data-k12-skin-active='k12'\] \.hc-app__body::after\),\s*:global\(body\[data-k12-skin-active='k12'\] \.hc-app__glow\)\s*\{[^}]*opacity:\s*0/s,
    )
  })
})
