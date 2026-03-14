<script setup lang="ts">
import { usePlatform } from '@/composables/usePlatform'
import { useAppStore } from '@/stores/app'
import { PanelLeft } from 'lucide-vue-next'

const { isMac } = usePlatform()
const appStore = useAppStore()
</script>

<template>
  <div
    data-tauri-drag-region
    class="hc-titlebar"
    :class="{ 'hc-titlebar--mac': isMac }"
  >
    <div class="hc-titlebar__left" />

    <!-- Center: app title -->
    <span class="hc-titlebar__title">HexClaw Desktop</span>

    <!-- Right: sidebar toggle -->
    <div class="hc-titlebar__right">
      <button class="hc-titlebar__btn" @click="appStore.toggleSidebar">
        <PanelLeft :size="16" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.hc-titlebar {
  height: 38px;
  flex-shrink: 0;
  user-select: none;
  -webkit-app-region: drag;
  display: flex;
  align-items: center;
  padding: 0 12px;
}

.hc-titlebar--mac {
  padding-left: 78px;
}

/* ── Left spacer ── */
.hc-titlebar__left {
  width: 28px;
}

/* ── Center ── */
.hc-titlebar__title {
  flex: 1;
  text-align: center;
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-secondary);
}

/* ── Right ── */
.hc-titlebar__right {
  display: flex;
  align-items: center;
}

.hc-titlebar__btn {
  padding: 5px 7px;
  border-radius: var(--hc-radius-sm);
  border: none;
  background: transparent;
  color: var(--hc-text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
  -webkit-app-region: no-drag;
}

.hc-titlebar__btn:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}

.hc-titlebar__btn:active {
  background: var(--hc-bg-active);
  transform: scale(0.95);
}
</style>
