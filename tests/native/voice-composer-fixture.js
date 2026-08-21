/**
 * 原生 Voice Composer 边界驱动。
 *
 * 只替换麦克风采集源：WebAudio 在内存中生成音轨；MediaRecorder、Tauri IPC、
 * Sidecar STT 与聊天发送均继续走应用真实实现。合成音轨不会接到扬声器或写入磁盘。
 */
;(function runVoiceComposerBoundary() {
  'use strict'

  const fixtureOrigin = '__HEX_VOICE_FIXTURE_ORIGIN__'
  const syntheticState = {
    getUserMediaCalls: 0,
    audioTracksCreated: 0,
    contexts: [],
  }

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

  async function progress(stage, detail) {
    const payload = { stage }
    if (detail !== undefined) payload.detail = detail
    await json('/__voice_boundary__/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }

  function runtimeSnapshot() {
    const start = document.querySelector('[data-testid="chat-voice-start"]')
    return {
      location: window.location.href,
      readyState: document.readyState,
      title: document.title,
      bodyText: document.body?.textContent?.trim().slice(0, 500) || '',
      voiceStartCount: document.querySelectorAll('[data-testid="chat-voice-start"]').length,
      voiceStartDisabled: start instanceof HTMLButtonElement ? start.disabled : null,
      voiceStartOuterHTML: start instanceof HTMLElement ? start.outerHTML.slice(0, 500) : '',
      chatInputCount: document.querySelectorAll('[data-testid="chat-input"]').length,
      welcomeSkipCount: document.querySelectorAll('[data-testid="welcome-skip"]').length,
    }
  }

  window.addEventListener('error', (event) => {
    void progress('runtime-error', {
      message: event.error instanceof Error ? event.error.message : String(event.message || event.error),
      snapshot: runtimeSnapshot(),
    })
  })
  window.addEventListener('unhandledrejection', (event) => {
    void progress('runtime-rejection', {
      message: event.reason instanceof Error ? event.reason.message : String(event.reason),
      snapshot: runtimeSnapshot(),
    })
  })

  function button(selector) {
    const element = document.querySelector(selector)
    if (!(element instanceof HTMLButtonElement) || element.disabled) return null
    return element
  }

  function canonicalDraft() {
    const editor = document.querySelector('[data-testid="chat-input"]')
    return editor instanceof HTMLElement ? editor.dataset.canonicalSource || '' : ''
  }

  function toastMessages() {
    return [...document.querySelectorAll('.hc-toast__msg')]
      .map((element) => element.textContent?.trim() || '')
      .filter(Boolean)
  }

  function closeToasts() {
    for (const close of document.querySelectorAll('.hc-toast__close')) {
      if (close instanceof HTMLButtonElement) close.click()
    }
  }

  function assistantMessages() {
    return [...document.querySelectorAll('[data-testid="chat-message-assistant"]')]
  }

  async function startRecording(expectedCallCount) {
    const start = await waitFor(
      () => button('[data-testid="chat-voice-start"]'),
      'enabled voice start button',
    )
    await progress(`recording-${expectedCallCount}-start-ready`, {
      calls: syntheticState.getUserMediaCalls,
      snapshot: runtimeSnapshot(),
    })
    start.click()
    await progress(`recording-${expectedCallCount}-start-clicked`)
    await waitFor(
      () => document.querySelector('[data-testid="chat-voice-panel"]'),
      'voice recording panel',
    )
    await progress(`recording-${expectedCallCount}-panel-visible`, {
      calls: syntheticState.getUserMediaCalls,
    })
    await waitFor(
      () => syntheticState.getUserMediaCalls === expectedCallCount,
      `synthetic media stream ${expectedCallCount}`,
    )
    await progress(`recording-${expectedCallCount}-media-ready`)
  }

  async function finishRecording() {
    await sleep(1_250)
    const send = await waitFor(
      () => button('[data-testid="chat-voice-send"]'),
      'enabled voice transcript send button',
    )
    send.click()
    await waitFor(
      () => !document.querySelector('[data-testid="chat-voice-panel"]'),
      'voice recording panel to close',
    )
  }

  async function installSyntheticAudioInput() {
    invariant(typeof window.MediaRecorder === 'function', 'Native MediaRecorder is unavailable')
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext
    invariant(typeof AudioContextCtor === 'function', 'WebAudio AudioContext is unavailable')

    const getUserMedia = async (constraints) => {
      invariant(Boolean(constraints?.audio), 'Voice capture must request an audio track')
      syntheticState.getUserMediaCalls += 1

      const context = new AudioContextCtor()
      await context.resume()
      const destination = context.createMediaStreamDestination()
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.frequency.value = 440 + syntheticState.getUserMediaCalls * 20
      gain.gain.value = 0.08
      oscillator.connect(gain)
      gain.connect(destination)
      oscillator.start()
      syntheticState.audioTracksCreated += destination.stream.getAudioTracks().length
      syntheticState.contexts.push({ context, oscillator })
      return destination.stream
    }

    const mediaDevices = navigator.mediaDevices || {}
    try {
      Object.defineProperty(mediaDevices, 'getUserMedia', {
        configurable: true,
        value: getUserMedia,
      })
    } catch {
      mediaDevices.getUserMedia = getUserMedia
    }
    // WKWebView 某些版本将 mediaDevices 暴露为原型 getter；固定实例，避免产品在点击时
    // 重新取到未注入的原生对象，导致测试误触系统麦克风而非合成音轨。
    try {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        enumerable: true,
        get: () => mediaDevices,
      })
    } catch {
      if (navigator.mediaDevices !== mediaDevices) {
        try {
          Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: mediaDevices,
          })
        } catch {
          // 只读宿主对象由后续 identity 诊断明确失败，不静默伪造成功。
        }
      }
    }

    // 强制覆盖 WebKit 的不完整 SpeechRecognition 暴露，确保走产品定义的 MediaRecorder 兜底。
    window.SpeechRecognition = undefined
    window.webkitSpeechRecognition = undefined
  }

  async function disposeSyntheticAudio() {
    for (const entry of syntheticState.contexts.splice(0)) {
      try {
        entry.oscillator.stop()
      } catch {
        // 轨道停止时可能已经结束振荡器。
      }
      try {
        await entry.context.close()
      } catch {
        // 关闭中的 AudioContext 不需要重复处理。
      }
    }
  }

  async function execute() {
    sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    if (document.readyState === 'loading') {
      await new Promise((resolve) => window.addEventListener('DOMContentLoaded', resolve, { once: true }))
    }
    // 等待 Vue 首屏挂载完成；该夹具通过 index.html head 注入，不能在 body 生成前取按钮。
    await sleep(100)
    // Test.app 必须走与生产 Tauri 相同的 MediaRecorder 兜底路径。
    for (const key of ['SpeechRecognition', 'webkitSpeechRecognition']) {
      try {
        Object.defineProperty(window, key, {
          configurable: true,
          value: undefined,
          writable: true,
        })
      } catch {
        try {
          window[key] = undefined
        } catch {
          // WebKit 只读实现保持原值时，合同会在启动阶段失败。
        }
      }
    }
    await installSyntheticAudioInput()
    await progress('fixture-ready', {
      diagnostics: {
        ...runtimeSnapshot(),
        tauriFlag: Boolean(globalThis.isTauri),
        speechRecognition: typeof window.SpeechRecognition,
        webkitSpeechRecognition: typeof window.webkitSpeechRecognition,
        mediaRecorder: typeof window.MediaRecorder,
        mediaDevices: typeof navigator.mediaDevices,
        getUserMedia: typeof navigator.mediaDevices?.getUserMedia,
      },
    })
    setTimeout(() => void progress('delayed-diagnostics', runtimeSnapshot()), 5_000)

    const mediaRecorderSource = Function.prototype.toString.call(window.MediaRecorder)
    const report = {
      status: 'PASS',
      source: {
        mediaRecorderConstructor: window.MediaRecorder.name,
        nativeMediaRecorder: /\[native code\]/.test(mediaRecorderSource),
        syntheticGetUserMedia: true,
        realMicrophonePermissionCovered: false,
        audioPersisted: false,
      },
      scenarios: {},
    }

    // success：真实 MediaRecorder → Tauri IPC → Sidecar STT → 既有聊天发送链路。
    await startRecording(1)
    await finishRecording()
    await waitFor(async () => {
      const current = await stats()
      return current.sttRequests === 1 && current.chatRequests >= 1 ? current : null
    }, 'success STT and chat receipts')
    await progress('success-receipts')
    await waitFor(
      () => document.body.textContent?.includes('HEXCLAW_VOICE_CHAT_OK'),
      'successful assistant response',
    )
    await progress('success-rendered')
    invariant(canonicalDraft() === '', 'Successful voice send must clear the Composer draft')
    report.scenarios.success = {
      status: 'PASS',
      panelClosed: !document.querySelector('[data-testid="chat-voice-panel"]'),
      draft: canonicalDraft(),
    }

    // cancel：左 X 只丢弃本次录音，不触发 STT 或聊天上游。
    const beforeCancel = await stats()
    await startRecording(2)
    await sleep(250)
    const cancel = await waitFor(
      () => button('[data-testid="chat-voice-cancel"]'),
      'enabled voice cancel button',
    )
    cancel.click()
    await waitFor(
      () => !document.querySelector('[data-testid="chat-voice-panel"]'),
      'cancelled voice panel to close',
    )
    await sleep(650)
    const afterCancel = await stats()
    invariant(afterCancel.sttRequests === beforeCancel.sttRequests, 'Cancel must not invoke STT')
    invariant(afterCancel.chatRequests === beforeCancel.chatRequests, 'Cancel must not invoke chat')
    invariant(canonicalDraft() === '', 'Cancel must not fill the Composer draft')
    report.scenarios.cancel = {
      status: 'PASS',
      sttDelta: afterCancel.sttRequests - beforeCancel.sttRequests,
      chatDelta: afterCancel.chatRequests - beforeCancel.chatRequests,
    }
    await progress('cancel-verified')

    // stt-failure：错误由现有 Toast 承载，且不能继续调用聊天发送。
    closeToasts()
    const beforeSttFailure = await stats()
    await startRecording(3)
    await finishRecording()
    await waitFor(async () => {
      const current = await stats()
      return current.sttRequests === beforeSttFailure.sttRequests + 1 ? current : null
    }, 'failed STT receipt')
    const sttFailureToast = await waitFor(
      () => toastMessages().find((message) => /STT|transcrib|转录|转写/i.test(message)),
      'existing STT error toast',
    )
    const afterSttFailure = await stats()
    invariant(
      afterSttFailure.chatRequests === beforeSttFailure.chatRequests,
      'STT failure must not invoke chat',
    )
    report.scenarios['stt-failure'] = {
      status: 'PASS',
      errorCarrier: 'ToastProvider',
      errorText: sttFailureToast,
      chatDelta: afterSttFailure.chatRequests - beforeSttFailure.chatRequests,
    }
    await progress('stt-failure-verified')

    // send-failure：STT 成功后进入既有聊天链；上游失败由现有 assistant error 承载。
    closeToasts()
    const beforeSendFailure = await stats()
    const assistantCount = assistantMessages().length
    await startRecording(4)
    await finishRecording()
    await waitFor(async () => {
      const current = await stats()
      return current.sttRequests === beforeSendFailure.sttRequests + 1 &&
        current.chatRequests > beforeSendFailure.chatRequests
        ? current
        : null
    }, 'failed chat receipt')
    const errorAssistant = await waitFor(() => {
      const messages = assistantMessages()
      if (messages.length <= assistantCount) return null
      const last = messages.at(-1)
      const text = last?.textContent?.trim() || ''
      return text && !text.includes('HEXCLAW_VOICE_CHAT_OK') ? text : null
    }, 'existing assistant send error')
    report.scenarios['send-failure'] = {
      status: 'PASS',
      errorCarrier: 'assistant-message',
      errorText: errorAssistant,
      draftAfterOptimisticAcceptance: canonicalDraft(),
    }
    await progress('send-failure-verified')

    const finalStats = await stats()
    invariant(finalStats.sttRequests === 3, 'Expected exactly three STT requests')
    invariant(
      finalStats.audioBytes.every((size) => size > 0),
      'Every STT request needs audio bytes',
    )
    invariant(syntheticState.getUserMediaCalls === 4, 'Expected four isolated capture attempts')
    invariant(syntheticState.audioTracksCreated === 4, 'Expected four synthetic audio tracks')
    report.receipts = finalStats
    report.syntheticCapture = {
      calls: syntheticState.getUserMediaCalls,
      audioTracks: syntheticState.audioTracksCreated,
    }
    await progress('fixture-complete')
    return report
  }

  async function complete() {
    let report
    try {
      report = await execute()
    } catch (error) {
      report = {
        status: 'FAIL',
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        syntheticCapture: {
          calls: syntheticState.getUserMediaCalls,
          audioTracks: syntheticState.audioTracksCreated,
        },
      }
    } finally {
      await disposeSyntheticAudio()
    }

    try {
      await progress('reporting-complete')
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
