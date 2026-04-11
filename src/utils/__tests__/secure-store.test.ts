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

  // ─── 安全改进验证: 浏览器端 fail-closed ────────────────
  it('浏览器模式不再把敏感值持久化到 localStorage', async () => {
    const sourceCode = await import('../secure-store?raw')
    const raw = typeof sourceCode === 'string' ? sourceCode : sourceCode.default
    expect(raw).toContain('volatileBrowserStore')
    expect(raw).not.toContain("enc.encode('hexclaw-desktop')")
    expect(raw).not.toContain('DEVICE_SALT_KEY')
  })

  // ─── 功能测试: saveSecureValue + loadSecureValue 对称性 ──
  it('同一浏览器运行时内存储和读取应该对称', async () => {
    const { saveSecureValue, loadSecureValue } = await import('../secure-store')

    await saveSecureValue('test-key', 'my-secret-api-key')
    const value = await loadSecureValue('test-key')
    expect(value).toBe('my-secret-api-key')
    expect(localStorage.getItem('hc-sec-test-key')).toBeNull()
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
    expect(localStorage.getItem('hc-sec-corrupted')).toBeNull()
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

  // ─── 旧版浏览器持久化清理 ─────────────────────────
  it('检测到旧版 localStorage 持久化密文时会忽略并清理', async () => {
    const { loadSecureValue } = await import('../secure-store')

    localStorage.setItem('hc-sec-legacy-key', 'legacy-secret')
    const value = await loadSecureValue('legacy-key')
    expect(value).toBeNull()
    expect(localStorage.getItem('hc-sec-legacy-key')).toBeNull()
  })
})
