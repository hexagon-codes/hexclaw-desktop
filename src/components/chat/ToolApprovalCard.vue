<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'
import { ShieldAlert, ShieldCheck, X, Check } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

interface Props {
  requestId: string
  toolName: string
  arguments?: Record<string, unknown>
  risk: 'safe' | 'sensitive' | 'dangerous'
  reason: string
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
const remaining = ref(props.timeout)

// Countdown
const timer = setInterval(() => {
  remaining.value--
  if (remaining.value <= 0) {
    clearInterval(timer)
    if (!responded.value) {
      responded.value = true
      emit('respond', props.requestId, false, false)
    }
  }
}, 1000)

onUnmounted(() => clearInterval(timer))

const riskColor = computed(() => {
  switch (props.risk) {
    case 'dangerous': return 'var(--hc-error)'
    case 'sensitive': return 'var(--hc-warning, #f59e0b)'
    default: return 'var(--hc-success, #22c55e)'
  }
})

const riskIcon = computed(() => props.risk === 'dangerous' ? ShieldAlert : ShieldCheck)

function approve() {
  if (responded.value) return
  responded.value = true
  clearInterval(timer)
  emit('respond', props.requestId, true, remember.value)
}

function deny() {
  if (responded.value) return
  responded.value = true
  clearInterval(timer)
  emit('respond', props.requestId, false, false)
}

const argsPreview = computed(() => {
  if (!props.arguments) return ''
  try {
    return JSON.stringify(props.arguments, null, 2)
  } catch {
    return String(props.arguments)
  }
})
</script>

<template>
  <div class="hc-approval" :class="{ 'hc-approval--responded': responded }">
    <div class="hc-approval__header">
      <component :is="riskIcon" :size="16" :style="{ color: riskColor }" />
      <span class="hc-approval__title">{{ t('chat.toolApproval', 'Tool Approval Required') }}</span>
      <span class="hc-approval__timer" :style="{ color: remaining <= 5 ? 'var(--hc-error)' : '' }">
        {{ remaining }}s
      </span>
    </div>

    <div class="hc-approval__body">
      <div class="hc-approval__tool">
        <span class="hc-approval__label">Tool:</span>
        <code>{{ toolName }}</code>
        <span class="hc-approval__risk" :style="{ background: riskColor }">{{ risk }}</span>
      </div>
      <div v-if="reason" class="hc-approval__reason">{{ reason }}</div>
      <details v-if="argsPreview" class="hc-approval__args">
        <summary>{{ t('chat.toolParams', 'Parameters') }}</summary>
        <pre>{{ argsPreview }}</pre>
      </details>
    </div>

    <div v-if="!responded" class="hc-approval__actions">
      <label class="hc-approval__remember">
        <input v-model="remember" type="checkbox" />
        {{ t('chat.alwaysAllow', 'Always allow this tool') }}
      </label>
      <div class="hc-approval__buttons">
        <button class="hc-approval__btn hc-approval__btn--deny" @click="deny">
          <X :size="14" /> {{ t('chat.deny', 'Deny') }}
        </button>
        <button class="hc-approval__btn hc-approval__btn--approve" @click="approve">
          <Check :size="14" /> {{ t('chat.approve', 'Allow') }}
        </button>
      </div>
    </div>

    <div v-else class="hc-approval__responded">
      {{ responded ? t('chat.approvalResponded', 'Response sent') : '' }}
    </div>
  </div>
</template>

<style scoped>
.hc-approval {
  border: 1px solid var(--hc-border);
  border-radius: 12px;
  padding: 12px 16px;
  margin: 8px 0;
  background: var(--hc-bg-secondary, #f8f9fa);
  transition: opacity 0.3s;
}

.hc-approval--responded {
  opacity: 0.6;
}

.hc-approval__header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.hc-approval__title {
  font-weight: 600;
  font-size: 13px;
  flex: 1;
}

.hc-approval__timer {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.hc-approval__tool {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.hc-approval__label {
  font-size: 12px;
  color: var(--hc-text-secondary);
}

.hc-approval__risk {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  color: white;
}

.hc-approval__reason {
  font-size: 13px;
  color: var(--hc-text-secondary);
  margin: 4px 0;
}

.hc-approval__args {
  margin-top: 8px;
}

.hc-approval__args summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--hc-text-secondary);
}

.hc-approval__args pre {
  font-size: 11px;
  max-height: 120px;
  overflow-y: auto;
  background: var(--hc-bg-tertiary, #eee);
  padding: 8px;
  border-radius: 6px;
  margin-top: 4px;
}

.hc-approval__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--hc-border);
}

.hc-approval__remember {
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}

.hc-approval__buttons {
  display: flex;
  gap: 8px;
}

.hc-approval__btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 14px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border: none;
  transition: background 0.15s;
}

.hc-approval__btn--deny {
  background: var(--hc-bg-tertiary, #e5e7eb);
  color: var(--hc-text);
}

.hc-approval__btn--deny:hover {
  background: var(--hc-error);
  color: white;
}

.hc-approval__btn--approve {
  background: var(--hc-primary, #3b82f6);
  color: white;
}

.hc-approval__btn--approve:hover {
  background: var(--hc-primary-hover, #2563eb);
}

.hc-approval__responded {
  font-size: 12px;
  color: var(--hc-text-secondary);
  text-align: center;
  padding: 4px 0;
}
</style>
