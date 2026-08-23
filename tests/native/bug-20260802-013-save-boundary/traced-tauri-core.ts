import { invoke as actualInvoke } from '__BUG013_ACTUAL_TAURI_CORE__'

export * from '__BUG013_ACTUAL_TAURI_CORE__'

export interface ScenarioTrace {
  commands: Record<string, number>
  appendCalls: number
  appendBytes: number
  maxChunkBytes: number
  maxStringArgumentBytes: number
  forbiddenBase64Keys: string[]
  operationIds: string[]
  grantNames: Array<{ command: string; name: string }>
  rejectedCommands: Array<{ command: string; error: string }>
  copyResolved: number
}

interface TraceConfiguration {
  exactBytes: number
  progress: (stage: string, detail?: Record<string, unknown>) => Promise<void>
  abortController: () => AbortController | null
}

const traces: Record<string, ScenarioTrace> = {}
let activeScenario = 'startup'
let configuration: TraceConfiguration | null = null

export function configureInvokeTrace(value: TraceConfiguration): void {
  configuration = value
}

export function setInvokeScenario(value: string): void {
  activeScenario = value
}

export function allInvokeTraces(): Record<string, ScenarioTrace> {
  return traces
}

export function traceFor(scenario: string): ScenarioTrace {
  traces[scenario] ??= {
    commands: {},
    appendCalls: 0,
    appendBytes: 0,
    maxChunkBytes: 0,
    maxStringArgumentBytes: 0,
    forbiddenBase64Keys: [],
    operationIds: [],
    grantNames: [],
    rejectedCommands: [],
    copyResolved: 0,
  }
  return traces[scenario]
}

function inspectArgument(value: unknown, trace: ScenarioTrace, key = ''): void {
  if (ArrayBuffer.isView(value)) return
  if (typeof value === 'string') {
    trace.maxStringArgumentBytes = Math.max(trace.maxStringArgumentBytes, value.length)
    if (/base64/i.test(key) || /^(?:data:|[A-Za-z0-9+/]{4096})/.test(value)) {
      trace.forbiddenBase64Keys.push(key || '<string>')
    }
    return
  }
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 32)) inspectArgument(entry, trace, key)
    return
  }
  for (const [childKey, child] of Object.entries(value)) {
    inspectArgument(child, trace, childKey)
  }
}

export async function invoke<T>(
  command: string,
  args: Record<string, unknown> = {},
  options?: unknown,
): Promise<T> {
  const trace = traceFor(activeScenario)
  trace.commands[command] = (trace.commands[command] ?? 0) + 1
  inspectArgument(args, trace)
  const operation = args.operationId
  if (typeof operation === 'string' && !trace.operationIds.includes(operation)) {
    trace.operationIds.push(operation)
  }
  const chunk = args.chunk
  if (command === 'append_file_grant_chunk' && ArrayBuffer.isView(chunk)) {
    trace.appendCalls += 1
    trace.appendBytes += chunk.byteLength
    trace.maxChunkBytes = Math.max(trace.maxChunkBytes, chunk.byteLength)
  }

  try {
    if (command === 'copy_file_grant' && activeScenario === 'copy-failure') {
      await configuration?.progress('copy-failure-arming')
      // 复制失败分支在真实 Tauri invoke 边界注入确定性错误，避免 macOS 权限变化导致系统调用悬挂。
      // Save grant、staging grant 及两侧清理由真实实现执行，生产代码仍走同一错误收敛路径。
      throw new Error('copy failure injected at native invoke boundary')
    }
    const result = await actualInvoke<T>(command, args, options)
    if (
      result
      && typeof result === 'object'
      && 'name' in result
      && typeof result.name === 'string'
    ) {
      trace.grantNames.push({ command, name: result.name })
    }
    const activeAbort = configuration?.abortController()
    if (
      command === 'append_file_grant_chunk'
      && activeScenario === 'abort-at-half'
      && typeof result === 'number'
      && configuration
      && result >= configuration.exactBytes / 2
      && activeAbort
      && !activeAbort.signal.aborted
    ) {
      activeAbort.abort()
      await configuration.progress('abort-at-half', { stagedBytes: result })
    }
    if (command === 'copy_file_grant') trace.copyResolved += 1
    return result
  } catch (error) {
    trace.rejectedCommands.push({
      command,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
