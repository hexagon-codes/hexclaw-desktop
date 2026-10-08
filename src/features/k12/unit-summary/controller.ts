import { computed, ref } from 'vue'
import { backendScopeKey } from '@/services/backend-context'
import {
  k12GetUnitSummaryDocument,
  k12GetUnitSummaryJob,
  k12ListUnitSummaryDocuments,
  k12GetPrintArtifactContent,
  k12ResumeUnitSummaryJob,
  type UnitSummaryResponse,
  type UnitSummaryReference,
  type UnitSummaryJobDTO,
} from '@/api/k12'
import { savePdfArtifact } from '../export'
import type { PersistentPrintRequest } from '../persistent-print'
import { materialArtifact } from './types'
import type { Artifact, ChatMessageMetadata } from '@/types/chat'

interface MessageReference {
  messageId: string
  ref: UnitSummaryReference
}
const TERMINAL = new Set([
  'succeeded',
  'reused',
  'superseded',
  'failed',
  'needs_input',
])
function parseJSON(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}
export function unitSummaryMessageReferences(
  messages: Array<{ id: string; metadata?: ChatMessageMetadata }>,
): MessageReference[] {
  const result: MessageReference[] = []
  for (const message of messages) {
    const values = parseJSON(message.metadata?.artifacts)
    for (const value of Array.isArray(values) ? values : []) {
      if (value && typeof value === 'object' && value.kind === 'unit_summary')
        result.push({ messageId: message.id, ref: value })
    }
    const direct = parseJSON(message.metadata?.unit_summary_ref)
    if (direct && typeof direct === 'object')
      result.push({ messageId: message.id, ref: direct as UnitSummaryReference })
  }
  return result
}

