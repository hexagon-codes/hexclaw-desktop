<script setup lang="ts">
import { computed } from 'vue'
import { computeStructuredDiff } from '@/utils/diff'
import type { Artifact } from '@/types'

const props = defineProps<{
  artifact: Artifact
}>()

const structuredDiff = computed(() => {
  if (!props.artifact.previousContent) return null
  return computeStructuredDiff(props.artifact.previousContent, props.artifact.content)
})

const hasDiff = computed(() => !!props.artifact.previousContent)
</script>

<template>
  <div class="hc-diff">
    <div v-if="!hasDiff" class="hc-diff__empty">
      No previous version to compare
    </div>
    <template v-else-if="structuredDiff">
      <!-- stats summary -->
      <div class="hc-diff__stats">
        <span class="hc-diff__stats-add">+{{ structuredDiff.stats.additions }}</span>
        <span class="hc-diff__stats-sep">/</span>
        <span class="hc-diff__stats-remove">-{{ structuredDiff.stats.deletions }}</span>
      </div>

      <div v-if="structuredDiff.hunks.length === 0" class="hc-diff__empty">
        No changes
      </div>

      <div v-else class="hc-diff__body">
        <template v-for="(hunk, hIdx) in structuredDiff.hunks" :key="hIdx">
          <!-- hunk separator -->
          <div v-if="hIdx > 0" class="hc-diff__hunk-sep" />
          <!-- hunk header -->
          <div class="hc-diff__hunk-header">{{ hunk.header }}</div>
          <!-- hunk lines -->
          <div
            v-for="(line, lIdx) in hunk.lines"
            :key="`${hIdx}-${lIdx}`"
            class="hc-diff__line"
            :class="'hc-diff__line--' + line.type"
          >
            <span class="hc-diff__gutter hc-diff__gutter--old">{{ line.oldLineNo ?? '' }}</span>
            <span class="hc-diff__gutter hc-diff__gutter--new">{{ line.newLineNo ?? '' }}</span>
            <span class="hc-diff__sign">{{ line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ' }}</span>
            <span class="hc-diff__content">{{ line.content }}</span>
          </div>
        </template>
      </div>
    </template>
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

.hc-diff__stats {
  padding: 6px 12px;
  font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
  font-size: 12px;
  border-bottom: 1px solid var(--hc-border);
  background: var(--hc-bg-secondary, #f8f9fa);
}

.hc-diff__stats-add {
  color: var(--hc-success);
  font-weight: 600;
}

.hc-diff__stats-sep {
  margin: 0 4px;
  color: var(--hc-text-muted);
}

.hc-diff__stats-remove {
  color: var(--hc-error);
  font-weight: 600;
}

.hc-diff__body {
  overflow-x: auto;
  font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
  font-size: 12px;
  line-height: 1.6;
}

.hc-diff__hunk-header {
  padding: 4px 12px;
  background: var(--hc-bg-tertiary, #e9ecef);
  color: var(--hc-text-muted);
  font-weight: 600;
  font-size: 11px;
  white-space: pre;
  user-select: none;
}

.hc-diff__hunk-sep {
  height: 0;
  border-top: 1px dashed var(--hc-border);
  margin: 0;
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
