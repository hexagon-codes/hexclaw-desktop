<script setup lang="ts">
/**
 * ContextDetailPanel — Task 详情面板。
 *
 * 消费 WorkspaceContextProjection | null，不 import RuntimeContext。
 * 5 个 UX section：task / skill / execution / outputs / health。
 *
 * 不显示：
 * - System Layer
 * - Skill capabilities
 * - Execution valid transitions
 * - Memory Layer
 * - semantic layer topology
 *
 * Health section 默认折叠，hasIssues 时自动展开。
 */
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { MessageCircle, Copy, FileText, Image, File, Code, Wrench } from 'lucide-vue-next'
import type { WorkspaceContextProjection, TaskResultProjection, ResultItemProjection } from '@/types/workspace'
import ContextCard from '@/components/inspector/ContextCard.vue'
import KeyValueRow from '@/components/inspector/KeyValueRow.vue'

const { t } = useI18n()
const router = useRouter()

const props = defineProps<{
  projection: WorkspaceContextProjection | null
  resultProjection: TaskResultProjection | null
}>()

// Health section: 默认折叠，hasIssues 时自动展开
const healthExpanded = ref(false)

watch(
  () => props.projection?.health?.hasIssues,
  (hasIssues) => {
    if (hasIssues) healthExpanded.value = true
  },
)

const healthStatusLabel = computed(() => {
  if (!props.projection?.health) return ''
  if (props.projection.health.hasIssues) {
    return props.projection.health.severity === 'critical'
      ? t('workspace.health.critical')
      : t('workspace.health.warning')
  }
  return t('workspace.health.healthy')
})

const healthStatusColor = computed(() => {
  if (!props.projection?.health) return ''
  if (!props.projection.health.hasIssues) return 'var(--hc-success)'
  return props.projection.health.severity === 'critical'
    ? 'var(--hc-error)'
    : 'var(--hc-warning)'
})

function stateLabel(state: string): string {
  const map: Record<string, string> = {
    idle: t('workspace.execution.stateIdle'),
    preparing: t('workspace.execution.statePreparing'),
    running: t('workspace.execution.stateRunning'),
    completed: t('workspace.execution.stateCompleted'),
    failed: t('workspace.execution.stateFailed'),
  }
  return map[state] || state
}

function stageLabel(stage: string): string {
  const map: Record<string, string> = {
    preparing: t('workspace.execution.stagePreparing'),
    executing: t('workspace.execution.stageExecuting'),
    finalizing: t('workspace.execution.stageFinalizing'),
  }
  return map[stage] || stage
}

function stateColor(state: string): string {
  const map: Record<string, string> = {
    idle: 'var(--hc-text-muted)',
    preparing: '#f59e0b',
    running: 'var(--hc-accent)',
    completed: 'var(--hc-success)',
    failed: 'var(--hc-error)',
  }
  return map[state] || 'var(--hc-text-muted)'
}

