<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

import HcClearableField from '@/components/common/HcClearableField.vue'

import type { SourceIssueIntent, SourceIssueRetakeFileIntent, SourceRegion } from '../source-issue'
import SourceRegionSelector from './SourceRegionSelector.vue'

type SourcePanel = 'correction' | 'region' | 'retake' | 'skip'

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
  pageAssetId?: string
  sourceImageUrl?: string
  sourceWidth?: number
  sourceHeight?: number
  currentSourceRegion?: SourceRegion
}>()

const emit = defineEmits<{
  (event: 'intent', intent: SourceIssueIntent): void
  (event: 'retakeFile', intent: SourceIssueRetakeFileIntent): void
}>()

const activePanel = ref<SourcePanel | null>(null)
const correctedText = ref('')
const regionDraft = ref<SourceRegion>(initialRegionDraft())
const regionEditor = ref<InstanceType<typeof SourceRegionSelector> | null>(null)
const retakeInput = ref<HTMLInputElement | null>(null)
let activeTrigger: HTMLButtonElement | null = null

const locked = computed(() => props.disabled === true || !props.commandAvailable)
const affectedCopy = computed(() => props.affectedLabels.join(' 和'))
const sourceEditorAvailable = computed(
  () =>
    !!props.pageAssetId?.trim() &&
    !!props.sourceImageUrl?.trim() &&
    Number.isInteger(props.sourceWidth) &&
    Number.isInteger(props.sourceHeight) &&
    (props.sourceWidth ?? 0) > 0 &&
    (props.sourceHeight ?? 0) > 0,
)
const regionValid = computed(() => {
  const width = Math.floor(props.sourceWidth ?? 0)
  const height = Math.floor(props.sourceHeight ?? 0)
  const region = regionDraft.value
  return (
    sourceEditorAvailable.value &&
    Number.isInteger(region.x) &&
    Number.isInteger(region.y) &&
    Number.isInteger(region.width) &&
    Number.isInteger(region.height) &&
    region.x >= 0 &&
    region.y >= 0 &&
    region.width > 0 &&
    region.height > 0 &&
    region.x + region.width <= width &&
    region.y + region.height <= height
  )
})

function intentBase() {
  return {
    problem_ids: [...props.problemIds],
    dependency_group_id: props.dependencyGroupId,
    structure_version: props.structureVersion,
    expected_input_revision: props.expectedInputRevision,
  }
}

function initialRegionDraft(): SourceRegion {
  const sourceWidth = Math.max(0, Math.floor(props.sourceWidth ?? 0))
  const sourceHeight = Math.max(0, Math.floor(props.sourceHeight ?? 0))
  if (sourceWidth < 1 || sourceHeight < 1) return { x: 0, y: 0, width: 0, height: 0 }
  const current = props.currentSourceRegion
  const x = Math.max(0, Math.min(sourceWidth - 1, Math.round(Number(current?.x) || 0)))
  const y = Math.max(0, Math.min(sourceHeight - 1, Math.round(Number(current?.y) || 0)))
  const width = Math.max(
    1,
    Math.min(sourceWidth - x, Math.round(Number(current?.width) || sourceWidth)),
  )
  const height = Math.max(
    1,
    Math.min(sourceHeight - y, Math.round(Number(current?.height) || sourceHeight)),
  )
  return { x, y, width, height }
}

function resetRegionDraft(): void {
  regionDraft.value = initialRegionDraft()
}

function clearRetakeInput(): void {
  if (retakeInput.value) retakeInput.value.value = ''
}

async function openPanel(panel: SourcePanel, event: Event): Promise<void> {
  if (locked.value) return
  if (activePanel.value === 'region') resetRegionDraft()
  if (activePanel.value === 'retake') clearRetakeInput()
  activeTrigger = event.currentTarget as HTMLButtonElement
  activePanel.value = panel
  if (panel === 'region') resetRegionDraft()
  if (panel === 'retake') clearRetakeInput()
  await nextTick()
  if (panel === 'region') regionEditor.value?.focus()
}

async function closePanel(restoreFocus: boolean): Promise<void> {
  if (locked.value) return
  if (activePanel.value === 'region') resetRegionDraft()
  if (activePanel.value === 'retake') clearRetakeInput()
  activePanel.value = null
  await nextTick()
  if (restoreFocus) activeTrigger?.focus()
}

function closeOnEscape(event: KeyboardEvent): void {
  if (!activePanel.value || locked.value) return
  event.preventDefault()
  void closePanel(true)
}

function saveCorrection(): void {
  const corrected = correctedText.value.trim()
  if (locked.value || !corrected) return
  emit('intent', {
    ...intentBase(),
    action: 'correct_recognition',
    payload: { corrected_text: corrected },
  })
  activePanel.value = null
}

function confirmRegion(): void {
  const pageAssetId = props.pageAssetId?.trim() ?? ''
  if (locked.value || !pageAssetId || !regionValid.value) return
  emit('intent', {
    ...intentBase(),
    action: 'reselect_region',
    payload: { page_asset_id: pageAssetId, region: { ...regionDraft.value } },
  })
}

function chooseRetakeFile(): void {
  if (locked.value || !retakeInput.value) return
  clearRetakeInput()
  retakeInput.value.click()
}

function selectRetakeFile(event: Event): void {
  if (locked.value) return
  const input = event.currentTarget as HTMLInputElement
  const file = input.files?.[0]
  if (!file || !file.type.startsWith('image/')) return
  emit('retakeFile', { ...intentBase(), action: 'retake', file })
  clearRetakeInput()
}

function confirmSkip(): void {
  if (locked.value) return
  emit('intent', { ...intentBase(), action: 'skip' })
  activePanel.value = null
}

function resume(): void {
  if (locked.value) return
  emit('intent', { ...intentBase(), action: 'resume' })
}

