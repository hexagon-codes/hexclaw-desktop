/**
 * 已安装应用真实推理状态驱动。
 *
 * 该脚本只会被 native harness 注入临时前端副本。它使用现有 Composer 发起一条
 * 普通聊天消息，并在真实 WebSocket 的首个入站帧前设置一次测试观察屏障，确保
 * 原生窗口截图与 DOM 回执属于同一个“请求已接受、首正文未出现”状态。
 */
;(function runInstalledAssistantStatusBoundary() {
  'use strict'

  const controlOrigin = '__HEX_CHAT_STATUS_CONTROL_ORIGIN__'
  const userMarker = 'HEX_CHAT_STATUS_REAL_INSTALLED_USER_001'
  const expectedProvider = 'hexclaw-gpt'
  const expectedModel = 'gpt-5.6-sol'
  const expectedNeutralLabel = '正在回复…'
  const forbiddenLegacyLabels = ['正在生成回答', '正在准备回答', '思考中']
  const startedAt = Date.now()
  const nativeMatchMedia = globalThis.matchMedia.bind(globalThis)
  const nativeFetch = globalThis.fetch.bind(globalThis)
  const nativeTauriInternals = globalThis.__TAURI_INTERNALS__
  const socketTrace = {
    targetRequests: [],
    fallbackRequests: [],
    inboundReceipts: [],
    firstVisibleContentAt: null,
  }

  sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  history.replaceState({}, '', '/chat')

  // 原生窗口没有 Playwright 的 reducedMotion 上下文；测试副本只对该媒体查询注入
  // 确定性事实，并由 harness 同时注入禁动画 CSS，生产资源保持不变。
  globalThis.matchMedia = (query) => {
    if (query !== '(prefers-reduced-motion: reduce)') return nativeMatchMedia(query)
    return {
      matches: true,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return true },
    }
  }

  globalThis.fetch = (input, init) => {
    const rawURL = typeof input === 'string' ? input : input?.url || ''
    const body = typeof init?.body === 'string' ? init.body : ''
    if (body.includes(userMarker) && !rawURL.startsWith(controlOrigin)) {
      let endpoint = ''
      try {
        endpoint = new URL(rawURL, location.origin).pathname
      } catch {
        endpoint = '<invalid-url>'
      }
      socketTrace.fallbackRequests.push({
        method: nonEmptyString(init?.method) || 'GET',
        endpoint,
      })
      void post('/trace', {
        kind: 'target-http-request',
        value: socketTrace.fallbackRequests.at(-1),
      }).catch(() => {})
    }
    return nativeFetch(input, init)
  }

  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

  function invariant(condition, message) {
    if (!condition) throw new Error(message)
  }

  function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  }

  function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : ''
  }

  async function waitFor(read, label, timeout = 60_000, interval = 100) {
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

  async function requestJSON(path, init) {
    const response = await fetch(`${controlOrigin}${path}`, {
      cache: 'no-store',
      ...init,
    })
    if (!response.ok) throw new Error(`Control request failed: ${response.status} ${path}`)
    return response.status === 204 ? null : response.json()
  }

  async function post(path, value) {
    return requestJSON(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    })
  }

  function safeReceipt(value) {
    const candidate = record(value)
    if (!candidate) return null
    return {
      version: candidate.version,
      reasoning_request: candidate.reasoning_request,
      reasoning_support: candidate.reasoning_support,
      reasoning_execution: candidate.reasoning_execution,
    }
  }

  function safeOutbound(value) {
    const message = record(value)
    if (!message) return null
    const metadata = record(message.metadata) || {}
    return {
      type: nonEmptyString(message.type),
      request_id: nonEmptyString(message.request_id),
      session_id: nonEmptyString(message.session_id),
      provider: nonEmptyString(message.provider),
      model: nonEmptyString(message.model),
      thinking: nonEmptyString(metadata.thinking || metadata.thinking_enabled),
      thinking_effort: nonEmptyString(metadata.thinking_effort),
      content_marker: nonEmptyString(message.content).includes(userMarker),
    }
  }

  function safeInbound(value) {
    const message = record(value)
    if (!message) return null
    const metadata = record(message.metadata) || {}
    const receipt = safeReceipt(message.reasoning_receipt || metadata.reasoning_receipt)
    return {
      type: nonEmptyString(message.type),
      request_id: nonEmptyString(message.request_id),
      assistant_message_id: nonEmptyString(
        message.assistant_message_id || metadata.assistant_message_id || message.message_id,
      ),
      sequence: Number.isSafeInteger(message.sequence) ? message.sequence : 0,
      done: message.done === true,
      content_length: typeof message.content === 'string' ? message.content.length : 0,
      reasoning_length: typeof message.reasoning === 'string' ? message.reasoning.length : 0,
      reasoning_receipt: receipt,
    }
  }

  function parseJSON(value) {
    if (typeof value !== 'string') return null
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }

  // Tauri 原生会话通过 Rust sidecar_socket_* IPC，不经过浏览器 WebSocket。
  // 测试副本只包装既有 invoke/channel 回调：记录脱敏 wire 事实，并在目标请求首个
  // 入站帧交付 Vue 前建立截图屏障；真实 IPC 仍只调用一次且按原顺序重放。
  function installNativeSocketObserver() {
    invariant(
      nativeTauriInternals &&
        typeof nativeTauriInternals.invoke === 'function' &&
        typeof nativeTauriInternals.transformCallback === 'function',
      'Tauri IPC internals are unavailable',
    )
    const nativeInvoke = nativeTauriInternals.invoke.bind(nativeTauriInternals)
    const nativeTransformCallback = nativeTauriInternals.transformCallback.bind(nativeTauriInternals)
    const callbackSockets = new Map()
    const queuedInbound = []
    let targetSocketID = ''
    let released = false
    let releaseStarted = false

    async function releaseWhenAuthorized() {
      if (releaseStarted) return
      releaseStarted = true
      try {
        await waitFor(async () => {
          const barrier = await requestJSON('/barrier')
          return barrier.release_first_inbound === true ? barrier : null
        }, 'native screenshot barrier release', 30_000, 50)
        released = true
        for (const entry of queuedInbound.splice(0)) entry.callback(entry.rawMessage)
      } catch (error) {
        void post('/runtime-error', {
          message: error instanceof Error ? error.message : String(error),
        }).catch(() => {})
      }
    }

    nativeTauriInternals.transformCallback = (callback, once = false) => {
      if (typeof callback !== 'function') return nativeTransformCallback(callback, once)
      let callbackID = 0
      const wrapped = (rawMessage) => {
        const envelope = record(rawMessage)
        const socketEvent = record(envelope?.message)
        const socketID = callbackSockets.get(callbackID) || ''
        const isTargetInbound =
          socketID &&
          socketID === targetSocketID &&
          socketEvent?.type === 'message' &&
          typeof socketEvent.data === 'string'
        if (isTargetInbound) {
          const inbound = safeInbound(parseJSON(socketEvent.data))
          if (inbound?.reasoning_receipt) {
            socketTrace.inboundReceipts.push(inbound)
            void post('/trace', { kind: 'inbound-receipt', value: inbound }).catch(() => {})
          }
          if (!released) {
            queuedInbound.push({ callback, rawMessage })
            void releaseWhenAuthorized()
            return
          }
        }
        callback(rawMessage)
      }
      callbackID = nativeTransformCallback(wrapped, once)
      return callbackID
    }

    nativeTauriInternals.invoke = async (command, args, options) => {
      const values = record(args) || {}
      if (command === 'sidecar_socket_send' && typeof values.data === 'string') {
        const outbound = safeOutbound(parseJSON(values.data))
        if (outbound?.type === 'message' && outbound.content_marker) {
          invariant(!targetSocketID, 'A second target socket was opened')
          targetSocketID = nonEmptyString(values.socketId)
          invariant(targetSocketID, 'Target native socket identity is missing')
          socketTrace.targetRequests.push(outbound)
          void post('/trace', { kind: 'target-request', value: outbound }).catch(() => {})
        }
      }
      const result = await nativeInvoke(command, args, options)
      if (command === 'sidecar_socket_open') {
        const channelID = Number(values.onEvent?.id)
        const socketID = nonEmptyString(result)
        invariant(Number.isSafeInteger(channelID) && channelID >= 0, 'Native socket channel identity is missing')
        invariant(socketID, 'Native socket open returned no identity')
        callbackSockets.set(channelID, socketID)
      }
      return result
    }
  }

  installNativeSocketObserver()

  function rect(element) {
    if (!(element instanceof HTMLElement)) return null
    const value = element.getBoundingClientRect()
    return {
      x: Math.round(value.x * 100) / 100,
      y: Math.round(value.y * 100) / 100,
      width: Math.round(value.width * 100) / 100,
      height: Math.round(value.height * 100) / 100,
    }
  }

  function statusSnapshot() {
    const pending = document.querySelector('[data-testid="chat-assistant-pending"]')
    const persisted = [...document.querySelectorAll('[data-testid="chat-message-assistant"]')].at(-1)
    const message = pending || persisted
    const neutralHosts = message
      ? [...message.querySelectorAll('[data-component="AssistantRunStatus"]')]
      : []
    const thinkingHosts = message
      ? [...message.querySelectorAll('[data-component="ThinkingProgress"]')]
      : []
    const liveRegions = message ? [...message.querySelectorAll('[role="status"]')] : []
    const typingDots = document.querySelectorAll(
      '.hc-typing-dots, [data-testid="chat-typing-dots"], [data-component="TypingDots"]',
    )
    const answer = message?.querySelector('.hc-msg__bubble-wrap')
    const host = neutralHosts[0] || thinkingHosts[0] || null
    const style = host instanceof HTMLElement ? getComputedStyle(host) : null
    return {
      location_path: location.pathname,
      pending: Boolean(pending),
      persisted: Boolean(persisted),
      assistant_message_id: message?.getAttribute('data-assistant-message-id') || '',
      neutral_host_count: neutralHosts.length,
      thinking_host_count: thinkingHosts.length,
      live_region_count: liveRegions.length,
      typing_dots_count: typingDots.length,
      neutral_texts: neutralHosts.map((element) => element.textContent?.trim() || ''),
      thinking_texts: thinkingHosts.map((element) => element.textContent?.trim() || ''),
      answer_visible: Boolean(answer && answer.textContent?.trim()),
      answer_length: answer?.textContent?.trim().length || 0,
      reasoning_request: host?.getAttribute('data-reasoning-request') || '',
      reasoning_support: host?.getAttribute('data-reasoning-support') || '',
      reasoning_execution: host?.getAttribute('data-reasoning-execution') || '',
      thinking_state: host?.getAttribute('data-thinking-state') || '',
      host_rect: rect(host),
      host_style: style
        ? {
            display: style.display,
            gap: style.gap,
            padding: style.padding,
            color: style.color,
            font_size: style.fontSize,
            font_weight: style.fontWeight,
            background_color: style.backgroundColor,
            border_top_width: style.borderTopWidth,
          }
        : null,
      reduced_motion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      elapsed_ms: Date.now() - startedAt,
    }
  }

  function setComposerText(editor, value) {
    invariant(editor instanceof HTMLElement, 'Chat Composer editor is unavailable')
    editor.focus()
    editor.replaceChildren(document.createTextNode(value))
    editor.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }),
    )
  }

  async function enableReasoning() {
    const modelButton = await waitFor(
      () => document.querySelector('.hc-model-selector__btn'),
      'model selector',
    )
    invariant(
      modelButton.textContent?.includes(expectedModel),
      'Selected model is not the exact authorized model',
    )
    const control = await waitFor(() => {
      const element = document.querySelector('.hc-chat__thinking-control')
      return element instanceof HTMLButtonElement && !element.disabled ? element : null
    }, 'enabled exact-model reasoning control')
    if (control.getAttribute('aria-pressed') !== 'true') {
      control.click()
      const mode = await waitFor(
        () => document.querySelector('[data-testid="chat-thinking-mode"]'),
        'reasoning mode switch',
      )
      if (mode.getAttribute('aria-checked') !== 'true') mode.click()
    }
    await waitFor(
      () => control.getAttribute('aria-pressed') === 'true',
      'reasoning mode enabled',
    )
    if (control.getAttribute('aria-expanded') !== 'true') control.click()
    const low = await waitFor(
      () => document.querySelector('[data-testid="chat-thinking-effort-low"]'),
      'authorized low reasoning effort',
    )
    low.click()
    await waitFor(
      () => low.getAttribute('aria-checked') === 'true',
      'low reasoning effort selected',
    )
    return {
      model_label: modelButton.textContent?.trim() || '',
      reasoning_control_enabled: !control.disabled,
      reasoning_control_pressed: control.getAttribute('aria-pressed'),
      low_effort_selected: low.getAttribute('aria-checked'),
    }
  }

  async function executeInitial() {
    const editor = await waitFor(
      () => document.querySelector('[data-testid="chat-input"]'),
      'production Chat Composer',
    )
    const route = await enableReasoning()
    setComposerText(editor, userMarker)
    const send = await waitFor(() => {
      const button = document.querySelector('[data-testid="chat-send"]')
      return button instanceof HTMLButtonElement && !button.disabled ? button : null
    }, 'enabled production send button')
    send.click()

    const before = await waitFor(() => {
      const snapshot = statusSnapshot()
      return snapshot.neutral_host_count === 1 ? snapshot : null
    }, 'single neutral assistant status before first inbound frame')
    invariant(before.neutral_texts[0] === expectedNeutralLabel, 'Neutral status copy drifted')
    invariant(before.live_region_count === 1, 'Assistant message must expose one live region')
    invariant(before.typing_dots_count === 0, 'Legacy typing dots must be absent')
    invariant(before.answer_visible === false, 'Answer became visible before the screenshot barrier')
    invariant(before.reduced_motion === true, 'Installed gate must run with reduced motion')
    invariant(
      forbiddenLegacyLabels.every((label) => !document.body.textContent?.includes(label)),
      'Forbidden legacy assistant status copy is visible',
    )
    await post('/report', { stage: 'before-first-content', route, status: before })

    const afterFirstContent = await waitFor(() => {
      const snapshot = statusSnapshot()
      return snapshot.answer_visible ? snapshot : null
    }, 'first visible answer content', 180_000)
    socketTrace.firstVisibleContentAt = Date.now() - startedAt
    invariant(
      afterFirstContent.neutral_host_count === 0,
      'Neutral assistant status must disappear after first visible answer',
    )
    invariant(afterFirstContent.typing_dots_count === 0, 'Legacy typing dots returned')
    await post('/report', { stage: 'after-first-content', status: afterFirstContent })

    const terminal = await waitFor(() => {
      const snapshot = statusSnapshot()
      const thought = snapshot.thinking_texts.find((text) => /^思考了\s+/.test(text))
      return snapshot.persisted && thought ? { ...snapshot, thought } : null
    }, 'terminal applied reasoning projection', 180_000)
    invariant(terminal.neutral_host_count === 0, 'Terminal state retained neutral run status')
    invariant(terminal.thinking_host_count === 1, 'Terminal state must have one ThinkingProgress')
    invariant(terminal.live_region_count === 0, 'Completed thought must not remain a live region')
    invariant(terminal.reasoning_request === 'on', 'Terminal reasoning request is not on')
    invariant(terminal.reasoning_support === 'supported', 'Terminal reasoning support is not supported')
    invariant(terminal.reasoning_execution === 'applied', 'Terminal reasoning execution is not applied')
    invariant(/^思考了\s+(?:\d+s|\d+m(?:\s+\d+s)?)$/.test(terminal.thought), 'Terminal duration label drifted')
    const appliedReceipts = socketTrace.inboundReceipts.filter(
      (frame) => frame.reasoning_receipt?.reasoning_execution === 'applied',
    )
    invariant(appliedReceipts.length > 0, 'Real WebSocket never delivered an applied receipt')
    invariant(socketTrace.targetRequests.length === 1, 'Expected one provider-bound chat request')
    invariant(socketTrace.fallbackRequests.length === 0, 'Target request entered an HTTP fallback path')
    const outbound = socketTrace.targetRequests[0]
    invariant(outbound.provider === expectedProvider, 'Outbound provider identity drifted')
    invariant(outbound.model === expectedModel, 'Outbound model identity drifted')
    invariant(outbound.thinking === 'on', 'Outbound reasoning request is not on')
    invariant(outbound.thinking_effort === 'low', 'Outbound reasoning effort is not low')
    await post('/report', {
      stage: 'terminal',
      status: terminal,
      outbound,
      applied_receipts: appliedReceipts,
      target_request_count: socketTrace.targetRequests.length,
      fallback_request_count: socketTrace.fallbackRequests.length,
      first_visible_content_at_ms: socketTrace.firstVisibleContentAt,
    })
  }

  async function executeRestart() {
    const baseline = await requestJSON('/baseline')
    const restored = await waitFor(() => {
      const snapshot = statusSnapshot()
      const userVisible = [...document.querySelectorAll('[data-testid="chat-message-user"]')]
        .some((element) => element.textContent?.includes(userMarker))
      const thought = snapshot.thinking_texts.find((text) => /^思考了\s+/.test(text))
      return snapshot.persisted && userVisible && thought ? { ...snapshot, thought } : null
    }, 'persisted assistant reasoning state after App restart', 90_000)
    invariant(restored.assistant_message_id === baseline.assistant_message_id, 'Assistant identity drifted after restart')
    invariant(restored.thought === baseline.thought, 'Thinking duration summary drifted after restart')
    invariant(restored.reasoning_request === 'on', 'Restored reasoning request drifted')
    invariant(restored.reasoning_support === 'supported', 'Restored reasoning support drifted')
    invariant(restored.reasoning_execution === 'applied', 'Restored reasoning execution drifted')
    invariant(socketTrace.targetRequests.length === 0, 'Restart emitted a second provider-bound request')
    invariant(socketTrace.fallbackRequests.length === 0, 'Restart emitted a target HTTP request')
    invariant(restored.typing_dots_count === 0, 'Restart restored legacy typing dots')
    await post('/report', {
      stage: 'restart-restored',
      status: restored,
      target_request_count_this_run: socketTrace.targetRequests.length,
      fallback_request_count_this_run: socketTrace.fallbackRequests.length,
    })
  }

  async function execute() {
    if (document.readyState === 'loading') {
      await new Promise((resolve) => window.addEventListener('DOMContentLoaded', resolve, { once: true }))
    }
    const mode = await requestJSON('/mode')
    await post('/report', {
      stage: `bootstrap-${mode.phase}`,
      environment: {
        runtime: 'Tauri Test.app WKWebView',
        is_tauri: globalThis.isTauri === true,
        has_tauri_internals: typeof globalThis.__TAURI_INTERNALS__?.invoke === 'function',
        locale: navigator.language,
        viewport: { width: innerWidth, height: innerHeight },
        device_pixel_ratio: devicePixelRatio,
        reduced_motion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      },
    })
    if (mode.phase === 'initial') return executeInitial()
    invariant(mode.phase === 'restart', 'Unexpected installed fixture phase')
    return executeRestart()
  }

  window.addEventListener('error', (event) => {
    void post('/runtime-error', {
      message: event.error instanceof Error ? event.error.message : String(event.message || event.error),
    }).catch(() => {})
  })
  window.addEventListener('unhandledrejection', (event) => {
    void post('/runtime-error', {
      message: event.reason instanceof Error ? event.reason.message : String(event.reason),
    }).catch(() => {})
  })

  void execute().catch((error) => {
    void post('/runtime-error', {
      message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      status: statusSnapshot(),
    }).catch(() => {})
  })
})()
