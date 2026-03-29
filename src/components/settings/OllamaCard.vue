<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Server,
  Loader2,
  CheckCircle,
  RefreshCw,
  Link,
  AlertCircle,
  Circle,
  Download,
  ExternalLink,
} from 'lucide-vue-next'
import { getOllamaStatus, type OllamaStatus } from '@/api/ollama'

const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download'
const POLL_INTERVAL = 3000

const { t } = useI18n()

const status = ref<OllamaStatus | null>(null)
const detecting = ref(false)
const error = ref('')
const waitingInstall = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null

type CardState =
  | 'detecting'
  | 'not_running'
  | 'waiting_install'
  | 'running_not_associated'
  | 'associated'
  | 'error'

const state = computed<CardState>(() => {
  if (detecting.value && !waitingInstall.value) return 'detecting'
  if (waitingInstall.value) return 'waiting_install'
  if (error.value) return 'error'
  if (!status.value || !status.value.running) return 'not_running'
  if (!status.value.associated) return 'running_not_associated'
  return 'associated'
})

const stateLabel = computed(() => {
  switch (state.value) {
    case 'detecting':
      return t('settings.ollama.detecting', '检测中…')
    case 'not_running':
      return t('settings.ollama.notRunning', '未运行')
    case 'waiting_install':
      return t('settings.ollama.waitingInstall', '等待安装…')
    case 'running_not_associated':
      return t('settings.ollama.notAssociated', '运行中（未关联）')
    case 'associated':
      return t('settings.ollama.associated', '已连接')
    case 'error':
      return t('settings.ollama.error', '检测失败')
  }
  return ''
})

async function detect() {
  if (detecting.value && !waitingInstall.value) return
  detecting.value = true
  error.value = ''
  try {
    status.value = await getOllamaStatus()
    // If Ollama is now running, stop polling
    if (status.value?.running && waitingInstall.value) {
      stopPolling()
    }
  } catch (e) {
    // During install polling, don't show errors — just keep waiting
    if (!waitingInstall.value) {
      error.value = e instanceof Error ? e.message : 'Unknown error'
      status.value = null
    }
  } finally {
    detecting.value = false
  }
}

async function openInstallPage() {
  try {
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(OLLAMA_DOWNLOAD_URL)
  } catch {
    window.open(OLLAMA_DOWNLOAD_URL, '_blank')
  }
  startInstall()
}

function startInstall() {
  waitingInstall.value = true
  error.value = ''
  startPolling()
}

function cancelWaiting() {
  stopPolling()
}

function startPolling() {
  clearPollTimer()
  pollTimer = setInterval(() => detect(), POLL_INTERVAL)
}

function stopPolling() {
  clearPollTimer()
  waitingInstall.value = false
}

