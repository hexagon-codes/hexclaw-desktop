<script setup lang="ts">
import { computed, ref } from 'vue'

import HcClearableField from '@/components/common/HcClearableField.vue'

import type { SourceIssueAction, SourceIssueIntent } from '../source-issue'

const props = defineProps<{
  scope: 'problem' | 'group'
  displayLabel: string
  affectedLabels: string[]
  problemIds: string[]
  dependencyGroupId?: string
  structureVersion: number
  expectedInputRevision: number
  skipped: boolean
  commandAvailable: boolean
  disabled?: boolean
  skipLabel: string
}>()

const emit = defineEmits<{
  (event: 'intent', intent: SourceIssueIntent): void
}>()

const correctionOpen = ref(false)
const skipOpen = ref(false)
const correctedText = ref('')
const locked = computed(() => props.disabled === true || !props.commandAvailable)
const affectedCopy = computed(() => props.affectedLabels.join(' 和'))

function dispatch(action: SourceIssueAction, payload?: SourceIssueIntent['payload']) {
  if (locked.value) return
  emit('intent', {
    action,
    problem_ids: [...props.problemIds],
    dependency_group_id: props.dependencyGroupId,
    structure_version: props.structureVersion,
    expected_input_revision: props.expectedInputRevision,
    payload,
  })
}

function saveCorrection() {
  const corrected = correctedText.value.trim()
  if (!corrected) return
  dispatch('correct_recognition', { corrected_text: corrected })
  correctionOpen.value = false
}

function confirmSkip() {
  dispatch('skip')
  skipOpen.value = false
}
</script>

<template>
  <div
    class="source-resolver"
    data-source-issue-resolver
    :data-resolver-scope="scope"
  >
    <button
      v-if="skipped"
      type="button"
      :disabled="locked"
      @click="dispatch('resume')"
    >
      恢复处理
    </button>
    <template v-else>
      <div class="source-resolver__actions">
        <button type="button" :disabled="locked" @click="correctionOpen = true">
          纠正识别
        </button>
        <button type="button" :disabled="locked" @click="dispatch('reselect_region')">
          重新选择区域
        </button>
        <button type="button" :disabled="locked" @click="dispatch('retake')">
          重新拍摄
        </button>
        <button type="button" :disabled="locked" @click="skipOpen = true">
          {{ skipLabel }}
        </button>
      </div>
      <div v-if="correctionOpen" class="source-resolver__correction">
        <label>
          <span>纠正识别内容</span>
          <HcClearableField>
            <textarea v-model="correctedText" :aria-label="`纠正${displayLabel}识别内容`" />
          </HcClearableField>
        </label>
        <button type="button" :disabled="locked || !correctedText.trim()" @click="saveCorrection">
          保存并重新处理
        </button>
        <button type="button" @click="correctionOpen = false">取消</button>
      </div>
      <div
        v-if="skipOpen"
        class="source-resolver__dialog"
        role="alertdialog"
        aria-modal="true"
        :aria-label="scope === 'group' ? '确认跳过题组' : '确认跳过题目'"
      >
        <p>
          {{ affectedCopy }} 将标记为“已跳过 · 未判断对错”，不会写入错题、复习或学情；其他题继续处理。
        </p>
        <button type="button" :disabled="locked" @click="confirmSkip">
          {{ scope === 'group' ? `确认跳过 ${problemIds.length} 题` : '确认跳过这题' }}
        </button>
        <button type="button" @click="skipOpen = false">取消</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.source-resolver {
  display: grid;
  gap: 8px;
}
.source-resolver__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.source-resolver button {
  border: 1px solid var(--hc-border);
  border-radius: 8px;
  background: var(--hc-bg-card);
  color: var(--hc-text-primary);
  padding: 5px 8px;
  font: inherit;
  cursor: pointer;
}
.source-resolver button:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}
.source-resolver__correction,
.source-resolver__dialog {
  display: grid;
  gap: 7px;
  padding: 9px;
  border: 1px solid var(--hc-border);
  border-radius: 9px;
  background: var(--hc-bg-card);
}
.source-resolver__correction label {
  display: grid;
  gap: 5px;
}
.source-resolver__correction textarea {
  min-height: 64px;
  resize: vertical;
}
.source-resolver__dialog p {
  margin: 0;
}
</style>
