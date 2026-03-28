<script setup lang="ts">
defineProps<{ agentName: string; isHandoff?: boolean }>()
</script>
<template>
  <div class="agent-badge" :class="{ 'agent-badge--handoff': isHandoff }">
    <span class="agent-badge__icon">&#x1F916;</span>
    <span class="agent-badge__name">{{ agentName }}</span>
    <span v-if="isHandoff" class="agent-badge__label">handoff</span>
  </div>
</template>
<style scoped>
.agent-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 12px; font-size: 11px; background: var(--bg-secondary); color: var(--text-secondary); }
.agent-badge__name { font-weight: 500; }
.agent-badge__label { font-size: 10px; padding: 0 4px; background: var(--accent-muted); border-radius: 4px; }
.agent-badge--handoff { animation: badge-pulse 1s ease-in-out; }
@keyframes badge-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
</style>
