/**
 * secure-store 安全性和正确性测试
 *
 * 验证加密存储的安全性、边界情况、降级行为
 */
import { describe, it, expect, beforeEach } from 'vitest'

describe('secure-store', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  // ─── 安全改进验证: 设备专属随机 salt ────────────────
  it('使用设备专属随机 salt（不再硬编码）', async () => {
    const sourceCode = await import('../secure-store?raw')
    const raw = typeof sourceCode === 'string' ? sourceCode : sourceCode.default
    // 不应再包含旧的硬编码 salt
    expect(raw).not.toContain("const APP_SALT = 'hexclaw-desktop-2026'")
    expect(raw).not.toContain("enc.encode('hexclaw-salt')")
    // 应使用 getDeviceSalt 生成随机 salt
    expect(raw).toContain('getDeviceSalt')
    expect(raw).toContain('crypto.getRandomValues')
  })

  // ─── 功能测试: saveSecureValue + loadSecureValue 对称性 ──
  it('存储和读取应该对称（非 Tauri 环境，走 localStorage 降级）', async () => {
    const { saveSecureValue, loadSecureValue } = await import('../secure-store')

    await saveSecureValue('test-key', 'my-secret-api-key')
    const value = await loadSecureValue('test-key')
    expect(value).toBe('my-secret-api-key')
  })

  // ─── 边界情况: 空值处理 ─────────────────────────────
  it('保存空字符串应该正常工作', async () => {
    const { saveSecureValue, loadSecureValue } = await import('../secure-store')

    await saveSecureValue('empty-key', '')
    const value = await loadSecureValue('empty-key')
    expect(value).toBe('')
  })

  // ─── 边界情况: 读取不存在的 key ─────────────────────
  it('读取不存在的 key 应返回 null', async () => {
    const { loadSecureValue } = await import('../secure-store')

    const value = await loadSecureValue('nonexistent-key')
    expect(value).toBeNull()
  })

  // ─── 边界情况: 损坏数据处理 ─────────────────────────
  it('localStorage 中存在损坏数据时应返回 null 而不是抛异常', async () => {
    const { loadSecureValue } = await import('../secure-store')

    localStorage.setItem('hc-sec-corrupted', 'not-valid-base64!!!')
    const value = await loadSecureValue('corrupted')
    expect(value).toBeNull()
  })

  // ─── 删除测试 ──────────────────────────────────────
  it('removeSecureValue 应该正确删除', async () => {
    const { saveSecureValue, loadSecureValue, removeSecureValue } = await import('../secure-store')

    await saveSecureValue('del-test', 'value')
    await removeSecureValue('del-test')
    const value = await loadSecureValue('del-test')
    expect(value).toBeNull()
  })

  // ─── 特殊字符处理 ─────────────────────────────────
  it('应正确处理包含特殊字符的值', async () => {
    const { saveSecureValue, loadSecureValue } = await import('../secure-store')
    const specialValue = '密钥=sk-abc123!@#$%^&*()_+🔑\n\t'

    await saveSecureValue('special', specialValue)
    const value = await loadSecureValue('special')
    expect(value).toBe(specialValue)
  })

  // ─── 设备 salt 持久化测试 ─────────────────────────
  it('设备 salt 应只生成一次并持久化', async () => {
    // 动态导入确保在当前 localStorage 状态下执行
    // 注意：模块可能被缓存，salt 来自之前的 localStorage
    const { saveSecureValue } = await import('../secure-store')

    // 存储后应该有 salt
    await saveSecureValue('salt-test-key', 'value1')
    const salt1 = localStorage.getItem('hc-device-salt')
    expect(salt1).toBeTruthy()

    // 同一模块实例内再次存储应使用相同 salt
    await saveSecureValue('salt-test-key2', 'value2')
    const salt2 = localStorage.getItem('hc-device-salt')
    expect(salt2).toBe(salt1)
  })
})