watch(
  () => [
    props.pageAssetId,
    props.sourceWidth,
    props.sourceHeight,
    props.currentSourceRegion?.x,
    props.currentSourceRegion?.y,
    props.currentSourceRegion?.width,
    props.currentSourceRegion?.height,
  ],
  () => resetRegionDraft(),
)
</script>

<template>
  <div
    class="source-resolver"
    data-source-issue-resolver
    :data-resolver-scope="scope"
    :aria-busy="locked ? 'true' : undefined"
    @keydown.esc="closeOnEscape"
  >
    <button v-if="skipped" type="button" class="hc-btn" :disabled="locked" @click="resume">
      恢复处理
    </button>
    <template v-else>
      <div class="source-resolver__actions">
        <button
          type="button"
          class="hc-btn"
          :disabled="locked"
          @click="openPanel('correction', $event)"
        >
          纠正识别
        </button>
        <button
          type="button"
          class="hc-btn"
          :disabled="locked"
          @click="openPanel('region', $event)"
        >
          重新选择区域
        </button>
        <button
          type="button"
          class="hc-btn"
          :disabled="locked"
          @click="openPanel('retake', $event)"
        >
          重新拍摄
        </button>
        <button type="button" class="hc-btn" :disabled="locked" @click="openPanel('skip', $event)">
          {{ skipLabel }}
        </button>
      </div>

      <div
        v-if="activePanel === 'correction'"
        class="source-resolver__panel source-resolver__correction"
        data-source-panel="correction"
      >
        <label>
          <span>纠正识别内容</span>
          <HcClearableField>
            <textarea
              v-model="correctedText"
              :disabled="locked"
              :aria-label="`纠正${displayLabel}识别内容`"
            />
          </HcClearableField>
        </label>
        <button
          type="button"
          class="hc-btn hc-btn-primary"
          :disabled="locked || !correctedText.trim()"
          @click="saveCorrection"
        >
          保存并重新处理
        </button>
        <button
          type="button"
          class="hc-btn hc-btn-ghost"
          :disabled="locked"
          @click="closePanel(true)"
        >
          取消
        </button>
      </div>

      <div
        v-if="activePanel === 'region'"
        class="source-resolver__panel"
        data-source-panel="region"
      >
        <p>将仅重新读取{{ displayLabel }}，原图不会被修改。</p>
        <SourceRegionSelector
          v-if="sourceEditorAvailable"
          ref="regionEditor"
          v-model="regionDraft"
          :page-asset-id="pageAssetId!"
          :source-image-url="sourceImageUrl!"
          :source-width="sourceWidth!"
          :source-height="sourceHeight!"
          :current-region="currentSourceRegion"
          :display-label="displayLabel"
          :disabled="locked"
          @escape="closePanel(true)"
        />
        <div class="source-resolver__actions">
          <button
            type="button"
            class="hc-btn hc-btn-ghost"
            :disabled="locked"
            @click="closePanel(true)"
          >
            取消
          </button>
          <button
            type="button"
            class="hc-btn hc-btn-primary"
            :disabled="locked || !regionValid"
            @click="confirmRegion"
          >
            使用此区域重新读取
          </button>
        </div>
      </div>

      <div
        v-if="activePanel === 'retake'"
        class="source-resolver__panel"
        data-source-panel="retake"
      >
        <p>
          <b>使用新照片重新处理{{ displayLabel }}？</b
          >新照片会保存为新的识别版本，原照片仍保留用于核对。
        </p>
        <input
          ref="retakeInput"
          type="file"
          accept="image/*"
          hidden
          :disabled="locked"
          @change="selectRetakeFile"
        />
        <div class="source-resolver__actions">
          <button
            type="button"
            class="hc-btn hc-btn-ghost"
            :disabled="locked"
            @click="closePanel(true)"
          >
            取消
          </button>
          <button
            type="button"
            class="hc-btn hc-btn-primary"
            :disabled="locked"
            @click="chooseRetakeFile"
          >
            使用新照片
          </button>
        </div>
      </div>

      <div
        v-if="activePanel === 'skip'"
        class="source-resolver__panel source-resolver__dialog"
        data-source-panel="skip"
        role="alertdialog"
        aria-modal="true"
        :aria-label="scope === 'group' ? '确认跳过题组' : '确认跳过题目'"
      >
        <p>
          {{ affectedCopy }} 将标记为“已跳过 ·
          未判断对错”，不会写入错题、复习或学情；其他题继续处理。
        </p>
        <button type="button" class="hc-btn hc-btn-primary" :disabled="locked" @click="confirmSkip">
          {{ scope === 'group' ? `确认跳过 ${problemIds.length} 题` : '确认跳过这题' }}
        </button>
        <button
          type="button"
          class="hc-btn hc-btn-ghost"
          :disabled="locked"
          @click="closePanel(true)"
        >
          取消
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.source-resolver {
  display: block;
  margin-top: 10px;
  padding: 12px;
  border: 0.5px solid var(--hc-border);
  border-color: color-mix(in srgb, var(--hc-warning) 35%, var(--hc-border));
  border-radius: 11px;
  background: var(--hc-bg-card);
  line-height: 1.6;
}
.source-resolver__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 9px;
}
.source-resolver__panel {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 0.5px solid var(--hc-divider);
}
.source-resolver__panel p {
  margin: 7px 0;
  color: var(--hc-text-secondary);
  font-size: 12px;
  line-height: 1.55;
}
.source-resolver__panel > p:first-child {
  margin-top: 0;
}
.source-resolver__correction,
.source-resolver__dialog {
  display: grid;
  gap: 7px;
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
@media (max-width: 640px) {
  .source-resolver__actions button {
    width: 100%;
    min-height: 44px;
  }
}
</style>
