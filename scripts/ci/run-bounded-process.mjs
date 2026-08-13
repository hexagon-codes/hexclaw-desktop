#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1_000
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const DEFAULT_TERMINATE_GRACE_MS = 2_000
const DEFAULT_TERMINATE_CONFIRM_MS = 2_000
const PROCESS_GROUP_POLL_MS = 20
const PARENT_SIGNALS = Object.freeze(['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM'])
const PROCESS_TABLE_MAX_BYTES = 4 * 1024 * 1024
const OPTION_NAMES = new Set([
  'acceptedExitCodes',
  'cwd',
  'env',
  'maxOutputBytes',
  'terminateConfirmMs',
  'terminateGraceMs',
  'timeoutMs',
])
const MAX_EXTRA_FILE_DESCRIPTORS = 4
const MAX_SOURCE_FILE_DESCRIPTOR = 65_535
const MAX_CHILD_FILE_DESCRIPTOR = 9

export class BoundedProcessError extends Error {
  constructor(category, details = {}) {
    const fields = [`Bounded process failed: category=${category}`]
    if (Number.isInteger(details.exitCode)) fields.push(`exit=${details.exitCode}`)
    if (typeof details.signal === 'string') fields.push(`signal=${details.signal}`)
    super(fields.join(' '))
    this.name = 'BoundedProcessError'
    this.category = category
    this.exitCode = Number.isInteger(details.exitCode) ? details.exitCode : undefined
    this.signal = typeof details.signal === 'string' ? details.signal : undefined
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validateOptions(options) {
  if (!isPlainObject(options)) throw new BoundedProcessError('invalid-options')
  if (Object.keys(options).some((name) => !OPTION_NAMES.has(name))) {
    throw new BoundedProcessError('unknown-option')
  }
  return options
}

function validateFileDescriptorMappings(mappings) {
  if (
    !Array.isArray(mappings) ||
    mappings.length < 1 ||
    mappings.length > MAX_EXTRA_FILE_DESCRIPTORS
  ) {
    throw new BoundedProcessError('invalid-file-descriptors')
  }
  const childDescriptors = new Set()
  for (const mapping of mappings) {
    if (
      !isPlainObject(mapping) ||
      Object.keys(mapping).length !== 2 ||
      !Object.hasOwn(mapping, 'childFd') ||
      !Object.hasOwn(mapping, 'sourceFd') ||
      !Number.isInteger(mapping.sourceFd) ||
      mapping.sourceFd < 0 ||
      mapping.sourceFd > MAX_SOURCE_FILE_DESCRIPTOR ||
      !Number.isInteger(mapping.childFd) ||
      mapping.childFd < 3 ||
      mapping.childFd > MAX_CHILD_FILE_DESCRIPTOR ||
      childDescriptors.has(mapping.childFd)
    ) {
      throw new BoundedProcessError('invalid-file-descriptors')
    }
    childDescriptors.add(mapping.childFd)
  }
  return mappings.map((mapping) => Object.freeze({ ...mapping }))
}

function childStdio(mappings) {
  const stdio = ['ignore', 'pipe', 'pipe']
  for (const { childFd, sourceFd } of mappings) {
    while (stdio.length <= childFd) stdio.push('ignore')
    stdio[childFd] = sourceFd
  }
  return stdio
}

function positiveInteger(value, fallback, maximum, label) {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
    throw new BoundedProcessError(`invalid-${label}`)
  }
  return selected
}

function validateEnvironment(environment) {
  if (
    environment === null ||
    typeof environment !== 'object' ||
    Array.isArray(environment) ||
    (Object.getPrototypeOf(environment) !== Object.prototype &&
      Object.getPrototypeOf(environment) !== null)
  ) {
    throw new BoundedProcessError('invalid-environment')
  }
  const clean = Object.create(null)
  for (const [name, value] of Object.entries(environment)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
      typeof value !== 'string' ||
      name.includes('\0') ||
      value.includes('\0')
    ) {
      throw new BoundedProcessError('invalid-environment')
    }
    clean[name] = value
  }
  return clean
}

