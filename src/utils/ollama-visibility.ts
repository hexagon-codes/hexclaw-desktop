export interface WaitForOllamaModelVisibilityOptions {
  sync: () => Promise<void>
  isVisible: () => boolean
  intervalMs?: number
  maxRetries?: number
  signal?: AbortSignal
}

function waitForDelay(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort)
      resolve(true)
    }, ms)

    function handleAbort() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', handleAbort)
      resolve(false)
    }

    signal?.addEventListener('abort', handleAbort, { once: true })
  })
}

export async function waitForOllamaModelVisibility({
  sync,
  isVisible,
  intervalMs = 1000,
  maxRetries = 4,
  signal,
}: WaitForOllamaModelVisibilityOptions): Promise<boolean> {
  await sync()
  if (isVisible()) return true

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const shouldContinue = await waitForDelay(intervalMs, signal)
    if (!shouldContinue) return false
    await sync()
    if (isVisible()) return true
  }

  return false
}
