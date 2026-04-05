<script setup lang="ts">
import { Copy, Check, RotateCcw, Pencil, ThumbsUp, ThumbsDown } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { setClipboard } from '@/api/desktop'

const { t } = useI18n()

const props = defineProps<{
  role: 'user' | 'assistant'
  content: string
  feedback?: 'like' | 'dislike' | null
}>()

const emit = defineEmits<{
  copy: []
  retry: []
  edit: []
  delete: []
  like: []
  dislike: []
}>()

const copied = ref(false)
const activeFeedback = computed(() => props.feedback ?? null)

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
</script>

<template>
  <div class="hc-msg-actions">
    <template v-if="role === 'assistant'">
      <button class="hc-msg-actions__btn" :class="{ 'hc-msg-actions__btn--active': activeFeedback === 'like' }" :title="t('chat.liked')" @click="emit('like')">
        <ThumbsUp :size="13" />
      </button>
      <button class="hc-msg-actions__btn" :class="{ 'hc-msg-actions__btn--active-bad': activeFeedback === 'dislike' }" :title="t('chat.disliked')" @click="emit('dislike')">
        <ThumbsDown :size="13" />
      </button>
      <span class="hc-msg-actions__divider" />
      <button class="hc-msg-actions__btn" :class="{ 'hc-msg-actions__btn--copied': copied }" :title="copied ? t('chat.copied') : t('common.copy')" @click="handleCopy">
        <Check v-if="copied" :size="13" />
        <Copy v-else :size="13" />
      </button>
      <button class="hc-msg-actions__btn" :title="t('chat.regenerate')" @click="emit('retry')">
        <RotateCcw :size="13" />
      </button>
    </template>

    <template v-else>
      <button class="hc-msg-actions__btn" :class="{ 'hc-msg-actions__btn--copied': copied }" :title="copied ? t('chat.copied') : t('common.copy')" @click="handleCopy">
        <Check v-if="copied" :size="13" />
        <Copy v-else :size="13" />
      </button>
      <button class="hc-msg-actions__btn" :title="t('chat.editMessage')" @click="emit('edit')">
        <Pencil :size="13" />
      </button>
    </template>
  </div>
</template>

<style scoped>
/* Apple HIG: 毛玻璃浮层 + 弹簧入场动效 */
.hc-msg-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 4px 6px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border: 0.5px solid rgba(0, 0, 0, 0.08);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08), 0 2px 4px rgba(0, 0, 0, 0.04);
  animation: hc-spring-in 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
}

.hc-msg-actions__divider {
  width: 0.5px;
  height: 16px;
  background: rgba(0, 0, 0, 0.1);
  margin: 0 2px;
}

.hc-msg-actions__btn {
  padding: 5px 7px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--hc-text-secondary, #6E6E73);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.15s, color 0.15s;
}

.hc-msg-actions__btn:hover {
  background: rgba(0, 0, 0, 0.06);
  color: var(--hc-text-primary, #1D1D1F);
}

.hc-msg-actions__btn:active {
  transform: scale(0.92);
}

.hc-msg-actions__btn--copied { color: #34C759 !important; }

.hc-msg-actions__btn--active {
  color: var(--hc-accent, #007AFF);
  background: rgba(0, 122, 255, 0.1);
}

.hc-msg-actions__btn--active-bad {
  color: var(--hc-error, #FF3B30);
  background: rgba(255, 59, 48, 0.08);
}

@keyframes hc-spring-in {
  from { opacity: 0; transform: scale(0.96) translateY(8px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}
</style>
