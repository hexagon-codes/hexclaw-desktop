<script setup lang="ts">
/**
 * 语义索引策略卡。
 *
 * 新 sidecar 提供 corpus-scoped embedding policy 时显示完整选择器；旧 sidecar 的
 * 404/405 只回退到原有的本地模型安装恢复横幅。其他故障必须显式可重试，不能把
 * 服务故障伪装成“功能尚未提供”。
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, CheckCircle2, ChevronDown, LoaderCircle, Sparkles } from 'lucide-vue-next'
import EmbeddingStatusBanner from './EmbeddingStatusBanner.vue'
import EmbeddingProfileSelect from './EmbeddingProfileSelect.vue'
import {
  applyKnowledgeEmbeddingPolicy,
  getKnowledgeEmbeddingPolicy,
  isKnowledgeEmbeddingPolicyUnsupported,
  type EmbeddingProfile,
  type EmbeddingRevisionProjection,
  type EmbeddingSelection,
  type KnowledgeEmbeddingPolicyProjection,
} from '@/api/knowledge-index'
import { thirdPartyAiServicesUrl } from '@/utils/legal-links'

const CORPUS_ID = 'default'

const { t, locale } = useI18n()
const mode = ref<'loading' | 'policy' | 'legacy' | 'error'>('loading')
const policy = ref<KnowledgeEmbeddingPolicyProjection | null>(null)
const expanded = ref(false)
const applying = ref(false)
const errorDetail = ref('')
const announcement = ref('')
const providerDocsUrl = computed(() => thirdPartyAiServicesUrl(locale.value))

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const shaped = error as { status?: number; statusCode?: number }
  return shaped.status ?? shaped.statusCode
}

function shouldRevealFailure(projection: KnowledgeEmbeddingPolicyProjection): boolean {
  return (
    projection.active_revision?.state === 'failed' ||
    projection.desired_revision?.state === 'failed'
  )
}

async function loadPolicy() {
  mode.value = 'loading'
  errorDetail.value = ''
  try {
    const next = await getKnowledgeEmbeddingPolicy(CORPUS_ID)
    policy.value = next
    mode.value = 'policy'
    if (shouldRevealFailure(next)) expanded.value = true
  } catch (error) {
    if (isKnowledgeEmbeddingPolicyUnsupported(error)) {
      policy.value = null
      mode.value = 'legacy'
      return
    }
    mode.value = 'error'
    errorDetail.value = error instanceof Error ? error.message : String(error)
  }
}

onMounted(() => void loadPolicy())

function profileForSelection(selection: EmbeddingSelection): EmbeddingProfile | null {
  if (selection.kind !== 'profile') return null
  return (
    policy.value?.available_profiles.find((item) => item.profile_id === selection.profile_id) ??
    null
  )
}

const selectionLabel = computed(() => {
  const selection = policy.value?.selection
  if (!selection) return ''
  if (selection.kind === 'auto') return t('knowledge.semanticIndex.auto', '自动')
  if (selection.kind === 'disabled') return t('knowledge.semanticIndex.textOnly', '仅文本检索')
  return profileForSelection(selection)?.model_name ?? selection.profile_id
})

function revisionProfile(revision: EmbeddingRevisionProjection | null | undefined) {
  return revision?.profile ?? null
}

const activeProfile = computed(() => revisionProfile(policy.value?.active_revision))
const desiredRevision = computed(() => policy.value?.desired_revision ?? null)

function revisionProgress(revision: EmbeddingRevisionProjection | null): string {
  if (!revision || revision.chunks_total == null || revision.chunks_done == null) return ''
  return `${revision.chunks_done}/${revision.chunks_total}`
}

function stateLabel(state: EmbeddingRevisionProjection['state'] | undefined): string {
  switch (state) {
    case 'ready':
      return t('knowledge.semanticIndex.ready', '已就绪')
    case 'building':
    case 'pending':
      return t('knowledge.semanticIndex.enhancing', '增强中')
    case 'retry_wait':
      return t('knowledge.semanticIndex.retrying', '等待重试')
    case 'failed':
      return t('knowledge.semanticIndex.failed', '需要处理')
    case 'cancelled':
      return t('knowledge.semanticIndex.cancelled', '已取消')
    case 'disabled':
      return t('knowledge.semanticIndex.textReady', '文本检索可用')
    default:
      return t('knowledge.semanticIndex.preparing', '准备中')
  }
}

const summaryParts = computed(() => {
  const current = policy.value
  if (!current) return []
  const parts = [selectionLabel.value]
  const active = activeProfile.value

  if (desiredRevision.value) {
    parts.push(
      active
        ? `${t('knowledge.semanticIndex.currentModel', '当前使用')} ${active.model_name}${active.provider_name ? ` · ${active.provider_name}` : ''}`
        : t('knowledge.semanticIndex.noActiveModel', '当前仅使用文本检索'),
    )
    const progress = revisionProgress(desiredRevision.value)
    parts.push(
      progress
        ? `${stateLabel(desiredRevision.value.state)} ${progress}`
        : stateLabel(desiredRevision.value.state),
    )
  } else if (current.selection.kind === 'disabled') {
    parts.push(t('knowledge.semanticIndex.textReady', '文本检索可用'))
  } else {
    if (active) parts.push(active.provider_name || active.model_name)
    parts.push(stateLabel(current.active_revision?.state))
  }
  return parts.filter(Boolean)
})

const selectorLabels = computed(() => ({
  selectLabel: t('knowledge.semanticIndex.modelLabel', '索引模型'),
  auto: t('knowledge.semanticIndex.auto', '自动'),
  recommended: t('knowledge.semanticIndex.recommended', '推荐'),
  cloudGroup: t('knowledge.semanticIndex.cloudGroup', '云端模型'),
  localGroup: t('knowledge.semanticIndex.localGroup', '本地模型'),
  textOnly: t('knowledge.semanticIndex.textOnly', '仅文本检索'),
  local: t('knowledge.semanticIndex.local', '本地'),
  cloud: t('knowledge.semanticIndex.cloud', '云端'),
  installed: t('knowledge.semanticIndex.installed', '已安装'),
  connected: t('knowledge.semanticIndex.configured', '已配置'),
  downloadable: t('knowledge.semanticIndex.downloadable', '可下载'),
  downloading: t('knowledge.semanticIndex.downloading', '下载中'),
  unavailable: t('knowledge.semanticIndex.unavailable', '不可用'),
}))

async function selectPolicy(selection: EmbeddingSelection) {
  const current = policy.value
  if (!current || applying.value) return
  applying.value = true
  errorDetail.value = ''
  try {
    await applyKnowledgeEmbeddingPolicy(CORPUS_ID, current.policy_version, selection)
    const refreshed = await getKnowledgeEmbeddingPolicy(CORPUS_ID)
    policy.value = refreshed
    announcement.value = t('knowledge.semanticIndex.updated', '索引模型设置已更新')
  } catch (error) {
    // 乐观锁冲突时先刷新真相，再提示用户；绝不以旧版本覆盖新状态。
    if (errorStatus(error) === 409) {
      try {
        policy.value = await getKnowledgeEmbeddingPolicy(CORPUS_ID)
      } catch {
        // 下方统一显示原错误；刷新失败不能覆盖最初的冲突信息。
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
  }
}

const activeDetail = computed(() => {
  const active = activeProfile.value
  if (!active) return t('knowledge.semanticIndex.textOnly', '仅文本检索')
  const location =
    active.location === 'local'
      ? t('knowledge.semanticIndex.local', '本地')
      : t('knowledge.semanticIndex.cloud', '云端')
  return `${active.model_name} · ${active.provider_name} · ${location}`
})
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
      <span v-if="errorDetail">{{ errorDetail }}</span>
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
    data-testid="kb-semantic-index-card"
  >
    <button
      type="button"
      class="kb-index-card__header"
      data-testid="kb-semantic-index-header"
      :aria-expanded="expanded"
      aria-controls="kb-semantic-index-body"
      @click="expanded = !expanded"
    >
      <span class="kb-index-card__heading">
        <Sparkles :size="16" aria-hidden="true" />
        <span>{{ t('knowledge.semanticIndex.title', '语义索引') }}</span>
      </span>
      <span class="kb-index-card__summary" data-testid="kb-semantic-index-summary">
        <span v-for="(part, index) in summaryParts" :key="`${part}-${index}`">
          <span v-if="index" aria-hidden="true"> · </span>{{ part }}
        </span>
      </span>
      <ChevronDown
        :size="16"
        class="kb-index-card__chevron"
        :class="{ 'kb-index-card__chevron--open': expanded }"
        aria-hidden="true"
      />
    </button>

    <div
      v-if="expanded"
      id="kb-semantic-index-body"
      class="kb-index-card__body"
      data-testid="kb-semantic-index-body"
    >
      <div class="kb-index-card__setting">
        <div class="kb-index-card__setting-copy">
          <b>{{ t('knowledge.semanticIndex.modelLabel', '索引模型') }}</b>
          <span>{{
            policy.recommendation?.reason_text ||
            t('knowledge.semanticIndex.modelHint', '自动选择通常最省心，也可以固定使用一个模型。')
          }}</span>
        </div>
        <div class="kb-index-card__selector">
          <LoaderCircle
            v-if="applying"
            :size="15"
            class="kb-index-card__spinner"
            aria-hidden="true"
          />
          <EmbeddingProfileSelect
            :selection="policy.selection"
            :profiles="policy.available_profiles"
            :recommendation-profile-id="policy.recommendation?.profile_id ?? null"
            :labels="selectorLabels"
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
            :disabled="applying"
            @select="selectPolicy"
          />
        </div>
      </div>

      <div class="kb-index-card__actual">
        <CheckCircle2
          v-if="policy.active_revision?.state === 'ready'"
          :size="14"
          aria-hidden="true"
        />
        <LoaderCircle v-else :size="14" aria-hidden="true" />
        <span>
          <b>{{ t('knowledge.semanticIndex.currentModel', '当前使用') }}</b>
          {{ activeDetail }}
        </span>
      </div>

      <div v-if="desiredRevision" class="kb-index-card__progress" role="status">
        <span>
          {{
            t(
              'knowledge.semanticIndex.backgroundEnhancing',
              '大文件文本已可检索，语义索引正在后台增强。',
            )
          }}
        </span>
        <span v-if="revisionProgress(desiredRevision)" class="kb-index-card__progress-value">
          {{ revisionProgress(desiredRevision) }}
        </span>
        <progress
          v-if="desiredRevision.chunks_total"
          :value="desiredRevision.chunks_done ?? 0"
          :max="desiredRevision.chunks_total"
        />
      </div>

      <p v-if="errorDetail" class="kb-index-card__inline-error" role="alert">{{ errorDetail }}</p>
    </div>
    <p class="sr-only" aria-live="polite">{{ announcement }}</p>
  </section>
</template>

<style scoped>
.kb-index-card,
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
  min-height: 58px;
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr) 18px;
  align-items: center;
  gap: 16px;
  padding: 13px 18px;
  border: 0;
  border-radius: inherit;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.kb-index-card__header:focus-visible {
  outline: 2px solid var(--hc-accent);
  outline-offset: -2px;
}

.kb-index-card__heading,
.kb-index-card__summary,
.kb-index-card__actual,
.kb-index-card__progress {
  display: flex;
  align-items: center;
}

.kb-index-card__heading {
  gap: 8px;
  font-size: 14px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.kb-index-card__heading svg {
  color: var(--hc-accent);
}

.kb-index-card__summary {
  min-width: 0;
  justify-content: flex-end;
  overflow: hidden;
  color: var(--hc-text-secondary);
  font-size: 12.5px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.kb-index-card__summary > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.kb-index-card__chevron {
  color: var(--hc-text-muted);
  transition: transform 160ms ease;
}

.kb-index-card__chevron--open {
  transform: rotate(180deg);
}

.kb-index-card__body {
  padding: 18px;
  border-top: 0.5px solid var(--hc-border);
}

.kb-index-card__setting {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
  align-items: center;
  gap: 24px;
}

.kb-index-card__setting-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.kb-index-card__setting-copy b {
  font-size: 13.5px;
  font-weight: 600;
}

.kb-index-card__setting-copy span,
.kb-index-card__actual,
.kb-index-card__progress {
  color: var(--hc-text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.kb-index-card__selector {
  position: relative;
  min-width: 0;
}

.kb-index-card__spinner {
  position: absolute;
  z-index: 2;
  top: 11px;
  right: 36px;
  color: var(--hc-accent);
  animation: kb-index-spin 0.8s linear infinite;
}

.kb-index-card__actual,
.kb-index-card__progress {
  gap: 7px;
  margin-top: 14px;
}

.kb-index-card__actual svg {
  flex: none;
  color: var(--hc-success, #22a447);
}

.kb-index-card__progress {
  display: grid;
  grid-template-columns: minmax(0, 1fr) max-content;
}

.kb-index-card__progress-value {
  color: var(--hc-text-primary);
  font-variant-numeric: tabular-nums;
}

.kb-index-card__progress progress {
  grid-column: 1 / -1;
  width: 100%;
  height: 4px;
  accent-color: var(--hc-accent);
}

.kb-index-card__inline-error {
  margin: 12px 0 0;
  color: var(--hc-error);
  font-size: 12px;
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

@media (max-width: 640px) {
  .kb-index-card__header {
    grid-template-columns: minmax(0, 1fr) 18px;
    gap: 7px;
    padding: 12px 14px;
  }

  .kb-index-card__summary {
    grid-column: 1;
    grid-row: 2;
    justify-content: flex-start;
  }

  .kb-index-card__chevron {
    grid-column: 2;
    grid-row: 1 / span 2;
  }

  .kb-index-card__setting {
    grid-template-columns: 1fr;
    gap: 12px;
  }

  .kb-index-card__body {
    padding: 14px;
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
