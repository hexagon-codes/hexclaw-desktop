<script setup lang="ts">
/**
 * Corpus-scoped semantic-index policy card.
 *
 * The policy projection is the only UI source of truth. A desired revision is
 * a staged profile rebuild; indexing_activity without a desired revision is
 * ordinary document enhancement and must never be presented as a rebuild.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, ChevronDown, Layers, LoaderCircle } from 'lucide-vue-next'
import EmbeddingStatusBanner from './EmbeddingStatusBanner.vue'
import EmbeddingProfileSelect from './EmbeddingProfileSelect.vue'
import SemanticRebuildCancelDialog from './SemanticRebuildCancelDialog.vue'
import {
  applyKnowledgeEmbeddingPolicy,
  cancelKnowledgeJob,
  getKnowledgeEmbeddingPolicy,
  getKnowledgeJob,
  isKnowledgeEmbeddingPolicyUnsupported,
  type EmbeddingProfile,
  type EmbeddingRevisionProjection,
  type EmbeddingSelection,
  type KnowledgeEmbeddingPolicyProjection,
  type KnowledgeIndexingActivity,
} from '@/api/knowledge-index'
import {
  getSharedOllamaPullState,
  getSharedOllamaPullTask,
  releaseSharedOllamaPull,
  startSharedOllamaPull,
  type SharedOllamaPullTask,
} from '@/services/ollama-pull-registry'
import { thirdPartyAiServicesUrl } from '@/utils/legal-links'
import { waitForOllamaModelVisibility } from '@/utils/ollama-visibility'

const CORPUS_ID = 'default'
const POLL_INTERVAL_MS = 1_000
const MAX_POLL_INTERVAL_MS = 5_000
const MODEL_VISIBILITY_INTERVAL_MS = 1_000
const MODEL_VISIBILITY_MAX_RETRIES = 4
const TERMINAL_JOB_STATES = new Set(['succeeded', 'failed', 'cancelled'])
const POLLABLE_REVISION_STATES = new Set(['pending', 'building', 'retry_wait'])
const IDLE_ACTIVITY: KnowledgeIndexingActivity = {
  state: 'idle',
  processing_documents: 0,
  chunks_done: null,
  chunks_total: null,
}

const { t, locale } = useI18n()
const mode = ref<'loading' | 'policy' | 'legacy' | 'error'>('loading')
const policy = ref<KnowledgeEmbeddingPolicyProjection | null>(null)
const expanded = ref(false)
const applying = ref(false)
const cancellingDesired = ref(false)
const cancelConfirmOpen = ref(false)
const cancelConfirmJobId = ref<string | null>(null)
const errorDetail = ref('')
const pollErrorDetail = ref('')
const announcement = ref('')
const trackedJobId = ref<string | null>(null)
const headerRef = ref<HTMLButtonElement | null>(null)
const selectorRef = ref<{ containsFocus: () => boolean } | null>(null)
const providerDocsUrl = computed(() => thirdPartyAiServicesUrl(locale.value))
const observedModelPulls = new Map<string, Promise<void>>()
const modelVerificationAborts = new Map<string, AbortController>()

let pollTimer: ReturnType<typeof setTimeout> | null = null
let pollAttempts = 0
let policyReadSequence = 0
let disposed = false

function semanticMessage(key: string, values: Record<string, string | number> = {}): string {
  return String(t(`knowledge.semanticIndex.${key}`, values))
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const shaped = error as { status?: number; statusCode?: number }
  return shaped.status ?? shaped.statusCode
}

function invalidatePolicyReads() {
  policyReadSequence += 1
}

async function readLatestPolicy(): Promise<KnowledgeEmbeddingPolicyProjection | null> {
  const sequence = ++policyReadSequence
  const next = await getKnowledgeEmbeddingPolicy(CORPUS_ID)
  return sequence === policyReadSequence ? next : null
}

function activityOf(projection: KnowledgeEmbeddingPolicyProjection): KnowledgeIndexingActivity {
  return projection.indexing_activity ?? IDLE_ACTIVITY
}

function shouldRevealFailure(projection: KnowledgeEmbeddingPolicyProjection): boolean {
  return (
    activityOf(projection).state === 'failed' ||
    projection.active_revision?.state === 'failed' ||
    projection.desired_revision?.state === 'failed'
  )
}

function needsPolling(projection: KnowledgeEmbeddingPolicyProjection | null): boolean {
  if (!projection) return false
  return (
    Boolean(trackedJobId.value) ||
    Boolean(
      projection.desired_revision &&
      POLLABLE_REVISION_STATES.has(projection.desired_revision.state),
    ) ||
    activityOf(projection).state === 'building' ||
    activityOf(projection).state === 'retry_wait'
  )
}

function clearPollTimer(resetAttempts = false) {
  if (pollTimer !== null) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
  if (resetAttempts) pollAttempts = 0
}

function acceptProjection(next: KnowledgeEmbeddingPolicyProjection) {
  if (policy.value && next.policy_version < policy.value.policy_version) return
  const moveFocusToHeader = Boolean(next.desired_revision && selectorRef.value?.containsFocus())
  policy.value = next
  mode.value = 'policy'
  const desiredJobId =
    next.desired_revision && POLLABLE_REVISION_STATES.has(next.desired_revision.state)
      ? next.desired_revision.job_id
      : null
  if (desiredJobId) trackedJobId.value = desiredJobId
  else trackedJobId.value = null
  if (shouldRevealFailure(next)) expanded.value = true
  if (moveFocusToHeader) headerRef.value?.focus()
  reconcileSharedModelPulls(next)
}

function focusHeaderIfSelectionLocked(next: KnowledgeEmbeddingPolicyProjection) {
  if (!next.desired_revision) return
  headerRef.value?.focus()
}

function schedulePoll() {
  clearPollTimer()
  if (disposed || !needsPolling(policy.value)) return
  const delay = Math.min(POLL_INTERVAL_MS * 2 ** Math.min(pollAttempts, 3), MAX_POLL_INTERVAL_MS)
  pollTimer = setTimeout(() => void pollOnce(), delay)
}

async function pollOnce() {
  pollTimer = null
  if (disposed || !needsPolling(policy.value)) return
  pollAttempts += 1

  try {
    const jobId = trackedJobId.value
    if (jobId) {
      try {
        const job = await getKnowledgeJob(jobId)
        if (TERMINAL_JOB_STATES.has(job.state)) trackedJobId.value = null
      } catch (error) {
        // A worker may compact a terminal job before this view's next poll.
        // Policy is the canonical projection, so a stale job reference must
        // never prevent the policy refresh that tells us the final state.
        if (errorStatus(error) === 404) trackedJobId.value = null
      }
    }

    const next = await readLatestPolicy()
    if (disposed || !next) return
    acceptProjection(next)
    pollErrorDetail.value = ''
  } catch (error) {
    if (disposed) return
    pollErrorDetail.value = error instanceof Error ? error.message : String(error)
  }

  schedulePoll()
}

async function loadPolicy() {
  clearPollTimer(true)
  invalidatePolicyReads()
  mode.value = 'loading'
  errorDetail.value = ''
  pollErrorDetail.value = ''
  try {
    const next = await readLatestPolicy()
    if (disposed || !next) return
    acceptProjection(next)
    schedulePoll()
  } catch (error) {
    if (disposed) return
    if (isKnowledgeEmbeddingPolicyUnsupported(error)) {
      policy.value = null
      mode.value = 'legacy'
      return
    }
    mode.value = 'error'
    errorDetail.value = error instanceof Error ? error.message : String(error)
  }
}

onMounted(() => {
  disposed = false
  void loadPolicy()
})

onBeforeUnmount(() => {
  disposed = true
  clearPollTimer()
  for (const controller of modelVerificationAborts.values()) controller.abort()
  modelVerificationAborts.clear()
})

function profileForSelection(selection: EmbeddingSelection): EmbeddingProfile | null {
  if (selection.kind !== 'profile') return null
  return (
    policy.value?.available_profiles.find((item) => item.profile_id === selection.profile_id) ??
    null
  )
}

function revisionProfile(revision: EmbeddingRevisionProjection | null | undefined) {
  return revision?.profile ?? null
}

function progressText(done: number | null | undefined, total: number | null | undefined): string {
  if (done == null || total == null) return ''
  return `${done}/${total}`
}

function profileLabel(profile: EmbeddingProfile | null): string {
  if (!profile) return t('knowledge.semanticIndex.textOnly', '仅文本检索')
  return `${profile.provider_name} · ${profile.model_name}`
}

const activeProfile = computed(() => revisionProfile(policy.value?.active_revision))
const desiredRevision = computed(() => policy.value?.desired_revision ?? null)
const canCancelDesired = computed(
  () =>
    Boolean(desiredRevision.value?.job_id) &&
    ['pending', 'building', 'retry_wait', 'failed'].includes(desiredRevision.value?.state ?? ''),
)
const activity = computed(() => (policy.value ? activityOf(policy.value) : IDLE_ACTIVITY))
const desiredProgress = computed(() =>
  progressText(desiredRevision.value?.chunks_done, desiredRevision.value?.chunks_total),
)
const activityProgress = computed(() =>
  progressText(activity.value.chunks_done, activity.value.chunks_total),
)
const displayProfiles = computed(() =>
  (policy.value?.available_profiles ?? []).map((profile) =>
    getSharedOllamaPullState(profile.model_name)
      ? { ...profile, availability: 'downloading' as const }
      : profile,
  ),
)
const downloadProgress = computed<Record<string, number | null>>(() => {
  const entries = (policy.value?.available_profiles ?? []).flatMap((profile) => {
    const state = getSharedOllamaPullState(profile.model_name)
    return state ? [[profile.profile_id, state.progress] as const] : []
  })
  return Object.fromEntries(entries)
})

function recommendationReason(reasonCode: string | null | undefined): string {
  const keyByReasonCode: Record<string, string> = {
    configured_embedding: 'recommendationConfigured',
    local_model_download: 'recommendationLocalDownload',
    embedding_unavailable: 'recommendationUnavailable',
  }
  return semanticMessage(keyByReasonCode[reasonCode ?? ''] ?? 'recommendationGeneric')
}

const selectionLabel = computed(() => {
  const selection = policy.value?.selection
  if (!selection) return ''
  if (selection.kind === 'auto') return t('knowledge.semanticIndex.auto', '自动')
  if (selection.kind === 'disabled') return t('knowledge.semanticIndex.textOnly', '仅文本检索')
  return profileForSelection(selection)?.model_name ?? selection.profile_id
})

const summaryRoute = computed(() => {
  const current = policy.value
  if (!current) return ''
  if (desiredRevision.value) {
    return semanticMessage('targetRoute', { model: desiredRevision.value.profile.model_name })
  }
  if (current.selection.kind === 'disabled') {
    return t('knowledge.semanticIndex.textOnly', '仅文本检索')
  }
  if (current.selection.kind === 'auto') {
    return semanticMessage('autoRoute', {
      selection: selectionLabel.value,
      provider: activeProfile.value?.provider_name ?? semanticMessage('pendingSelection'),
    })
  }
  const active = activeProfile.value
  if (!active) return selectionLabel.value
  const location =
    active.location === 'local'
      ? t('knowledge.semanticIndex.local', '本地')
      : t('knowledge.semanticIndex.cloud', '云端')
  return semanticMessage('fixedRoute', { model: active.model_name, location: String(location) })
})

const summaryStatus = computed(() => {
  const current = policy.value
  if (!current) return ''
  if (desiredRevision.value?.state === 'failed') {
    return t('knowledge.semanticIndex.failed', '需要处理')
  }
  if (desiredRevision.value?.state === 'retry_wait') {
    return t('knowledge.semanticIndex.retrying', '等待重试')
  }
  if (desiredRevision.value) {
    return desiredProgress.value || t('knowledge.semanticIndex.enhancing', '增强中')
  }
  if (current.selection.kind === 'disabled') {
    return t('knowledge.semanticIndex.ready', '已就绪')
  }
  if (activity.value.state === 'failed' || current.active_revision?.state === 'failed') {
    return t('knowledge.semanticIndex.failed', '需要处理')
  }
  if (activity.value.state === 'retry_wait') {
    return t('knowledge.semanticIndex.retrying', '等待重试')
  }
  if (activity.value.state === 'building') {
    const count = activity.value.processing_documents
    return count > 0
      ? semanticMessage(count === 1 ? 'processingItem' : 'processingItems', { count })
      : t('knowledge.semanticIndex.enhancing', '增强中')
  }
  return t('knowledge.semanticIndex.ready', '已就绪')
})

const summaryTone = computed(() => {
  if (policy.value?.selection.kind === 'disabled') return 'text-only'
  if (desiredRevision.value || activity.value.state !== 'idle') return 'building'
  if (policy.value?.active_revision?.state === 'failed') return 'building'
  return 'ready'
})

const selectionHint = computed(() => {
  const current = policy.value
  if (!current) return ''
  const active = activeProfile.value
  const desired = desiredRevision.value

  if (desired?.state === 'failed') {
    if (active) {
      return semanticMessage('failedDesiredWithActive', {
        desired: profileLabel(desired.profile),
        active: profileLabel(active),
      })
    }
    return semanticMessage('failedDesiredWithoutActive', {
      desired: profileLabel(desired.profile),
    })
  }

  if (desired?.state === 'retry_wait') {
    if (active) {
      return semanticMessage('retryingDesiredWithActive', {
        desired: profileLabel(desired.profile),
        active: profileLabel(active),
      })
    }
    return semanticMessage('retryingDesiredWithoutActive', {
      desired: profileLabel(desired.profile),
    })
  }

  if (desired) {
    const target = profileLabel(desired.profile)
    if (active) {
      return semanticMessage('buildingDesiredWithActive', {
        desired: target,
        active: profileLabel(active),
      })
    }
    return semanticMessage('buildingDesiredWithoutActive', { desired: target })
  }

  if (current.selection.kind === 'disabled') {
    return semanticMessage('disabledHint')
  }

  if (current.selection.kind === 'profile') {
    return semanticMessage(active?.location === 'local' ? 'fixedLocalHint' : 'fixedCloudHint', {
      profile: profileLabel(active),
    })
  }

  const reason = recommendationReason(current.recommendation?.reason_code)
  const progress = activityProgress.value
  return progress
    ? semanticMessage('autoHintWithProgress', {
        reason,
        profile: profileLabel(active),
        progress,
      })
    : semanticMessage('autoHint', { reason, profile: profileLabel(active) })
})

const selectorLabels = computed(() => ({
  selectLabel: t('knowledge.semanticIndex.modelLabel', '索引模型'),
  auto: t('knowledge.semanticIndex.auto', '自动'),
  autoRecommended: semanticMessage('autoRecommended'),
  recommended: t('knowledge.semanticIndex.recommended', '推荐'),
  cloudGroup: t('knowledge.semanticIndex.cloudGroup', '云端模型'),
  localGroup: t('knowledge.semanticIndex.localGroup', '本地模型'),
  textOnly: t('knowledge.semanticIndex.textOnly', '仅文本检索'),
  local: t('knowledge.semanticIndex.local', '本地'),
  cloud: t('knowledge.semanticIndex.cloud', '云端'),
  installed: t('knowledge.semanticIndex.installed', '已安装'),
  connected: t('knowledge.semanticIndex.configured', '已配置'),
  download: semanticMessage('download'),
  downloadable: t('knowledge.semanticIndex.downloadable', '可下载'),
  downloading: t('knowledge.semanticIndex.downloading', '下载中'),
  unavailable: t('knowledge.semanticIndex.unavailable', '不可用'),
}))

function formatDownloadProgress(progress: number): string {
  return semanticMessage('downloadingProgress', { progress })
}

function profileIsCanonicallyInstalled(profileId: string): boolean {
  return Boolean(
    policy.value?.available_profiles.some(
      (profile) => profile.profile_id === profileId && profile.availability === 'installed',
    ),
  )
}

async function refreshCanonicalPolicy() {
  const refreshed = await readLatestPolicy()
  if (disposed || !refreshed) return
  acceptProjection(refreshed)
}

function observeModelPull(profile: EmbeddingProfile, task: SharedOllamaPullTask) {
  if (observedModelPulls.get(task.model) === task.promise) return
  observedModelPulls.set(task.model, task.promise)
  const controller = new AbortController()
  modelVerificationAborts.get(task.model)?.abort()
  modelVerificationAborts.set(task.model, controller)

  void (async () => {
    try {
      await task.promise
      if (disposed) return
      clearPollTimer()
      invalidatePolicyReads()
      const installed = await waitForOllamaModelVisibility({
        sync: refreshCanonicalPolicy,
        isVisible: () => profileIsCanonicallyInstalled(profile.profile_id),
        intervalMs: MODEL_VISIBILITY_INTERVAL_MS,
        maxRetries: MODEL_VISIBILITY_MAX_RETRIES,
        signal: controller.signal,
      })
      if (!disposed && installed) {
        announcement.value = semanticMessage('modelInstalled', { model: profile.model_name })
      }
    } catch (error) {
      if (disposed) return
      errorDetail.value = error instanceof Error ? error.message : String(error)
      announcement.value = errorDetail.value
    } finally {
      if (observedModelPulls.get(task.model) === task.promise) {
        observedModelPulls.delete(task.model)
      }
      if (modelVerificationAborts.get(task.model) === controller) {
        modelVerificationAborts.delete(task.model)
      }
      if (!disposed) releaseSharedOllamaPull(task)
      schedulePoll()
    }
  })()
}

function reconcileSharedModelPulls(projection: KnowledgeEmbeddingPolicyProjection) {
  for (const profile of projection.available_profiles) {
    const task = getSharedOllamaPullTask(profile.model_name)
    if (!task) continue
    if (profile.availability === 'installed') {
      releaseSharedOllamaPull(task)
      continue
    }
    if (profile.location === 'local') observeModelPull(profile, task)
  }
}

function downloadProfile(profile: EmbeddingProfile) {
  const canonical = policy.value?.available_profiles.find(
    (candidate) => candidate.profile_id === profile.profile_id,
  )
  if (
    disposed ||
    !canonical ||
    canonical.location !== 'local' ||
    canonical.availability !== 'downloadable' ||
    getSharedOllamaPullTask(canonical.model_name)
  ) {
    return
  }

  errorDetail.value = ''
  announcement.value = ''
  const { task } = startSharedOllamaPull(canonical.model_name)
  observeModelPull(canonical, task)
}

async function selectPolicy(selection: EmbeddingSelection) {
  const current = policy.value
  if (!current || applying.value || desiredRevision.value) return
  clearPollTimer(true)
  invalidatePolicyReads()
  applying.value = true
  errorDetail.value = ''
  try {
    const result = await applyKnowledgeEmbeddingPolicy(CORPUS_ID, current.policy_version, selection)
    trackedJobId.value = result.job_id ?? null
    const refreshed = await readLatestPolicy()
    if (disposed || !refreshed) return
    acceptProjection(refreshed)
    announcement.value = t('knowledge.semanticIndex.updated', '索引模型设置已更新')
  } catch (error) {
    // Refresh the canonical projection after optimistic-lock conflicts.
    if (errorStatus(error) === 409) {
      try {
        const refreshed = await readLatestPolicy()
        if (!disposed && refreshed) {
          acceptProjection(refreshed)
        }
      } catch {
        // Keep the original conflict as the visible error.
      }
      errorDetail.value = t(
        'knowledge.semanticIndex.conflict',
        '设置已在其他位置更新，请重新选择。',
      )
    } else {
      errorDetail.value = error instanceof Error ? error.message : String(error)
    }
    announcement.value = errorDetail.value
  } finally {
    applying.value = false
    if (policy.value) focusHeaderIfSelectionLocked(policy.value)
    schedulePoll()
  }
}

async function cancelDesiredRebuild(jobId: string) {
  if (!jobId || cancellingDesired.value) return
  clearPollTimer(true)
  invalidatePolicyReads()
  cancellingDesired.value = true
  errorDetail.value = ''
  try {
    await cancelKnowledgeJob(jobId)
    const refreshed = await readLatestPolicy()
    if (disposed || !refreshed) return
    acceptProjection(refreshed)
    announcement.value = semanticMessage('rebuildCancelled')
  } catch (error) {
    if (disposed) return
    errorDetail.value = error instanceof Error ? error.message : String(error)
    announcement.value = errorDetail.value
  } finally {
    cancellingDesired.value = false
    headerRef.value?.focus()
    schedulePoll()
  }
}

function openCancelConfirmation() {
  const jobId = desiredRevision.value?.job_id
  if (!jobId || !canCancelDesired.value || cancellingDesired.value) return
  cancelConfirmJobId.value = jobId
  cancelConfirmOpen.value = true
}

async function closeCancelConfirmation() {
  cancelConfirmOpen.value = false
  cancelConfirmJobId.value = null
  await nextTick()
  headerRef.value?.focus()
}

async function confirmCancelDesired() {
  if (!cancelConfirmOpen.value) return
  const confirmedJobId = cancelConfirmJobId.value
  cancelConfirmOpen.value = false
  cancelConfirmJobId.value = null
  if (!confirmedJobId || desiredRevision.value?.job_id !== confirmedJobId) {
    await nextTick()
    headerRef.value?.focus()
    return
  }
  await nextTick()
  headerRef.value?.focus()
  await cancelDesiredRebuild(confirmedJobId)
}

watch([canCancelDesired, () => desiredRevision.value?.job_id ?? null], ([canCancel, jobId]) => {
  if (
    cancelConfirmOpen.value &&
    (!canCancel || !cancelConfirmJobId.value || jobId !== cancelConfirmJobId.value)
  ) {
    void closeCancelConfirmation()
  }
})

const activeUsageKey = computed(() => {
  if (policy.value?.selection.kind === 'disabled' || !activeProfile.value) {
    return 'actualTextOnly'
  }
  return desiredRevision.value ? 'actualProfileServing' : 'actualProfile'
})
const activeUsageProfile = computed(() => profileLabel(activeProfile.value))

const actualState = computed(() => {
  const current = policy.value
  if (!current) return ''
  if (desiredRevision.value?.state === 'failed') {
    return semanticMessage('semanticRetryPending')
  }
  if (desiredRevision.value?.state === 'retry_wait') {
    return semanticMessage('semanticRetryWaiting')
  }
  if (desiredRevision.value) {
    const progress = desiredProgress.value || activityProgress.value
    return progress
      ? semanticMessage('currentIndexBuildingProgress', { progress })
      : semanticMessage('currentIndexBuilding')
  }
  if (current.selection.kind === 'disabled') {
    return semanticMessage('textOnlyReady')
  }
  if (activity.value.state === 'failed' || current.active_revision?.state === 'failed') {
    return semanticMessage('semanticRetryPending')
  }
  if (activity.value.state === 'retry_wait') {
    return semanticMessage('semanticRetryWaiting')
  }
  if (activity.value.state === 'building') {
    const count = activity.value.processing_documents
    return count > 0
      ? semanticMessage(count === 1 ? 'documentsEnhancingOne' : 'documentsEnhancingMany', {
          count,
        })
      : semanticMessage('semanticEnhancing')
  }
  if (!activeProfile.value) return semanticMessage('textOnlyReady')
  return semanticMessage('hybridReady')
})

const actualStateTone = computed(() =>
  desiredRevision.value || activity.value.state !== 'idle' ? 'building' : 'ready',
)

const livePhase = computed(() => {
  const current = policy.value
  if (!current) return ''
  if (
    desiredRevision.value?.state === 'failed' ||
    activity.value.state === 'failed' ||
    current.active_revision?.state === 'failed'
  ) {
    return semanticMessage('semanticRetryPending')
  }
  if (
    desiredRevision.value?.state === 'retry_wait' ||
    activity.value.state === 'retry_wait'
  ) {
    return semanticMessage('semanticRetryWaiting')
  }
  if (desiredRevision.value || activity.value.state === 'building') {
    return semanticMessage('semanticEnhancing')
  }
  if (current.selection.kind === 'disabled' || !activeProfile.value) {
    return semanticMessage('textOnlyReady')
  }
  return semanticMessage('hybridReady')
})

const liveStatusText = computed(() =>
  announcement.value
    ? semanticMessage('liveStatusWithAnnouncement', {
        announcement: announcement.value,
        status: livePhase.value,
      })
    : livePhase.value,
)

const visibleError = computed(() => errorDetail.value || pollErrorDetail.value)
</script>

<template>
  <EmbeddingStatusBanner v-if="mode === 'legacy'" />

  <section
    v-else-if="mode === 'error'"
    class="kb-index-error"
    data-testid="kb-semantic-index-error"
    role="status"
  >
    <AlertCircle :size="16" aria-hidden="true" />
    <div class="kb-index-error__copy">
      <b>{{ t('knowledge.semanticIndex.loadFailed', '暂时无法读取语义索引状态') }}</b>
      <span v-if="visibleError">{{ visibleError }}</span>
    </div>
    <button
      type="button"
      class="hc-btn hc-btn-ghost"
      data-testid="kb-semantic-index-retry"
      @click="loadPolicy"
    >
      {{ t('common.retry', '重试') }}
    </button>
  </section>

  <section
    v-else-if="mode === 'policy' && policy"
    class="kb-index-card"
    :class="{ 'kb-index-card--collapsed': !expanded }"
    data-testid="kb-semantic-index-card"
  >
    <button
      ref="headerRef"
      type="button"
      class="kb-index-card__header"
      data-testid="kb-semantic-index-header"
      :aria-expanded="expanded"
      aria-controls="kb-semantic-index-body"
      @click="expanded = !expanded"
    >
      <span class="kb-index-card__icon">
        <Layers :size="13" data-testid="kb-semantic-index-layers-icon" aria-hidden="true" />
      </span>
      <span class="kb-index-card__title">{{ t('knowledge.semanticIndex.title', '语义索引') }}</span>
      <span class="kb-index-card__summary" data-testid="kb-semantic-index-summary">
        {{ summaryRoute }}
      </span>
      <span
        class="kb-index-card__status"
        :class="`kb-index-card__status--${summaryTone}`"
        data-testid="kb-semantic-index-status"
      >
        {{ summaryStatus }}
      </span>
      <ChevronDown
        :size="13"
        class="kb-index-card__chevron"
        :class="{ 'kb-index-card__chevron--open': expanded }"
        aria-hidden="true"
      />
    </button>

    <div
      v-show="expanded"
      id="kb-semantic-index-body"
      class="kb-index-card__body"
      data-testid="kb-semantic-index-body"
    >
      <div class="kb-index-card__setting">
        <div class="kb-index-card__setting-copy">
          <b>{{ t('knowledge.semanticIndex.modelLabel', '索引模型') }}</b>
          <span data-testid="kb-semantic-index-hint">{{ selectionHint }}</span>
        </div>
        <div class="kb-index-card__selector">
          <LoaderCircle
            v-if="applying"
            :size="15"
            class="kb-index-card__spinner"
            aria-hidden="true"
          />
          <EmbeddingProfileSelect
            ref="selectorRef"
            :selection="policy.selection"
            :profiles="displayProfiles"
            :recommendation-profile-id="policy.recommendation?.profile_id ?? null"
            :labels="selectorLabels"
            :download-progress="downloadProgress"
            :format-download-progress="formatDownloadProgress"
            :provider-notice="
              t(
                'knowledge.semanticIndex.providerNotice',
                '云端模型由你配置的第三方 Provider 提供。HexClaw 仅负责连接与调用；索引文本和查询文本会发送至该服务商，计费与数据处理规则以其为准。',
              )
            "
            :provider-docs-label="
              t('knowledge.semanticIndex.providerDocs', '查看第三方 AI 服务说明 ↗')
            "
            :provider-docs-aria-label="`${t('knowledge.semanticIndex.providerDocs', '查看第三方 AI 服务说明 ↗')} — ${t('common.openInNewWindow', '在新窗口打开')}`"
            :provider-docs-url="providerDocsUrl"
            :disabled="applying || Boolean(desiredRevision)"
            @select="selectPolicy"
            @download="downloadProfile"
          />
        </div>
      </div>

      <div class="kb-index-card__actual" data-testid="kb-semantic-index-actual">
        <i18n-t
          :keypath="`knowledge.semanticIndex.${activeUsageKey}`"
          tag="span"
          scope="global"
        >
          <template #profile>
            <strong>{{ activeUsageProfile }}</strong>
          </template>
        </i18n-t>
        <span class="kb-index-card__spacer" />
        <span
          class="kb-index-card__actual-state"
          :class="`kb-index-card__actual-state--${actualStateTone}`"
        >
          {{ actualState }}
        </span>
        <button
          v-if="canCancelDesired"
          type="button"
          class="kb-index-card__cancel"
          data-testid="kb-semantic-index-cancel"
          :disabled="cancellingDesired"
          @click="openCancelConfirmation"
        >
          <LoaderCircle
            v-if="cancellingDesired"
            :size="13"
            class="kb-index-card__spinner-inline"
            aria-hidden="true"
          />
          {{ semanticMessage('cancelRebuild') }}
        </button>
      </div>

      <p v-if="visibleError" class="kb-index-card__inline-error">
        {{ visibleError }}
      </p>
    </div>
    <p class="sr-only" aria-live="polite" aria-atomic="true">{{ liveStatusText }}</p>
  </section>

  <SemanticRebuildCancelDialog
    :open="cancelConfirmOpen"
    :title="semanticMessage('cancelRebuildTitle')"
    :lead="semanticMessage('cancelRebuildLead')"
    :message="semanticMessage('cancelRebuildDetail')"
    :confirm-text="semanticMessage('cancelRebuild')"
    :cancel-text="semanticMessage('continueRebuild')"
    :close-label="String(t('common.close', '关闭'))"
    @confirm="confirmCancelDesired"
    @cancel="closeCancelConfirmation"
  />
</template>

<style scoped>
.kb-index-card {
  width: 100%;
  max-width: none;
  margin: 0 0 14px;
  color: var(--hc-text-primary);
  container-type: inline-size;
}

.kb-index-error {
  width: min(100%, 860px);
  margin: 0 0 18px;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-lg, 14px);
  background: var(--hc-bg-card);
  color: var(--hc-text-primary);
  box-shadow: 0 1px 1px color-mix(in srgb, var(--hc-text-primary) 3%, transparent);
}

.kb-index-card__header {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--hc-text-muted);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  transition: color 0.15s var(--hc-ease-smooth, ease);
}

.kb-index-card__header:hover {
  color: var(--hc-text-secondary);
}

.kb-index-card__header:focus-visible {
  border-radius: 6px;
  outline: 2px solid var(--hc-ring);
  outline-offset: 3px;
}

.kb-index-card__icon {
  width: 13px;
  height: 13px;
  display: grid;
  place-items: center;
  flex: none;
  color: currentColor;
}

.kb-index-card__title {
  color: var(--hc-text-primary);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.kb-index-card__summary {
  min-width: 0;
  max-width: 45%;
  margin-left: auto;
  overflow: hidden;
  color: var(--hc-text-muted);
  font-size: 11.5px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kb-index-card__status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--hc-text-muted);
  font-size: 11.5px;
  font-weight: 500;
  white-space: nowrap;
}

.kb-index-card__status::before {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--hc-success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--hc-success) 11%, transparent);
  content: '';
}

.kb-index-card__status--building::before {
  background: var(--hc-warning);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--hc-warning) 11%, transparent);
}

.kb-index-card__status--text-only::before {
  background: var(--hc-text-muted);
  box-shadow: none;
}

.kb-index-card__chevron {
  flex: none;
  color: currentColor;
  transition: transform 0.18s var(--hc-ease-out, ease-out);
}

.kb-index-card__chevron--open {
  transform: rotate(180deg);
}

.kb-index-card__body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 10px;
  padding: 14px;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-lg, 14px);
  background: var(--hc-bg-card);
}

.kb-index-card__setting {
  display: flex;
  align-items: center;
  gap: 14px;
}

.kb-index-card__setting-copy {
  min-width: 0;
  flex: 1;
}

.kb-index-card__setting-copy b {
  display: block;
  color: var(--hc-text-primary);
  font-size: 13px;
  font-weight: 500;
}

.kb-index-card__setting-copy span {
  display: block;
  margin-top: 2px;
  color: var(--hc-text-muted);
  font-size: 11.5px;
  line-height: 1.5;
}

.kb-index-card__selector {
  position: relative;
  width: min(300px, 45%);
  min-width: 240px;
  margin-left: auto;
}

.kb-index-card__spinner {
  position: absolute;
  z-index: 2;
  top: 11px;
  right: 36px;
  color: var(--hc-accent);
  animation: kb-index-spin 0.8s linear infinite;
}

.kb-index-card__actual {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  color: var(--hc-text-secondary);
  font-size: 11.5px;
}

.kb-index-card__cancel {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin: 0;
  padding: 2px 0;
  border: 0;
  background: none;
  color: var(--hc-error);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.kb-index-card__cancel:hover:not(:disabled) {
  text-decoration: underline;
}

.kb-index-card__cancel:disabled {
  cursor: wait;
  opacity: 0.65;
}

.kb-index-card__spinner-inline {
  animation: kb-index-spin 0.8s linear infinite;
}

.kb-index-card__actual strong {
  min-width: 0;
  overflow: hidden;
  color: var(--hc-text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kb-index-card__spacer {
  flex: 1;
}

.kb-index-card__actual-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--hc-success);
  white-space: nowrap;
}

.kb-index-card__actual-state::before {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 12%, transparent);
  content: '';
}

.kb-index-card__actual-state--building {
  color: var(--hc-warning);
}

.kb-index-card__inline-error {
  margin: 10px 0 0;
  color: var(--hc-error);
  font-size: 11.5px;
}

.kb-index-error {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 14px;
  color: var(--hc-error);
}

.kb-index-error__copy {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
}

.kb-index-error__copy b {
  color: var(--hc-text-primary);
  font-size: 13px;
}

@keyframes kb-index-spin {
  to {
    transform: rotate(360deg);
  }
}

@container (max-width: 520px) {
  .kb-index-card__summary {
    max-width: 36%;
  }

  .kb-index-card__setting {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .kb-index-card__selector {
    width: 100%;
    max-width: none;
    min-width: 0;
    min-height: 44px;
    margin-left: 0;
  }
}

@container (max-width: 420px) {
  .kb-index-card__summary {
    max-width: 28%;
  }

  .kb-index-card__actual {
    flex-wrap: wrap;
  }

  .kb-index-card__spacer {
    display: none;
  }

  .kb-index-card__actual-state {
    margin-left: auto;
  }
}

@container (max-width: 360px) {
  .kb-index-card__summary {
    display: none;
  }

  .kb-index-card__header {
    gap: 7px;
  }

  .kb-index-card__status {
    margin-left: auto;
    font-size: 10.5px;
  }

  .kb-index-card__body {
    padding-inline: 13px;
  }

  .kb-index-card__selector {
    max-width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .kb-index-card__chevron,
  .kb-index-card__spinner {
    transition: none;
    animation: none;
  }
}
</style>
