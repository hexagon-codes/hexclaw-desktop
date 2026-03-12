<script setup lang="ts">
import { getCurrentWindow } from '@tauri-apps/api/window'
import logoUrl from '@/assets/logo.png'

const appWindow = getCurrentWindow()

function minimize() {
  appWindow.minimize()
}

function toggleMaximize() {
  appWindow.toggleMaximize()
}

function close() {
  appWindow.close()
}
</script>

<template>
  <div
    data-tauri-drag-region
    class="h-[38px] flex items-center justify-between px-4 flex-shrink-0 select-none"
    :style="{ background: 'var(--hc-bg-sidebar)' }"
  >
    <!-- macOS 留出红绿灯按钮空间 -->
    <div class="flex items-center gap-1.5 pl-[18px]">
      <img :src="logoUrl" alt="HexClaw" class="w-5 h-5" />
      <span class="text-xs font-semibold tracking-wide" :style="{ color: 'var(--hc-text-secondary)' }">
        HexClaw
      </span>
    </div>

    <!-- 右侧窗口控制 (macOS 使用原生控制，这里做 fallback) -->
    <div class="flex items-center gap-0.5 -mr-1">
      <button
        class="w-7 h-7 flex items-center justify-center rounded hover:bg-white/5 transition-colors"
        :style="{ color: 'var(--hc-text-muted)' }"
        @click="minimize"
      >
        <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
      </button>
      <button
        class="w-7 h-7 flex items-center justify-center rounded hover:bg-white/5 transition-colors"
        :style="{ color: 'var(--hc-text-muted)' }"
        @click="toggleMaximize"
      >
        <svg width="8" height="8" viewBox="0 0 8 8"><rect x="0.5" y="0.5" width="7" height="7" rx="1" fill="none" stroke="currentColor"/></svg>
      </button>
      <button
        class="w-7 h-7 flex items-center justify-center rounded hover:bg-red-500/80 transition-colors"
        :style="{ color: 'var(--hc-text-muted)' }"
        @click="close"
      >
        <svg width="8" height="8" viewBox="0 0 8 8"><line x1="1" y1="1" x2="7" y2="7" stroke="currentColor" stroke-width="1.2"/><line x1="7" y1="1" x2="1" y2="7" stroke="currentColor" stroke-width="1.2"/></svg>
      </button>
    </div>
  </div>
</template>
