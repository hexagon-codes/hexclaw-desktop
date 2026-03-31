<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue'
import TitleBar from './TitleBar.vue'
import Sidebar from './Sidebar.vue'
import DetailPanel from './DetailPanel.vue'
import InspectorContext from '@/components/inspector/InspectorContext.vue'
import CommandPalette from '@/components/common/CommandPalette.vue'
import { useAppStore } from '@/stores/app'

const appStore = useAppStore()

async function syncIMInstancesWhenReady() {
  try {
    const { ensureIMInstancesSyncedToBackend } = await import('@/api/im-channels')
    await ensureIMInstancesSyncedToBackend()
  } catch (e) {
    console.warn('[IM] 启动同步实例失败:', e)
  }
}

function dismissSplash() {
  const splash = document.getElementById('splash-screen')
  if (splash) {
    splash.classList.add('fade-out')
    splash.addEventListener('transitionend', () => splash.remove(), { once: true })
  }
}

onMounted(() => {
  appStore.startHealthCheck()
  // 如果 sidecar 30 秒内未就绪，也移除 splash 避免永远卡住
  const splashTimeout = setTimeout(dismissSplash, 30000)
  watch(
    () => appStore.sidecarReady,
    (ready, wasReady) => {
      if (ready && !wasReady) {
        clearTimeout(splashTimeout)
        dismissSplash()
        void syncIMInstancesWhenReady()
      }
    },
    { immediate: true },
  )
})

onUnmounted(() => {
  appStore.stopHealthCheck()
})
</script>

<template>
  <div class="hc-app">
    <TitleBar />
    <div class="hc-app__body">
      <Sidebar />
      <main class="hc-app__content">
        <slot />
      </main>
      <DetailPanel :open="appStore.detailPanelOpen" @close="appStore.toggleDetailPanel">
        <InspectorContext />
      </DetailPanel>
    </div>
    <CommandPalette />
  </div>
</template>

<style scoped>
.hc-app {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--hc-bg-main);
}

.hc-app__body {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.hc-app__content {
  flex: 1;
  overflow: hidden;
  position: relative;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
</style>
