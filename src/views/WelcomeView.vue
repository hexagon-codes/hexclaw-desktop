<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Key, Bot, Sparkles, ArrowRight, ArrowLeft, Check, Loader2, CheckCircle, XCircle } from 'lucide-vue-next'
import { useSettingsStore } from '@/stores/settings'
import { PROVIDER_PRESETS } from '@/config/providers'
import type { ProviderType } from '@/types'
import { testLLMConnection } from '@/api/config'

const router = useRouter()
const { t } = useI18n()
const settingsStore = useSettingsStore()
const step = ref(0)
const finishing = ref(false)

const apiKey = ref('')
const provider = ref<ProviderType>('openai')
const model = ref('gpt-4o')
const selectedAgentRole = ref<'assistant' | 'coder' | 'writer'>('assistant')

/** Available models based on selected provider */
const providerModels = computed(() => {
  const preset = PROVIDER_PRESETS[provider.value]
  return preset?.defaultModels ?? []
})

/** Whether the current provider requires an API key */
const requiresApiKey = computed(() => provider.value !== 'ollama')

/** Validation: API key required for non-Ollama providers */
const canProceedFromStep0 = computed(() => {
  if (requiresApiKey.value && apiKey.value.trim().length === 0) return false
  return !!model.value && connectionResult.value?.ok === true
})

// Reset model when provider changes
watch(provider, (newProvider) => {
  const preset = PROVIDER_PRESETS[newProvider]
  const defaultModels = preset?.defaultModels ?? []
  model.value = defaultModels[0]?.id ?? ''
  // Clear API key when switching providers
  apiKey.value = ''
})

watch([provider, apiKey, model], () => {
  connectionResult.value = null
})

const steps = computed(() => [
  { title: t('welcome.step1Title'), description: t('welcome.step1Desc'), icon: Key },
  { title: t('welcome.step2Title'), description: t('welcome.step2Desc'), icon: Bot },
  { title: t('welcome.step3Title'), description: t('welcome.step3Desc'), icon: Sparkles },
])

const agentOptions = computed(() => [
  { role: 'assistant' as const, title: t('welcome.generalAssistant'), description: t('welcome.generalAssistantDesc') },
  { role: 'coder' as const, title: t('welcome.codeAssistant'), description: t('welcome.codeAssistantDesc') },
  { role: 'writer' as const, title: t('welcome.writingAssistant'), description: t('welcome.writingAssistantDesc') },
])

const selectedAgentTitle = computed(() =>
  agentOptions.value.find((agent) => agent.role === selectedAgentRole.value)?.title || t('welcome.generalAssistant'),
)

// ─── 连接测试 ──────────────────────────────────────
const connectionTesting = ref(false)
const connectionResult = ref<{ ok: boolean; msg: string } | null>(null)

