import { invoke } from '@tauri-apps/api/core'
import { createApp, defineComponent, h, ref } from 'vue'
import { createI18n } from 'vue-i18n'

import ChatExportMenu from '@/components/chat/ChatExportMenu.vue'
import {
  createNativeFileOperation,
  discardFileGrant,
  type NativeFileGrant,
} from '@/api/native-files'
import { saveBlobInApp } from '@/utils/download'
import {
  allInvokeTraces,
  configureInvokeTrace,
  setInvokeScenario,
  traceFor,
} from './traced-tauri-core'

const fixtureOrigin = import.meta.env.VITE_BUG013_FIXTURE_ORIGIN as string
const exactBytes = 100 * 1024 * 1024
const ipcChunkBytes = 256 * 1024
const saveLimitBytes = 512 * 1024 * 1024
const startedAt = Date.now()

let activeScenario = 'startup'
let activeAbort: AbortController | null = null

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => window.setTimeout(resolvePromise, milliseconds))
}

async function waitFor<T>(
  read: () => T | null | undefined | false,
  label: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value) return value
    await sleep(50)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function post(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${fixtureOrigin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`Fixture request failed: ${response.status} ${path}`)
}

async function progress(stage: string, detail: Record<string, unknown> = {}): Promise<void> {
  await post('/__bug013__/progress', {
    stage,
    elapsedMs: Date.now() - startedAt,
    ...detail,
  })
}