function acceptedExitCodeSet(value) {
  if (value === undefined) return new Set([0])
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 16 ||
    value.some((code) => !Number.isInteger(code) || code < 0 || code > 255) ||
    new Set(value).size !== value.length
  ) {
    throw new BoundedProcessError('invalid-exit-policy')
  }
  return new Set(value)
}

function processGroupExists(processGroupID) {
  try {
    process.kill(-processGroupID, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    throw new BoundedProcessError('process-tree-state')
  }
}

function processTable() {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], {
    encoding: 'utf8',
    env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    maxBuffer: PROCESS_TABLE_MAX_BYTES,
    timeout: 2_000,
  })
  if (result.status !== 0 || result.signal !== null || result.error) {
    throw new BoundedProcessError('process-tree-state')
  }
  return result.stdout
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line))
    .filter((match) => match !== null)
    .map((match) =>
      Object.freeze({
        pgid: Number(match[3]),
        pid: Number(match[1]),
        ppid: Number(match[2]),
        startedAt: match[4],
      }),
    )
}

function sameProcessIdentity(left, right) {
  return (
    left !== undefined &&
    right !== undefined &&
    left.pid === right.pid &&
    left.pgid === right.pgid &&
    left.startedAt === right.startedAt
  )
}

function processGroupSnapshot(processGroupID) {
  return processTable().filter(({ pgid }) => pgid === processGroupID)
}

function relevantProcessGroupMembers(processGroupID, known) {
  const members = processGroupSnapshot(processGroupID)
  const relevant = new Map()
  for (const member of members) {
    const previous = known.get(member.pid)
    if (sameProcessIdentity(previous, member)) relevant.set(member.pid, member)
  }
  let changed = true
  while (changed) {
    changed = false
    for (const member of members) {
      if (relevant.has(member.pid)) continue
      if (relevant.has(member.ppid) || known.has(member.ppid)) {
        known.set(member.pid, member)
        relevant.set(member.pid, member)
        changed = true
      }
    }
  }
  return [...relevant.values()]
}

function signalProcessIdentity(identity, signal) {
  const current = processTable().find(({ pid }) => pid === identity.pid)
  if (!sameProcessIdentity(identity, current)) return false
  try {
    process.kill(identity.pid, signal)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw new BoundedProcessError('process-tree-signal')
  }
}

function signalProcessGroup(processGroupID, signal) {
  try {
    process.kill(-processGroupID, signal)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    // macOS 会对尚未被父进程回收的短命进程组返回 EPERM；先等待 close 收敛再判失败。
    if (error?.code === 'EPERM') return false
    // 进程组可能在发信号的系统调用边界恰好退出；确认消失后按成功收敛处理。
    if (!processGroupExists(processGroupID)) return false
    throw new BoundedProcessError('process-tree-signal')
  }
}

async function waitForProcessGroupExit(processGroupID, known, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (relevantProcessGroupMembers(processGroupID, known).length > 0) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await delay(Math.min(PROCESS_GROUP_POLL_MS, remaining))
  }
  return true
}

async function terminateProcessGroup(processGroupID, graceMs, confirmMs, groupLeaderIsLive) {
  const initial = processGroupSnapshot(processGroupID)
  if (initial.length === 0) return
  const known = new Map(initial.map((identity) => [identity.pid, identity]))
  if (groupLeaderIsLive) {
    signalProcessGroup(processGroupID, 'SIGTERM')
  } else {
    for (const identity of initial) signalProcessIdentity(identity, 'SIGTERM')
  }
  if (await waitForProcessGroupExit(processGroupID, known, graceMs)) return

  const deadline = Date.now() + confirmMs
  while (Date.now() < deadline) {
    const remaining = relevantProcessGroupMembers(processGroupID, known)
    if (remaining.length === 0) return
    // 升级阶段只向已核验 start identity 的 PID 发信号，不再二次使用可复用 PGID。
    for (const identity of remaining) signalProcessIdentity(identity, 'SIGKILL')
    await delay(Math.min(PROCESS_GROUP_POLL_MS, Math.max(1, deadline - Date.now())))
  }
  if (relevantProcessGroupMembers(processGroupID, known).length > 0) {
    throw new BoundedProcessError('process-tree-stuck')
  }
}

