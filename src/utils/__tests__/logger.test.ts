import { describe, it, expect, vi, beforeEach } from 'vitest'
import { logger } from '../logger'

describe('logger', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('has debug/info/warn/error methods', () => {
    expect(typeof logger.debug).toBe('function')
    expect(typeof logger.info).toBe('function')
    expect(typeof logger.warn).toBe('function')
    expect(typeof logger.error).toBe('function')
  })

  it('error logs to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logger.error('test error')
    expect(spy).toHaveBeenCalled()
    expect(spy.mock.calls[0]![0]).toContain('ERROR')
    expect(spy.mock.calls[0]![0]).toContain('test error')
  })

  it('warn logs to console.warn', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logger.warn('test warning')
    expect(spy).toHaveBeenCalled()
    expect(spy.mock.calls[0]![0]).toContain('WARN')
  })

  it('log message includes timestamp format HH:mm:ss.SSS', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logger.error('timestamp test')
    const msg = spy.mock.calls[0]![0] as string
    // 格式: [HH:mm:ss.SSS] [ERROR] timestamp test
    expect(msg).toMatch(/\[\d{2}:\d{2}:\d{2}\.\d{3}\]/)
  })

  it('passes extra arguments', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const extra = { key: 'value' }
    logger.error('with extra', extra)
    expect(spy).toHaveBeenCalledWith(expect.any(String), extra)
  })
})
