import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  tauri: false,
  invoke: vi.fn(),
}))

vi.mock('@/utils/platform', () => ({ isTauri: () => native.tauri }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => native.invoke(...args),
}))

const connectionKey = {
  ownerKind: 'connection' as const,
  ownerId: 'connector-001',
  secretKind: 'token' as const,
}
const providerKey = {
  ownerKind: 'provider' as const,
  ownerId: 'pvd_v1_00112233445566778899aabbccddeeff',
  secretKind: 'api_key' as const,
}

describe('secure-store write-only renderer boundary', () => {
  beforeEach(() => {
    native.tauri = false
    native.invoke.mockReset()
    localStorage.clear()
  })

  it('contains no renderer persistence or vault read API', async () => {
    const sourceCode = await import('../secure-store?raw')
    const raw = typeof sourceCode === 'string' ? sourceCode : sourceCode.default
    const api = await import('../secure-store')

    expect(raw).toContain('browserSessionVault')
    expect(raw).not.toContain('localStorage')
    expect(raw).not.toContain('get_credential')
    expect(raw).not.toContain('read_credential')
    expect(api).not.toHaveProperty('getCredential')
  })

  it('browser fallback exposes only typed presence and deletes process memory', async () => {
    const { credentialPresent, deleteCredential, putCredential } = await import('../secure-store')

    await expect(putCredential(connectionKey, 'session-secret')).resolves.toEqual({
      credentialRef: 'hexclaw-vault:v1:connection:connector-001:token',
      updated: true,
    })
    await expect(credentialPresent(connectionKey)).resolves.toBe(true)
    await expect(deleteCredential(connectionKey)).resolves.toMatchObject({ updated: true })
    await expect(credentialPresent(connectionKey)).resolves.toBe(false)
    expect(localStorage.length).toBe(0)
  })

  it('forbids standalone provider writes and deletes before native IPC', async () => {
    const { deleteCredential, putCredential } = await import('../secure-store')

    await expect(putCredential(providerKey, 'sk-live')).rejects.toThrow('native config coordinator')
    await expect(deleteCredential(providerKey)).rejects.toThrow('native config coordinator')
    expect(native.invoke).not.toHaveBeenCalled()
  })

  it('forbids provider presence checks before browser or native vault access', async () => {
    const { credentialPresent } = await import('../secure-store')

    await expect(credentialPresent(providerKey)).rejects.toThrow('native config coordinator')

    native.tauri = true
    await expect(credentialPresent(providerKey)).rejects.toThrow('native config coordinator')
    expect(native.invoke).not.toHaveBeenCalled()
  })

  it('Tauri connection mutations use typed owner keys and return opaque refs', async () => {
    native.tauri = true
    native.invoke
      .mockResolvedValueOnce({
        credentialRef: 'hexclaw-vault:v1:connection:connector-001:token',
        updated: true,
      })
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce({
        credentialRef: 'hexclaw-vault:v1:connection:connector-001:token',
        updated: true,
      })
    const { credentialPresent, deleteCredential, putCredential } = await import('../secure-store')

    await putCredential(connectionKey, '密钥=token-abc123')
    await expect(credentialPresent(connectionKey)).resolves.toBe(true)
    await deleteCredential(connectionKey)

    expect(native.invoke.mock.calls).toEqual([
      ['put_credential', { key: connectionKey, secret: '密钥=token-abc123' }],
      ['credential_present', { key: connectionKey }],
      ['delete_credential', { key: connectionKey }],
    ])
  })

  it('derives canonical provider and connection references without aliasing', async () => {
    const { credentialRefFor } = await import('../secure-store')

    expect(credentialRefFor(providerKey)).toBe(
      'llm_provider/pvd_v1_00112233445566778899aabbccddeeff/api_key',
    )
    expect(credentialRefFor(connectionKey)).toBe('hexclaw-vault:v1:connection:connector-001:token')
    expect(() => credentialRefFor({ ...providerKey, ownerId: '../provider' })).toThrow('identity')
  })
})