function navigateToChat(sessionId: string) {
  router.push({ path: '/chat', query: { sessionId } })
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

async function copyPath(path: string) {
  try {
    await navigator.clipboard.writeText(path)
  } catch {
    // clipboard unavailable — 静默失败
  }
}

function getKindIcon(kind: ResultItemProjection['kind']) {
  const map: Record<string, typeof File> = {
    text: FileText,
    code: Code,
    image: Image,
    audio: File,
    video: File,
    file: File,
    tool_call: Wrench,
  }
  return map[kind] ?? File
}

function getGroupLabel(group: string): string {
  const map: Record<string, string> = {
    primary: t('workspace.result.primaryGroup'),
    generated_files: t('workspace.result.filesGroup'),
    supporting: t('workspace.result.supportingGroup'),
  }
  return map[group] || group
}
</script>

<template>
  <div class="context-detail">
    <!-- No selection -->
    <div v-if="!projection" class="context-detail__empty">
      <p class="context-detail__empty-text">{{ t('workspace.noSelection') }}</p>
    </div>

    <template v-else>
      <!-- Task section -->
      <ContextCard :eyebrow="t('workspace.sections.task')" :title="projection.task.goal || projection.taskId.slice(0, 8)">
        <button
          v-if="projection.task.navigation?.chatSessionId"
          class="context-detail__nav-btn"
          @click="navigateToChat(projection.task.navigation.chatSessionId)"
        >
          <MessageCircle :size="12" />
          <span>{{ t('workspace.goToChat') }}</span>
        </button>
        <KeyValueRow
          :label="t('workspace.field.status')"
          :value="projection.task.status"
        />
        <KeyValueRow
          v-if="projection.task.progress !== undefined"
          :label="t('workspace.field.progress')"
          :value="`${projection.task.progress}%`"
        />
        <KeyValueRow
          v-if="projection.task.inputSummary"
          :label="t('workspace.field.input')"
          :value="projection.task.inputSummary"
        />
        <KeyValueRow
          v-if="projection.task.outputSummary"
          :label="t('workspace.field.output')"
          :value="projection.task.outputSummary"
        />
        <KeyValueRow
          v-if="projection.task.errorCode"
          :label="t('workspace.field.error')"
          :value="`${projection.task.errorCode}: ${projection.task.errorMessage || ''}`"
          :value-color="'var(--hc-error)'"
        />
      </ContextCard>

      <!-- Skill section -->
      <ContextCard
        v-if="projection.skill"
        :eyebrow="t('workspace.sections.skill')"
        :title="`${projection.skill.skillId} v${projection.skill.version}`"
      >
        <KeyValueRow
          :label="t('workspace.field.instructions')"
          :value="projection.skill.loadedSections.markdown
            ? t('workspace.skill.markdownLoaded')
            : t('workspace.skill.markdownUnloaded')"
        />
        <KeyValueRow
          :label="t('workspace.field.references')"
          :value="projection.skill.loadedSections.references
            ? t('workspace.skill.referencesLoaded')
            : t('workspace.skill.referencesUnloaded')"
        />
        <KeyValueRow
          :label="t('workspace.field.status')"
          :value="projection.skill.status"
          :value-color="projection.skill.status === 'loaded'
            ? 'var(--hc-success)'
            : projection.skill.status === 'error'
              ? 'var(--hc-error)'
              : 'var(--hc-text-muted)'"
        />
      </ContextCard>

      <!-- Execution section -->
      <ContextCard
        v-if="projection.execution"
        :eyebrow="t('workspace.sections.execution')"
        :title="stateLabel(projection.execution.state)"
      >
        <KeyValueRow
          :label="t('workspace.field.state')"
          :value="stateLabel(projection.execution.state)"
          :value-color="stateColor(projection.execution.state)"
        />
        <KeyValueRow
          :label="t('workspace.field.stage')"
          :value="stageLabel(projection.execution.stage)"
        />
        <KeyValueRow
          :label="t('workspace.field.steps')"
          :value="String(projection.execution.stepCount)"
        />
        <KeyValueRow
          :label="t('workspace.field.elapsed')"
          :value="projection.execution.elapsed"
        />
      </ContextCard>

      <!-- Result section（取代旧 Outputs section） -->
      <ContextCard
        v-if="resultProjection"
        :eyebrow="t('workspace.sections.outputs')"
        :title="resultProjection.summary"
      >
        <div class="context-detail__results">
          <div
            v-for="item in resultProjection.items"
            :key="item.id"
            class="result-item"
          >
            <!-- Header row -->
            <div class="result-item__header">
              <component :is="getKindIcon(item.kind)" :size="14" class="result-item__icon" />
              <div class="result-item__info">
                <span class="result-item__title">{{ item.title }}</span>
                <span v-if="item.description" class="result-item__desc">{{ item.description }}</span>
              </div>
              <span class="result-item__group-tag">{{ getGroupLabel(item.group) }}</span>
              <span
                class="result-item__status"
                :class="{
                  'result-item__status--valid': item.status === 'valid',
                  'result-item__status--invalid': item.status === 'invalid',
                }"
              >
                ●
              </span>
            </div>
            <!-- Metadata row -->
            <div class="result-item__meta">
              <span v-if="item.sizeBytes !== undefined" class="result-item__meta-item">
                {{ t('workspace.result.sizeLabel') }}: {{ formatSize(item.sizeBytes) }}
              </span>
              <span v-if="item.mimeType" class="result-item__meta-item">{{ item.mimeType }}</span>
              <span v-if="item.dimensions" class="result-item__meta-item">
                {{ item.dimensions.width }}×{{ item.dimensions.height }}
              </span>
            </div>
            <!-- Path row -->
            <div v-if="item.path" class="result-item__path-row">
              <span class="result-item__path-label">{{ t('workspace.result.pathLabel') }}:</span>
              <span class="result-item__path-value">{{ item.path }}</span>
              <button
                class="result-item__copy-btn"
                :title="t('workspace.result.copyPath')"
                @click="copyPath(item.path)"
              >
                <Copy :size="10" />
              </button>
            </div>
          </div>
        </div>
      </ContextCard>

      <!-- 无 Result 时 fallback 到旧 outputs -->
      <ContextCard
        v-else-if="projection.outputs"
        :eyebrow="t('workspace.sections.outputs')"
        :title="t('workspace.outputs.generated', { n: projection.outputs.generatedAssets })"
      >
        <KeyValueRow
          :label="t('workspace.field.status')"
          :value="projection.outputs.hasInvalidAssets
            ? t('workspace.outputs.hasInvalid')
            : t('workspace.outputs.allValid')"
          :value-color="projection.outputs.hasInvalidAssets
            ? 'var(--hc-warning)'
            : 'var(--hc-success)'"
        />
      </ContextCard>

      <!-- Health section -->
      <ContextCard
        v-if="projection.health"
        :eyebrow="t('workspace.sections.health')"
        :title="t('workspace.health.label')"
      >
        <button
          class="context-detail__health-toggle"
          @click="healthExpanded = !healthExpanded"
        >
          <span
            class="context-detail__health-status"
            :style="{ color: healthStatusColor }"
          >
            ● {{ healthStatusLabel }}
          </span>
          <span class="context-detail__health-chevron" :class="{ 'context-detail__health-chevron--open': healthExpanded }">
            ▶
          </span>
        </button>
        <div v-if="healthExpanded" class="context-detail__health-detail">
          <KeyValueRow
            :label="t('workspace.field.issues')"
            :value="projection.health.hasIssues ? 'Yes' : t('workspace.health.noIssues')"
            :value-color="projection.health.hasIssues ? 'var(--hc-warning)' : 'var(--hc-success)'"
          />
          <KeyValueRow
            v-if="projection.health.severity"
            :label="t('workspace.field.severity')"
            :value="projection.health.severity"
          />
        </div>
      </ContextCard>
    </template>
  </div>
