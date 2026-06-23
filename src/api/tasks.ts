import { apiGet, apiPost } from './client'
import { env } from '@/config/env'
import { DESKTOP_USER_ID } from '@/constants'
import type { CronJob, CronJobInput, JobSpec } from '@/types'

export type { CronJob, CronJobInput, JobSpec }

/** 创建任务时给后端 LLM 编译的超时预算（仅同步 JSON 模式备用；SSE 模式无 timeout）。 */
export const CRON_CREATE_TIMEOUT_MS = 120_000

/** SSE 编译阶段 — 与后端 cron.ProgressStage 对齐。 */
export type CronCompileStage = 'analyzing' | 'calling_llm' | 'validating' | 'persisting'

export interface CronCompileProgress {
  stage: CronCompileStage
  message: string
}

export interface CreateCronJobResult {
  job: CronJob
  spec_preview: JobSpec
}

export interface CreateCronJobStreamOptions {
  /** 阶段事件回调（按 analyzing → calling_llm → validating → persisting 顺序到来）。 */
  onProgress?: (p: CronCompileProgress) => void
  /** 取消信号 — 中断后 SSE 流关闭，后端 ctx.Done() 中断编译。 */
  signal?: AbortSignal
  /** BUG-A 超时兜底（毫秒）。超时后中断 SSE 并 reject 友好错误。默认 180000（3 分钟）。 */
  timeoutMs?: number
}

/** SSE 编译默认超时 — 本地大模型编译 cron 脚本 p99 < 3 分钟；超过视为卡死。 */
export const CRON_SSE_TIMEOUT_MS = 180_000

/**
 * D1.2 统一 endpoint client：POST /api/v1/cronjob 单入口 7-action。
 *
 * 所有后续 getCronJobs / pause / resume / trigger / delete 都路由到这里。
 */
export interface CronJobUnifiedRequest {
  action: 'create' | 'update' | 'list' | 'pause' | 'resume' | 'remove' | 'run'
  idempotency_key?: string
  user_id?: string
  draft?: {
    name: string
    schedule: string
    prompt: string
    deliver?: string[]
    /** IM 投递目标会话 id —— IM deliver 时必发，否则后端 Deliverer 对 IM 目标硬失败（修复 AP-034 类型债：
     *  此前靠 createCronJobJSON 条件 spread 运行时下发但类型不可见，重构易丢、回退历史 P0）。 */
    chat_id?: string
  }
  job_id?: string
  include_paused?: boolean
}

export interface CronJobUnifiedResponse {
  action: string
  job?: CronJob
  jobs?: CronJob[]
  total?: number
  quota?: { used: number; limit: number }
  ok?: boolean
}

export function cronjobAction(req: CronJobUnifiedRequest): Promise<CronJobUnifiedResponse> {
  return apiPost<CronJobUnifiedResponse>('/api/v1/cronjob', {
    user_id: DESKTOP_USER_ID,
    ...req,
  })
}

/** D2.1 Layer 2 LLM 解析端点。 */
export interface CronParseResponse {
  draft?: {
    name: string
    schedule: string
    prompt: string
    deliver?: string[]
  }
  needs_clarification?: boolean
  suggestion?: string
  tier: number
}

export function parseCronText(text: string, locale?: string): Promise<CronParseResponse> {
  return apiPost<CronParseResponse>('/api/v1/cron/parse', {
    text,
    hints: { locale: locale || 'zh-CN' },
  })
}

/** 生成幂等 key — 浏览器 crypto.randomUUID 或 fallback timestamp+random */
export function genIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** 获取任务列表（路由到 unified endpoint） */
export async function getCronJobs(): Promise<{ jobs: CronJob[]; total: number; quota?: { used: number; limit: number } }> {
  const resp = await cronjobAction({ action: 'list', include_paused: true })
  return { jobs: resp.jobs ?? [], total: resp.total ?? 0, quota: resp.quota }
}

/**
 * 创建任务 — 双路径调度：
 *
 *   1. 无 onProgress callback → 走 apiPost JSON 路径
 *      - 阻塞等编译完一次性返结果
 *      - 与既有测试 mock（apiPost spy）兼容
 *      - 适合脚本 / 非交互场景
 *
 *   2. 有 onProgress → 走 SSE 流式路径
 *      - 实时推 analyzing → calling_llm → validating → persisting 4 阶段
 *      - 客户端 UI 显示进度条
 *      - 支持取消（signal.abort → 后端 ctx 取消）
 *
 * 后端按 Accept header 自动区分 SSE / JSON，无需额外开关。
 */