function clearPollTimer() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(0)} MB`
  return `${(bytes / 1e9).toFixed(1)} GB`
}

onMounted(() => detect())
onBeforeUnmount(() => clearPollTimer())

const emit = defineEmits<{
  associate: []
}>()

defineExpose({ state, waitingInstall, startInstall, cancelWaiting, detect })
</script>

<template>
  <div class="ollama-card" :class="`ollama-card--${state}`">
    <!-- Header -->
    <div class="ollama-card__header">
      <div class="ollama-card__header-left">
        <Server :size="16" class="ollama-card__icon" />
        <span class="ollama-card__title">{{
          t('settings.ollama.title', '本地模型 (Ollama)')
        }}</span>
      </div>

      <div class="ollama-card__header-right">
        <span class="ollama-card__badge" :class="`ollama-card__badge--${state}`">
          <Loader2
            v-if="state === 'detecting' || state === 'waiting_install'"
            :size="11"
            class="ollama-card__spin"
          />
          <CheckCircle v-else-if="state === 'associated'" :size="11" />
          <AlertCircle v-else-if="state === 'error'" :size="11" />
          <Circle v-else :size="11" />
          {{ stateLabel }}
        </span>
        <button
          class="ollama-card__refresh"
          :class="{ 'ollama-card__refresh--spinning': detecting }"
          :disabled="detecting || waitingInstall"
          :title="t('common.refresh', '刷新')"
          @click="detect"
        >
          <RefreshCw :size="13" />
        </button>
      </div>
    </div>

    <!-- Body -->
    <Transition name="ollama-body" mode="out-in">
      <!-- Detecting -->
      <div v-if="state === 'detecting'" key="detecting" class="ollama-card__body">
        <div class="ollama-card__detect-placeholder">
          <div class="ollama-card__pulse-bar" />
          <div class="ollama-card__pulse-bar ollama-card__pulse-bar--short" />
        </div>
      </div>

      <!-- Not running -->
      <div v-else-if="state === 'not_running'" key="not_running" class="ollama-card__body">
        <p class="ollama-card__hint">
          {{
            t(
              'settings.ollama.notRunningHint',
              '未在 localhost:11434 检测到 Ollama，请先启动或安装。',
            )
          }}
        </p>
        <button
          class="ollama-card__action-btn ollama-card__action-btn--primary"
          @click="openInstallPage"
        >
          <Download :size="13" />
          {{ t('settings.ollama.install', '前往安装') }}
          <ExternalLink :size="10" class="ollama-card__external-icon" />
        </button>
      </div>

      <!-- Waiting for install -->
      <div v-else-if="state === 'waiting_install'" key="waiting_install" class="ollama-card__body">
        <div class="ollama-card__waiting">
          <div class="ollama-card__waiting-indicator">
            <div class="ollama-card__waiting-dot" />
            <div class="ollama-card__waiting-dot" />
            <div class="ollama-card__waiting-dot" />
          </div>
          <p class="ollama-card__waiting-text">
            {{
              t(
                'settings.ollama.waitingInstallHint',
                '已打开下载页面，安装并启动 Ollama 后将自动检测…',
              )
            }}
          </p>
        </div>
        <button class="ollama-card__action-btn ollama-card__action-btn--ghost" @click="cancelWaiting">
          {{ t('common.cancel', '取消') }}
        </button>
      </div>

      <!-- Running but not linked -->
      <div
        v-else-if="state === 'running_not_associated'"
        key="running_not_associated"
        class="ollama-card__body"
      >
        <p class="ollama-card__hint">
          {{
            t(
              'settings.ollama.linkHint',
              'Ollama 正在运行，关联后即可使用本地模型。',
            )
          }}
        </p>
        <button
          class="ollama-card__action-btn ollama-card__action-btn--primary"
          @click="emit('associate')"
        >
          <Link :size="13" />
          {{ t('settings.ollama.associate', '关联为供应商') }}
        </button>
      </div>

      <!-- Associated -->
      <div v-else-if="state === 'associated' && status" key="associated" class="ollama-card__body">
        <div v-if="status.version" class="ollama-card__version">
          Ollama {{ status.version }}
        </div>
        <div v-if="status.models?.length" class="ollama-card__models">
          <div class="ollama-card__models-title">
            {{ t('settings.ollama.models', '已下载模型') }} ({{ status.model_count }})
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
          {{
            t(
              'settings.ollama.noModels',
              '暂无已下载模型。运行 `ollama pull qwen2.5` 获取模型。',
            )
          }}
        </p>
      </div>

      <!-- Error -->
      <div v-else-if="state === 'error'" key="error" class="ollama-card__body">
        <p class="ollama-card__error-msg">{{ error }}</p>
      </div>
    </Transition>

    <!-- Footer -->
    <div class="ollama-card__footer">
      {{
        t(
          'settings.ollama.otherLocal',
          '其他本地模型（LM Studio、llama.cpp、vLLM）可通过 OpenAI 兼容接口接入。',
        )
      }}
    </div>
  </div>
</template>

<style scoped>
.ollama-card {
  border: 1px solid var(--hc-border);
  border-radius: var(--hc-radius-lg);
  background: var(--hc-bg-card);
  transition: border-color 0.3s;
}

.ollama-card--associated {
  border-color: color-mix(in srgb, var(--hc-success) 25%, var(--hc-border));
}

.ollama-card--error {
  border-color: color-mix(in srgb, var(--hc-error) 20%, var(--hc-border));
}

.ollama-card--waiting_install {
  border-color: color-mix(in srgb, var(--hc-accent) 25%, var(--hc-border));
}

/* ─── Header ────────────────────────────────────────── */
.ollama-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
}

.ollama-card__header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ollama-card__icon {
  color: var(--hc-text-muted);
}

.ollama-card__title {
  font-weight: 600;
  font-size: 13px;
  color: var(--hc-text-primary);
}

.ollama-card__header-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* ─── Badge ─────────────────────────────────────────── */
.ollama-card__badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 999px;
  transition: background 0.2s, color 0.2s;
}

.ollama-card__badge--detecting,
.ollama-card__badge--not_running {
  color: var(--hc-text-muted);
  background: var(--hc-bg-hover);
}

.ollama-card__badge--waiting_install {
  color: var(--hc-accent);
  background: var(--hc-accent-subtle);
}

.ollama-card__badge--associated {
  color: var(--hc-success);
  background: color-mix(in srgb, var(--hc-success) 10%, transparent);
}

.ollama-card__badge--running_not_associated {
  color: var(--hc-warning);
  background: color-mix(in srgb, var(--hc-warning) 10%, transparent);
}

.ollama-card__badge--error {
  color: var(--hc-error);
  background: color-mix(in srgb, var(--hc-error) 10%, transparent);
}

/* ─── Refresh ───────────────────────────────────────── */
.ollama-card__refresh {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  background: none;
  border: 1px solid transparent;
  cursor: pointer;
  border-radius: var(--hc-radius-sm);
  color: var(--hc-text-muted);
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.ollama-card__refresh:hover:not(:disabled) {
  background: var(--hc-bg-hover);
  color: var(--hc-text-secondary);
  border-color: var(--hc-border);
}

.ollama-card__refresh:active:not(:disabled) {
  background: var(--hc-bg-active);
}

.ollama-card__refresh:disabled {
  cursor: default;
  opacity: 0.5;
}

.ollama-card__refresh--spinning svg {
  animation: ollama-spin 0.8s linear infinite;
}

@keyframes ollama-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.ollama-card__spin {
  animation: ollama-spin 0.8s linear infinite;
}

/* ─── Body ──────────────────────────────────────────── */
.ollama-card__body {
  padding: 0 14px 12px;
}

.ollama-card__hint {
  font-size: 12px;
  color: var(--hc-text-secondary);
  line-height: 1.5;
  margin-bottom: 10px;
}


/* ─── Action Button ─────────────────────────────────── */
.ollama-card__action-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: var(--hc-radius-sm);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-hover);
  color: var(--hc-text-secondary);
  text-decoration: none;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.ollama-card__action-btn:hover {
  background: var(--hc-bg-active);
  color: var(--hc-text-primary);
  border-color: var(--hc-border);
}

.ollama-card__action-btn--primary {
  background: var(--hc-accent);
  color: var(--hc-text-inverse);
  border-color: var(--hc-accent);
}

.ollama-card__action-btn--primary:hover {
  background: var(--hc-accent-hover);
  border-color: var(--hc-accent-hover);
  color: var(--hc-text-inverse);
}

.ollama-card__action-btn--ghost {
  background: transparent;
  border-color: transparent;
  color: var(--hc-text-muted);
}

.ollama-card__action-btn--ghost:hover {
  color: var(--hc-text-secondary);
  background: var(--hc-bg-hover);
}

.ollama-card__external-icon {
  opacity: 0.6;
  margin-left: -2px;
}

/* ─── Waiting for install ───────────────────────────── */
.ollama-card__waiting {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: var(--hc-radius-sm);
  background: var(--hc-accent-subtle);
  margin-bottom: 10px;
}

.ollama-card__waiting-indicator {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.ollama-card__waiting-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--hc-accent);
  animation: ollama-bounce 1.4s ease-in-out infinite;
}

.ollama-card__waiting-dot:nth-child(2) {
  animation-delay: 0.16s;
}

.ollama-card__waiting-dot:nth-child(3) {
  animation-delay: 0.32s;
}

@keyframes ollama-bounce {
  0%,
  80%,
  100% {
    opacity: 0.3;
    transform: scale(0.8);
  }
  40% {
    opacity: 1;
    transform: scale(1);
  }
}

.ollama-card__waiting-text {
  font-size: 12px;
  color: var(--hc-accent);
  line-height: 1.4;
  margin: 0;
}

/* ─── Detect skeleton ───────────────────────────────── */
.ollama-card__detect-placeholder {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ollama-card__pulse-bar {
  height: 12px;
  width: 70%;
  border-radius: 6px;
  background: var(--hc-bg-hover);
  animation: ollama-pulse 1.5s ease-in-out infinite;
}

.ollama-card__pulse-bar--short {
  width: 40%;
}

@keyframes ollama-pulse {
  0%,
  100% {
    opacity: 0.4;
  }
  50% {
    opacity: 1;
  }
}

/* ─── Error ─────────────────────────────────────────── */
.ollama-card__error-msg {
  font-size: 12px;
  color: var(--hc-error);
  line-height: 1.5;
  margin-bottom: 10px;
  padding: 8px 10px;
  border-radius: var(--hc-radius-sm);
  background: color-mix(in srgb, var(--hc-error) 6%, transparent);
}

/* ─── Associated details ────────────────────────────── */
.ollama-card__version {
  font-size: 11px;
  color: var(--hc-text-muted);
  margin-bottom: 8px;
}

.ollama-card__models-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--hc-text-secondary);
  margin-bottom: 6px;
}

.ollama-card__model {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 0;
  font-size: 12px;
  border-bottom: 1px solid var(--hc-border-subtle);
}

.ollama-card__model:last-child {
  border-bottom: none;
}

.ollama-card__model-name {
  font-family: 'SF Mono', ui-monospace, monospace;
  font-weight: 500;
  color: var(--hc-text-primary);
}

.ollama-card__model-meta {
  color: var(--hc-text-muted);
  font-size: 11px;
}

/* ─── Footer ────────────────────────────────────────── */
.ollama-card__footer {
  font-size: 11px;
  color: var(--hc-text-muted);
  border-top: 1px solid var(--hc-border-subtle);
  padding: 8px 14px;
  line-height: 1.5;
}

/* ─── Body transition ───────────────────────────────── */
.ollama-body-enter-active,
.ollama-body-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.ollama-body-enter-from {
  opacity: 0;
  transform: translateY(-4px);
}

.ollama-body-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
