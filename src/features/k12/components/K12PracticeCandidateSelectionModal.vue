<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import type {
  PracticeCandidateDTO,
  PracticeCandidateSelectionDTO,
} from '@/api/k12'

const props = defineProps<{
  open: boolean
  originalQuestion: string
  selection: PracticeCandidateSelectionDTO | null
  loading?: boolean
  generating?: boolean
  committing?: boolean
  error?: string
}>()

const emit = defineEmits<{
  close: []
  retry: []
  generate: []
  commit: [candidateIds: string[]]
}>()

const selected = ref(new Set<string>())

const candidates = computed<PracticeCandidateDTO[]>(() => {
  const items = props.selection?.candidates ?? []
  if (items.some((item) => item.candidate_kind === 'original')) {
    return [...items].sort(
      (left, right) =>
        Number(left.candidate_kind !== 'original') - Number(right.candidate_kind !== 'original') ||
        left.batch_ordinal - right.batch_ordinal ||
        left.candidate_ordinal - right.candidate_ordinal,
    )
  }
  return [
    {
      candidate_id: 'original-pending',
      candidate_kind: 'original',
      batch_ordinal: 0,
      candidate_ordinal: 0,
      normalized_content_hash: '',
      state: props.loading ? 'generating' : 'ready',
      question_markdown: props.originalQuestion,
    },
    ...items,
  ]
})

watch(
  () => [props.open, props.selection?.selection_id, props.selection?.candidates] as const,
  ([open, selectionId], previous) => {
    if (!open) {
      selected.value = new Set()
      return
    }
    const selectionChanged = selectionId !== previous?.[1]
    const next = selectionChanged ? new Set<string>() : new Set(selected.value)
    for (const candidate of candidates.value) {
      if (
        candidate.candidate_kind === 'original' ||
        candidate.state === 'already_in_set'
      ) {
        next.add(candidate.candidate_id)
      }
    }
    selected.value = next
  },
  { immediate: true, deep: true },
)

function isDisabled(candidate: PracticeCandidateDTO): boolean {
  return (
    candidate.state === 'generating' ||
    candidate.state === 'failed' ||
    candidate.state === 'already_in_set' ||
    !props.selection
  )
}

function toggle(candidate: PracticeCandidateDTO) {
  if (isDisabled(candidate)) return
  const next = new Set(selected.value)
  if (next.has(candidate.candidate_id)) next.delete(candidate.candidate_id)
  else next.add(candidate.candidate_id)
  selected.value = next
}

const newlySelected = computed(() =>
  candidates.value.filter(
    (candidate) =>
      candidate.state === 'ready' && selected.value.has(candidate.candidate_id),
  ),
)

function stateLabel(candidate: PracticeCandidateDTO): string {
  if (candidate.state === 'generating') return '生成中'
  if (candidate.state === 'failed') return '生成失败'
  if (candidate.state === 'already_in_set') return '已在练习集'
  return '可选择'
}

function commit() {
  if (!props.selection || props.committing || newlySelected.value.length === 0) return
  emit(
    'commit',
    newlySelected.value.map((candidate) => candidate.candidate_id),
  )
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="candidate-modal__overlay"
      data-testid="practice-candidate-modal"
      @click.self="emit('close')"
    >
      <section
        class="candidate-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="practice-candidate-title"
      >
        <header class="candidate-modal__head">
          <h2 id="practice-candidate-title">选择加入练习集的题目</h2>
          <button type="button" aria-label="关闭" :disabled="committing" @click="emit('close')">
            ×
          </button>
        </header>

        <div v-if="error" class="candidate-modal__error" role="alert">
          <span>{{ error }}</span>
          <button
            v-if="!selection"
            type="button"
            data-governed-button="k12-retry"
            :disabled="loading"
            @click="emit('retry')"
          >
            重试
          </button>
        </div>

        <div class="candidate-modal__list" aria-live="polite">
          <label
            v-for="candidate in candidates"
            :key="candidate.candidate_id"
            class="candidate-modal__item"
            :class="`candidate-modal__item--${candidate.state}`"
          >
            <input
              type="checkbox"
              :checked="selected.has(candidate.candidate_id)"
              :disabled="isDisabled(candidate)"
              @change="toggle(candidate)"
            />
            <span class="candidate-modal__copy">
              <b>{{ candidate.candidate_kind === 'original' ? '原题' : '新生成的题目' }}</b>
              <MarkdownRenderer :content="candidate.question_markdown || '正在生成…'" />
              <small v-if="candidate.failure_message">{{ candidate.failure_message }}</small>
            </span>
            <span class="candidate-modal__state">{{ stateLabel(candidate) }}</span>
          </label>
        </div>

        <footer class="candidate-modal__foot">
          <button
            type="button"
            class="hc-btn"
            :disabled="!selection || generating || committing"
            data-testid="practice-candidate-generate"
            @click="emit('generate')"
          >
            {{ generating ? '正在生成…' : '再生成 3 题' }}
          </button>
          <span class="candidate-modal__spacer" />
          <button type="button" class="hc-btn" :disabled="committing" @click="emit('close')">
            取消
          </button>
          <button
            type="button"
            class="hc-btn hc-btn-primary"
            :disabled="!selection || committing || newlySelected.length === 0"
            data-testid="practice-candidate-commit"
            @click="commit"
          >
            {{ committing ? '正在加入…' : `加入练习集（${newlySelected.length}）` }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.candidate-modal__overlay {
  position: fixed;
  z-index: var(--hc-z-modal);
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, #081220 42%, transparent);
  backdrop-filter: blur(4px);
}
.candidate-modal {
  width: min(720px, 100%);
  max-height: min(760px, 90vh);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  border: 0.5px solid var(--hc-border);
  border-radius: 16px;
  background: var(--hc-bg-elevated);
  box-shadow: var(--hc-shadow-float);
}
.candidate-modal__head,
.candidate-modal__foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 18px;
}
.candidate-modal__head {
  justify-content: space-between;
  border-bottom: 0.5px solid var(--hc-border);
}
.candidate-modal__head h2 {
  margin: 0;
  font-size: 17px;
}
.candidate-modal__head button {
  border: 0;
  background: transparent;
  color: var(--hc-text-muted);
  font: inherit;
  font-size: 20px;
  cursor: pointer;
}
.candidate-modal__list {
  display: grid;
  gap: 10px;
  overflow: auto;
  padding: 16px 18px;
}
.candidate-modal__item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px;
  padding: 13px 14px;
  border: 0.5px solid var(--hc-border);
  border-radius: 12px;
  background: var(--hc-bg-card);
  cursor: pointer;
}
.candidate-modal__item--already_in_set,
.candidate-modal__item--generating,
.candidate-modal__item--failed {
  cursor: default;
}
.candidate-modal__item--already_in_set {
  opacity: 0.64;
}
.candidate-modal__copy {
  display: grid;
  gap: 5px;
  min-width: 0;
}
.candidate-modal__copy b {
  font-size: 13px;
}
.candidate-modal__copy small,
.candidate-modal__state {
  color: var(--hc-text-muted);
  font-size: 11.5px;
}
.candidate-modal__item--failed .candidate-modal__state,
.candidate-modal__item--failed small,
.candidate-modal__error {
  color: var(--hc-error);
}
.candidate-modal__error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 16px 18px 0;
  padding: 12px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--hc-error) 8%, var(--hc-bg-card));
}
.candidate-modal__foot {
  border-top: 0.5px solid var(--hc-border);
}
.candidate-modal__spacer {
  flex: 1;
}
</style>
