<script setup lang="ts">
/**
 * 图像生成 composer — 当用户在聊天选择器选中图像生成模型时取代 ChatInput。
 *
 * 极简交互：prompt + 尺寸 + 张数 → 生成 → 在聊天流插入图像消息。
 * 不走 chat completions，直接调 /api/v1/images/generate。
 */
import { ref, computed } from 'vue'
import { Sparkles, Loader2, Image as ImageIcon } from 'lucide-vue-next'
import { generateImage, type ImageGenResult } from '@/api/imagegen'
import { logger } from '@/utils/logger'

const props = defineProps<{
  modelId: string
  modelName: string
  /** Provider 后端 key（如 zhipu / openai），用于显式路由 */
  providerKey?: string
}>()

const emit = defineEmits<{
  /** 生成成功 — 父组件将结果作为 assistant 消息插入会话 */
  generated: [result: ImageGenResult, prompt: string]
  /** 生成失败 — 父组件展示错误 */
  error: [message: string]
}>()

const prompt = ref('')
const size = ref('1024x1024')
const n = ref(1)
const style = ref<'vivid' | 'natural'>('vivid')
const quality = ref<'standard' | 'hd'>('standard')
const generating = ref(false)
const lastError = ref('')

// DALL-E 3 才支持 style / quality，其他模型隐藏这两个字段
const isDallE3 = computed(() => props.modelId === 'dall-e-3')

// 尺寸选项按模型差异化
const sizeOptions = computed(() => {
  if (isDallE3.value) return ['1024x1024', '1792x1024', '1024x1792']
  if (props.modelId.startsWith('cogview')) return ['1024x1024', '768x1344', '1344x768', '864x1152', '1152x864']
  return ['1024x1024', '512x512']
})

async function handleGenerate() {
  const text = prompt.value.trim()
  if (!text || generating.value) return
  generating.value = true
  lastError.value = ''
  try {
    const result = await generateImage({
      model: props.modelId,
      prompt: text,
      size: size.value,
      n: n.value,
      ...(isDallE3.value ? { style: style.value, quality: quality.value } : {}),
    })
    emit('generated', result, text)
    prompt.value = ''
  } catch (e) {
    const msg = e instanceof Error ? e.message : '生成失败'
    lastError.value = msg
    logger.error('[ImageGenComposer] generate failed', e)
    emit('error', msg)
  } finally {
    generating.value = false
  }
}

function onKeydown(e: KeyboardEvent) {
  // Cmd/Ctrl+Enter 生成
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    handleGenerate()
  }
}
</script>

<template>
  <div class="hc-imagegen">
    <div class="hc-imagegen__header">
      <ImageIcon :size="16" />
      <span class="hc-imagegen__title">图像生成</span>
    </div>

    <textarea
      v-model="prompt"
      class="hc-imagegen__prompt"
      placeholder="描述你想生成的图像，例如「一只穿宇航服的橘猫站在月球表面，写实风格」"
      :disabled="generating"
      @keydown="onKeydown"
    />

    <div class="hc-imagegen__options">
      <label class="hc-imagegen__opt">
        <span>尺寸</span>
        <select v-model="size" :disabled="generating">
          <option v-for="s in sizeOptions" :key="s" :value="s">{{ s }}</option>
        </select>
      </label>

      <label class="hc-imagegen__opt">
        <span>张数</span>
        <select v-model.number="n" :disabled="generating">
          <option :value="1">1</option>
          <option :value="2">2</option>
          <option :value="4">4</option>
        </select>
      </label>

      <template v-if="isDallE3">
        <label class="hc-imagegen__opt">
          <span>风格</span>
          <select v-model="style" :disabled="generating">
            <option value="vivid">绚丽</option>
            <option value="natural">自然</option>
          </select>
        </label>
        <label class="hc-imagegen__opt">
          <span>质量</span>
          <select v-model="quality" :disabled="generating">
            <option value="standard">标准</option>
            <option value="hd">高清</option>
          </select>
        </label>
      </template>

      <button
        class="hc-imagegen__btn"
        :disabled="!prompt.trim() || generating"
        @click="handleGenerate"
      >
        <Loader2 v-if="generating" :size="13" class="hc-imagegen__spin" />
        <Sparkles v-else :size="13" />
        {{ generating ? '生成中…' : '生成图像' }}
        <span v-if="!generating" class="hc-imagegen__hint">⌘↩</span>
      </button>
    </div>

    <p v-if="lastError" class="hc-imagegen__error">{{ lastError }}</p>
  </div>
</template>

<style scoped>
.hc-imagegen {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  border: 0.5px solid var(--hc-border);
  border-radius: 16px;
  background: var(--hc-bg-card);
}

.hc-imagegen__header {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--hc-text-secondary);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.hc-imagegen__title { color: var(--hc-text-primary); }

.hc-imagegen__prompt {
  width: 100%;
  min-height: 72px;
  resize: vertical;
  padding: 12px 14px;
  border: 0.5px solid var(--hc-border);
  border-radius: 10px;
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
  font-family: inherit;
  font-size: 14px;
  line-height: 1.6;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.hc-imagegen__prompt:focus {
  border-color: var(--hc-accent);
  box-shadow: 0 0 0 3px rgba(0, 122, 255, 0.12);
}

.hc-imagegen__options {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
}

.hc-imagegen__opt {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--hc-text-secondary);
}

.hc-imagegen__opt select {
  appearance: none;
  -webkit-appearance: none;
  padding: 7px 28px 7px 12px;
  border: 0.5px solid var(--hc-border);
  border-radius: 8px;
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
  font-size: 13px;
  outline: none;
  cursor: pointer;
  transition: border-color 0.15s ease;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6' fill='none'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%238b95a5' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 9px center;
}
.hc-imagegen__opt select:hover { border-color: var(--hc-text-muted); }
.hc-imagegen__opt select:focus { border-color: var(--hc-accent); }

.hc-imagegen__btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-left: auto;
  padding: 8px 18px;
  border-radius: 10px;
  background: var(--hc-accent);
  color: var(--hc-text-inverse);
  border: 0.5px solid var(--hc-accent);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease, transform 0.12s ease;
}
.hc-imagegen__btn:active:not(:disabled) { transform: scale(0.97); }

.hc-imagegen__btn:hover:not(:disabled) { background: var(--hc-accent-hover); }
.hc-imagegen__btn:disabled { opacity: 0.5; cursor: not-allowed; }

.hc-imagegen__hint {
  margin-left: 4px;
  opacity: 0.7;
  font-family: 'SF Mono', ui-monospace, monospace;
  font-size: 10px;
}

.hc-imagegen__spin { animation: hc-imagegen-spin 0.8s linear infinite; }

@keyframes hc-imagegen-spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

.hc-imagegen__error {
  color: var(--hc-error);
  font-size: 11px;
  margin-top: 4px;
}

/** 导出 imageToSrc 供调用方在消息中渲染 */
</style>
