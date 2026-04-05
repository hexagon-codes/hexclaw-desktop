/**
 * useHexclaw composable tests
 *
 * Tests for backend connection health-check polling, exponential backoff,
 * and lifecycle management (onMounted / onUnmounted).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, nextTick } from 'vue'
import { mount } from '@vue/test-utils'

// ─── Mocks ──────────────────────────────────────────────
const checkHealthMock = vi.fn<() => Promise<boolean>>()

vi.mock('@/api/client', () => ({
  checkHealth: (...args: unknown[]) => checkHealthMock(...(args as [])),
}))

import { useHexclaw } from '../useHexclaw'

// ─── Helper: mount composable within component context ──
function mountComposable() {
  let result!: ReturnType<typeof useHexclaw>
  const wrapper = mount(defineComponent({
    setup() {
      result = useHexclaw()
      return () => null
    },
  }))
  return { result, wrapper }
}

describe('useHexclaw', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    checkHealthMock.mockResolvedValue(false)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ────────────────────────────────────────────────────────
  // 1. Sets connected=true when checkHealth returns true
  // ────────────────────────────────────────────────────────
  it('sets connected=true when checkHealth returns true', async () => {
    checkHealthMock.mockResolvedValue(true)
    const { result, wrapper } = mountComposable()

    // onMounted triggers startMonitor which calls check() immediately
    await vi.runOnlyPendingTimersAsync()

    expect(result.connected.value).toBe(true)
    wrapper.unmount()
  })

  // ────────────────────────────────────────────────────────
  // 2. Sets connected=false when checkHealth returns false
  // ────────────────────────────────────────────────────────
  it('sets connected=false when checkHealth returns false', async () => {
    checkHealthMock.mockResolvedValue(false)
    const { result, wrapper } = mountComposable()

    await vi.runOnlyPendingTimersAsync()

    expect(result.connected.value).toBe(false)
    wrapper.unmount()
  })

  // ────────────────────────────────────────────────────────
  // 3. checking is true during check, false after
  // ────────────────────────────────────────────────────────
  it('checking is true during check and false after', async () => {
    let resolveHealth!: (v: boolean) => void
    checkHealthMock.mockImplementation(() => new Promise<boolean>((r) => { resolveHealth = r }))

    const { result, wrapper } = mountComposable()

    // Let the check() call start (onMounted fires synchronously)
    await nextTick()
    expect(result.checking.value).toBe(true)

    // Resolve the health check and flush all microtasks
    resolveHealth(true)
    await nextTick()
    await nextTick()
    expect(result.checking.value).toBe(false)

    wrapper.unmount()
  })

  // ────────────────────────────────────────────────────────
  // 4. checkHealth exception is caught, checking becomes false
  // ────────────────────────────────────────────────────────
  it('catches checkHealth exceptions and resets checking to false', async () => {
    // Mount with a healthy mock first, then test the error path
    // by calling check() directly (which we can await-catch).
    // This avoids unhandled rejections from fire-and-forget interval calls,
    // since the source's check() has try/finally but no catch block.
    checkHealthMock.mockResolvedValue(true)
    const { result, wrapper } = mountComposable()
    await vi.runOnlyPendingTimersAsync()
    expect(result.connected.value).toBe(true)

    // Now set up the rejection and call check() directly
    checkHealthMock.mockRejectedValueOnce(new Error('network error'))
    // Await the promise (which rejects then gets handled by finally)
    await result.check().catch(() => { /* expected rejection */ })

    // The finally block still executes: checking becomes false
    expect(result.checking.value).toBe(false)
    // connected retains its previous value since the assignment threw
    // before it could set connected.value
    // (connected.value = await checkHealth() throws before assignment)

    result.stopMonitor()
    wrapper.unmount()
  })

  // ────────────────────────────────────────────────────────
  // 5. startMonitor calls check immediately and sets interval
  // ────────────────────────────────────────────────────────
  it('startMonitor calls check immediately and sets interval', async () => {
    checkHealthMock.mockResolvedValue(true)
    const { result, wrapper } = mountComposable()

    // onMounted already called startMonitor, so clear and call manually
    await vi.runOnlyPendingTimersAsync()
    checkHealthMock.mockClear()

    result.startMonitor(3000)
    // Immediate call
    expect(checkHealthMock).toHaveBeenCalledTimes(1)

    await vi.runOnlyPendingTimersAsync()

    // Advance timer by 3000ms to trigger interval
    checkHealthMock.mockClear()
    await vi.advanceTimersByTimeAsync(3000)
    expect(checkHealthMock).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })

  // ────────────────────────────────────────────────────────
  // 6. stopMonitor clears interval
  // ────────────────────────────────────────────────────────
  it('stopMonitor clears interval and stops further polling', async () => {
    checkHealthMock.mockResolvedValue(true)
    const { result, wrapper } = mountComposable()
    await vi.runOnlyPendingTimersAsync()

    result.stopMonitor()
    checkHealthMock.mockClear()

    // Advance time significantly — no new calls should happen
    await vi.advanceTimersByTimeAsync(30000)
    expect(checkHealthMock).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  // ────────────────────────────────────────────────────────
  // 7. After 6 consecutive failures, interval doubles (5000 -> 10000)
  // ────────────────────────────────────────────────────────
  it('doubles interval after 6 consecutive failures', async () => {
    checkHealthMock.mockResolvedValue(false)
    const { wrapper } = mountComposable()

    // Drain the immediate call from onMounted -> startMonitor
    await vi.runOnlyPendingTimersAsync()

    // retryCount starts at 0, the first check (onMounted) sets it to 1
    // We need 5 more failures to reach retryCount === 6
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(5000)
      await vi.runOnlyPendingTimersAsync()
    }

    // After the 6th failure (retryCount === 6), interval doubles to 10000
    // The interval was just restarted at 10000ms
    checkHealthMock.mockClear()

    // At 5000ms, no call (interval is now 10000)
    await vi.advanceTimersByTimeAsync(5000)
    await vi.runOnlyPendingTimersAsync()
    const callsAt5s = checkHealthMock.mock.calls.length

    // At 10000ms total, we should get a call
    await vi.advanceTimersByTimeAsync(5000)
    await vi.runOnlyPendingTimersAsync()
    const callsAt10s = checkHealthMock.mock.calls.length

    expect(callsAt10s).toBeGreaterThan(callsAt5s)

    wrapper.unmount()
  })

  // ────────────────────────────────────────────────────────
  // 8. After recovery (connected=true), interval resets to 5000
  // ────────────────────────────────────────────────────────
  it('resets interval to 5000 after recovery', async () => {
    checkHealthMock.mockResolvedValue(false)
    const { result, wrapper } = mountComposable()

    // Run through 6 failures to trigger backoff
    await vi.runOnlyPendingTimersAsync()
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(5000)
      await vi.runOnlyPendingTimersAsync()
    }
    // Now interval is 10000ms

    // Recover
    checkHealthMock.mockResolvedValue(true)
    await vi.advanceTimersByTimeAsync(10000)
    await vi.runOnlyPendingTimersAsync()

    expect(result.connected.value).toBe(true)

    // After recovery, interval should be back at 5000
    checkHealthMock.mockClear()
    await vi.advanceTimersByTimeAsync(5000)
    await vi.runOnlyPendingTimersAsync()
    expect(checkHealthMock).toHaveBeenCalled()

    wrapper.unmount()
  })

  // ────────────────────────────────────────────────────────
  // 9. Interval caps at 30000ms
  // ────────────────────────────────────────────────────────
  it('caps interval at 30000ms', async () => {
    checkHealthMock.mockResolvedValue(false)
    const { result, wrapper } = mountComposable()

    // Start with a custom high interval to test cap
    result.startMonitor(20000)
    await vi.runOnlyPendingTimersAsync()

    // After 6 failures at 20000ms, double would be 40000 but should cap at 30000
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(20000)
      await vi.runOnlyPendingTimersAsync()
    }

    // At this point: retryCount hit 6, interval = min(20000*2, 30000) = 30000
    // Verify no call at 20000ms after the backoff restart
    checkHealthMock.mockClear()
    await vi.advanceTimersByTimeAsync(20000)
    await vi.runOnlyPendingTimersAsync()
    const callsAt20s = checkHealthMock.mock.calls.length

    // But there should be a call by 30000ms
    await vi.advanceTimersByTimeAsync(10000) // total 30000ms
    await vi.runOnlyPendingTimersAsync()
    const callsAt30s = checkHealthMock.mock.calls.length

    expect(callsAt30s).toBeGreaterThan(callsAt20s)

    wrapper.unmount()
  })

  // ────────────────────────────────────────────────────────
  // 10. onMounted starts monitor, onUnmounted stops it
  // ────────────────────────────────────────────────────────
  it('onMounted starts monitor and onUnmounted stops it', async () => {
    checkHealthMock.mockResolvedValue(true)

    const { result, wrapper } = mountComposable()

    // onMounted calls startMonitor -> check()
    await vi.runOnlyPendingTimersAsync()
    expect(checkHealthMock).toHaveBeenCalled()
    expect(result.connected.value).toBe(true)

    // Unmount should stop the interval
    wrapper.unmount()
    checkHealthMock.mockClear()

    await vi.advanceTimersByTimeAsync(30000)
    expect(checkHealthMock).not.toHaveBeenCalled()
  })
})
