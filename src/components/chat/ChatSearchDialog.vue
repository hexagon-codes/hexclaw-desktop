<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { Search, X, ArrowUp, ArrowDown } from 'lucide-vue-next'

const props = defineProps<{
  messages: { id: string; role: string; content: string; timestamp: string }[]
}>()

const emit = defineEmits<{
  close: []
  scrollTo: [msgId: string]
}>()

const query = ref('')
const inputRef = ref<HTMLInputElement>()
const currentIndex = ref(0)

const results = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return []
  return props.messages.filter(m => m.content.toLowerCase().includes(q))
})

watch(query, () => {
  currentIndex.value = 0
})

watch(results, (r) => {
  if (r.length > 0) {
    emit('scrollTo', r[currentIndex.value]!.id)
  }
})

function prev() {
  if (results.value.length === 0) return
  currentIndex.value = (currentIndex.value - 1 + results.value.length) % results.value.length
  emit('scrollTo', results.value[currentIndex.value]!.id)
}

function next() {
  if (results.value.length === 0) return
  currentIndex.value = (currentIndex.value + 1) % results.value.length
  emit('scrollTo', results.value[currentIndex.value]!.id)
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
  if (e.key === 'Enter' && e.shiftKey) { prev(); e.preventDefault() }
  else if (e.key === 'Enter') { next(); e.preventDefault() }
}

nextTick(() => inputRef.value?.focus())
</script>

<template>
  <div class="hc-search-bar">
    <Search :size="14" class="hc-search-bar__icon" />
    <input
      ref="inputRef"
      v-model="query"
      class="hc-search-bar__input"
      placeholder="搜索消息..."
      @keydown="handleKeydown"
    />
    <span v-if="query" class="hc-search-bar__count">
      {{ results.length > 0 ? `${currentIndex + 1}/${results.length}` : '无结果' }}
    </span>
    <button class="hc-search-bar__btn" @click="prev" :disabled="results.length === 0">
      <ArrowUp :size="14" />
    </button>
    <button class="hc-search-bar__btn" @click="next" :disabled="results.length === 0">
      <ArrowDown :size="14" />
    </button>
    <button class="hc-search-bar__btn" @click="emit('close')">
      <X :size="14" />
    </button>
  </div>
</template>

<style scoped>
.hc-search-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--hc-bg-elevated);
  border-bottom: 1px solid var(--hc-border);
  animation: hc-slide-down 0.15s ease-out;
  overflow: hidden;
}

@keyframes hc-slide-down {
  from { transform: translateY(-100%); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

.hc-search-bar__icon {
  color: var(--hc-text-muted);
  flex-shrink: 0;
}

.hc-search-bar__input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  font-size: 13px;
  color: var(--hc-text-primary);
}

.hc-search-bar__input::placeholder {
  color: var(--hc-text-muted);
}

.hc-search-bar__count {
  font-size: 11px;
  color: var(--hc-text-muted);
  white-space: nowrap;
}

.hc-search-bar__btn {
  padding: 3px;
  border-radius: var(--hc-radius-sm);
  border: none;
  background: transparent;
  color: var(--hc-text-secondary);
  cursor: pointer;
  display: flex;
  transition: background 0.15s;
}

.hc-search-bar__btn:hover {
  background: var(--hc-bg-hover);
}

.hc-search-bar__btn:disabled {
  opacity: 0.3;
  cursor: default;
}
</style>
