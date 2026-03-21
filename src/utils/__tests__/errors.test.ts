import { describe, it, expect, vi } from 'vitest'
import {
  createApiError,
  fromHttpStatus,
  fromNativeError,
  trySafe,
  isRetryable,
  getErrorMessage,
} from '../errors'

describe('createApiError', () => {
  it('creates structured error', () => {
    const err = createApiError('NETWORK_ERROR', '网络不可达', undefined, new Error('fetch failed'))
    expect(err.code).toBe('NETWORK_ERROR')
    expect(err.message).toBe('网络不可达')
    expect(err.status).toBeUndefined()
    expect(err.cause).toBeInstanceOf(Error)
  })
})

describe('fromHttpStatus', () => {
  it('maps 401 to UNAUTHORIZED', () => {
    const err = fromHttpStatus(401)
    expect(err.code).toBe('UNAUTHORIZED')
    expect(err.status).toBe(401)
  })

  it('maps 403 to FORBIDDEN', () => {
    expect(fromHttpStatus(403).code).toBe('FORBIDDEN')
  })

  it('maps 404 to NOT_FOUND', () => {
    expect(fromHttpStatus(404).code).toBe('NOT_FOUND')
  })

  it('maps 422 to VALIDATION_ERROR', () => {
    expect(fromHttpStatus(422).code).toBe('VALIDATION_ERROR')
  })

  it('maps 429 to RATE_LIMITED', () => {
    expect(fromHttpStatus(429).code).toBe('RATE_LIMITED')
  })

  it('maps 500+ to SERVER_ERROR', () => {
    expect(fromHttpStatus(500).code).toBe('SERVER_ERROR')
    expect(fromHttpStatus(502).code).toBe('SERVER_ERROR')
    expect(fromHttpStatus(503).code).toBe('SERVER_ERROR')
  })

  it('uses server message when provided', () => {
    const err = fromHttpStatus(500, 'database timeout')
    expect(err.message).toBe('database timeout')
  })

  it('maps unknown status to UNKNOWN', () => {
    const err = fromHttpStatus(418)
    expect(err.code).toBe('UNKNOWN')
    expect(err.status).toBe(418)
  })
})

describe('fromNativeError', () => {
  it('detects TypeError with fetch as NETWORK_ERROR', () => {
    const err = fromNativeError(new TypeError('Failed to fetch'))
    expect(err.code).toBe('NETWORK_ERROR')
  })

  it('detects AbortError as TIMEOUT', () => {
    const abort = new DOMException('signal aborted', 'AbortError')
    const err = fromNativeError(abort)
    expect(err.code).toBe('TIMEOUT')
  })

  it('handles plain Error', () => {
    const err = fromNativeError(new Error('something broke'))
    expect(err.code).toBe('UNKNOWN')
    expect(err.message).toBe('something broke')
  })

  it('handles non-Error values', () => {
    const err = fromNativeError('string error')
    expect(err.code).toBe('UNKNOWN')
    expect(err.message).toBe('string error')
  })

  it('extracts status from FetchError-like objects', () => {
    const fetchErr = Object.assign(new Error('Not Found'), { status: 404 })
    const err = fromNativeError(fetchErr)
    expect(err.code).toBe('NOT_FOUND')
    expect(err.status).toBe(404)
  })
})

describe('trySafe', () => {
  it('returns [data, null] on success', async () => {
    const [data, err] = await trySafe(() => Promise.resolve(42))
    expect(data).toBe(42)
    expect(err).toBeNull()
  })

  it('returns [null, error] on failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const [data, err] = await trySafe(() => Promise.reject(new Error('fail')))
    expect(data).toBeNull()
    expect(err).not.toBeNull()
    expect(err!.code).toBe('UNKNOWN')
    expect(err!.message).toBe('fail')
  })
})

describe('isRetryable', () => {
  it('returns true for retryable codes', () => {
    expect(isRetryable(createApiError('NETWORK_ERROR', ''))).toBe(true)
    expect(isRetryable(createApiError('TIMEOUT', ''))).toBe(true)
    expect(isRetryable(createApiError('SERVER_ERROR', ''))).toBe(true)
    expect(isRetryable(createApiError('RATE_LIMITED', ''))).toBe(true)
  })

  it('returns false for non-retryable codes', () => {
    expect(isRetryable(createApiError('NOT_FOUND', ''))).toBe(false)
    expect(isRetryable(createApiError('UNAUTHORIZED', ''))).toBe(false)
    expect(isRetryable(createApiError('VALIDATION_ERROR', ''))).toBe(false)
  })
})

describe('getErrorMessage', () => {
  it('returns the error message', () => {
    const err = createApiError('NETWORK_ERROR', '服务不可达')
    expect(getErrorMessage(err)).toBe('服务不可达')
  })
})
