<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SessionHistoryStatus } from '@/stores/chat-session-loading'

const props = defineProps<{ status: SessionHistoryStatus }>()
const emit = defineEmits<{ retry: [] }>()
const { t } = useI18n()
const showActivity = ref(false)
const activityDelayMs = 180
const captionDelayMs = 1200 - activityDelayMs

watch(() => props.status, (status, _, onCleanup) => {
  showActivity.value = false
  if (status !== 'loading') return
  const timer = setTimeout(() => { showActivity.value = true }, activityDelayMs)
  onCleanup(() => clearTimeout(timer))
}, { immediate: true })

const message = computed(() => {
  if (props.status === 'loading') return showActivity.value ? t('chat.historyLoading') : ''
  return t(props.status === 'failed' ? 'chat.historyLoadFailed' : 'chat.historyNoMessages')
})
</script>

<template>
  <div class="hc-chat-history-status" :data-history-status="status">
    <span v-if="showActivity" class="hc-chat-history-status__spinner" aria-hidden="true">
      <span v-for="spoke in 8" :key="spoke" :style="{ '--spoke': spoke - 1 }" />
    </span>
    <span
      class="hc-chat-history-status__message"
      :class="{ 'hc-chat-history-status__message--delayed': showActivity }"
      :style="{ '--history-caption-delay': `${captionDelayMs}ms` }"
      role="status"
      aria-atomic="true"
    >{{ message }}</span>
    <button
      v-if="status === 'failed'"
      type="button"
      class="btn btn-ghost hc-chat-history-status__retry"
      @click="emit('retry')"
    >
      {{ t('common.retry') }}
    </button>
  </div>
</template>

<style scoped>
.hc-chat-history-status {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto minmax(0, 1fr);
  justify-items: center;
  align-items: center;
  row-gap: 8px;
  padding: 16px;
  color: var(--hc-text-secondary);
  font-size: 13px;
  line-height: 1.5;
  text-align: center;
}

.hc-chat-history-status__spinner {
  grid-area: 2 / 1;
  position: relative;
  width: 18px;
  height: 18px;
  animation: hc-spin 1s steps(8) infinite;
}

.hc-chat-history-status__spinner > span {
  position: absolute;
  inset: 0;
  transform: rotate(calc(45deg * var(--spoke)));
}

.hc-chat-history-status__spinner > span::before {
  content: '';
  position: absolute;
  top: 0;
  left: calc(50% - 1px);
  width: 2px;
  height: 5px;
  border-radius: 2px;
  background: currentColor;
  opacity: calc(1 - .105 * var(--spoke));
}

.hc-chat-history-status__message {
  grid-area: 2 / 1;
}

.hc-chat-history-status[data-history-status='loading'] .hc-chat-history-status__message,
.hc-chat-history-status__retry {
  grid-area: 3 / 1;
  align-self: start;
}

.hc-chat-history-status__message--delayed {
  animation: chat-history-caption 120ms ease-out var(--history-caption-delay) both;
}

@keyframes chat-history-caption {
  from { opacity: 0; }
  to { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .hc-chat-history-status__spinner,
  .hc-chat-history-status__message--delayed {
    animation: none;
  }
}
</style>