</template>

<style scoped>
.context-detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
}

.context-detail__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48px 16px;
}

.context-detail__empty-text {
  font-size: 13px;
  color: var(--hc-text-muted);
}

/* Nav button */
.context-detail__nav-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border: 1px solid var(--hc-accent);
  border-radius: var(--hc-radius-sm, 6px);
  background: transparent;
  color: var(--hc-accent);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.context-detail__nav-btn:hover {
  background: var(--hc-accent-subtle, rgba(0, 122, 255, 0.08));
}

/* Health toggle */
.context-detail__health-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 4px 0;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 12px;
  color: var(--hc-text-primary);
}

.context-detail__health-status {
  font-weight: 500;
}

.context-detail__health-chevron {
  font-size: 8px;
  color: var(--hc-text-muted);
  transition: transform 0.15s;
}

.context-detail__health-chevron--open {
  transform: rotate(90deg);
}

.context-detail__health-detail {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--hc-divider);
}

/* ── Result items ──────────────────────────────── */

.context-detail__results {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.result-item {
  border: 1px solid var(--hc-border-subtle);
  border-radius: 6px;
  padding: 10px 12px;
  background: var(--hc-bg-subtle);
}

.result-item__header {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.result-item__icon {
  flex-shrink: 0;
  color: var(--hc-text-secondary);
  margin-top: 1px;
}

.result-item__info {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.result-item__title {
  font-size: 12px;
  font-weight: 600;
  color: var(--hc-text-primary);
  line-height: 1.35;
  word-break: break-word;
}

.result-item__desc {
  font-size: 11px;
  color: var(--hc-text-muted);
  line-height: 1.35;
}

.result-item__group-tag {
  flex-shrink: 0;
  font-size: 9px;
  font-weight: 600;
  color: var(--hc-text-muted);
  background: var(--hc-bg-active);
  padding: 1px 6px;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.result-item__status {
  flex-shrink: 0;
  font-size: 8px;
  color: var(--hc-text-muted);
  margin-top: 2px;
}

.result-item__status--valid {
  color: var(--hc-success);
}

.result-item__status--invalid {
  color: var(--hc-error);
}

.result-item__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
  padding-left: 22px;
}

.result-item__meta-item {
  font-size: 10px;
  color: var(--hc-text-muted);
}

.result-item__path-row {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  padding-left: 22px;
}

.result-item__path-label {
  font-size: 10px;
  color: var(--hc-text-muted);
  flex-shrink: 0;
}

.result-item__path-value {
  font-size: 10px;
  font-family: ui-monospace, monospace;
  color: var(--hc-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.result-item__copy-btn {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  border-radius: 4px;
}

.result-item__copy-btn:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}
</style>
