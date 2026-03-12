import { describe, it, expect } from 'vitest'
import { env } from '../env'

describe('env config', () => {
  it('has required properties', () => {
    expect(env).toHaveProperty('apiBase')
    expect(env).toHaveProperty('wsBase')
    expect(env).toHaveProperty('isDev')
    expect(env).toHaveProperty('timeout')
    expect(env).toHaveProperty('logLevel')
  })

  it('apiBase is a valid URL string', () => {
    expect(env.apiBase).toMatch(/^https?:\/\//)
  })

  it('wsBase is a valid WebSocket URL', () => {
    expect(env.wsBase).toMatch(/^wss?:\/\//)
  })

  it('timeout is a positive number', () => {
    expect(env.timeout).toBeGreaterThan(0)
  })

  it('logLevel is a valid level', () => {
    expect(['debug', 'info', 'warn', 'error']).toContain(env.logLevel)
  })

  it('config is frozen (immutable)', () => {
    expect(Object.isFrozen(env)).toBe(true)
  })
})