async function runBoundedProcessInternal(command, args, options, fileDescriptorMappings) {
  if (process.platform === 'win32') {
    return Promise.reject(new BoundedProcessError('unsupported-platform'))
  }
  validateOptions(options)
  if (typeof command !== 'string' || !isAbsolute(command) || command.includes('\0')) {
    return Promise.reject(new BoundedProcessError('invalid-command'))
  }
  if (
    !Array.isArray(args) ||
    args.some((value) => typeof value !== 'string' || value.includes('\0'))
  ) {
    return Promise.reject(new BoundedProcessError('invalid-arguments'))
  }
  const timeoutMs = positiveInteger(
    options.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    'timeout',
  )
  const maxOutputBytes = positiveInteger(
    options.maxOutputBytes,
    DEFAULT_MAX_OUTPUT_BYTES,
    DEFAULT_MAX_OUTPUT_BYTES,
    'output-limit',
  )
  const terminateGraceMs = positiveInteger(
    options.terminateGraceMs,
    DEFAULT_TERMINATE_GRACE_MS,
    DEFAULT_TERMINATE_GRACE_MS,
    'terminate-grace',
  )
  const terminateConfirmMs = positiveInteger(
    options.terminateConfirmMs,
    DEFAULT_TERMINATE_CONFIRM_MS,
    DEFAULT_TERMINATE_CONFIRM_MS,
    'terminate-confirm',
  )
  const acceptedExitCodes = acceptedExitCodeSet(options.acceptedExitCodes)
  if (typeof options.cwd !== 'string' || !isAbsolute(options.cwd) || options.cwd.includes('\0')) {
    return Promise.reject(new BoundedProcessError('invalid-cwd'))
  }
  let environment
  try {
    environment = validateEnvironment(options.env)
  } catch (error) {
    return Promise.reject(error)
  }
  const cwd = resolve(options.cwd)

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    let terminalCategory = ''
    let terminalSignal = ''
    let terminationPromise
    let outputBytes = 0
    const stdout = []
    const stderr = []
    let child
    try {
      child = spawn(command, args, {
        cwd,
        detached: true,
        env: environment,
        shell: false,
        stdio: childStdio(fileDescriptorMappings),
        windowsHide: true,
      })
    } catch {
      rejectPromise(new BoundedProcessError('start-failed'))
      return
    }
    const signalHandlers = new Map()
    const removeSignalHandlers = () => {
      for (const [signal, handler] of signalHandlers) process.off(signal, handler)
      signalHandlers.clear()
    }
    const terminate = (category, parentSignal = '') => {
      if (terminalCategory) return
      terminalCategory = category
      terminalSignal = parentSignal
      clearTimeout(timeout)
      if (!child.pid) return
      // 固定使用创建时的进程组 ID；组消失后不再保留延迟信号，避免误伤复用 PID。
      terminationPromise = terminateProcessGroup(
        child.pid,
        terminateGraceMs,
        terminateConfirmMs,
        true,
      ).then(
        () => ({ error: null }),
        (error) => ({ error }),
      )
    }
    const collect = (target) => (chunk) => {
      if (terminalCategory) return
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (outputBytes + bytes.length > maxOutputBytes) {
        terminate('output-limit')
        return
      }
      outputBytes += bytes.length
      target.push(bytes)
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    const timeout = setTimeout(() => terminate('timeout'), timeoutMs)
    timeout.unref?.()
    for (const signal of PARENT_SIGNALS) {
      const handler = () => terminate('parent-signal', signal)
      signalHandlers.set(signal, handler)
      process.on(signal, handler)
    }
    child.once('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      removeSignalHandlers()
      rejectPromise(new BoundedProcessError('start-failed'))
    })
    child.once('close', async (code, signal) => {
      if (settled) return
      clearTimeout(timeout)
      if (terminalCategory) {
        const termination = await terminationPromise
        removeSignalHandlers()
        if (!termination?.error) {
          settled = true
          if (terminalSignal === 'SIGQUIT') {
            process.kill(process.pid, terminalSignal)
            return
          }
          const error = new BoundedProcessError(terminalCategory, {
            signal: terminalSignal || signal,
          })
          rejectPromise(error)
        } else {
          settled = true
          rejectPromise(termination.error)
        }
        return
      }
      if (child.pid && processGroupExists(child.pid)) {
        terminalCategory = 'process-tree-leak'
        try {
          await terminateProcessGroup(child.pid, terminateGraceMs, terminateConfirmMs, false)
        } catch (error) {
          settled = true
          removeSignalHandlers()
          rejectPromise(error)
          return
        }
        settled = true
        removeSignalHandlers()
        rejectPromise(new BoundedProcessError(terminalCategory, { signal }))
        return
      }
      settled = true
      removeSignalHandlers()
      if (signal !== null || !acceptedExitCodes.has(code)) {
        rejectPromise(new BoundedProcessError('exit', { exitCode: code, signal }))
        return
      }
      resolvePromise(
        Object.freeze({
          code: Number.isInteger(code) ? code : -1,
          signal: signal ?? null,
          stderr: Buffer.concat(stderr).toString('utf8'),
          stdout: Buffer.concat(stdout).toString('utf8'),
        }),
      )
    })
  })
}

