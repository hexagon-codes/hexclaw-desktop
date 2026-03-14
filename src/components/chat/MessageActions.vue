<script setup lang="ts">
import { Copy, RotateCcw, Pencil, ThumbsUp, ThumbsDown } from 'lucide-vue-next'
import { ref } from 'vue'

const props = defineProps<{
  role: 'user' | 'assistant'
  content: string
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
const liked = ref<'like' | 'dislike' | null>(null)

function handleLike() {
  liked.value = liked.value === 'like' ? null : 'like'
  emit('like')
}

function handleDislike() {
  liked.value = liked.value === 'dislike' ? null : 'dislike'
  emit('dislike')
}

async function handleCopy() {
  try {
    await navigator.clipboard.writeText(props.content)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {
    console.error('复制失败')
  }
  emit('copy')
}
</script>

<template>
  <div class="hc-msg-actions">
    <!-- AI message actions: like, dislike, copy, retry -->
    <template v-if="role === 'assistant'">
      <button class="hc-msg-actions__btn" :class="{ 'hc-msg-actions__btn--active': liked === 'like' }" title="赞" @click="handleLike">
        <ThumbsUp :size="13" />
      </button>
      <button class="hc-msg-actions__btn" :class="{ 'hc-msg-actions__btn--active-bad': liked === 'dislike' }" title="踩" @click="handleDislike">
        <ThumbsDown :size="13" />
      </button>
      <span class="hc-msg-actions__divider" />
      <button class="hc-msg-actions__btn" :title="copied ? '已复制' : '复制'" @click="handleCopy">
        <Copy :size="13" />
      </button>
      <button class="hc-msg-actions__btn" title="重新生成" @click="emit('retry')">
        <RotateCcw :size="13" />
      </button>
    </template>

    <!-- User message actions: copy, edit -->
    <template v-else>
      <button class="hc-msg-actions__btn" :title="copied ? '已复制' : '复制'" @click="handleCopy">
        <Copy :size="13" />
      </button>
      <button class="hc-msg-actions__btn" title="编辑" @click="emit('edit')">
        <Pencil :size="13" />
      </button>
    </template>
  </div>
</template>

<style scoped>
.hc-msg-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px 4px;
  border-radius: 8px;
  background: var(--hc-bg-card);
  border: 1px solid var(--hc-border);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.04);
  animation: hc-actions-fade-in 0.15s ease;
}

.hc-msg-actions__divider {
  width: 1px;
  height: 14px;
  background: var(--hc-border);
  margin: 0 2px;
}

.hc-msg-actions__btn {
  padding: 4px 6px;
  border-radius: 5px;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
}

.hc-msg-actions__btn:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}

.hc-msg-actions__btn:active {
  transform: scale(0.92);
}

.hc-msg-actions__btn--active {
  color: var(--hc-accent);
  background: var(--hc-accent-subtle, rgba(79, 140, 255, 0.1));
}

.hc-msg-actions__btn--active-bad {
  color: var(--hc-error, #ff3b30);
  background: rgba(255, 59, 48, 0.08);
}

@keyframes hc-actions-fade-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
