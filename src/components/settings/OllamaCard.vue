<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Server, Download, Loader2, CheckCircle, XCircle, RefreshCw, Link } from 'lucide-vue-next'
import { getOllamaStatus, type OllamaStatus, type OllamaModel } from '@/api/ollama'

const { t } = useI18n()

const status = ref<OllamaStatus | null>(null)
const detecting = ref(false)
const error = ref('')

type CardState = 'detecting' | 'not_running' | 'running_not_associated' | 'associated' | 'error'

const state = computed<CardState>(() => {
  if (detecting.value) return 'detecting'
  if (error.value) return 'error'
  if (!status.value || !status.value.running) return 'not_running'
  if (!status.value.associated) return 'running_not_associated'
  return 'associated'
})

const stateLabel = computed(() => {
  switch (state.value) {
    case 'detecting': return t('settings.ollama.detecting', 'Detecting...')
    case 'not_running': return t('settings.ollama.notRunning', 'Not Running')
    case 'running_not_associated': return t('settings.ollama.notAssociated', 'Running (not linked)')
    case 'associated': return t('settings.ollama.associated', 'Connected')
    case 'error': return t('settings.ollama.error', 'Detection Failed')
  }
})

const stateColor = computed(() => {
  switch (state.value) {
    case 'associated': return 'var(--hc-success, #22c55e)'
    case 'running_not_associated': return 'var(--hc-warning, #f59e0b)'
    case 'not_running': return 'var(--hc-text-secondary)'
    case 'error': return 'var(--hc-error, #ef4444)'
    default: return 'var(--hc-text-secondary)'
  }
})

async function detect() {
  detecting.value = true
  error.value = ''
  try {
    status.value = await getOllamaStatus()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Unknown error'
    status.value = null
  } finally {
    detecting.value = false
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(0)} MB`
  return `${(bytes / 1e9).toFixed(1)} GB`
}

onMounted(() => detect())

const emit = defineEmits<{
  associate: []
}>()
</script>

<template>
  <div class="ollama-card">
    <div class="ollama-card__header">
      <Server :size="18" />
      <span class="ollama-card__title">{{ t('settings.ollama.title', 'Local LLM (Ollama)') }}</span>
      <span class="ollama-card__badge" :style="{ color: stateColor }">
        <Loader2 v-if="state === 'detecting'" :size="12" class="ollama-card__spin" />
        <CheckCircle v-else-if="state === 'associated'" :size="12" />
        <XCircle v-else-if="state === 'error' || state === 'not_running'" :size="12" />
        {{ stateLabel }}
      </span>
      <button class="ollama-card__refresh" :disabled="detecting" @click="detect">
        <RefreshCw :size="14" :class="{ 'ollama-card__spin': detecting }" />
      </button>
    </div>

    <!-- Not running -->
    <div v-if="state === 'not_running'" class="ollama-card__body">
      <p class="ollama-card__hint">
        {{ t('settings.ollama.notRunningHint', 'Ollama is not detected on localhost:11434. Start Ollama or install it from') }}
        <a href="https://ollama.com" target="_blank" rel="noopener">ollama.com</a>
      </p>
    </div>

    <!-- Running but not associated -->
    <div v-else-if="state === 'running_not_associated'" class="ollama-card__body">
      <p class="ollama-card__hint">
        {{ t('settings.ollama.linkHint', 'Ollama is running. Link it as a provider to use local models.') }}
      </p>
      <button class="ollama-card__btn ollama-card__btn--primary" @click="emit('associate')">
        <Link :size="14" />
        {{ t('settings.ollama.associate', 'Link as Provider') }}
      </button>
    </div>

    <!-- Associated -->
    <div v-else-if="state === 'associated' && status" class="ollama-card__body">
      <div v-if="status.version" class="ollama-card__version">
        Ollama {{ status.version }}
      </div>
      <div v-if="status.models?.length" class="ollama-card__models">
        <div class="ollama-card__models-title">
          {{ t('settings.ollama.models', 'Downloaded Models') }} ({{ status.model_count }})
        </div>
        <div v-for="m in status.models" :key="m.name" class="ollama-card__model">
          <span class="ollama-card__model-name">{{ m.name }}</span>
          <span class="ollama-card__model-meta">
            {{ formatSize(m.size) }}
            <template v-if="m.parameter_size"> · {{ m.parameter_size }}</template>
            <template v-if="m.quantization_level"> · {{ m.quantization_level }}</template>
          </span>
        </div>
      </div>
      <p v-else class="ollama-card__hint">
        {{ t('settings.ollama.noModels', 'No models downloaded. Run `ollama pull qwen2.5` to get started.') }}
      </p>
    </div>

    <!-- Error -->
    <div v-else-if="state === 'error'" class="ollama-card__body">
      <p class="ollama-card__error">{{ error }}</p>
    </div>

    <div class="ollama-card__footer">
      {{ t('settings.ollama.otherLocal', 'Other local LLMs (LM Studio, llama.cpp, vLLM) can be added as OpenAI-compatible providers.') }}
    </div>
  </div>
</template>

<style scoped>
.ollama-card {
  border: 1px solid var(--hc-border);
  border-radius: 12px;
  padding: 16px;
  background: var(--hc-bg-secondary, #f8f9fa);
}

.ollama-card__header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.ollama-card__title {
  font-weight: 600;
  font-size: 14px;
  flex: 1;
}

.ollama-card__badge {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 500;
}

.ollama-card__refresh {
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
  color: var(--hc-text-secondary);
  transition: background 0.15s;
}

.ollama-card__refresh:hover {
  background: var(--hc-bg-tertiary, #e5e7eb);
}

.ollama-card__spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.ollama-card__body {
  margin-bottom: 12px;
}

.ollama-card__hint {
  font-size: 13px;
  color: var(--hc-text-secondary);
  margin-bottom: 8px;
}

.ollama-card__hint a {
  color: var(--hc-primary, #3b82f6);
}

.ollama-card__error {
  font-size: 13px;
  color: var(--hc-error, #ef4444);
}

.ollama-card__btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border: none;
}

.ollama-card__btn--primary {
  background: var(--hc-primary, #3b82f6);
  color: white;
}

.ollama-card__btn--primary:hover {
  background: var(--hc-primary-hover, #2563eb);
}

.ollama-card__version {
  font-size: 12px;
  color: var(--hc-text-secondary);
  margin-bottom: 8px;
}

.ollama-card__models-title {
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 6px;
}

.ollama-card__model {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
  font-size: 13px;
}

.ollama-card__model-name {
  font-family: 'SF Mono', monospace;
  font-weight: 500;
}

.ollama-card__model-meta {
  color: var(--hc-text-secondary);
  font-size: 12px;
}

.ollama-card__footer {
  font-size: 11px;
  color: var(--hc-text-tertiary, #9ca3af);
  border-top: 1px solid var(--hc-border);
  padding-top: 8px;
}
</style>
