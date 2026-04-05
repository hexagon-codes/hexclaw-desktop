import { describe, it, expect, vi, afterEach } from 'vitest'
import { waitForOllamaModelVisibility } from '../ollama-visibility'

describe('waitForOllamaModelVisibility', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries sync until the target model becomes visible', async () => {
    vi.useFakeTimers()

    let visible = false
    const sync = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {
        visible = true
      })

    const waiting = waitForOllamaModelVisibility({
      sync,
      isVisible: () => visible,
      intervalMs: 1000,
      maxRetries: 2,
    })

    await vi.advanceTimersByTimeAsync(1000)

    await expect(waiting).resolves.toBe(true)
    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('stops retrying when the abort signal is cancelled', async () => {
    vi.useFakeTimers()

    const controller = new AbortController()
    const sync = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

    const waiting = waitForOllamaModelVisibility({
      sync,
      isVisible: () => false,
      intervalMs: 1000,
      maxRetries: 4,
      signal: controller.signal,
    })

    controller.abort()
    await vi.advanceTimersByTimeAsync(1000)

    await expect(waiting).resolves.toBe(false)
    expect(sync).toHaveBeenCalledTimes(1)
  })
})
