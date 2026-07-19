import { apiGet, apiPost } from './client'

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

/** Read model for the semantic-index card and its model picker. */
export interface KnowledgeEmbeddingPolicyProjection {
  policy_version: number
  selection: EmbeddingSelection
  active_revision: KnowledgeEmbeddingRevisionProjection | null
  desired_revision: KnowledgeEmbeddingRevisionProjection | null
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

function embeddingPolicyPath(corpusId: string): string {
  return `/api/v1/knowledge/corpora/${encodeURIComponent(corpusId)}/embedding-policy`
}

export function getKnowledgeEmbeddingPolicy(
  corpusId: string,
): Promise<KnowledgeEmbeddingPolicyProjection> {
  return apiGet<KnowledgeEmbeddingPolicyProjection>(embeddingPolicyPath(corpusId))
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
    `${embeddingPolicyPath(corpusId)}:apply`,
    body,
  )
}

/**
 * Detects only a genuinely absent backend route. Business errors and textual
 * messages containing "404" must remain visible to the caller.
 */
export function isKnowledgeEmbeddingPolicyUnsupported(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { status?: unknown; statusCode?: unknown }
  const status = candidate.status ?? candidate.statusCode
  return status === 404 || status === 405
}
