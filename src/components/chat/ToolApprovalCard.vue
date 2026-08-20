<script setup lang="ts">
import { ref, onUnmounted } from 'vue'
import { Shield } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

interface Props {
  requestId: string
  toolName: string
  arguments?: Record<string, unknown>
  risk: 'safe' | 'sensitive' | 'dangerous'
  reason: string
  deadlineAt?: string
  timeout?: number // seconds
}

const props = withDefaults(defineProps<Props>(), {
  timeout: 30,
})

const emit = defineEmits<{
  respond: [requestId: string, approved: boolean, remember: boolean]
}>()

const remember = ref(false)
const responded = ref(false)
const fallbackDeadlineAt = Date.now() + props.timeout * 1000

function projectRemainingSeconds() {
  const deadlineAt = props.deadlineAt
    ? new Date(props.deadlineAt).getTime()
    : fallbackDeadlineAt
  return Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000))
}

const remaining = ref(projectRemainingSeconds())

// Countdown
const timer = setInterval(() => {
  remaining.value = projectRemainingSeconds()
  if (remaining.value <= 0) {
    clearInterval(timer)
  }
}, 1000)

onUnmounted(() => clearInterval(timer))

function approve() {
  if (responded.value || projectRemainingSeconds() <= 0) return
  responded.value = true
  clearInterval(timer)
  emit('respond', props.requestId, true, remember.value)
}

function deny() {
  if (responded.value || projectRemainingSeconds() <= 0) return
  responded.value = true
  clearInterval(timer)
  emit('respond', props.requestId, false, false)
}

</script>

<template>
  <div
    class="hc-approval"
    :class="{ 'hc-approval--responded': responded }"
    :aria-busy="responded"
  >
    <div class="hc-approval__header">
      <Shield :size="15" /> {{ t('chat.toolApproval', 'Tool Approval Required') }} ·
      <code>{{ toolName }}</code>
      <span class="hc-approval__timer">{{ remaining }}s</span>
    </div>

    <div v-if="reason" class="hc-approval__reason">{{ reason }}</div>

    <div class="hc-approval__actions">
      <label class="hc-approval__remember">
        <input v-model="remember" type="checkbox" :disabled="responded || remaining <= 0" />
        本会话内始终允许此工具
      </label>
      <div class="hc-approval__buttons">
        <button
          class="hc-approval__btn hc-approval__btn--deny"
          :disabled="responded || remaining <= 0"
          @click="deny"
        >
          {{ t('chat.deny', 'Deny') }}
        </button>
        <button
          class="hc-approval__btn hc-approval__btn--approve"
          :disabled="responded || remaining <= 0"
          @click="approve"
        >
          {{ t('chat.approve', 'Allow') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hc-approval {
  border: 0.5px solid var(--hc-border);
  border-radius: 12px;
  padding: 11px 13px;
  margin: 8px 0;
  background: var(--hc-bg-card);
  font-size: 12.5px;
  color: var(--hc-text-secondary);
}

.hc-approval__header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: var(--hc-text-primary);
}

.hc-approval code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  background: var(--hc-bg-active);
  padding: 1px 6px;
  border-radius: 5px;
  color: var(--hc-accent);
}

.hc-approval__timer {
  margin-left: auto;
  color: var(--hc-error);
}

.hc-approval__reason {
  margin-top: 7px;
}

.hc-approval__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
  padding-top: 9px;
  border-top: 0.5px solid var(--hc-border);
}

.hc-approval__remember {
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--hc-text-muted);
}

.hc-approval__remember input {
  margin: 3px 3px 3px 4px;
  color: revert;
  font-family: Arial;
  font-size: 13.3333px;
  line-height: normal;
}

.hc-approval__buttons {
  display: flex;
  gap: 8px;
}

.hc-approval__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 500;
  font-family: Arial;
  line-height: normal;
  cursor: pointer;
  border: 0.5px solid var(--hc-border);
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
  white-space: nowrap;
  transition: background 0.15s, box-shadow 0.2s, border-color 0.15s;
}

.hc-approval__btn--deny:hover:not(:disabled) {
  background: var(--hc-bg-hover);
}

.hc-approval__btn--approve {
  background: linear-gradient(180deg, #5fb3ea 0%, #4a9de0 100%);
  color: white;
  border-color: transparent;
  box-shadow: 0 6px 18px rgba(95, 179, 234, 0.28);
}

.hc-approval__btn--approve:hover:not(:disabled) {
  background: linear-gradient(180deg, #67b8ec 0%, #4f9fe1 100%);
  box-shadow: 0 10px 26px rgba(95, 179, 234, 0.34);
}

.hc-approval__btn:disabled {
  cursor: not-allowed;
  opacity: 0.45;
  transform: none;
  box-shadow: none;
}

.hc-approval__btn:disabled:hover {
  background: var(--hc-bg-input);
}

.hc-approval__btn--approve:disabled:hover {
  background: var(--hc-accent);
}
</style>
