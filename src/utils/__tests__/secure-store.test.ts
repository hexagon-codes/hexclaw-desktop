import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

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

    expect(raw).toContain('Sidecar secret coordinator')
    expect(raw).toContain('sidecar-connection:v1:')
    expect(raw).not.toContain('hexclaw-vault:v1:')
    expect(raw).not.toContain('localStorage')
    expect(raw).not.toContain('get_credential')
    expect(raw).not.toContain('read_credential')
    expect(api).not.toHaveProperty('getCredential')
  })

  it('rejects standalone connection mutations instead of using a renderer vault', async () => {
    const { credentialPresent, deleteCredential, putCredential } = await import('../secure-store')

    await expect(putCredential(connectionKey, 'session-secret')).rejects.toThrow('Sidecar secret coordinator')
    await expect(credentialPresent(connectionKey)).rejects.toThrow('Sidecar secret coordinator')
    await expect(deleteCredential(connectionKey)).rejects.toThrow('Sidecar secret coordinator')
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

  it('Tauri connection mutations never reach the retired OS vault commands', async () => {
    native.tauri = true
    const { credentialPresent, deleteCredential, putCredential } = await import('../secure-store')

    await expect(putCredential(connectionKey, '密钥=token-abc123')).rejects.toThrow('Sidecar secret coordinator')
    await expect(credentialPresent(connectionKey)).rejects.toThrow('Sidecar secret coordinator')
    await expect(deleteCredential(connectionKey)).rejects.toThrow('Sidecar secret coordinator')
    expect(native.invoke).not.toHaveBeenCalled()
  })

  it('does not register the retired Connection vault commands in Tauri', () => {
    const libSource = readFileSync('src-tauri/src/lib.rs', 'utf8')
    expect(libSource).not.toContain('pub mod credential_vault')
    expect(libSource).not.toContain('credential_vault::put_credential')
    expect(libSource).not.toContain('credential_vault::delete_credential')
    expect(libSource).not.toContain('credential_vault::credential_present')
  })

  it('derives canonical provider and connection references without aliasing', async () => {
    const { credentialRefFor } = await import('../secure-store')

    expect(credentialRefFor(providerKey)).toBe(
      'llm_provider/pvd_v1_00112233445566778899aabbccddeeff/api_key',
    )
    expect(credentialRefFor(connectionKey)).toBe('sidecar-connection:v1:connector-001:token')
    expect(() => credentialRefFor({ ...providerKey, ownerId: '../provider' })).toThrow('identity')
  })
})
