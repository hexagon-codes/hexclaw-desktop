<script setup lang="ts">
defineProps<{
  status: 'online' | 'offline' | 'error' | 'warning' | 'idle' | 'running'
}>()
</script>

<template>
  <span class="hc-badge" :class="`hc-badge--${status}`">
    <span class="hc-badge__dot" />
    <span class="hc-badge__label">
      <template v-if="status === 'online'">在线</template>
      <template v-else-if="status === 'offline'">离线</template>
      <template v-else-if="status === 'error'">错误</template>
      <template v-else-if="status === 'warning'">警告</template>
      <template v-else-if="status === 'idle'">空闲</template>
      <template v-else-if="status === 'running'">运行中</template>
    </span>
  </span>
</template>

<style scoped>
.hc-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--hc-space-1);
  padding: var(--hc-space-1) var(--hc-space-2) var(--hc-space-1) var(--hc-space-2);
  border-radius: 100px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
}

.hc-badge__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex-shrink: 0;
  background: currentColor;
}

/* ── Status variants ── */
.hc-badge--online {
  color: var(--hc-success);
  background: rgba(50, 213, 131, 0.1);
}

.hc-badge--offline,
.hc-badge--idle {
  color: var(--hc-text-muted);
  background: var(--hc-bg-hover);
}

.hc-badge--error {
  color: var(--hc-error);
  background: rgba(245, 101, 101, 0.1);
}

.hc-badge--warning {
  color: var(--hc-warning);
  background: rgba(240, 180, 41, 0.1);
}

.hc-badge--running {
  color: var(--hc-accent);
  background: var(--hc-accent-subtle);
}
</style>