export async function runBoundedProcess(command, args, options = {}) {
  return runBoundedProcessInternal(command, args, options, [])
}

// 该入口仅供可信内部模块把预先安全打开的描述符传给子进程，不暴露任意 stdio 配置。
export async function runBoundedProcessWithFileDescriptors(command, args, options = {}, mappings) {
  let validatedMappings
  try {
    validatedMappings = validateFileDescriptorMappings(mappings)
  } catch (error) {
    return Promise.reject(error)
  }
  return runBoundedProcessInternal(command, args, options, validatedMappings)
}

function parseCLI(argv) {
  const separator = argv.indexOf('--')
  if (separator < 0 || separator === argv.length - 1) throw new BoundedProcessError('cli-arguments')
  const options = { env: {} }
  for (let index = 0; index < separator; index += 2) {
    const name = argv[index]
    const raw = argv[index + 1]
    if (!raw) throw new BoundedProcessError('cli-arguments')
    if (name === '--timeout-ms') options.timeoutMs = Number(raw)
    else if (name === '--max-output-bytes') options.maxOutputBytes = Number(raw)
    else if (name === '--terminate-grace-ms') options.terminateGraceMs = Number(raw)
    else if (name === '--terminate-confirm-ms') options.terminateConfirmMs = Number(raw)
    else if (name === '--cwd') options.cwd = raw
    else if (name === '--env') {
      const equals = raw.indexOf('=')
      if (equals < 1) throw new BoundedProcessError('cli-arguments')
      options.env[raw.slice(0, equals)] = raw.slice(equals + 1)
    } else throw new BoundedProcessError('cli-arguments')
  }
  return { command: argv[separator + 1], args: argv.slice(separator + 2), options }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  Promise.resolve()
    .then(() => parseCLI(process.argv.slice(2)))
    .then(({ command, args, options }) => runBoundedProcess(command, args, options))
    .then(() => {
      process.stdout.write('PASS: bounded-process category=success\n')
      process.exitCode = 0
    })
    .catch(async (error) => {
      const category = error instanceof BoundedProcessError ? error.category : 'internal'
      const fields = [`ERROR: bounded-process category=${category}`]
      if (Number.isInteger(error?.exitCode)) fields.push(`exit=${error.exitCode}`)
      if (typeof error?.signal === 'string') fields.push(`signal=${error.signal}`)
      await new Promise((resolveWrite) =>
        process.stderr.write(`${fields.join(' ')}\n`, resolveWrite),
      )
      if (typeof error?.signal === 'string') {
        process.kill(process.pid, error.signal)
        return
      }
      process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1
    })
}
