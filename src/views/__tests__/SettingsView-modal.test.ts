/**
 * SettingsView — Edit Model Dialog Tests
 *
 * Verifies the edit-model overlay implementation uses native Teleport + div
 * instead of NModal, and has correct accessibility attributes.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const SETTINGS_VIEW_PATH = path.resolve(__dirname, '../SettingsView.vue')
const source = fs.readFileSync(SETTINGS_VIEW_PATH, 'utf-8')

describe('SettingsView — edit model dialog', () => {
  it('editModelOverlayRef exists as a template ref', () => {
    // Script: ref declaration
    expect(source).toContain('editModelOverlayRef')
    expect(source).toMatch(/const editModelOverlayRef\s*=\s*ref/)
  })

  it('Dialog uses Teleport to="body" (not inline NModal)', () => {
    expect(source).toContain('<Teleport to="body">')
  })

  it('NModal is NOT imported (was removed in favor of native Teleport)', () => {
    // Check the import section for NModal
    expect(source).not.toMatch(/import\s+.*\bNModal\b.*from\s+['"]naive-ui['"]/)
    expect(source).not.toContain('<NModal')
    expect(source).not.toContain('<n-modal')
  })

  it('Dialog overlay has tabindex="-1" for ESC key support', () => {
    expect(source).toContain('tabindex="-1"')
  })

  it('editModelOverlayRef receives focus when dialog opens', () => {
    // The watch should call focus() on the overlay
    expect(source).toMatch(/editModelOverlayRef\.value\?\.focus\(\)/)
  })

  it('ref="editModelOverlayRef" is used in the template', () => {
    expect(source).toContain('ref="editModelOverlayRef"')
  })
})
