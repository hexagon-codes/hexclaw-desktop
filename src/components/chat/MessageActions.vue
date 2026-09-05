<script setup lang="ts">
import {
  Copy,
  Check,
  RotateCcw,
  Pencil,
  ThumbsUp,
  ThumbsDown,
  Volume2,
  Square,
  GitBranch,
} from 'lucide-vue-next'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { setClipboard } from '@/api/desktop'
import { useVoice } from '@/composables/useVoice'
import { useToast } from '@/composables/useToast'

const { t } = useI18n()
const toast = useToast()

const props = withDefaults(
  defineProps<{
    role: 'user' | 'assistant'
    content: string
    showRetry?: boolean
    retryDisabled?: boolean
    retryTitle?: string
    showFork?: boolean
    retryMode?: 'regenerate' | 'task-stage'
    feedback?: 'like' | 'dislike' | null
  }>(),
  { showRetry: true, retryDisabled: false, showFork: true, retryMode: 'regenerate' },
)

const emit = defineEmits<{
  copy: []
  retry: []
  edit: []
  like: []
  dislike: []
  fork: []
}>()

const copied = ref(false)
const activeFeedback = computed(() => props.feedback ?? null)
// F4：整条全是代码块/纯图片时 plainText 为空 → 朗读无意义。禁用喇叭而非"点了没反应"。
const speakable = computed(() => plainText(props.content).length > 0)

// 朗读：每个 MessageActions 实例独立 useVoice，互不干扰；
// 切换消息播报时手动 stopSpeaking 以释放 audio 资源
const { isSpeaking, speak, stopSpeaking, error: voiceError } = useVoice()