function makeDeterministicBlob(): Blob {
  const parts: Uint8Array[] = []
  const chunkCount = exactBytes / ipcChunkBytes
  for (let index = 0; index < chunkCount; index += 1) {
    const chunk = new Uint8Array(ipcChunkBytes)
    chunk.fill(index % 251)
    parts.push(chunk)
  }
  return new Blob(parts, { type: 'application/octet-stream' })
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

async function runExactSave(blob: Blob): Promise<Record<string, unknown>> {
  activeScenario = 'exact-100mib'
  setInvokeScenario(activeScenario)
  traceFor(activeScenario)
  await progress('exact-blob-ready', { size: blob.size })
  await sleep(1_500)
  await progress('exact-dialog-opening')
  const result = await saveBlobInApp(blob, 'bug013-exact-100mib.bin')
  await progress('exact-grant-result', { leafName: result })
  invariant(
    result === 'bug013-exact-100mib.bin',
    `Exact Save returned the wrong leaf name: ${String(result)}`,
  )
  const trace = traceFor(activeScenario)
  invariant(trace.appendCalls === exactBytes / ipcChunkBytes, 'Exact Save used the wrong chunk count')
  invariant(trace.appendBytes === exactBytes, 'Exact Save staged the wrong byte count')
  invariant(trace.maxChunkBytes === ipcChunkBytes, 'Exact Save exceeded the IPC chunk ceiling')
  invariant(trace.copyResolved === 1, 'Exact Save did not complete one native copy')
  invariant(trace.forbiddenBase64Keys.length === 0, 'Exact Save exposed a base64-sized IPC argument')
  await progress('exact-success', { leafName: result })
  return { leafName: result, size: blob.size, trace }
}

async function runNativeLimitRejections(): Promise<Record<string, unknown>> {
  activeScenario = 'native-limit-rejections'
  setInvokeScenario(activeScenario)
  traceFor(activeScenario)

  const saveLimitOperation = createNativeFileOperation('bug013-save-limit-plus-one')
  let saveLimitError = ''
  try {
    await invoke('create_staging_file_grant', {
      operationId: saveLimitOperation,
      purpose: 'save_copy',
      name: 'save-limit-plus-one.bin',
      mime: 'application/octet-stream',
      size: saveLimitBytes + 1,
    })
  } catch (error) {
    saveLimitError = errorText(error)
  }
  invariant(saveLimitError.includes('staging file size is invalid'), 'Save limit +1 was not rejected')

  const hundredMiBPlusOneOperation = createNativeFileOperation('bug013-100mib-plus-one')
  const hundredMiBPlusOneGrant = await invoke<NativeFileGrant>('create_staging_file_grant', {
    operationId: hundredMiBPlusOneOperation,
    purpose: 'save_copy',
    name: 'hundred-mib-plus-one.bin',
    mime: 'application/octet-stream',
    size: exactBytes + 1,
  })
  await discardFileGrant(hundredMiBPlusOneGrant)

  const chunkOperation = createNativeFileOperation('bug013-ipc-chunk-plus-one')
  const chunkGrant = await invoke<NativeFileGrant>('create_staging_file_grant', {
    operationId: chunkOperation,
    purpose: 'save_copy',
    name: 'ipc-chunk-plus-one.bin',
    mime: 'application/octet-stream',
    size: ipcChunkBytes + 1,
  })
  let chunkError = ''
  try {
    await invoke('append_file_grant_chunk', {
      grantId: chunkGrant.grantId,
      operationId: chunkGrant.operationId,
      purpose: chunkGrant.purpose,
      offset: 0,
      chunk: new Uint8Array(256 * 1024 + 1),
    })
  } catch (error) {
    chunkError = errorText(error)
  } finally {
    await discardFileGrant(chunkGrant)
  }
  invariant(chunkError.includes('staging chunk size is invalid'), 'IPC chunk +1 was not rejected')
  await progress('native-limit-rejections-complete')
  return {
    saveLimitPlusOneBytes: saveLimitBytes + 1,
    saveLimitError,
    hundredMiBPlusOneDeclaredAccepted: true,
    ipcChunkPlusOneBytes: ipcChunkBytes + 1,
    ipcChunkError: chunkError,
    trace: traceFor(activeScenario),
  }
}

async function runDialogCancel(): Promise<Record<string, unknown>> {
  activeScenario = 'dialog-cancel'
  setInvokeScenario(activeScenario)
  traceFor(activeScenario)
  await progress('cancel-dialog-opening')
  const result = await saveBlobInApp(new Blob(['cancel']), 'bug013-dialog-cancel.bin')
  invariant(result === null, 'Dialog cancellation did not return null')
  const trace = traceFor(activeScenario)
  invariant(trace.commands.create_staging_file_grant === undefined, 'Dialog cancel created staging')
  invariant(trace.commands.copy_file_grant === undefined, 'Dialog cancel copied bytes')
  await progress('cancel-complete')
  return { result, trace }
}

async function runAbortAtHalf(blob: Blob): Promise<Record<string, unknown>> {
  activeScenario = 'abort-at-half'
  setInvokeScenario(activeScenario)
  traceFor(activeScenario)
  activeAbort = new AbortController()
  await progress('abort-dialog-opening')
  let caught = ''
  try {
    await saveBlobInApp(blob, 'bug013-abort-at-half.bin', activeAbort.signal)
  } catch (error) {
    caught = errorText(error)
  } finally {
    activeAbort = null
  }
  invariant(caught.startsWith('AbortError:'), 'Half-stage cancellation did not surface AbortError')
  const trace = traceFor(activeScenario)
  invariant(trace.appendBytes === exactBytes / 2, 'Cancellation did not stop at the 50% boundary')
  invariant(trace.commands.copy_file_grant === undefined, 'Cancellation reached native copy')
  invariant((trace.commands.discard_file_grant ?? 0) >= 2, 'Cancellation did not reclaim both grants')
  await progress('abort-complete', { stagedBytes: trace.appendBytes })
  return { error: caught, trace }
}

async function runCopyFailure(): Promise<Record<string, unknown>> {
  activeScenario = 'copy-failure'
  setInvokeScenario(activeScenario)
  traceFor(activeScenario)
  await progress('copy-failure-dialog-opening')
  let caught = ''
  try {
    await saveBlobInApp(
      new Blob([new Uint8Array(ipcChunkBytes)], { type: 'application/octet-stream' }),
      'bug013-copy-failure.bin',
    )
  } catch (error) {
    caught = errorText(error)
  }
  invariant(caught.length > 0, 'Copy failure unexpectedly succeeded')
  const trace = traceFor(activeScenario)
  invariant(trace.commands.copy_file_grant === 1, 'Copy failure did not reach the native copy command')
  invariant((trace.commands.discard_file_grant ?? 0) >= 2, 'Copy failure did not attempt both cleanups')
  await progress('copy-failure-complete', { error: caught })
  return { error: caught, trace }
}

function mountConsumer(): { visible: ReturnType<typeof ref<boolean>> } {
  const visible = ref(true)
  const Root = defineComponent({
    setup() {
      return () => h('section', { id: 'consumer-entry' }, [
        visible.value
          ? h(ChatExportMenu, {
              messages: [{
                id: 'bug013-message',
                role: 'user',
                content: 'BUG-20260802-013 current consumer entry',
                timestamp: '2026-08-22T00:00:00.000Z',
              }],
              sessionTitle: 'BUG013 consumer',
              onClose: () => { visible.value = false },
            })
          : h('p', { id: 'consumer-closed' }, 'closed'),
      ])
    },
  })
  const i18n = createI18n({
    legacy: false,
    locale: 'zh-CN',
    messages: {
      'zh-CN': {
        common: { download: '下载' },
        chat: {
          title: '对话',
          exportedAt: '导出时间',
          exportUser: '用户',
          modeAgent: '智能体',
          exportMarkdownDesc: '导出 Markdown',
          exportJsonDesc: '导出 JSON',
        },
      },
    },
  })
  createApp(Root).use(i18n).mount('#app')
  return { visible }
}

async function runConsumerEntry(consumer: { visible: ReturnType<typeof ref<boolean>> }): Promise<Record<string, unknown>> {
  activeScenario = 'consumer-entry'
  setInvokeScenario(activeScenario)
  traceFor(activeScenario)
  const button = await waitFor(
    () => document.querySelector<HTMLButtonElement>('.hc-export-menu__item'),
    'ChatExportMenu Markdown action',
  )
  await progress('consumer-dialog-opening')
  button.click()
  await waitFor(() => traceFor(activeScenario).copyResolved > 0, 'consumer native copy', 45_000)
  await waitFor(() => !consumer.visible.value, 'consumer close state')
  const trace = traceFor(activeScenario)
  invariant(trace.commands.pick_save_file_grant === 1, 'Consumer did not open one Save grant')
  invariant(trace.copyResolved === 1, 'Consumer did not complete one native copy')
  await progress('consumer-complete')
  return { closed: !consumer.visible.value, trace }
}

async function execute(): Promise<void> {
  invariant(Boolean(fixtureOrigin), 'Fixture origin is missing')
  invariant(Boolean((globalThis as Record<string, unknown>).isTauri), 'Fixture is not running in Tauri')
  configureInvokeTrace({
    exactBytes,
    progress,
    abortController: () => activeAbort,
  })
  const consumer = mountConsumer()
  await progress('fixture-ready', { title: document.title })
  const blob = makeDeterministicBlob()
  invariant(blob.size === exactBytes, 'Deterministic Blob has the wrong size')

  const scenarios = {
    limits: await runNativeLimitRejections(),
    exact: await runExactSave(blob),
    dialogCancel: await runDialogCancel(),
    abortAtHalf: await runAbortAtHalf(blob),
    copyFailure: await runCopyFailure(),
    consumer: await runConsumerEntry(consumer),
  }
  await post('/__bug013__/report', { status: 'PASS', scenarios })
}

window.addEventListener('error', (event) => {
  void progress('runtime-error', { error: String(event.message || event.error) })
})
window.addEventListener('unhandledrejection', (event) => {
  void progress('runtime-rejection', { error: errorText(event.reason) })
})

void execute().catch(async (error) => {
  await post('/__bug013__/report', {
    status: 'FAIL',
    error: errorText(error),
    activeScenario,
    traces: allInvokeTraces(),
  }).catch(() => {})
})
