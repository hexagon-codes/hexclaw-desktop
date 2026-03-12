<script setup lang="ts">
import { Copy, RotateCcw, Pencil, Trash2 } from 'lucide-vue-next'

const props = defineProps<{
  role: 'user' | 'assistant'
  content: string
}>()

const emit = defineEmits<{
  copy: []
  retry: []
  edit: []
  delete: []
}>()

async function handleCopy() {
  try {
    await navigator.clipboard.writeText(props.content)
  } catch {
    console.error('复制失败')
  }
  emit('copy')
}
</script>

<template>
  <div
    class="flex items-center gap-0.5 rounded-lg border px-1 py-0.5"
    :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
  >
    <button
      class="p-1 rounded hover:bg-white/5 transition-colors"
      :style="{ color: 'var(--hc-text-muted)' }"
      title="复制"
      @click="handleCopy"
    >
      <Copy :size="12" />
    </button>
    <button
      v-if="role === 'assistant'"
      class="p-1 rounded hover:bg-white/5 transition-colors"
      :style="{ color: 'var(--hc-text-muted)' }"
      title="重新生成"
      @click="emit('retry')"
    >
      <RotateCcw :size="12" />
    </button>
    <button
      v-if="role === 'user'"
      class="p-1 rounded hover:bg-white/5 transition-colors"
      :style="{ color: 'var(--hc-text-muted)' }"
      title="编辑"
      @click="emit('edit')"
    >
      <Pencil :size="12" />
    </button>
  </div>
</template>
