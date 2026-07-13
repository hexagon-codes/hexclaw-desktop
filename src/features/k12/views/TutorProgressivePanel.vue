<script setup lang="ts">
/**
 * 渐进提示分阶段辅导面板（T3.1 · 原型 app.html #chatTutorView 的提示①→②→完整讲解揭示）。
 *
 * 后端 tutor-turn 三阶段（PRD §3.3.4）：1 方向提示 → 2 具体提示·批改 → 3 完整讲解（带验算解）；
 * 情绪守门命中时切安抚、不推进、不给解。本面板只做**分阶段揭示交互**——把后端的 prompt_hint 指令
 * 逐级展示给家长，「再给点提示」升级、「直接讲」跳阶段三。真话术由上游会话 LLM 生成，本层不造答案。
 */
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useK12Store } from '../store'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import type { TutorTurnResp } from '@/api/k12'

const props = defineProps<{ agentName: string; grade?: string }>()

const { t } = useI18n()
const store = useK12Store()

const problem = ref('')
const studentAnswer = ref('')
const priorStage = ref(0)
const turns = ref<TutorTurnResp[]>([])
const loading = ref(false)
const errMsg = ref('')

const started = computed(() => turns.value.length > 0)
// 到阶段三（完整讲解）或情绪守门后不再升级
const canEscalate = computed(() => {
  const last = turns.value[turns.value.length - 1]
  return !last || (last.stage < 3 && !last.comfort)
})

async function turn(parentMessage: string) {
  if (!problem.value.trim() || loading.value) return
  loading.value = true
  errMsg.value = ''
  try {
    const resp = await store.tutorTurn({
      agent: props.agentName,
      prior_stage: priorStage.value,
      parent_message: parentMessage,
      student_answer: studentAnswer.value.trim() || undefined,
      problem: problem.value.trim(),
      grade: props.grade,
    })
    turns.value.push(resp)
    priorStage.value = resp.stage
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

const nextHint = () => turn(started.value ? t('k12.tutor.cueMoreHint') : '')
const fullExplain = () => turn(t('k12.tutor.cueFull'))

function reset() {
  turns.value = []
  priorStage.value = 0
  problem.value = ''
  studentAnswer.value = ''
  errMsg.value = ''
}

function stageLabel(s: number): string {
  return t(`k12.tutor.stage${s}`)
}
</script>

<template>
  <div class="tutor-panel" data-testid="tutor-progressive">
    <div class="tutor-panel__head">
      <span class="tutor-panel__title">💡 {{ t('k12.tutor.title') }}</span>
      <button v-if="started" class="tutor-panel__reset" @click="reset">{{ t('k12.tutor.reset') }}</button>
    </div>

    <textarea
      v-model="problem"
      class="tutor-panel__in"
      :placeholder="t('k12.tutor.problemPlaceholder')"
      :disabled="started"
      rows="2"
    />
    <input
      v-model="studentAnswer"
      class="tutor-panel__in"
      :placeholder="t('k12.tutor.answerPlaceholder')"
      :disabled="loading"
    />

    <!-- 分阶段揭示历史 -->
    <div v-for="(turnItem, i) in turns" :key="i" class="tutor-turn" :class="{ comfort: turnItem.comfort }">
      <div class="tutor-turn__stage">
        <span class="tutor-turn__badge">{{ turnItem.comfort ? t('k12.tutor.comfort') : stageLabel(turnItem.stage) }}</span>
        <span v-if="turnItem.emotion_cue" class="tutor-turn__cue">{{ turnItem.emotion_cue }}</span>
      </div>
      <!-- 渐进提示为模型生成，数学题提示含 LaTeX → md 渲染。 -->
      <MarkdownRenderer class="tutor-turn__hint tutor-turn__md" :content="turnItem.prompt_hint" />
      <div v-if="turnItem.stage === 3 && turnItem.solution" class="tutor-turn__solution" data-testid="tutor-solution">
        <span v-if="turnItem.badge" class="tutor-turn__vbadge">✓ {{ turnItem.badge }}</span>
        <!-- 完整讲解为模型生成的富文本（**加粗** / 列表 / LaTeX 数学）→ md 渲染，勿裸显。 -->
        <MarkdownRenderer class="tutor-turn__md" :content="turnItem.solution" />
      </div>
    </div>

    <div v-if="errMsg" class="tutor-panel__err">{{ errMsg }}</div>

    <div class="tutor-panel__actions">
      <button
        class="tutor-panel__btn"
        :disabled="!problem.trim() || loading || !canEscalate"
        data-testid="tutor-next-hint"
        @click="nextHint"
      >
        {{ started ? t('k12.tutor.moreHint') : t('k12.tutor.firstHint') }}
      </button>
      <button
        class="tutor-panel__btn tutor-panel__btn--full"
        :disabled="!problem.trim() || loading || !canEscalate"
        data-testid="tutor-full"
        @click="fullExplain"
      >
        {{ t('k12.tutor.full') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.tutor-panel { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; }
.tutor-panel__head { display: flex; align-items: center; }
.tutor-panel__title { font-size: 13px; font-weight: 700; flex: 1; }
.tutor-panel__reset {
  font-size: 11.5px; padding: 3px 8px; border: none; border-radius: 7px;
  background: transparent; color: var(--hc-text-muted); cursor: pointer;
}
.tutor-panel__in {
  width: 100%; box-sizing: border-box; font-size: 13px; padding: 8px 10px;
  border: 0.5px solid var(--hc-border); border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input); color: var(--hc-text-primary); resize: vertical;
}
.tutor-panel__in:disabled { opacity: 0.6; }
.tutor-turn {
  border-left: 3px solid var(--hc-accent); padding: 6px 10px; margin: 2px 0;
  background: var(--hc-bg-elevated); border-radius: 0 var(--hc-radius-md) var(--hc-radius-md) 0;
}
.tutor-turn.comfort { border-left-color: var(--hc-warn, #e0a03a); }
.tutor-turn__stage { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.tutor-turn__badge {
  font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
  background: var(--hc-accent-subtle); color: var(--hc-accent);
}
.tutor-turn__cue { font-size: 11.5px; color: var(--hc-warn, #e0a03a); }
.tutor-turn__hint { font-size: 12.5px; color: var(--hc-text-primary); line-height: 1.5; }
.tutor-turn__solution { margin-top: 6px; }
.tutor-turn__vbadge { font-size: 11px; color: var(--hc-success); }
.tutor-turn__solution { font-size: 12.5px; }
/* md 容器:紧凑段距，让讲解/提示不因块级 p 的默认外边距而撑开。 */
.tutor-turn__md { font-size: 12.5px; }
.tutor-turn__md :deep(p) { margin: 4px 0; }
.tutor-turn__md :deep(p:first-child) { margin-top: 0; }
.tutor-turn__md :deep(p:last-child) { margin-bottom: 0; }
.tutor-panel__err { font-size: 12px; color: var(--hc-danger, #e05a5a); }
.tutor-panel__actions { display: flex; gap: 8px; }
.tutor-panel__btn {
  flex: 1; font-size: 12.5px; padding: 8px; border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md); background: var(--hc-bg-input); color: var(--hc-text-primary); cursor: pointer;
}
.tutor-panel__btn--full { background: var(--hc-accent-subtle); color: var(--hc-accent); border-color: var(--hc-border-hl); }
.tutor-panel__btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