export function createCronJob(
  input: CronJobInput,
  options: CreateCronJobStreamOptions = {},
): Promise<CreateCronJobResult> {
  if (!options.onProgress && !options.signal) {
    // 经典路径：走 apiPost，所有 spy/mock 仍生效
    return createCronJobJSON(input)
  }
  return createCronJobSSE(input, options)
}

/**
 * createCronJobSSE 通过 SSE 流消费 4 阶段进度事件。
 *
 * 失败路径：
 *   - 网络层错误 → reject Error(网络原因)
 *   - 后端发 `event: error` → reject Error(payload.error)
 *   - 流意外结束（无 done/error 事件）→ reject Error("编译流意外结束")
 */
export async function createCronJobSSE(
  input: CronJobInput,
  options: CreateCronJobStreamOptions = {},
): Promise<CreateCronJobResult> {
  const body = JSON.stringify({
    name: input.name,
    schedule: input.schedule,
    prompt: input.prompt,
    type: input.type ?? 'cron',
    user_id: DESKTOP_USER_ID,
    ...(input.deliver && input.deliver.length ? { deliver: input.deliver } : {}),
    ...(input.chat_id ? { chat_id: input.chat_id } : {}),
  })

  // BUG-A 超时兜底：组合内部 timeout + 外部 signal 到统一 AbortController。
  // 无论后端 hold 住连接（只发 progress 不收尾）还是用户主动取消，都能中断 reader.read()。
  const timeoutMs = options.timeoutMs ?? CRON_SSE_TIMEOUT_MS
  const ac = new AbortController()
  let abortReason: 'timeout' | 'external' | null = null

  const timer = setTimeout(() => {
    abortReason = 'timeout'
    ac.abort()
  }, timeoutMs)

  const onExternalAbort = () => {
    abortReason = abortReason ?? 'external'
    ac.abort()
  }
  if (options.signal) {
    if (options.signal.aborted) onExternalAbort()
    else options.signal.addEventListener('abort', onExternalAbort, { once: true })
  }

  // abortPromise 永不 resolve，只在 ac.abort() 时 reject 对应友好错误。
  // 用 Promise.race 包住 fetch + 每次 reader.read()，保证 mock / 真实环境都能中断。
  const abortPromise = new Promise<never>((_, reject) => {
    ac.signal.addEventListener(
      'abort',
      () => {
        if (abortReason === 'timeout') {
          reject(
            new Error(
              `编译超时（已等待 ${Math.round(timeoutMs / 1000)} 秒）— 本地模型推理太慢，建议到设置 → LLM 改选更快的模型`,
            ),
          )
        } else {
          reject(new Error('已取消创建'))
        }
      },
      { once: true },
    )
  })

  const cleanup = () => {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onExternalAbort)
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  try {
    // D1.2 后端把 SSE 创建拆到 /api/v1/cron/jobs/stream 单独路径
    const response = await Promise.race([
      fetch(`${env.apiBase}/api/v1/cron/jobs/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body,
        signal: ac.signal,
      }),
      abortPromise,
    ])

    if (!response.ok) {
      // 失败但不是 SSE — 尝试以 JSON 读取后端错误
      let serverMsg = response.statusText
      try {
        const txt = await response.text()
        const parsed = JSON.parse(txt) as { error?: string }
        if (parsed?.error) serverMsg = parsed.error
      } catch {
        /* ignore */
      }
      throw new Error(serverMsg)
    }

    if (!response.body) throw new Error('SSE 响应缺少 body')

    reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await Promise.race([reader.read(), abortPromise])
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE 帧以 \n\n 分隔
      while (true) {
        const idx = buffer.indexOf('\n\n')
        if (idx < 0) break
        const frame = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)

        const parsed = parseSSEFrame(frame)
        if (!parsed) continue
        if (parsed.event === 'progress') {
          options.onProgress?.(parsed.data as CronCompileProgress)
        } else if (parsed.event === 'done') {
          return parsed.data as CreateCronJobResult
        } else if (parsed.event === 'error') {
          const msg = (parsed.data as { error?: string })?.error ?? '后端返回错误'
          throw new Error(msg)
        }
      }
    }
    throw new Error('编译流意外结束（未收到 done / error 事件）')
  } finally {
    cleanup()
    // 释放流 — abort 时主动取消，避免 reader 泄漏
    if (reader) {
      try {
        await reader.cancel()
      } catch {
        /* reader 已关闭 / 已 abort，忽略 */
      }
    }
  }
}

/**
 * 兼容老路径：纯阻塞 JSON 调用，内部走 unified endpoint action=create。
 * D1.2 后旧 /api/v1/cron/jobs 已下线；此函数保签名兼容现有测试。
 */
export async function createCronJobJSON(input: CronJobInput): Promise<CreateCronJobResult> {
  const resp = await apiPost<CronJobUnifiedResponse>(
    '/api/v1/cronjob',
    {
      action: 'create',
      user_id: DESKTOP_USER_ID,
      idempotency_key: genIdempotencyKey(),
      draft: {
        name: input.name,
        schedule: input.schedule,
        prompt: input.prompt,
        ...(input.deliver && input.deliver.length ? { deliver: input.deliver } : {}),
        ...(input.chat_id ? { chat_id: input.chat_id } : {}),
      },
    },
    { timeout: CRON_CREATE_TIMEOUT_MS },
  )
  if (!resp.job) {
    throw new Error('创建失败：后端未返回 job')
  }
  return { job: resp.job, spec_preview: resp.job.spec ?? ({} as JobSpec) }
}

/** parseSSEFrame 解析一个 SSE 帧；不合规返 null。 */
function parseSSEFrame(frame: string): { event: string; data: unknown } | null {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (dataLines.length === 0) return null
  const dataStr = dataLines.join('\n')
  try {
    return { event, data: JSON.parse(dataStr) }
  } catch {
    return { event, data: dataStr }
  }
}

/** 删除任务（路由到 unified endpoint，D1.2） */
export async function deleteCronJob(id: string): Promise<{ message: string }> {
  await cronjobAction({ action: 'remove', job_id: id, idempotency_key: genIdempotencyKey() })
  return { message: '任务已删除' }
}

/** 暂停任务（路由到 unified endpoint，D1.2） */
export async function pauseCronJob(id: string): Promise<{ message: string }> {
  await cronjobAction({ action: 'pause', job_id: id, idempotency_key: genIdempotencyKey() })
  return { message: '任务已暂停' }
}

/** 恢复任务（路由到 unified endpoint，D1.2） */
export async function resumeCronJob(id: string): Promise<{ message: string }> {
  await cronjobAction({ action: 'resume', job_id: id, idempotency_key: genIdempotencyKey() })
  return { message: '任务已恢复' }
}

/** 立即触发任务（路由到 unified endpoint，D1.2）。后端 run action 不返回 run_id，故不声明。 */
export async function triggerCronJob(id: string): Promise<{ message: string }> {
  await cronjobAction({ action: 'run', job_id: id, idempotency_key: genIdempotencyKey() })
  return { message: '已触发' }
}

/** 获取任务执行历史 */
export async function getCronJobHistory(id: string, limit = 5): Promise<CronJobRun[]> {
  const res = await apiGet<{ history?: CronJobRunWire[]; runs?: CronJobRunWire[] }>(
    `/api/v1/cron/jobs/${encodeURIComponent(id)}/history`,
    { limit },
  )
  const raw = res.history ?? res.runs ?? []
  return raw.map((r) => ({
    ...r,
    started_at: r.started_at || r.run_at || '',
  }))
}

/** 任务执行记录（v2: 含沙箱执行的 stdout/stderr/exit_code/data） */
export interface CronJobRun {
  id: string
  job_id: string
  status: 'success' | 'failed' | 'error' | 'timeout' | 'running' | 'healed' | 'heal_failed'
  result?: string
  started_at: string
  finished_at?: string
  duration_ms?: number
  error?: string

  stdout?: string
  stderr?: string
  exit_code?: number
  data?: unknown
}

interface CronJobRunWire extends CronJobRun {
  run_at?: string
}
