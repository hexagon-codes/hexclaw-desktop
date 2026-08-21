/**
 * 知识库原生 WebView 边界驱动。
 *
 * 脚本只注入隔离复制的前端产物：操作真实 Vue DOM、Tauri IPC 与 Sidecar，
 * 并把可审计结果回传到同一轮的 loopback fixture。它不会进入生产产物。
 */
;(function runKnowledgeQueueReindexWebViewBoundary() {
  'use strict'

  const fixtureOrigin = '__HEX_KNOWLEDGE_WEBVIEW_FIXTURE_ORIGIN__'
  const documentTitle = 'NATIVE_WEBVIEW_REINDEX_FIXTURE.md'
  const documentBody = 'NATIVE_WEBVIEW_REINDEX_PROJECTION_BODY'
  const pngBytes = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLh/gAAAABJRU5ErkJggg==',
    ),
    (value) => value.charCodeAt(0),
  )
  const transportReceiptHookName = '__HEXCLAW_TEST_SIDECAR_RECEIPT__'
  const cancellationProjectionHookName = '__HEXCLAW_TEST_QUEUE_CANCEL_PROJECTION__'
  const transportReceiptResponseFields = [
    'id',
    'document_id',
    'job_id',
    'job_state',
    'state',
    'stage',
    'vector_index_state',
    'vector_job_id',
    'vector_job_state',
    'operation_id',
  ]
  const transportReceipts = []
  const cancellationProjections = []
  const queueCancelOnly = globalThis.__HEXCLAW_TEST_QUEUE_CANCEL_ONLY__ === true
  const fixtureStartedAt = Date.now()
  const stageTimeline = []
  let currentStage = 'fixture-bootstrap'
  let terminalReportSent = false
  let watchdogTimer = null

  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

  function invariant(condition, message) {
    if (!condition) throw new Error(message)
  }

  function cleanText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function canonicalKnowledgePath(path) {
    if (typeof path !== 'string') return null
    return path.split('?', 1)[0]
  }

  function observedTransportKind(method, path) {
    const canonicalPath = canonicalKnowledgePath(path)
    if (!canonicalPath) return null
    if (
      method === 'POST' &&
      /^\/api\/v1\/knowledge\/documents\/[^/]+\/reindex$/.test(canonicalPath)
    ) {
      return 'reindex'
    }
    if (method === 'POST' && /^\/api\/v1\/knowledge\/jobs\/[^/]+\/cancel$/.test(canonicalPath)) {
      return 'cancel'
    }
    if (method === 'GET' && /^\/api\/v1\/knowledge\/documents\/[^/]+$/.test(canonicalPath)) {
      return 'document-detail'
    }
    if (method === 'GET' && /^\/api\/v1\/knowledge\/jobs\/[^/]+$/.test(canonicalPath)) {
      return 'job-poll'
    }
    return null
  }

  function sanitizeTransportReceipt(receipt) {
    if (!receipt || typeof receipt !== 'object') return null
    const phase = receipt.phase === 'issued' || receipt.phase === 'responded' ? receipt.phase : null
    const method = receipt.method === 'POST' || receipt.method === 'GET' ? receipt.method : null
    const path = typeof receipt.path === 'string' ? receipt.path : null
    const canonicalPath = canonicalKnowledgePath(path)
    const kind = observedTransportKind(method, canonicalPath)
    if (!phase || !method || !canonicalPath || !kind) return null
    const sanitized = { phase, method, path: canonicalPath, kind }
    if (phase === 'responded') {
      if (!Number.isInteger(receipt.status) || receipt.status < 100 || receipt.status > 599)
        return null
      sanitized.status = receipt.status
      const fields = {}
      const sourceFields =
        receipt.fields && typeof receipt.fields === 'object' ? receipt.fields : {}
      for (const key of transportReceiptResponseFields) {
        const value = sourceFields[key]
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value))
          fields[key] = value
      }
      sanitized.fields = fields
    }
    return sanitized
  }

  function copyTransportReceipts(start = 0) {
    return transportReceipts.slice(start).map((receipt) => ({
      ...receipt,
      ...(receipt.fields ? { fields: { ...receipt.fields } } : {}),
    }))
  }

  function findTransportReceipt(start, kind, phase, expectedPath) {
    return transportReceipts
      .slice(start)
      .find(
        (receipt) =>
          receipt.kind === kind &&
          receipt.phase === phase &&
          (expectedPath === undefined || receipt.path === expectedPath),
      )
  }

  function sanitizeCancellationProjection(event) {
    if (!event || typeof event !== 'object') return null
    if (event.phase === 'before-mark' || event.phase === 'after-mark-sync') {
      return {
        phase: event.phase,
        rows: Number.isInteger(event.rows) && event.rows >= 0 ? event.rows : -1,
        storeItems:
          Number.isInteger(event.storeItems) && event.storeItems >= 0 ? event.storeItems : -1,
        contains: typeof event.contains === 'boolean' ? event.contains : null,
        entryStatus: typeof event.entryStatus === 'string' ? event.entryStatus : null,
      }
    }
    if (event.phase === 'mark-error') {
      return {
        phase: 'mark-error',
        errorKind:
          typeof event.errorKind === 'string' && event.errorKind.length <= 64
            ? event.errorKind
            : 'other',
      }
    }
    if (event.phase === 'resolved') {
      const state =
        typeof event.state === 'string' &&
        ['queued', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled'].includes(event.state)
          ? event.state
          : event.state === null
            ? null
            : undefined
      const stateType =
        typeof event.stateType === 'string' &&
        ['string', 'undefined', 'object', 'number', 'boolean'].includes(event.stateType)
          ? event.stateType
          : 'other'
      return { phase: 'resolved', state, stateType }
    }
    if (event.phase === 'rejected') {
      const errorKind =
        typeof event.errorKind === 'string' && event.errorKind.length <= 64
          ? event.errorKind
          : 'other'
      return { phase: 'rejected', errorKind }
    }
    return null
  }

  globalThis[transportReceiptHookName] = (receipt) => {
    try {
      const sanitized = sanitizeTransportReceipt(receipt)
      if (sanitized && transportReceipts.length < 96) transportReceipts.push(sanitized)
    } catch {
      // 测试回执不会影响被测请求。
    }
  }

  globalThis[cancellationProjectionHookName] = (event) => {
    try {
      const sanitized = sanitizeCancellationProjection(event)
      if (sanitized && cancellationProjections.length < 8) cancellationProjections.push(sanitized)
    } catch {
      // 测试观测不会影响取消处理器。
    }
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
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2_500)
    try {
      return await json('/__knowledge_webview_boundary__/stats', { signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Fixture stats request timed out')
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  function recordStage(stage) {
    currentStage = stage
    stageTimeline.push({ stage, elapsedMs: Date.now() - fixtureStartedAt })
    if (stageTimeline.length > 24) stageTimeline.shift()
  }

  async function progress(stage, detail) {
    recordStage(stage)
    const payload = { stage }
    if (detail !== undefined) payload.detail = detail
    await json('/__knowledge_webview_boundary__/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }

  function enabledButton(root, matcher) {
    return [...root.querySelectorAll('button')].find(
      (candidate) => !candidate.disabled && matcher.test(cleanText(candidate.textContent)),
    )
  }

  function setControlValue(control, value) {
    invariant(
      control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement,
      'Expected a text control',
    )
    const prototype = Object.getPrototypeOf(control)
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
    invariant(typeof descriptor?.set === 'function', 'Native text control setter is unavailable')
    descriptor.set.call(control, value)
    control.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }),
    )
    control.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function documentCard() {
    return [...document.querySelectorAll('[data-testid="knowledge-doc-card"]')].find((candidate) =>
      cleanText(candidate.textContent).includes(documentTitle),
    )
  }

  function cardSnapshot(card) {
    const status = cleanText(
      card.querySelector('[data-testid="knowledge-vector-status"]')?.textContent,
    )
    const badge = cleanText(
      card.querySelector('[data-testid="knowledge-document-badge"]')?.textContent,
    )
    const reindex = [...card.querySelectorAll('button')].find((button) =>
      /重建|Reindex/i.test(cleanText(button.textContent)),
    )
    return {
      status,
      badge,
      reindexDisabled: Boolean(reindex?.disabled),
      vectorCancelVisible: Boolean(card.querySelector('[data-testid="knowledge-vector-cancel"]')),
    }
  }

  function uploadSnapshot() {
    const rows = [...document.querySelectorAll('[data-testid="knowledge-upload-job"]')]
    const first = rows[0]
    return {
      rowCount: rows.length,
      processing: cleanText(first?.querySelector('[data-testid="upload-processing"]')?.textContent),
      cancelVisible: Boolean(first?.querySelector('[data-testid="knowledge-upload-cancel"]')),
      rowText: cleanText(first?.textContent),
    }
  }

  function watchdogDiagnostic() {
    const card = documentCard()
    const upload = uploadSnapshot()
    return {
      currentStage,
      elapsedMs: Date.now() - fixtureStartedAt,
      stageTimeline: stageTimeline.map((entry) => ({ ...entry })),
      dom: {
        path: location.pathname,
        knowledgePageVisible: Boolean(document.querySelector('.knowledge-page')),
        documentCardCount: document.querySelectorAll('[data-testid="knowledge-doc-card"]').length,
        currentDocument: card
          ? {
              title: documentTitle,
              projection: cardSnapshot(card),
            }
          : null,
        upload: {
          rowCount: upload.rowCount,
          processing: upload.processing,
          cancelVisible: upload.cancelVisible,
        },
      },
      transportReceipts: copyTransportReceipts(),
      cancellationProjections: cancellationProjections.map((event) => ({ ...event })),
    }
  }

  async function addManualDocument() {
    const addTrigger = await waitFor(
      () => enabledButton(document, /添加文档|Add Document/i),
      'knowledge add-document trigger',
    )
    addTrigger.click()
    const modal = await waitFor(
      () => document.querySelector('[data-testid="knowledge-add-document-modal"]'),
      'knowledge add-document modal',
    )
    const inputs = [...modal.querySelectorAll('input[type="text"]')]
    const content = modal.querySelector('textarea')
    invariant(inputs.length >= 2, 'Knowledge manual document modal is missing title/source inputs')
    setControlValue(inputs[0], documentTitle)
    setControlValue(content, documentBody)
    const add = await waitFor(
      () => enabledButton(modal, /^添加$|^Add$/i),
      'enabled manual document submit button',
    )
    add.click()
    return waitFor(documentCard, 'manual document card')
  }

  function dispatchSyntheticPng() {
    const input = document.querySelector('.knowledge-page input[type="file"]')
    invariant(input instanceof HTMLInputElement, 'Knowledge file input is unavailable')
    invariant(typeof DataTransfer === 'function', 'Native DataTransfer is unavailable')
    const selected = new File([pngBytes], 'native-cancel.png', { type: 'image/png' })
    const transfer = new DataTransfer()
    transfer.items.add(selected)
    Object.defineProperty(input, 'files', { configurable: true, value: transfer.files })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }

  async function leaveAndReturnToKnowledge() {
    const chat = await waitFor(
      () => document.querySelector('[data-nav-id="chat"]'),
      'sidebar chat navigation',
    )
    chat.click()
    await waitFor(
      () => document.querySelector('[data-testid="chat-input"]'),
      'chat view after knowledge cancellation',
    )
    const knowledge = await waitFor(
      () => document.querySelector('[data-nav-id="knowledge"]'),
      'sidebar knowledge navigation',
    )
    knowledge.click()
    await waitFor(() => document.querySelector('.knowledge-page'), 'knowledge view remount')
  }

  async function execute() {
    sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    history.replaceState({}, '', '/knowledge')
    await progress('fixture-ready')
    await waitFor(() => document.querySelector('.knowledge-page'), 'knowledge page')
    await waitFor(
      () => !document.querySelector('[data-testid="knowledge-add-document-modal"]'),
      'initial knowledge modal absence',
    )

    const report = {
      status: 'PASS',
      nativeDOM: {
        driver: 'injected fixture in temporary Tauri WKWebView',
        realWKWebView: true,
        axPermissionRequired: false,
      },
      reindex: {},
      queueCancelled: {},
    }

    if (!queueCancelOnly) {
      await addManualDocument()
      await progress('manual-document-visible')

    // 手工新增也会走真实语义任务。只有该初始任务终态、UI 明确重新放开按钮后，
    // 下一次点击才严格代表本用例要观察的 reindex 202/child-job 投影。
    await progress('initial-semantic-job-awaiting')
    const initialDocument = await waitFor(
      () => {
        const card = documentCard()
        if (!card) return null
        const reindexButton = enabledButton(card, /重建|Reindex/i)
        if (!reindexButton) return null
        return { card, snapshot: cardSnapshot(card), reindexButton }
      },
      'manual document initial semantic job terminal projection',
      35_000,
    )
    report.reindex.initial = initialDocument.snapshot
    await progress('manual-document-ready-for-reindex')

    const reindexArmReceipt = await json('/__knowledge_webview_boundary__/arm-reindex', {
      method: 'POST',
    })
    const reindexArmStats = await stats()
    await progress('reindex-armed', {
      armReceipt: reindexArmReceipt,
      embeddingRequests: reindexArmStats.embeddingRequests,
      heldEmbeddingRequests: reindexArmStats.heldEmbeddingRequests,
    })
    // arm-reindex 本身是一次异步回环。重新从当前 Vue 树取按钮，避免对初始
    // poll 完成前留下的脱离节点调用 click 而绕开真实 handler。
    const currentReindex = await waitFor(() => {
      const card = documentCard()
      const button = card ? enabledButton(card, /重建|Reindex/i) : null
      return button?.isConnected ? button : null
    }, 'current connected reindex button')
    const reindexReceiptStart = transportReceipts.length
    currentReindex.click()
    const reindexIssued = await waitFor(
      () => findTransportReceipt(reindexReceiptStart, 'reindex', 'issued'),
      'reindex click sidecar transport request',
      10_000,
    )
    await progress('reindex-clicked', {
      transportReceipts: copyTransportReceipts(reindexReceiptStart),
    })
    const reindexResponse = await waitFor(
      () => findTransportReceipt(reindexReceiptStart, 'reindex', 'responded'),
      'reindex sidecar transport response',
      30_000,
    )
    invariant(reindexResponse.status === 202, 'Reindex sidecar response must be HTTP 202')
    invariant(
      typeof reindexResponse.fields?.job_id === 'string' &&
        reindexResponse.fields.job_id.length > 0,
      'Reindex sidecar response must expose a pollable job_id',
    )
    const reindexJobID = reindexResponse.fields.job_id
    const reindexDocumentID =
      typeof reindexResponse.fields?.id === 'string' && reindexResponse.fields.id.length > 0
        ? reindexResponse.fields.id
        : reindexResponse.fields?.document_id
    invariant(
      typeof reindexDocumentID === 'string' && reindexDocumentID.length > 0,
      'Reindex sidecar response must expose its document id',
    )
    const reindexDocumentPath = `/api/v1/knowledge/documents/${encodeURIComponent(reindexDocumentID)}`
    const reindexJobPath = `/api/v1/knowledge/jobs/${encodeURIComponent(reindexJobID)}`
    report.reindex.transport = {
      issued: reindexIssued,
      response: reindexResponse,
    }
    await progress('reindex-sidecar-accepted', {
      transportReceipts: copyTransportReceipts(reindexReceiptStart),
    })

    const detailIssued = await waitFor(
      () =>
        findTransportReceipt(reindexReceiptStart, 'document-detail', 'issued', reindexDocumentPath),
      'reindex canonical document projection request',
      10_000,
    )
    const detailResponse = await waitFor(
      () =>
        findTransportReceipt(
          reindexReceiptStart,
          'document-detail',
          'responded',
          reindexDocumentPath,
        ),
      'reindex canonical document projection response',
      10_000,
    )
    invariant(
      detailResponse.status === 200,
      'Reindex document projection response must be HTTP 200',
    )
    invariant(
      detailResponse.fields?.id === reindexDocumentID,
      'Reindex document projection must return the requested document id',
    )
    invariant(
      detailResponse.fields?.vector_job_id === reindexJobID,
      'Reindex document projection must return the accepted child job_id',
    )
    invariant(
      typeof detailResponse.fields?.vector_job_state === 'string' &&
        detailResponse.fields.vector_job_state.length > 0,
      'Reindex document projection must return a vector_job_state',
    )
    report.reindex.detailProjection = {
      issued: detailIssued,
      response: detailResponse,
    }
    await progress('reindex-detail-projected', {
      transportReceipts: copyTransportReceipts(reindexReceiptStart),
    })

    const jobPollIssued = await waitFor(
      () => findTransportReceipt(reindexReceiptStart, 'job-poll', 'issued', reindexJobPath),
      'reindex child job poll request',
      10_000,
    )
    const jobPollResponse = await waitFor(
      () => findTransportReceipt(reindexReceiptStart, 'job-poll', 'responded', reindexJobPath),
      'reindex child job poll response',
      10_000,
    )
    invariant(jobPollResponse.status === 200, 'Reindex child job poll response must be HTTP 200')
    invariant(
      jobPollResponse.fields?.job_id === reindexJobID,
      'Reindex child job poll must return the accepted job_id',
    )
    invariant(
      typeof jobPollResponse.fields?.state === 'string' && jobPollResponse.fields.state.length > 0,
      'Reindex child job poll must return a job state',
    )
    report.reindex.jobPoll = {
      issued: jobPollIssued,
      response: jobPollResponse,
    }
    await progress('reindex-job-polled', {
      transportReceipts: copyTransportReceipts(reindexReceiptStart),
    })

    let reindexPending = null
    let reindexFastTerminal = false
    try {
      reindexPending = await waitFor(async () => {
        const card = documentCard()
        if (!card) return null
        const snapshot = cardSnapshot(card)
        const currentStats = await stats()
        const semanticProcessing =
          /语义增强|semantic/i.test(snapshot.status) && /增强中|Enhancing/i.test(snapshot.badge)
        if (!semanticProcessing || currentStats.heldEmbeddingRequests !== 1) return null
        return { ...snapshot, heldEmbeddingRequests: currentStats.heldEmbeddingRequests }
      }, 'reindex child-job projection and held embedding')
    } catch (error) {
      const currentStats = await stats()
      const currentCard = documentCard()
      const currentSnapshot = currentCard ? cardSnapshot(currentCard) : null
      const projectionReady = Boolean(
        currentSnapshot &&
          currentSnapshot.status.includes('文本 + 语义已就绪') &&
          currentSnapshot.badge.includes('混合检索') &&
          !currentSnapshot.vectorCancelVisible &&
          !currentSnapshot.reindexDisabled,
      )
      const jobSucceeded = jobPollResponse.fields?.state === 'succeeded'
      if (currentStats.heldEmbeddingRequests !== 0 || !projectionReady || !jobSucceeded) {
        throw error
      }
      reindexFastTerminal = true
      report.reindex.fastTerminal = {
        reason: 'Reindex completed before the loopback embedding hold could be observed',
        heldEmbeddingRequests: currentStats.heldEmbeddingRequests,
      }
      await progress('reindex-fast-terminal', {
        heldEmbeddingRequests: currentStats.heldEmbeddingRequests,
      })
    }
    if (reindexPending) {
      invariant(
        reindexPending.vectorCancelVisible,
        'Pending reindex must expose its real vector-job cancel control',
      )
      report.reindex.pending = reindexPending
      await progress('reindex-child-projected')
      await json('/__knowledge_webview_boundary__/release-reindex', { method: 'POST' })
    }
    const reindexTerminal = await waitFor(
      () => {
        const card = documentCard()
        if (!card) return null
        const snapshot = cardSnapshot(card)
        if (
          !snapshot.status.includes('文本 + 语义已就绪') ||
          !snapshot.badge.includes('混合检索') ||
          snapshot.vectorCancelVisible ||
          snapshot.reindexDisabled
        ) {
          return null
        }
        return snapshot
      },
      'reindex polling terminal projection',
      35_000,
    )
    report.reindex.terminal = reindexTerminal
    await progress(reindexFastTerminal ? 'reindex-fast-terminal-confirmed' : 'reindex-polled-terminal')
  }

    await json('/__knowledge_webview_boundary__/arm-image', { method: 'POST' })
    dispatchSyntheticPng()
    const queueProcessing = await waitFor(async () => {
      const snapshot = uploadSnapshot()
      const currentStats = await stats()
      if (
        snapshot.rowCount !== 1 ||
        !snapshot.processing ||
        !snapshot.cancelVisible ||
        currentStats.heldVisionRequests !== 1
      ) {
        return null
      }
      return { ...snapshot, heldVisionRequests: currentStats.heldVisionRequests }
    }, 'processing upload row with cancellable native job')
    report.queueCancelled.processing = queueProcessing
    await progress('upload-processing-visible')

    const cancel = document.querySelector('[data-testid="knowledge-upload-cancel"]')
    invariant(
      cancel instanceof HTMLButtonElement && !cancel.disabled,
      'Processing upload cancel button is unavailable',
    )
    const cancelReceiptStart = transportReceipts.length
    cancel.click()
    const cancelIssued = await waitFor(
      () => findTransportReceipt(cancelReceiptStart, 'cancel', 'issued'),
      'upload cancel click sidecar transport request',
      10_000,
    )
    const cancelResponse = await waitFor(
      () => findTransportReceipt(cancelReceiptStart, 'cancel', 'responded'),
      'upload cancel sidecar transport response',
      30_000,
    )
    invariant(
      cancelResponse.status === 200,
      'Upload cancellation sidecar response must be HTTP 200',
    )
    invariant(
      cancelResponse.fields?.state === 'cancelled',
      'Upload cancellation sidecar response must expose cancelled state',
    )
    report.queueCancelled.transport = {
      issued: cancelIssued,
      response: cancelResponse,
    }
    await progress('upload-cancel-sidecar-accepted', {
      transportReceipts: copyTransportReceipts(cancelReceiptStart),
    })
    const immediateRows = await waitFor(
      () =>
        document.querySelectorAll('[data-testid="knowledge-upload-job"]').length === 0
          ? true
          : null,
      'temporary upload row removal after cancellation',
    )
    report.queueCancelled.immediateRows = immediateRows === true ? 0 : immediateRows
    await progress('upload-row-removed')

    await leaveAndReturnToKnowledge()
    const remountRows = await waitFor(
      () =>
        document.querySelectorAll('[data-testid="knowledge-upload-job"]').length === 0
          ? true
          : null,
      'cancelled upload absence after knowledge remount',
    )
    report.queueCancelled.remountRows = remountRows === true ? 0 : remountRows
    report.queueCancelled.cancelledProjectionDoesNotReappear = report.queueCancelled.remountRows === 0
    await progress('cancelled-projection-absent-after-remount')

    const finalStats = await stats()
    invariant(
      finalStats.heldVisionRequests === 1,
      'Cancellation scenario must use exactly one controlled image request',
    )
    invariant(
      finalStats.externalModelInvocations === 0,
      'Native boundary must not invoke an external model',
    )
    invariant(finalStats.ollamaInvocations === 0, 'Native boundary must not invoke Ollama')
    report.transportReceipts = copyTransportReceipts()
    report.cancellationProjections = cancellationProjections.map((event) => ({ ...event }))
    return report
  }

  async function complete(report) {
    if (terminalReportSent) return false
    terminalReportSent = true
    if (watchdogTimer !== null) {
      clearTimeout(watchdogTimer)
      watchdogTimer = null
    }
    await json('/__knowledge_webview_boundary__/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    })
    return true
  }

  function startWatchdog() {
    watchdogTimer = setTimeout(() => {
      void (async () => {
        if (terminalReportSent) return
        const diagnostic = watchdogDiagnostic()
        try {
          await progress('watchdog-timeout', {
            diagnostic,
            transportReceipts: diagnostic.transportReceipts,
          })
          await complete({
            status: 'FAIL',
            error: `WebView fixture watchdog reached ${diagnostic.currentStage}`,
            diagnostic,
            transportReceipts: copyTransportReceipts(),
            cancellationProjections: cancellationProjections.map((event) => ({ ...event })),
          })
        } catch {
          // 回传通道不可用时由外层超时与应用日志保留失败证据。
        }
      })()
    }, 50_000)
  }

  startWatchdog()
  execute()
    .then((report) => complete(report))
    .catch(async (error) => {
      const report = {
        status: 'FAIL',
        error: error instanceof Error ? error.message : String(error),
        transportReceipts: copyTransportReceipts(),
        cancellationProjections: cancellationProjections.map((event) => ({ ...event })),
      }
      try {
        await complete(report)
      } catch {
        // 回传通道不可用时由外层超时与应用日志保留失败证据。
      }
    })
})()
