import { apiGet, apiPost } from './client'
import { DESKTOP_USER_ID } from '@/constants'

/**
 * The corpus has one source of truth for its embedding choice. Location,
 * provider and model are profile facts, so callers cannot submit them beside
 * the selection and create a contradictory request.
 */
export type EmbeddingSelection =
  | { kind: 'auto'; profile_id?: never }
  | { kind: 'profile'; profile_id: string }
  | { kind: 'disabled'; profile_id?: never }

export type KnowledgeEmbeddingLocation = 'local' | 'cloud'

export type KnowledgeEmbeddingAvailability =
  | 'installed'
  | 'downloadable'
  | 'downloading'
  | 'connected'
  | 'unavailable'

/** One server-validated model option in the corpus-scoped picker catalog. */
export interface KnowledgeEmbeddingProfile {
  profile_id: string
  model_name: string
  provider_id: string
  provider_name: string
  location: KnowledgeEmbeddingLocation
  capability: 'embedding'
  dimension: number
  availability: KnowledgeEmbeddingAvailability
  display_order: number
}

export type EmbeddingProfile = KnowledgeEmbeddingProfile

/** Immutable execution projection for the active or staged index revision. */
export interface KnowledgeEmbeddingRevisionProjection {
  revision_id: string
  profile_config_hash: string
  /** Persistent rebuild job, when this is the staged desired revision. */
  job_id?: string | null
  state: 'disabled' | 'pending' | 'building' | 'retry_wait' | 'ready' | 'failed' | 'cancelled'
  profile: KnowledgeEmbeddingProfile
  chunks_done?: number
  chunks_total?: number
}

export type EmbeddingRevisionProjection = KnowledgeEmbeddingRevisionProjection

export interface KnowledgeEmbeddingRecommendation {
  profile_id: string | null
  reason_code: string
  reason_text: string
}

/** Aggregate activity is independent from a staged profile rebuild. */
export interface KnowledgeIndexingActivity {
  state: 'idle' | 'building' | 'retry_wait' | 'failed'
  processing_documents: number
  chunks_done: number | null
  chunks_total: number | null
}

/** Read model for the semantic-index card and its model picker. */
export interface KnowledgeEmbeddingPolicyProjection {
  policy_version: number
  selection: EmbeddingSelection
  active_revision: KnowledgeEmbeddingRevisionProjection | null
  desired_revision: KnowledgeEmbeddingRevisionProjection | null
  indexing_activity: KnowledgeIndexingActivity
  available_profiles: KnowledgeEmbeddingProfile[]
  recommendation: KnowledgeEmbeddingRecommendation | null
  catalog_version: number
}

export interface ApplyKnowledgeEmbeddingPolicyRequest {
  expected_policy_version: number
  selection: EmbeddingSelection
}

export interface ApplyKnowledgeEmbeddingPolicyResult {
  policy_version: number
  selection: EmbeddingSelection
  active_revision_id: string | null
  desired_revision_id: string | null
  job_id?: string | null
}

export type KnowledgeJobState =
  | 'queued'
  | 'running'
  | 'retry_wait'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export interface KnowledgeJobProjection {
  job_id: string
  state: KnowledgeJobState
  stage: string
  pages_done: number | null
  pages_total: number | null
  chunks_done: number | null
  chunks_total: number | null
  last_error?: string | null
  available_actions?: string[]
}

function embeddingPolicyPath(corpusId: string): string {
  return `/api/v1/knowledge/corpora/${encodeURIComponent(corpusId)}/embedding-policy`
}

function withDesktopUser(url: string): string {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}user_id=${encodeURIComponent(DESKTOP_USER_ID)}`
}

export function getKnowledgeEmbeddingPolicy(
  corpusId: string,
): Promise<KnowledgeEmbeddingPolicyProjection> {
  return apiGet<KnowledgeEmbeddingPolicyProjection>(embeddingPolicyPath(corpusId), {
    user_id: DESKTOP_USER_ID,
  })
}

export function applyKnowledgeEmbeddingPolicy(
  corpusId: string,
  expectedPolicyVersion: number,
  selection: EmbeddingSelection,
): Promise<ApplyKnowledgeEmbeddingPolicyResult> {
  const body: ApplyKnowledgeEmbeddingPolicyRequest = {
    expected_policy_version: expectedPolicyVersion,
    selection,
  }
  return apiPost<ApplyKnowledgeEmbeddingPolicyResult>(
    withDesktopUser(`${embeddingPolicyPath(corpusId)}:apply`),
    body,
  )
}

export function getKnowledgeJob(jobId: string): Promise<KnowledgeJobProjection> {
  return apiGet<KnowledgeJobProjection>(`/api/v1/knowledge/jobs/${encodeURIComponent(jobId)}`, {
    user_id: DESKTOP_USER_ID,
  })
}

export function cancelKnowledgeJob(jobId: string): Promise<KnowledgeJobProjection> {
  return apiPost<KnowledgeJobProjection>(
    withDesktopUser(`/api/v1/knowledge/jobs/${encodeURIComponent(jobId)}/cancel`),
  )
}

/**
 * Detects only a genuinely absent backend route. Business errors and textual
 * messages containing "404" must remain visible to the caller.
 */
export function isKnowledgeEmbeddingPolicyUnsupported(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as {
    status?: unknown
    statusCode?: unknown
    data?: { code?: unknown }
    response?: { status?: unknown; _data?: { code?: unknown } }
  }
  const status = candidate.status ?? candidate.statusCode ?? candidate.response?.status
  if (status === 405) return true
  if (status !== 404) return false
  const code = candidate.data?.code ?? candidate.response?._data?.code
  return code !== 'semantic_index_not_found'
}
