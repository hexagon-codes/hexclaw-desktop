<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Key, Bot, Sparkles, ArrowRight, ArrowLeft, Check } from 'lucide-vue-next'

const router = useRouter()
const { t } = useI18n()
const step = ref(0)

const apiKey = ref('')
const provider = ref('openai')
const model = ref('gpt-4o')

const steps = computed(() => [
  { title: t('welcome.step1Title'), description: t('welcome.step1Desc'), icon: Key },
  { title: t('welcome.step2Title'), description: t('welcome.step2Desc'), icon: Bot },
  { title: t('welcome.step3Title'), description: t('welcome.step3Desc'), icon: Sparkles },
])

function nextStep() {
  if (step.value < 2) {
    step.value++
  } else {
    router.push('/chat')
  }
}

function prevStep() {
  if (step.value > 0) step.value--
}

function skip() {
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
              class="w-full rounded-lg border px-3 py-2 text-sm outline-none"
              :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
            >
              <option value="openai">OpenAI</option>
              <option value="deepseek">DeepSeek</option>
              <option value="anthropic">Anthropic</option>
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
              placeholder="sk-..."
            />
          </div>
        </div>

        <!-- Step 2: 选择 Agent -->
        <div v-else-if="step === 1" class="space-y-3">
          <div
            v-for="agent in [t('welcome.generalAssistant'), t('welcome.codeAssistant'), t('welcome.writingAssistant')]"
            :key="agent"
            class="flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors hover:border-blue-500/30"
            :style="{ borderColor: 'var(--hc-border)' }"
          >
            <div
              class="w-8 h-8 rounded-lg flex items-center justify-center"
              :style="{ background: 'var(--hc-accent)', color: '#fff' }"
            >
              <Bot :size="16" />
            </div>
            <span class="text-sm" :style="{ color: 'var(--hc-text-primary)' }">{{ agent }}</span>
          </div>
        </div>

        <!-- Step 3: 完成 -->
        <div v-else class="text-center py-4">
          <Sparkles :size="48" class="mx-auto mb-4" :style="{ color: 'var(--hc-accent)' }" />
          <p class="text-sm" :style="{ color: 'var(--hc-text-primary)' }">{{ t('welcome.step3Desc') }}</p>
          <p class="text-xs mt-1" :style="{ color: 'var(--hc-text-secondary)' }">
            {{ t('welcome.startJourney') }}
          </p>
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
          class="flex items-center gap-1 px-4 py-2 rounded-lg text-sm font-medium text-white"
          :style="{ background: 'var(--hc-accent)' }"
          @click="nextStep"
        >
          {{ step === 2 ? t('welcome.start') : t('welcome.next') }}
          <ArrowRight :size="14" />
        </button>
      </div>
    </div>
  </div>
</template>
