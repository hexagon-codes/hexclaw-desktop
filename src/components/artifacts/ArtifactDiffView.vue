<script setup lang="ts">
import { computed } from 'vue'
import { computeDiff } from '@/utils/diff'
import type { Artifact } from '@/types'

const props = defineProps<{
  artifact: Artifact
}>()

const diffLines = computed(() => {
  if (!props.artifact.previousContent) return []
  return computeDiff(props.artifact.previousContent, props.artifact.content)
})

const hasDiff = computed(() => !!props.artifact.previousContent)
</script>

<template>
  <div class="hc-diff">
    <div v-if="!hasDiff" class="hc-diff__empty">
      No previous version to compare
    </div>
    <div v-else class="hc-diff__body">
      <div
        v-for="(line, idx) in diffLines"
        :key="idx"
        class="hc-diff__line"
        :class="'hc-diff__line--' + line.type"
      >
        <span class="hc-diff__gutter hc-diff__gutter--old">{{ line.oldLineNo ?? '' }}</span>
        <span class="hc-diff__gutter hc-diff__gutter--new">{{ line.newLineNo ?? '' }}</span>
        <span class="hc-diff__sign">{{ line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ' }}</span>
        <span class="hc-diff__content">{{ line.content }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hc-diff {
  border-radius: var(--hc-radius-md);
  overflow: hidden;
  border: 1px solid var(--hc-border);
}

.hc-diff__empty {
  padding: 24px;
  text-align: center;
  font-size: 12px;
  color: var(--hc-text-muted);
}

.hc-diff__body {
  overflow-x: auto;
  font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
  font-size: 12px;
  line-height: 1.6;
}

.hc-diff__line {
  display: flex;
  padding: 0 8px;
  white-space: pre;
}

.hc-diff__line--add {
  background: color-mix(in srgb, var(--hc-success) 12%, transparent);
}

.hc-diff__line--remove {
  background: color-mix(in srgb, var(--hc-error) 12%, transparent);
}

.hc-diff__gutter {
  width: 32px;
  flex-shrink: 0;
  text-align: right;
  padding-right: 6px;
  color: var(--hc-text-muted);
  opacity: 0.5;
  user-select: none;
}

.hc-diff__sign {
  width: 14px;
  flex-shrink: 0;
  text-align: center;
  font-weight: 600;
}

.hc-diff__line--add .hc-diff__sign {
  color: var(--hc-success);
}

.hc-diff__line--remove .hc-diff__sign {
  color: var(--hc-error);
}

.hc-diff__content {
  flex: 1;
}
</style>