/** 后端是资料事实源；本控制器仅保存当前作用域投影和两处共享的动作状态。 */
export function createUnitSummaryController(options: {
  openPrint(request: PersistentPrintRequest): Promise<void>
  onError(error: Error): void
}) {
  const current = ref<UnitSummaryResponse[]>([])
  const bound = ref<Array<{ messageId: string; view: UnitSummaryResponse }>>([])
  const jobs = ref<UnitSummaryJobDTO[]>([])
  const selected = ref<UnitSummaryResponse | null>(null)
  const busy = ref<Record<string, boolean>>({})
  const loadError = ref('')
  let context = { agent: '', session: '', scope: '' }
  let generation = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let messageRefs: MessageReference[] = []
  let messageIds = new Set<string>()
  let referenceSignature = ''
  let refreshRequested = false
  let refreshInFlight: Promise<void> | undefined
  const artifacts = computed<Artifact[]>(() =>
    current.value.flatMap((view) => {
      const artifact = materialArtifact(view)
      return artifact ? [{ ...artifact, busy: !!busy.value[artifact.id] }] : []
    }),
  )
  const currentIdentity = () => `${context.scope}\u0000${context.agent}\u0000${context.session}`
  function active(token: number, identity: string) {
    return (
      !disposed &&
      token === generation &&
      identity === currentIdentity() &&
      context.scope === backendScopeKey()
    )
  }
  function report(cause: unknown) {
    options.onError(cause instanceof Error ? cause : new Error(String(cause)))
  }
  function stopTimer() {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  function schedule() {
    stopTimer()
    if (!disposed && jobs.value.some((job) => !TERMINAL.has(job.state)))
      timer = setTimeout(() => {
        void refresh()
      }, 1800)
  }
  async function refresh() {
    if (!context.agent || disposed) return
    if (refreshInFlight) return refreshInFlight
    const token = generation,
      identity = currentIdentity(),
      agent = context.agent,
      session = context.session
    const operation = (async () => {
      try {
        const views: UnitSummaryResponse[] = []
        let cursor: string | undefined
        const listedJobs: UnitSummaryJobDTO[] = []
        do {
          const response = await k12ListUnitSummaryDocuments(agent, { limit: 100, cursor })
          if (!active(token, identity)) return
          views.push(...(response.documents || []))
          listedJobs.push(...(response.jobs || []))
          const next = response.next_cursor
          if (next && next === cursor) throw new Error('Unit summary pagination did not advance')
          cursor = next || undefined
        } while (cursor)
        const projected: Array<{ messageId: string; view: UnitSummaryResponse }> = []
        const observedJobs = new Map(
          listedJobs.filter((job) => job.session_id === session).map((job) => [job.id, job]),
        )
        for (const item of [...messageRefs].reverse()) {
          let response: UnitSummaryResponse | undefined
          if (item.ref.document_id && item.ref.revision_id)
            response = await k12GetUnitSummaryDocument(
              agent,
              item.ref.document_id,
              item.ref.revision_id,
            )
          else if (item.ref.attempt_id)
            response = await k12GetUnitSummaryJob(agent, item.ref.attempt_id)
          if (!active(token, identity)) return
          if (response?.job) observedJobs.set(response.job.id, response.job)
          if (
            response?.material &&
            response.delivery?.complete &&
            !projected.some(
              (row) => row.view.material?.revision_id === response!.material!.revision_id,
            )
          )
            projected.push({ messageId: item.messageId, view: response })
        }
        // 服务端会话关联也是持久引用；消息投影稍晚到达时仍能恢复原位置，不猜最近一条消息。
        for (const view of views) {
          const source = view.job?.source_message_id
          if (
            source &&
            view.job?.session_id === session &&
            messageIds.has(source) &&
            view.delivery?.complete &&
            view.material &&
            !projected.some((row) => row.view.material?.revision_id === view.material!.revision_id)
          )
            projected.push({ messageId: source, view })
        }
        if (!active(token, identity)) return
        current.value = views
        bound.value = projected
        jobs.value = [...observedJobs.values()]
        loadError.value = ''
        schedule()
      } catch (cause) {
        if (active(token, identity)) {
          loadError.value = cause instanceof Error ? cause.message : String(cause)
          // 读取失败保留已有版本和任务身份；重试只查询，不重发生成。
          schedule()
        }
      }
    })().finally(() => {
      if (refreshInFlight === operation) {
        refreshInFlight = undefined
        if (refreshRequested) {
          refreshRequested = false
          void refresh()
        }
      }
    })
    refreshInFlight = operation
    return operation
  }
  function setContext(agent: string, session = '') {
    const scope = backendScopeKey()
    if (context.agent === agent && context.session === session && context.scope === scope) return
    generation++
    stopTimer()
    refreshInFlight = undefined
    context = { agent, session, scope }
    messageRefs = []
    messageIds = new Set()
    referenceSignature = ''
    refreshRequested = false
    current.value = []
    bound.value = []
    jobs.value = []
    selected.value = null
    busy.value = {}
    loadError.value = ''
  }
  function setMessages(messages: Array<{ id: string; metadata?: ChatMessageMetadata }>) {
    const refs = unitSummaryMessageReferences(messages)
    const signature = JSON.stringify([messages.map((item) => item.id), refs])
    if (referenceSignature === signature) return
    referenceSignature = signature
    messageRefs = refs
    messageIds = new Set(messages.map((item) => item.id))
    if (refreshInFlight) refreshRequested = true
    else void refresh()
  }
  async function openArtifact(id: string) {
    const artifact = artifacts.value.find((item) => item.id === id)
    if (!artifact?.reference) return
    const token = generation,
      identity = currentIdentity()
    const response = await k12GetUnitSummaryDocument(
      context.agent,
      artifact.reference.documentId,
      artifact.reference.revisionId,
    )
    if (active(token, identity)) selected.value = response
  }
  async function run(view: UnitSummaryResponse, action: 'download' | 'print') {
    const artifact = materialArtifact(view)
    if (!artifact?.reference || busy.value[artifact.id]) return
    const agent = context.agent,
      scope = context.scope
    busy.value = { ...busy.value, [artifact.id]: true }
    try {
      if (scope !== backendScopeKey()) throw new Error('Backend connection changed')
      if (action === 'print') {
        await options.openPrint({
          agent,
          sourceKind: 'unit_summary',
          sourceRef: artifact.reference.revisionId,
          title: artifact.title,
          artifactId: artifact.reference.artifactId,
          browserPrint: async () => {
            throw new Error('Native printing is unavailable in this environment')
          },
        })
      } else {
        const pdf = await k12GetPrintArtifactContent(agent, artifact.reference.artifactId)
        if (scope !== backendScopeKey()) throw new Error('Backend connection changed')
        const digest = Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', await pdf.arrayBuffer())),
        )
          .map((value) => value.toString(16).padStart(2, '0'))
          .join('')
        if (digest !== artifact.reference.byteDigest)
          throw new Error('The saved PDF digest does not match this material revision')
        await savePdfArtifact(pdf, artifact.reference.filename.replace(/\.pdf$/i, ''))
      }
    } catch (cause) {
      report(cause)
    } finally {
      if (scope === context.scope) {
        const next = { ...busy.value }
        delete next[artifact.id]
        busy.value = next
      }
    }
  }
  async function runArtifact(id: string, action: string) {
    try {
      if (action === 'open') return await openArtifact(id)
      const view = current.value.find((item) => materialArtifact(item)?.id === id)
      if (view && (action === 'download' || action === 'print')) await run(view, action)
    } catch (cause) {
      report(cause)
    }
  }
  async function resume(job: UnitSummaryJobDTO) {
    if (job.state === 'outcome_unknown' || job.failure_kind === 'invocation_outcome_unknown') {
      await refresh()
      return
    }
    try {
      await k12ResumeUnitSummaryJob(job.id, {
        agent: context.agent,
        expected_revision: job.revision,
        idempotency_key: crypto.randomUUID(),
      })
      await refresh()
    } catch (cause) {
      report(cause)
    }
  }
  function dispose() {
    disposed = true
    generation++
    stopTimer()
  }
  return {
    artifacts,
    bound,
    jobs,
    selected,
    busy,
    loadError,
    setContext,
    setMessages,
    refresh,
    run,
    runArtifact,
    resume,
    dispose,
  }
}
