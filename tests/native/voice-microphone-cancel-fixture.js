/**
 * 物理麦克风/TCC 取消边界驱动。
 *
 * 包装并调用 WebView 原生 getUserMedia，只观察授权与音轨生命周期；录音随后立即由
 * Composer 左侧 X 丢弃，不读取音频字节、不落盘，也不进入 STT 或发送链路。
 */
;(function runPhysicalMicrophoneCancelBoundary() {
  'use strict'

  const fixtureOrigin = '__HEX_VOICE_FIXTURE_ORIGIN__'
  const capture = {
    calls: 0,
    resolved: 0,
    denied: 0,
    error: '',
    stream: null,
  }
  let installedMediaDevices = null
  let installedGetUserMedia = null

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  function invariant(condition, message) {
    if (!condition) throw new Error(message)
  }

  async function waitFor(read, label, timeout = 30_000, interval = 80) {
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
    return response.json()
  }

  async function stats() {
    return json('/__voice_boundary__/stats')
  }

  async function progress(stage) {
    await json('/__voice_boundary__/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage }),
    })
  }

  function button(selector) {
    const element = document.querySelector(selector)
    if (!(element instanceof HTMLButtonElement) || element.disabled) return null
    return element
  }

  function canonicalDraft() {
    const editor = document.querySelector('[data-testid="chat-input"]')
    return editor instanceof HTMLElement ? editor.dataset.canonicalSource || '' : ''
  }

  async function observeNativeMicrophone() {
    const mediaDevices = navigator.mediaDevices
    invariant(mediaDevices, 'navigator.mediaDevices is unavailable')
    invariant(typeof mediaDevices.getUserMedia === 'function', 'Native getUserMedia is unavailable')

    const nativeGetUserMediaSource = Function.prototype.toString.call(mediaDevices.getUserMedia)
    const nativeGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices)
    const observedGetUserMedia = async (constraints) => {
      invariant(Boolean(constraints?.audio), 'Voice capture must request microphone audio')
      capture.calls += 1
      await progress('physical-get-user-media-requested')
      try {
        const stream = await nativeGetUserMedia(constraints)
        capture.resolved += 1
        capture.stream = stream
        await progress('physical-get-user-media-resolved')
        return stream
      } catch (error) {
        capture.denied += 1
        capture.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        await progress('physical-get-user-media-rejected')
        throw error
      }
    }

    try {
      Object.defineProperty(mediaDevices, 'getUserMedia', {
        configurable: true,
        value: observedGetUserMedia,
      })
    } catch {
      mediaDevices.getUserMedia = observedGetUserMedia
    }
    if (navigator.mediaDevices !== mediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: mediaDevices,
      })
    }

    // WKWebView 可能暴露不完整的 Web Speech；本门只验证产品既有 MediaRecorder 兜底。
    window.SpeechRecognition = undefined
    window.webkitSpeechRecognition = undefined
    installedMediaDevices = mediaDevices
    installedGetUserMedia = observedGetUserMedia

    return {
      constructor: window.MediaRecorder?.name || '',
      nativeMediaRecorder: /\[native code\]/.test(
        Function.prototype.toString.call(window.MediaRecorder),
      ),
      nativeGetUserMedia: /\[native code\]/.test(nativeGetUserMediaSource),
    }
  }

  function assertCapturePathPreflight() {
    invariant(
      navigator.mediaDevices === installedMediaDevices,
      'Installed MediaDevices instance was replaced before user action',
    )
    invariant(
      navigator.mediaDevices.getUserMedia === installedGetUserMedia,
      'Installed getUserMedia observer was replaced before user action',
    )
    invariant(
      window.SpeechRecognition === undefined && window.webkitSpeechRecognition === undefined,
      'Web Speech must remain disabled for the MediaRecorder boundary',
    )
    invariant(
      typeof window.MediaRecorder === 'function',
      'Native MediaRecorder became unavailable before user action',
    )
  }

  async function execute() {
    sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    invariant(typeof window.MediaRecorder === 'function', 'Native MediaRecorder is unavailable')
    const nativeSource = await observeNativeMicrophone()
    await progress('physical-fixture-ready')

    await waitFor(() => button('[data-testid="chat-voice-start"]'), 'enabled voice start button')
    await progress('physical-start-ready')
    await sleep(1_000)
    invariant(
      capture.calls === 0,
      'Microphone must not be requested before the user starts recording',
    )
    const before = await stats()
    const currentStart = await waitFor(
      () => button('[data-testid="chat-voice-start"]'),
      'current enabled voice start button',
    )
    invariant(currentStart.isConnected, 'Current voice start button must remain connected')
    invariant(
      currentStart === document.querySelector('[data-testid="chat-voice-start"]'),
      'Current voice start button must match the active selector',
    )
    assertCapturePathPreflight()
    await progress('physical-capture-path-preflight')

    await progress('physical-start-clicking')
    currentStart.click()
    await progress('physical-start-clicked')
    await waitFor(
      () => document.querySelector('[data-testid="chat-voice-panel"]'),
      'voice recording panel',
    )
    await progress('physical-panel-visible')
    await waitFor(
      () => capture.resolved === 1 || capture.denied === 1,
      'physical microphone authorization',
      120_000,
    )
    invariant(capture.denied === 0, capture.error || 'Physical microphone permission was denied')
    invariant(capture.calls === 1, 'Expected one native getUserMedia request')
    invariant(capture.resolved === 1, 'Native getUserMedia did not resolve')

    const tracks = capture.stream?.getAudioTracks() || []
    invariant(tracks.length > 0, 'Native getUserMedia returned no audio track')
    await waitFor(
      () => tracks.every((track) => track.readyState === 'live'),
      'live physical microphone track',
    )
    await sleep(350)

    const cancel = await waitFor(
      () => button('[data-testid="chat-voice-cancel"]'),
      'enabled voice cancel button',
    )
    cancel.click()
    await waitFor(
      () => !document.querySelector('[data-testid="chat-voice-panel"]'),
      'cancelled voice panel to close',
    )
    await waitFor(
      () => tracks.every((track) => track.readyState === 'ended'),
      'physical microphone tracks to stop',
    )
    await sleep(750)

    const after = await stats()
    const sttDelta = after.sttRequests - before.sttRequests
    const chatDelta = after.chatRequests - before.chatRequests
    invariant(sttDelta === 0, 'X discard must not invoke STT')
    invariant(chatDelta === 0, 'X discard must not invoke voice send')
    invariant(
      after.audioBytes.length === before.audioBytes.length,
      'X discard must not upload audio',
    )
    invariant(canonicalDraft() === '', 'X discard must not fill the Composer draft')
    await progress('physical-cancel-verified')

    return {
      status: 'PASS',
      source: {
        ...nativeSource,
        realGetUserMedia: true,
        syntheticGetUserMedia: false,
        realMicrophonePermissionCovered: true,
        audioBytesReadByFixture: 0,
      },
      scenario: {
        name: 'physical-cancel',
        status: 'PASS',
        requestedBeforeUserAction: 0,
        getUserMediaCalls: capture.calls,
        audioTracks: tracks.length,
        tracksStopped: tracks.every((track) => track.readyState === 'ended'),
        sttDelta,
        chatDelta,
        audioUploadDelta: after.audioBytes.length - before.audioBytes.length,
        draft: canonicalDraft(),
      },
      receipts: after,
    }
  }

  async function complete() {
    let report
    try {
      report = await execute()
    } catch (error) {
      report = {
        status: 'FAIL',
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        source: {
          realGetUserMedia: capture.resolved > 0,
          syntheticGetUserMedia: false,
          realMicrophonePermissionCovered: capture.resolved > 0,
          audioBytesReadByFixture: 0,
        },
        capture: {
          calls: capture.calls,
          resolved: capture.resolved,
          denied: capture.denied,
        },
      }
    }

    try {
      await progress('physical-reporting-complete')
      await json('/__voice_boundary__/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report),
      })
    } catch (error) {
      document.documentElement.dataset.voiceBoundaryReportError =
        error instanceof Error ? error.message : String(error)
    }
  }

  void complete()
})()