async function handleCopy() {
  try {
    await setClipboard(props.content)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {
    // clipboard write can fail in certain environments
  }
  emit('copy')
}

/** 朗读消息内容 — Markdown 转纯文本，避免读出 ``` # * 等符号 */
function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '') // 代码块整段去掉
    .replace(/`[^`]*`/g, '') // 行内代码
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // 图片
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 链接保留 anchor
    .replace(/[#*_~>|]/g, '') // 标记符号
    .replace(/\s+/g, ' ')
    .trim()
}

async function toggleSpeak() {
  if (isSpeaking.value) {
    stopSpeaking()
    return
  }
  const text = plainText(props.content)
  if (!text) return
  await speak(text)
  // speak() 内部把失败（如后端 TTS 未配置返回 503）静默吞进 voiceError，
  // 不上抛；这里显式 toast，避免"点了没反应"的无反馈体验。
  if (voiceError.value) {
    toast.error(t('chat.speakFailed', '语音播报失败，请检查语音合成服务是否已配置'))
  }
}
</script>

<template>
  <div
    class="hc-msg-actions"
    :class="`hc-msg-actions--${role}`"
    role="toolbar"
    :aria-label="t('chat.messageActions')"
  >
    <template v-if="role === 'assistant'">
      <button
        type="button"
        class="hc-msg-actions__btn"
        :class="{ 'hc-msg-actions__btn--active': activeFeedback === 'like' }"
        :title="t('chat.liked')"
        :aria-label="t('chat.liked')"
        @click="emit('like')"
      >
        <ThumbsUp :size="14" />
      </button>
      <button
        type="button"
        class="hc-msg-actions__btn"
        :class="{ 'hc-msg-actions__btn--active-bad': activeFeedback === 'dislike' }"
        :title="t('chat.disliked')"
        :aria-label="t('chat.disliked')"
        @click="emit('dislike')"
      >
        <ThumbsDown :size="14" />
      </button>
      <span class="hc-msg-actions__divider" aria-hidden="true" />
      <button
        type="button"
        class="hc-msg-actions__btn"
        :class="{ 'hc-msg-actions__btn--copied': copied }"
        :title="copied ? t('chat.copied') : t('common.copy')"
        :aria-label="copied ? t('chat.copied') : t('common.copy')"
        @click="handleCopy"
      >
        <Check v-if="copied" :size="14" />
        <Copy v-else :size="14" />
      </button>
      <button
        type="button"
        class="hc-msg-actions__btn"
        :title="retryTitle || t(retryMode === 'task-stage' ? 'chat.retryCurrentStage' : 'chat.regenerate')"
        :aria-label="t(retryMode === 'task-stage' ? 'chat.retryCurrentStage' : 'chat.regenerate')"
        v-if="showRetry !== false"
        :data-testid="retryMode === 'task-stage' ? 'message-task-stage-retry' : 'message-regenerate'"
        :disabled="retryDisabled"
        @click="emit('retry')"
      >
        <RotateCcw :size="14" />
      </button>
      <button
        type="button"
        class="hc-msg-actions__btn"
        :class="{ 'hc-msg-actions__btn--speaking': isSpeaking }"
        :disabled="!speakable && !isSpeaking"
        :title="isSpeaking ? t('chat.stopSpeaking', '停止朗读') : t('chat.speakMessage', '朗读')"
        :aria-label="
          isSpeaking ? t('chat.stopSpeaking', '停止朗读') : t('chat.speakMessage', '朗读')
        "
        @click="toggleSpeak"
      >
        <Square v-if="isSpeaking" :size="14" />
        <Volume2 v-else :size="14" />
      </button>
      <button
        v-if="showFork !== false"
        type="button"
        class="hc-msg-actions__btn"
        data-testid="message-fork"
        :title="t('chat.createBranch', '创建分支')"
        :aria-label="t('chat.createBranch', '创建分支')"
        @click="emit('fork')"
      >
        <GitBranch :size="14" />
      </button>
    </template>

    <template v-else>
      <button
        type="button"
        class="hc-msg-actions__btn"
        :class="{ 'hc-msg-actions__btn--copied': copied }"
        :title="copied ? t('chat.copied') : t('common.copy')"
        :aria-label="copied ? t('chat.copied') : t('common.copy')"
        @click="handleCopy"
      >
        <Check v-if="copied" :size="14" />
        <Copy v-else :size="14" />
      </button>
      <button
        type="button"
        class="hc-msg-actions__btn"
        :title="t('chat.editMessage')"
        :aria-label="t('chat.editMessage')"
        @click="emit('edit')"
      >
        <Pencil :size="14" />
      </button>
    </template>
  </div>
</template>

<style scoped>
.hc-msg-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  border-radius: 8px;
  color: var(--hc-text-secondary);
}

.hc-msg-actions--assistant {
  height: 24px;
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
  opacity: 0.68;
  visibility: visible;
  pointer-events: auto;
  transition: opacity 0.14s var(--hc-ease-out);
}

.hc-msg-actions--assistant:hover,
.hc-msg-actions--assistant:focus-within {
  opacity: 1;
}

.hc-msg-actions--assistant .hc-msg-actions__btn {
  color: var(--hc-text-muted);
}

.hc-msg-actions--user {
  height: 30px;
  padding: 3px;
  border: 0.5px solid color-mix(in srgb, var(--hc-border) 82%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--hc-bg-elevated) 82%, transparent);
  backdrop-filter: blur(16px) saturate(150%);
  -webkit-backdrop-filter: blur(16px) saturate(150%);
  box-shadow:
    0 6px 18px color-mix(in srgb, var(--hc-text-primary) 8%, transparent),
    inset 0 0.5px 0 color-mix(in srgb, #fff 52%, transparent);
}

.hc-msg-actions__divider {
  width: 1px;
  height: 16px;
  background: var(--hc-divider);
  margin: 0 2px;
}

.hc-msg-actions__btn {
  width: 24px;
  height: 24px;
  flex: none;
  padding: 0;
  border-radius: 7px;
  border: none;
  background: transparent;
  color: var(--hc-text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    background 0.12s var(--hc-ease-out),
    color 0.12s var(--hc-ease-out),
    transform 0.1s var(--hc-spring);
}

.hc-msg-actions__btn:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}

.hc-msg-actions__btn:active {
  transform: scale(0.9);
}

.hc-msg-actions__btn[data-testid='message-regenerate']:disabled {
  cursor: default;
  opacity: 0.45;
  transform: none;
}

.hc-msg-actions__btn--copied {
  color: #34c759 !important;
}

.hc-msg-actions__btn:focus-visible {
  outline: 2px solid var(--hc-accent);
  outline-offset: 1px;
}

.hc-msg-actions__btn svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.hc-msg-actions__btn--speaking {
  color: var(--hc-accent, #007aff);
  background: rgba(0, 122, 255, 0.1);
  animation: hc-speak-pulse 1.4s ease-in-out infinite;
}

@keyframes hc-speak-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}

.hc-msg-actions__btn--active {
  color: var(--hc-accent, #007aff);
  background: rgba(0, 122, 255, 0.1);
}

.hc-msg-actions__btn--active-bad {
  color: var(--hc-error, #ff3b30);
  background: rgba(255, 59, 48, 0.08);
}

@media (prefers-reduced-motion: reduce) {
  .hc-msg-actions--assistant,
  .hc-msg-actions__btn {
    transition: none;
  }
}
</style>
