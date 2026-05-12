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
import type { WorkspaceContextProjection } from '@/types/workspace'
import ContextCard from '@/components/inspector/ContextCard.vue'
import KeyValueRow from '@/components/inspector/KeyValueRow.vue'

const { t } = useI18n()

const props = defineProps<{
  projection: WorkspaceContextProjection | null
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

      <!-- Outputs section -->
      <ContextCard
        v-if="projection.outputs"
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
</style>
