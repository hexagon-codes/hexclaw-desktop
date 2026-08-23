/**
 * BUG-20260802-017 原生 WebView 驱动。
 *
 * 仅通过既有 Composer DOM 发起一次普通聊天；传输、60 秒 idle、错误投影和
 * 重启恢复全部继续走生产实现。夹具只向隔离 loopback 控制器回传脱敏事件。
 */
;(function runBug017ChunkIdleBoundary() {
  'use strict'

  const fixtureOrigin = '__HEX_BUG017_FIXTURE_ORIGIN__'
  const userMarker = 'BUG017_CURRENT_SOURCE_CHUNK_IDLE_USER'
  const partialMarker = 'BUG017_CURRENT_SOURCE_PARTIAL'
  const lateMarker = 'BUG017_CURRENT_SOURCE_LATE_SUCCESS'
  const errorText = 'WebSocket transport unavailable; retry will resume with the same request id'
  const startedAt = Date.now()

  sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  history.replaceState({}, '', '/chat')

  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

  function invariant(condition, message) {
    if (!condition) throw new Error(message)
  }

  async function waitFor(read, label, timeout = 30_000, interval = 100) {
    const deadline = Date.now() + timeout
    let lastError = null
    while (Date.now() < deadline) {
      try {
        const value = await read()
        if (value) return value
      } catch (error) {
        lastError = error
      }
      await sleep(interval)
    }
    const suffix = lastError instanceof Error ? `: ${lastError.message}` : ''
    throw new Error(`Timed out waiting for ${label}${suffix}`)
  }

  async function json(path, init) {
    const response = await fetch(`${fixtureOrigin}${path}`, {
      cache: 'no-store',
      ...init,
    })
    if (!response.ok) throw new Error(`Fixture request failed: ${response.status} ${path}`)
    if (response.status === 204) return null
    return response.json()
  }

  async function progress(stage, detail) {
    await json('/__bug017__/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage, elapsed_ms: Date.now() - startedAt, detail }),
    })
  }

  function messageSnapshot() {
    const assistants = [...document.querySelectorAll('[data-testid="chat-message-assistant"]')]
      .map((element) => element.textContent?.trim() || '')
      .filter(Boolean)
    const users = [...document.querySelectorAll('[data-testid="chat-message-user"]')]
      .map((element) => element.textContent?.trim() || '')
      .filter(Boolean)
    return {
      location: window.location.href,
      user_count: users.length,
      assistant_count: assistants.length,
      user_marker_count: users.filter((text) => text.includes(userMarker)).length,
      error_assistant_count: assistants.filter((text) => text.includes(errorText)).length,
      partial_assistant_count: assistants.filter((text) => text.includes(partialMarker)).length,
      late_success_count: assistants.filter((text) => text.includes(lateMarker)).length,
      assistant_texts: assistants.map((text) => text.slice(0, 240)),
    }
  }

  function enabledButton(selector) {
    const button = document.querySelector(selector)
    return button instanceof HTMLButtonElement && !button.disabled ? button : null
  }

  function setComposerText(editor, value) {
    invariant(editor instanceof HTMLElement, 'Chat Composer editor is unavailable')
    editor.focus()
    editor.replaceChildren(document.createTextNode(value))
    editor.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }),
    )
  }

  async function executeInitial() {
    const editor = await waitFor(
      () => document.querySelector('[data-testid="chat-input"]'),
      'production Chat Composer',
      45_000,
    )
    setComposerText(editor, userMarker)
    await waitFor(
      () => editor.dataset.canonicalSource === userMarker,
      'canonical Composer source',
    )
    const send = await waitFor(
      () => enabledButton('[data-testid="chat-send"]'),
      'enabled production send button',
    )
    await progress('send-ready', messageSnapshot())
    send.click()
    await progress('send-clicked', messageSnapshot())

    await waitFor(
      () => document.body.textContent?.includes(partialMarker),
      'first streamed chunk',
      30_000,
    )
    const partialAt = Date.now()
    await progress('partial-visible', messageSnapshot())

    await waitFor(
      () => document.body.textContent?.includes(errorText),
      '60 second chunk-idle error projection',
      72_000,
    )
    const errorAt = Date.now()
    const errorElapsedMs = errorAt - partialAt
    await progress('error-visible', {
      error_elapsed_from_partial_ms: errorElapsedMs,
      messages: messageSnapshot(),
    })

    invariant(errorElapsedMs >= 59_000, 'Chunk-idle error fired before the 60 second boundary')
    invariant(errorElapsedMs <= 66_000, 'Chunk-idle error fired too late for the 60 second boundary')
    invariant(messageSnapshot().error_assistant_count === 1, 'Expected one visible transport error')

    await waitFor(async () => {
      const stats = await json('/__bug017__/stats')
      return stats.provider_released ? stats : null
    }, 'held late terminal release', 15_000)
    await sleep(500)

    const afterRelease = messageSnapshot()
    invariant(afterRelease.error_assistant_count === 1, 'Late release changed the error exact-set')
    invariant(afterRelease.late_success_count === 0, 'Late success became visible after cancel')

    return {
      status: 'PASS',
      phase: 'initial',
      error_elapsed_from_partial_ms: errorElapsedMs,
      after_release: afterRelease,
    }
  }

  async function executeRestart() {
    await waitFor(
      () => document.body.textContent?.includes(errorText),
      'persisted chunk-idle error after App and Sidecar restart',
      45_000,
    )
    const snapshot = messageSnapshot()
    invariant(snapshot.user_marker_count === 1, 'Restart did not restore the unique user message')
    invariant(snapshot.error_assistant_count === 1, 'Restart did not restore one error assistant')
    invariant(snapshot.late_success_count === 0, 'Restart restored a forbidden late success')
    await progress('restart-visible', snapshot)
    return { status: 'PASS', phase: 'restart', messages: snapshot }
  }

  async function execute() {
    if (document.readyState === 'loading') {
      await new Promise((resolve) => window.addEventListener('DOMContentLoaded', resolve, { once: true }))
    }
    const mode = await json('/__bug017__/mode')
    await progress('fixture-ready', {
      phase: mode.phase,
      title: document.title,
      tauri: Boolean(globalThis.isTauri),
    })
    if (mode.phase === 'initial') return executeInitial()
    invariant(mode.phase === 'restart', 'Unexpected WebView fixture phase')
    return executeRestart()
  }

  window.addEventListener('error', (event) => {
    void progress('runtime-error', {
      message: event.error instanceof Error ? event.error.message : String(event.message || event.error),
    })
  })
  window.addEventListener('unhandledrejection', (event) => {
    void progress('runtime-rejection', {
      message: event.reason instanceof Error ? event.reason.message : String(event.reason),
    })
  })

  void execute()
    .then((report) => json('/__bug017__/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    }))
    .catch(async (error) => {
      const mode = await json('/__bug017__/current-phase').catch(() => ({ phase: 'unknown' }))
      await json('/__bug017__/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'FAIL',
          phase: mode.phase,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          messages: messageSnapshot(),
        }),
      }).catch(() => {})
    })
})()
