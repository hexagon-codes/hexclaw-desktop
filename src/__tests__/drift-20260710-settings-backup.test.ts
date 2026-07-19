/**
 * 2026-07-19 IA 收敛：学习档案拥有导出与备份；系统设置不得再次按孩子注入备份。
 * 系统设置不暴露应用数据目录；目录生命周期仅由应用内部管理。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '..')
const read = (relative: string) => fs.readFileSync(path.join(SRC, relative), 'utf8')

describe('K12 导出、备份与系统设置边界', () => {
  it('K12 场景不再向系统设置注入家庭学习档案备份', () => {
    const register = read('features/k12/register.ts')
    const settings = read('views/SettingsView.vue')

    expect(register).not.toContain('K12SettingsBackup')
    expect(register).not.toContain('registerSettingsExtension')
    expect(settings).not.toContain('scenarioRegistry.settingsExtension')
    expect(fs.existsSync(path.join(SRC, 'features/k12/views/K12SettingsBackup.vue'))).toBe(false)
  })

  it('系统设置不提供高级诊断或应用数据定位入口', () => {
    const settings = read('views/SettingsView.vue')

    expect(settings).not.toContain('data-testid="settings-app-data"')
    expect(settings).not.toContain("t('settings.diagnostics.")
    expect(settings).not.toContain('revealAppDataDirectory')
    expect(settings).not.toContain('data-testid="settings-data-dir"')
    expect(settings).not.toContain("t('settings.backup.title')")
  })

  it('桌面端不保留目录定位适配器及其专用 opener 权限', () => {
    const pkg = read('../package.json')
    const cargo = read('../src-tauri/Cargo.toml')
    const lib = read('../src-tauri/src/lib.rs')
    const capabilities = read('../src-tauri/capabilities/default.json')

    expect(fs.existsSync(path.join(SRC, 'utils/data-directory.ts'))).toBe(false)
    expect(fs.existsSync(path.join(SRC, 'utils/__tests__/data-directory.test.ts'))).toBe(false)
    expect(pkg).not.toContain('@tauri-apps/plugin-opener')
    expect(cargo).not.toContain('tauri-plugin-opener')
    expect(lib).not.toContain('tauri_plugin_opener::init()')
    expect(capabilities).not.toContain('opener:allow-reveal-item-in-dir')
  })
})