async function testConnection() {
  connectionTesting.value = true
  connectionResult.value = null
  try {
    const preset = PROVIDER_PRESETS[provider.value]
    const result = await testLLMConnection({
      provider: {
        type: provider.value,
        base_url: preset.defaultBaseUrl,
        api_key: requiresApiKey.value ? apiKey.value.trim() : '',
        model: model.value,
      },
    })
    connectionResult.value = {
      ok: result.ok,
      msg: result.message || (result.ok ? t('welcome.connectionTestSuccess') : t('welcome.connectionTestFailed')),
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : ''
    connectionResult.value = {
      ok: false,
      msg: errMsg.includes('404') ? t('welcome.connectionTestUnavailable') : (errMsg || t('welcome.connectionTestFailed')),
    }
  } finally {
    connectionTesting.value = false
  }
}

async function finishWizard() {
  if (finishing.value) return
  finishing.value = true
  try {
  // Ensure config is loaded
  if (!settingsStore.config) {
    await settingsStore.loadConfig()
  }

  const preset = PROVIDER_PRESETS[provider.value]

  // Build and add provider config
  const selectedModel = providerModels.value.find(m => m.id === model.value)
  settingsStore.addProvider({
    name: preset.name,
    type: provider.value,
    enabled: true,
    apiKey: requiresApiKey.value ? apiKey.value.trim() : '',
    baseUrl: preset.defaultBaseUrl,
    models: selectedModel
      ? [{ id: selectedModel.id, name: selectedModel.name, capabilities: selectedModel.capabilities ?? ['text'] }]
      : providerModels.value.length > 0
        ? [providerModels.value[0]!]
        : [],
  })

  // Set default model
  if (settingsStore.config) {
    settingsStore.config.llm.defaultModel = model.value
    settingsStore.config.general.welcomeCompleted = true
    settingsStore.config.general.defaultAgentRole = selectedAgentRole.value
    await settingsStore.saveConfig(settingsStore.config)
  }

  router.push({
    path: '/chat',
    query: {
      role: selectedAgentRole.value,
      roleTitle: selectedAgentTitle.value,
    },
  })
  } finally {
    finishing.value = false
  }
}

async function nextStep() {
  if (finishing.value) return
  if (step.value === 0 && !canProceedFromStep0.value) return
  if (step.value < 2) {
    step.value++
  } else {
    await finishWizard()
  }
}

function prevStep() {
  if (step.value > 0) step.value--
}

async function skip() {
  // Mark welcome as completed even when skipping
  if (!settingsStore.config) {
    await settingsStore.loadConfig()
  }
  if (settingsStore.config) {
    settingsStore.config.general.welcomeCompleted = true
    await settingsStore.saveConfig(settingsStore.config)
  }
  router.push('/chat')
}
</script>

<template>
  <div class="h-full flex items-center justify-center" :style="{ background: 'var(--hc-bg-main)' }">
    <div class="w-full max-w-md px-8">
      <!-- Logo -->
      <div class="text-center mb-10">
        <h1 class="text-2xl font-bold mb-2" :style="{ color: 'var(--hc-text-primary)' }">
          {{ t('welcome.title') }}
        </h1>
        <p class="text-sm" :style="{ color: 'var(--hc-text-secondary)' }">
          {{ t('welcome.tagline') }}
        </p>
      </div>

      <!-- 步骤指示器 -->
      <div class="flex items-center justify-center gap-2 mb-8">
        <div
          v-for="(s, i) in steps"
          :key="i"
          class="flex items-center"
        >
          <div
            class="w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium transition-colors"
            :style="{
              background: i <= step ? 'var(--hc-accent)' : 'var(--hc-bg-card)',
              color: i <= step ? '#fff' : 'var(--hc-text-muted)',
            }"
          >
            <Check v-if="i < step" :size="14" />
            <span v-else>{{ i + 1 }}</span>
          </div>
          <div
            v-if="i < steps.length - 1"
            class="w-12 h-0.5 mx-1"
            :style="{ background: i < step ? 'var(--hc-accent)' : 'var(--hc-border)' }"
          />
        </div>
      </div>

      <!-- 步骤内容 -->
      <div
        class="rounded-xl border p-6 mb-6"
        :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
      >
        <h2 class="text-base font-medium mb-1" :style="{ color: 'var(--hc-text-primary)' }">
          {{ steps[step]?.title }}
        </h2>
        <p class="text-xs mb-6" :style="{ color: 'var(--hc-text-secondary)' }">
          {{ steps[step]?.description }}
        </p>

        <!-- Step 1: LLM 配置 -->
        <div v-if="step === 0" class="space-y-4">
          <div>
            <label class="block text-sm mb-1.5" :style="{ color: 'var(--hc-text-secondary)' }">Provider</label>
            <select
              v-model="provider"
              class="hc-input"
            >
              <option value="openai">OpenAI</option>
              <option value="deepseek">DeepSeek</option>
              <option value="anthropic">Anthropic</option>
              <option value="gemini">Google Gemini</option>
              <option value="qwen">通义千问</option>
              <option value="ark">豆包 (Ark)</option>
              <option value="ollama">Ollama (本地)</option>
            </select>
          </div>
          <div>
            <label class="block text-sm mb-1.5" :style="{ color: 'var(--hc-text-secondary)' }">API Key</label>
            <input
              v-model="apiKey"
              type="password"
              class="w-full rounded-lg border px-3 py-2 text-sm outline-none"
              :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
              :placeholder="PROVIDER_PRESETS[provider].placeholder"
              :disabled="!requiresApiKey"
            />
            <p v-if="!requiresApiKey" class="text-xs mt-1" :style="{ color: 'var(--hc-text-muted)' }">
              Ollama 运行在本地，无需 API Key
            </p>
            <p v-else-if="apiKey.trim().length === 0" class="text-xs mt-1" :style="{ color: 'var(--hc-warning, #f59e0b)' }">
              请输入 API Key 以继续
            </p>
          </div>
          <div>
            <label class="block text-sm mb-1.5" :style="{ color: 'var(--hc-text-secondary)' }">Model</label>
            <select
              v-model="model"
              class="hc-input"
            >
              <option v-for="m in providerModels" :key="m.id" :value="m.id">
                {{ m.name }}
              </option>
            </select>
          </div>
          <div class="pt-1">
            <button
              class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border"
              :style="{
                borderColor: connectionResult?.ok ? '#22c55e55' : 'var(--hc-border)',
                color: connectionResult?.ok ? '#16a34a' : 'var(--hc-text-secondary)',
                background: 'var(--hc-bg-main)',
              }"
              :disabled="connectionTesting || (requiresApiKey && apiKey.trim().length === 0) || !model"
              @click="testConnection"
            >
              <Loader2 v-if="connectionTesting" :size="12" class="animate-spin" />
              <CheckCircle v-else-if="connectionResult?.ok" :size="12" style="color: #22c55e;" />
              <XCircle v-else-if="connectionResult && !connectionResult.ok" :size="12" style="color: #ef4444;" />
              {{ connectionTesting ? t('welcome.testing') : t('welcome.testConnection') }}
            </button>

            <div v-if="connectionResult" class="mt-3">
              <p
                class="text-xs px-3 py-1.5 rounded-lg inline-block"
                :style="{
                  background: connectionResult.ok ? '#22c55e15' : '#ef444415',
                  color: connectionResult.ok ? '#22c55e' : '#ef4444',
                }"
              >
                {{ connectionResult.msg }}
              </p>
            </div>
          </div>
        </div>

        <!-- Step 2: 选择 Agent -->
        <div v-else-if="step === 1" class="space-y-3">
          <div
            v-for="agent in agentOptions"
            :key="agent.role"
            class="flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors hover:border-blue-500/30"
            :style="{
              borderColor: selectedAgentRole === agent.role ? 'var(--hc-accent)' : 'var(--hc-border)',
              background: selectedAgentRole === agent.role ? 'var(--hc-bg-hover)' : 'transparent',
            }"
            @click="selectedAgentRole = agent.role"
          >
            <div
              class="w-8 h-8 rounded-lg flex items-center justify-center"
              :style="{ background: 'var(--hc-accent)', color: '#fff' }"
            >
              <Bot :size="16" />
            </div>
            <div class="min-w-0">
              <div class="text-sm font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ agent.title }}</div>
              <div class="text-xs mt-0.5" :style="{ color: 'var(--hc-text-secondary)' }">{{ agent.description }}</div>
            </div>
            <div
              class="ml-auto w-4 h-4 rounded-full border flex items-center justify-center"
              :style="{ borderColor: selectedAgentRole === agent.role ? 'var(--hc-accent)' : 'var(--hc-border)' }"
            >
              <div
                v-if="selectedAgentRole === agent.role"
                class="w-2 h-2 rounded-full"
                :style="{ background: 'var(--hc-accent)' }"
              />
            </div>
          </div>
        </div>

        <!-- Step 3: 完成 -->
        <div v-else class="text-center py-4">
          <Sparkles :size="48" class="mx-auto mb-4" :style="{ color: 'var(--hc-accent)' }" />
          <p class="text-sm" :style="{ color: 'var(--hc-text-primary)' }">{{ t('welcome.step3Desc') }}</p>
          <p class="text-xs mt-1 mb-4" :style="{ color: 'var(--hc-text-secondary)' }">
            {{ t('welcome.startJourney') }}
          </p>
          <div
            class="mx-auto mt-5 max-w-sm rounded-xl border p-4 text-left"
            :style="{ background: 'var(--hc-bg-main)', borderColor: 'var(--hc-border)' }"
          >
            <div class="flex items-center justify-between text-xs mb-2">
              <span :style="{ color: 'var(--hc-text-muted)' }">{{ t('welcome.summaryProvider') }}</span>
              <span :style="{ color: 'var(--hc-text-primary)' }">{{ PROVIDER_PRESETS[provider].name }}</span>
            </div>
            <div class="flex items-center justify-between text-xs mb-2">
              <span :style="{ color: 'var(--hc-text-muted)' }">{{ t('welcome.summaryModel') }}</span>
              <span :style="{ color: 'var(--hc-text-primary)' }">{{ providerModels.find((m) => m.id === model)?.name || model }}</span>
            </div>
            <div class="flex items-center justify-between text-xs mb-2">
              <span :style="{ color: 'var(--hc-text-muted)' }">{{ t('welcome.summaryAgent') }}</span>
              <span :style="{ color: 'var(--hc-text-primary)' }">{{ selectedAgentTitle }}</span>
            </div>
            <div class="flex items-center justify-between text-xs">
              <span :style="{ color: 'var(--hc-text-muted)' }">{{ t('welcome.summaryConnection') }}</span>
              <span :style="{ color: connectionResult?.ok ? '#22c55e' : '#ef4444' }">
                {{ connectionResult?.ok ? t('welcome.connectionReady') : t('welcome.connectionPending') }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- 操作按钮 -->
      <div class="flex items-center justify-between">
        <button
          v-if="step > 0"
          class="flex items-center gap-1 px-3 py-2 rounded-lg text-sm transition-colors"
          :style="{ color: 'var(--hc-text-secondary)' }"
          @click="prevStep"
        >
          <ArrowLeft :size="14" />
          {{ t('welcome.prev') }}
        </button>
        <button
          v-else
          class="px-3 py-2 text-sm transition-colors"
          :style="{ color: 'var(--hc-text-muted)' }"
          @click="skip"
        >
          {{ t('welcome.skip') }}
        </button>

        <button
          class="flex items-center gap-1 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity"
          :style="{
            background: 'var(--hc-accent)',
            opacity: (step === 0 && !canProceedFromStep0) || finishing ? 0.5 : 1,
            cursor: (step === 0 && !canProceedFromStep0) || finishing ? 'not-allowed' : 'pointer',
          }"
          :disabled="finishing"
          @click="nextStep"
        >
          {{ step === 2 ? t('welcome.start') : t('welcome.next') }}
          <ArrowRight :size="14" />
        </button>
      </div>
    </div>
  </div>
</template>
